/* third-person-rig.js — reusable third-person character controller
   (no app coupling, avatar-agnostic).

   Owns abstract-action input, arcade ground/air physics (walk, run, jump,
   double jump, dash with cooldown, coyote time, jump buffering) and a smooth
   follow camera. It never touches a mesh: the host reads rig.state each frame
   and drives whatever avatar it likes; discrete beats arrive via assignable
   callbacks (onJump/onLand/onDash).

     const rig = createThirdPersonRig({ camera, groundFn, collideFn, bounds: { radius: 74 } });
     rig.onJump = (n) => avatar.onJump(n);
     rig.press("forward", true);      // abstract actions, not key codes
     rig.update(dt);                  // physics + camera
     avatar.group.position.copy(rig.state.pos);

   Feel constants live in DEFAULT_FEEL and can be overridden per-field via
   opts.feel — tune jump arcs and dash punch without touching the logic. */

import * as THREE from "../../vendor/three.module.js";

export const DEFAULT_FEEL = {
  walkSpeed: 5.4,        // u/s
  runSpeed: 9.8,
  accel: 30,             // u/s² toward target speed
  decel: 22,
  airControl: 0.42,      // accel multiplier while airborne
  /* Manual steering is deliberately slower than auto-run steering. A 10.5
     rad/s quarter-turn made a 100 ms key tap swing the calf about 60 degrees;
     5.2 gives the player time to correct without making numeric station travel
     miss its authored fence approaches. */
  turnRate: 5.2,         // rad/s toward manual input heading
  airTurnRate: 3.0,
  autoTurnRate: 10.5,    // preserve authored auto-run cornering
  autoAirTurnRate: 5.5,
  gravity: 26,
  jumpSpeed: 8.8,        // ≈1.5 u apex
  doubleJumpSpeed: 7.6,
  coyoteTime: 0.12,      // jump grace after leaving ground
  jumpBuffer: 0.14,      // early Space presses land-and-fire
  dashSpeed: 19,
  dashCooldown: 0.8,
  airDashes: 1,          // dashes allowed per airtime
  /* Collision circle on the ground plane. Sized to the character's NOSE, not
     its waist: a quadruped is far longer than it is wide, and one circle must
     pick a failure mode — standing a hand's width off a rail is invisible,
     a muzzle pushed through it is not. */
  bodyRadius: 0.8,
  /* Camera framing. The height is measured from the ground and the look point
     sits at camLookHeight, so the resting elevation is
     atan((camHeight - camLookHeight) / camDistance) — 25° here. The first
     version used camHeight 3.0, i.e. 15°, which put the lens at calf-shoulder
     level: the ranch was seen edge-on, the ground ate half the frame, and
     there was no way to look over the exhibits from the saddle.
     camHeight scales with camDistance in desiredCamPos, so zooming out keeps
     this angle instead of flattening it. */
  camDistance: 7.0,
  camMinDistance: 3.2,
  camMaxDistance: 20.0,
  camHeight: 4.4,
  /* Framing follows how close the calf is to an exhibit, because the two
     situations want opposite cameras. Out in the open the useful view is a
     high, wide one — the ranch reads as a map and you can see where the amber
     path goes. Standing at a station the useful view is low and close, because
     the exhibit is a metre-scale object you are meant to read. The multipliers
     below apply at range and decay to 1 at the pad; the host feeds proximity
     in via rig.setFraming(). */
  camFarDistance: 1.45,   // ×camDistance out in the open
  camFarHeight: 2.2,      // ×camHeight out in the open (25° → ~40° elevation)
  camFramingLerp: 1.5,    // 1/s — a crane move, not a snap
  camLookHeight: 1.15,
  camLookAhead: 1.9,     // target leads in the move direction at speed
  camPosLerp: 5.0,       // 1/s exponential smoothing rates
  camYawLerp: 2.6,
  camTargetLerp: 7.0
};

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

/* Station framing as a pure function of proximity: 1 = standing at an exhibit
   (the resting close framing), 0 = open ranch. Split out of desiredCamPos so
   the policy can be asserted without a GPU — a software-rendered browser runs
   the sim far below real time, which makes the live camera unmeasurable while
   it is still craning. */
export function framingMultipliers(framing, feel = DEFAULT_FEEL) {
  const f = clamp(framing, 0, 1);
  return {
    distMul: 1 + (feel.camFarDistance - 1) * (1 - f),
    heightMul: 1 + (feel.camFarHeight - 1) * (1 - f)
  };
}

/* Resting elevation in degrees at a given framing, ignoring speed and orbit
   offset — the number a reviewer actually wants to argue about. */
export function framingElevationDeg(framing, feel = DEFAULT_FEEL) {
  const { distMul, heightMul } = framingMultipliers(framing, feel);
  const standoff = feel.camDistance * distMul;
  const rise = feel.camHeight * heightMul - feel.camLookHeight;
  return Math.atan2(rise, standoff) * 180 / Math.PI;
}
const REDUCED_MOTION = typeof matchMedia !== "undefined" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;
/* shortest-path angle stepping (heading chases input across ±π) */
export function turnToward(a, b, maxStep) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + clamp(d, -maxStep, maxStep);
}

/* collideFn(x, z, radius, clearance) → {x, z, hit} | null. Host-supplied like
   groundFn, so the rig stays scene-agnostic; see js/lib/obb-collider.js. */
export function createThirdPersonRig({ camera, groundFn = () => 0, collideFn = null, bounds = null, feel = {} } = {}) {
  const F = { ...DEFAULT_FEEL, ...feel };

  const down = new Set();          // held abstract actions
  const state = {
    pos: new THREE.Vector3(),
    heading: 0,                    // yaw, +Z forward at 0
    speed: 0,                      // signed ground-plane speed along heading
    speed01: 0,
    run01: 0,
    grounded: true,
    vy: 0,
    groundY: 0,
    jumps: 0,                      // jumps used since last grounded
    dashCooldown: 0,
    blocked: false                 // a collider pushed back this frame
  };

  let camYaw = 0;                  // follow direction (chases heading)
  let autoDir = null;              // world-space steer override (auto-run)
  let camDist = F.camDistance;
  let heightOff = 0;               // mouse-orbit vertical offset
  /* 0 = far from every exhibit, 1 = standing at one. Starts at 0 so entering
     roam out on the pasture opens on the high, wide view. */
  let framing = 0, framingTarget = 0;
  let chaseBoost = 0;              // temporary camYaw chase boost (face-exhibit)
  let fovKick = 0;                 // dash speed-feel: brief FOV widen
  let baseFov = 0;
  let sinceGrounded = 0;           // coyote clock
  let jumpBuffered = -1;           // seconds remaining, <0 = none
  let airDashesLeft = F.airDashes;
  let runHeld01 = 0;               // eased run blend for animation

  const camTarget = new THREE.Vector3();
  const _fwd = new THREE.Vector3();
  const rig = {
    state,
    feel: F,
    enabled: true,
    onJump: null,
    onLand: null,
    onDash: null,

    press(action, isDown) {
      if (isDown) {
        if (action === "jump") tryJump();
        else if (action === "dash") tryDash();
        else down.add(action);
      } else {
        down.delete(action);
      }
    },
    releaseAll() { down.clear(); autoDir = null; },
    /* world-space unit direction to steer toward (null = back to keys) */
    setAutoDir(dir) { autoDir = dir; },
    get camYaw() { return camYaw; },
    /* mouse orbit: yaw around the character + vertical offset. The view
       holds while standing (chase rate ≈ 0) and swings back behind the
       heading once the character moves. */
    /* dy sensitivity tracks the clamp range: the old 0.012 was tuned for a
       4.4-unit span, and reusing it over a 10-unit one would make the drag
       feel broken rather than roomy. */
    orbit(dx, dy) {
      camYaw += dx * 0.005;
      heightOff = clamp(heightOff + dy * 0.026, -2.0, 8.0);
    },
    /* swing the camera behind the heading soon (station arrivals) */
    boostChase(v = 2.2) { chaseBoost = v; },
    /* hand the lens back untouched when the host leaves this rig's mode */
    resetFov() {
      if (baseFov) {
        camera.fov = baseFov;
        camera.updateProjectionMatrix();
      }
      fovKick = 0;
    },
    /* 0..1 — how close the character is to an exhibit. The host owns the
       measurement (it knows where the stations are); the rig owns the easing. */
    setFraming(k) { framingTarget = clamp(k, 0, 1); },
    zoom(delta) {
      camDist = clamp(camDist + delta, F.camMinDistance, F.camMaxDistance);
    },
    teleport(x, z, heading = 0) {
      state.pos.set(x, groundFn(x, z), z);
      state.heading = heading;
      state.speed = 0;
      state.vy = 0;
      state.grounded = true;
      state.jumps = 0;
      camYaw = heading;
      heightOff = 0;
    },
    /* cinematic sky-drop: start the fall, let gravity and onLand do the rest */
    drop(height = 24) {
      state.pos.y = state.groundY + height;
      state.vy = 0;
      state.grounded = false;
      state.jumps = 0;
      sinceGrounded = Infinity;
    },
    /* place the camera at its steady-state pose immediately (mode entry) */
    snapCamera() {
      const p = desiredCamPos();
      camera.position.copy(p);
      camTarget.copy(lookPoint());
      camera.lookAt(camTarget);
    },
    update
  };

  function tryJump() {
    if (state.grounded || sinceGrounded < F.coyoteTime) {
      launch(F.jumpSpeed, 1);
    } else if (state.jumps === 1) {
      launch(F.doubleJumpSpeed, 2);
    } else {
      jumpBuffered = F.jumpBuffer;
    }
  }
  function launch(v, count) {
    state.vy = v;
    state.grounded = false;
    state.jumps = count;
    sinceGrounded = Infinity;      // consume coyote
    if (rig.onJump) rig.onJump(count);
  }
  function tryDash() {
    if (state.dashCooldown > 0) return;
    if (!state.grounded) {
      if (airDashesLeft <= 0) return;
      airDashesLeft--;
    }
    state.speed = F.dashSpeed;
    state.dashCooldown = F.dashCooldown;
    if (!REDUCED_MOTION) fovKick = 1;
    if (rig.onDash) rig.onDash();
  }

  function inputVector() {
    /* auto-steer (world-space) overrides the keys — the host clears it on
       any manual movement input */
    if (autoDir) return { x: autoDir.x, z: autoDir.z, backOnly: false };
    /* camera-relative: "forward" walks away from the camera. With the camera
       looking along fwd=(sinθ, cosθ), screen-right is (−cosθ, sinθ). */
    let x = 0, z = 0;
    if (down.has("forward")) z += 1;
    if (down.has("back")) z -= 1;
    if (down.has("left")) x -= 1;
    if (down.has("right")) x += 1;
    if (!x && !z) return null;
    const sin = Math.sin(camYaw), cos = Math.cos(camYaw);
    return { x: z * sin - x * cos, z: z * cos + x * sin, backOnly: z < 0 && !x };
  }

  function desiredCamPos() {
    /* station framing: 1 = on a pad (close, low), 0 = open ranch (back, high) */
    const { distMul, heightMul } = framingMultipliers(framing, F);
    /* pull back + rise with speed so dashes don't outrun the lerp into a close-up */
    const d = camDist * distMul * (1 + 0.24 * state.speed01);
    /* ground-based height: the camera holds its framing through jump arcs and
       sky-drop entrances instead of chasing the character vertically.
       Dividing by the SAME distMul keeps zoom angle-preserving as before —
       heightMul is then the only thing that changes the elevation. */
    const baseY = Math.min(state.pos.y, state.groundY + 1.5);
    const p = new THREE.Vector3(
      state.pos.x - Math.sin(camYaw) * d,
      baseY + F.camHeight * heightMul * (d / (F.camDistance * distMul)) + heightOff,
      state.pos.z - Math.cos(camYaw) * d
    );
    const floor = groundFn(p.x, p.z) + 0.55;
    if (p.y < floor) p.y = floor;
    return p;
  }
  function lookPoint() {
    _fwd.set(Math.sin(state.heading), 0, Math.cos(state.heading));
    const p = new THREE.Vector3()
      .copy(state.pos)
      .addScaledVector(_fwd, F.camLookAhead * state.speed01)
      .add({ x: 0, y: F.camLookHeight, z: 0 });
    /* keep the horizon in frame during sky-drops: tilt up, don't stare up */
    p.y = Math.min(p.y, state.groundY + 5.5);
    return p;
  }

  function update(dt) {
    if (!rig.enabled || dt <= 0) return;

    /* ease the station framing before the camera reads it this frame */
    framing += (framingTarget - framing) * Math.min(1, F.camFramingLerp * dt);

    const dir = inputVector();
    const running = down.has("run");
    runHeld01 += ((running && dir && !dir.backOnly ? 1 : 0) - runHeld01) * Math.min(1, dt * 8);

    /* --- heading chases the input direction (except pure backpedal: turning
       to face the camera while the camera chases heading = spin feedback) --- */
    if (dir && !dir.backOnly) {
      const want = Math.atan2(dir.x, dir.z);
      const rate = autoDir
        ? (state.grounded ? F.autoTurnRate : F.autoAirTurnRate)
        : (state.grounded ? F.turnRate : F.airTurnRate);
      state.heading = turnToward(state.heading, want, rate * dt);
    }

    /* --- scalar speed toward target (dash decays through the same path;
       backpedal is a signed negative speed along the unchanged heading) --- */
    const target = dir ? (dir.backOnly ? -F.walkSpeed * 0.55 : (running ? F.runSpeed : F.walkSpeed)) : 0;
    const ctl = state.grounded ? 1 : F.airControl;
    if (state.speed < target) state.speed = Math.min(target, state.speed + F.accel * ctl * dt);
    else state.speed = Math.max(target, state.speed - F.decel * ctl * dt);
    state.speed01 = clamp(Math.abs(state.speed) / F.runSpeed, 0, 1);
    state.run01 = runHeld01;

    /* --- integrate --- */
    const preX = state.pos.x, preZ = state.pos.z;
    state.pos.x += Math.sin(state.heading) * state.speed * dt;
    state.pos.z += Math.cos(state.heading) * state.speed * dt;
    if (bounds && bounds.radius) {
      const r = Math.hypot(state.pos.x, state.pos.z);
      if (r > bounds.radius) {
        const k = bounds.radius / r;
        state.pos.x *= k;
        state.pos.z *= k;
      }
    }
    /* props push back after the move, never before: resolving the integrated
       position is what lets the character slide along a fence instead of
       sticking to it. Passing feet height keeps low obstacles jumpable. */
    state.blocked = false;
    if (collideFn) {
      const p = collideFn(state.pos.x, state.pos.z, F.bodyRadius,
        state.pos.y - state.groundY);
      if (p) {
        state.pos.x = p.x;
        state.pos.z = p.z;
        /* A wall has to absorb the motion it cancels. Scalar speed survives
           collision otherwise, and the avatar gallops on the spot against a
           fence at full stride. Only a mostly-cancelled step counts: a glancing
           slide keeps its speed, which is what makes sliding read as sliding. */
        if (p.hit) {
          const got = Math.hypot(state.pos.x - preX, state.pos.z - preZ);
          const want = Math.abs(state.speed) * dt;
          if (want > 1e-6 && got < want * 0.5) {
            state.blocked = true;
            state.speed *= got / want;
          }
        }
      }
    }

    const wasGrounded = state.grounded;
    state.vy -= F.gravity * dt;
    state.pos.y += state.vy * dt;
    state.groundY = groundFn(state.pos.x, state.pos.z);

    /* downhill snap: while walking, follow a dropping slope instead of
       micro-hopping (leaving ground for one frame and re-landing each step) */
    if (wasGrounded && state.vy <= 0 && state.pos.y > state.groundY &&
        state.pos.y - state.groundY < 0.35) {
      state.pos.y = state.groundY;
      state.vy = 0;
    }

    if (state.pos.y <= state.groundY + 1e-3 && state.vy <= 0) {
      const impact = -state.vy;
      const wasAirborne = !state.grounded;
      state.pos.y = state.groundY;
      state.vy = 0;
      state.grounded = true;
      state.jumps = 0;
      airDashesLeft = F.airDashes;
      sinceGrounded = 0;
      if (wasAirborne && rig.onLand) rig.onLand(impact);
      if (jumpBuffered > 0) {
        jumpBuffered = -1;
        launch(F.jumpSpeed, 1);
      }
    } else if (state.pos.y > state.groundY + 1e-3) {
      state.grounded = false;
      sinceGrounded += dt;
    }
    if (jumpBuffered > 0) jumpBuffered -= dt;
    if (state.dashCooldown > 0) state.dashCooldown = Math.max(0, state.dashCooldown - dt);

    /* --- follow camera: a mouse-set view holds while standing, swings back
       behind the heading with movement (or a temporary chase boost) --- */
    if (chaseBoost > 0) chaseBoost = Math.max(0, chaseBoost - dt * 1.6);
    camYaw = turnToward(camYaw, state.heading,
      F.camYawLerp * dt * (0.05 + 1.2 * state.speed01 + chaseBoost));
    const goal = desiredCamPos();
    const kp = 1 - Math.exp(-F.camPosLerp * dt);
    camera.position.lerp(goal, kp);
    const kt = 1 - Math.exp(-F.camTargetLerp * dt);
    camTarget.lerp(lookPoint(), kt);
    camera.lookAt(camTarget);

    /* dash FOV kick: instant widen, ~0.4 s decay back to the base lens */
    if (!baseFov) baseFov = camera.fov;
    if (fovKick > 0) {
      fovKick *= Math.exp(-5.5 * dt);
      if (fovKick < 0.004) fovKick = 0;
      camera.fov = baseFov + 10 * fovKick;
      camera.updateProjectionMatrix();
    }
  }

  return rig;
}
