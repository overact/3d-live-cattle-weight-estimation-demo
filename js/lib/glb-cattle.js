/* glb-cattle.js — GLB avatar adapter behind the same contract as chibi-cattle.
   Wraps a loaded glTF so the third-person rig and roam glue never know which
   avatar is on stage.

   Clip locomotion comes from the asset's AnimationMixer; the game-feel beats
   the clips don't cover — jump squash/stretch, double-jump flip, dash lean,
   tint washes, blob shadow — are applied on wrapper groups above the model,
   with the same spring math as chibi-cattle.

   The adapter is asset-agnostic on purpose: the player calf and the ambient
   herd now share assets/world/cow_quaternius.glb, but that rig names its
   clips "Armature|Walk" and ships no emote clips at all, where the earlier
   Kenney "Cube Pets" cow named them "walk" and had dance/eat/gesture. Both
   differences are absorbed below rather than at the call site. */

import * as THREE from "../../vendor/three.module.js";

const TAU = Math.PI * 2;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const ease = (k) => k * k * (3 - 2 * k);

/* Role → clip names to try, best first. Resolved ONCE per asset so the
   per-frame state machine only ever speaks in stable role names. A missing
   role falls through to the procedural fallback instead of freezing the model
   in bind pose — which is what an unresolved play() used to do silently. */
const ROLE_ALIASES = {
  idle: ["idle", "static"],
  walk: ["walkslow", "walk"],
  run: ["run", "walk"],
  air: ["jump", "run"],
  cheer: ["dance", "gesture-positive"],
  graze: ["eat", "walkslow"]
};

/* Gait cadence is CYCLES PER SECOND, multiplied by each clip's own duration to
   get timeScale — the candidate assets are authored at wildly different lengths
   (Kenney's walk 0.5 s, Quaternius' Walk 3.33 s), so a hard-coded timeScale
   makes one sprint and the other crawl.

   The honest cadence is speed / stride, and the stride is measured off the rig
   (measureStride below) rather than guessed. But the calf is an arcade subject:
   walkSpeed 5.4 u/s on a 1.5-unit animal is ~4 body-heights per second, which
   at a real cow's stride is 7+ cycles/s of pure blur. So the cadence is capped
   and the residual slip is accepted — a deliberate stylisation on the animal
   the visitor is DRIVING, not the silent bug the ambient herd had. */
const GAIT_HZ_MAX = 3.1;
const GAIT_HZ_MIN = 0.55;
const AIR_HZ = 0.75;

/* One-shot emote timing, matched to chibi-cattle so the two avatars read the
   same. `role` is played when the asset carries that clip; every emote also
   has a wrapper-level fallback, which is all the Quaternius rig ever gets. */
const EMOTE_S = { spin: 0.65, flex: 0.9, bow: 1.1, moo: 0.55, denoise: 1.2 };
const EMOTE_ROLE = { spin: "cheer", flex: "cheer", bow: "graze", moo: "cheer" };

/* Bind-pose extents measured from GEOMETRY, never from the live skeleton.

   three r160's Box3.expandByObject prefers `object.boundingBox` when the
   object defines one, and SkinnedMesh does — computed by pushing every vertex
   through the CURRENT bone matrices. A SkeletonUtils.clone that has not been
   rendered yet has all-zero bone matrices, so that box came back ~917 units
   tall, the fit scaled the calf to 1/900th of its size, and the avatar
   silently vanished leaving only its blob shadow. Geometry boxes are in bind
   space and depend on nothing that has to have been drawn first. */
function bindPoseBox(root) {
  const box = new THREE.Box3(), one = new THREE.Box3();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    box.union(one.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld));
  });
  return box;
}

/* Ground a locomotion clip covers per loop, measured off the rig: the cycle is
   authored in place, so the body must travel exactly the hoof's fore-aft
   excursion (in the body frame) for the feet not to slip. Sampled once per
   clip at build time — ~40 mixer steps, sub-millisecond — because guessing this
   number is what made the ambient herd skate. Falls back to a body-length
   estimate when the rig has no recognisable foot bones. */
function measureStride(root, clip, forward = "z", samples = 40) {
  const feet = [];
  root.traverse((o) => { if (/foot|hoof|toe/i.test(o.name) && !/_end$/.test(o.name)) feet.push(o); });
  if (!feet.length) return null;
  const mixer = new THREE.AnimationMixer(root);
  const action = mixer.clipAction(clip);
  action.play();
  const v = new THREE.Vector3(), c = new THREE.Vector3();
  const span = feet.map(() => ({ lo: Infinity, hi: -Infinity }));
  for (let i = 0; i < samples; i++) {
    mixer.setTime((i / samples) * clip.duration);
    root.updateMatrixWorld(true);
    c.setFromMatrixPosition(root.matrixWorld);
    feet.forEach((f, k) => {
      const d = v.setFromMatrixPosition(f.matrixWorld).sub(c)[forward];
      span[k].lo = Math.min(span[k].lo, d);
      span[k].hi = Math.max(span[k].hi, d);
    });
  }
  action.stop();
  mixer.uncacheRoot(root);
  const mean = span.reduce((s, x) => s + (x.hi - x.lo), 0) / span.length;
  return mean > 1e-3 ? mean : null;
}

/* "Armature|Walk" → "walk": Blender's glTF exporter prefixes the armature. */
function resolveRoles(animations = []) {
  const byName = new Map(
    animations.map((c) => [c.name.split("|").pop().toLowerCase(), c]));
  const names = [...byName.keys()];
  const roles = {}, alias = {};
  for (const role in ROLE_ALIASES) {
    for (const want of ROLE_ALIASES[role]) {
      const hit = byName.get(want)
        ?? byName.get(names.find((n) => n.includes(want)));
      if (hit) { roles[role] = hit; alias[role] = want; break; }
    }
  }
  return { roles, alias };
}

export function createGlbCattle(gltf, opts = {}) {
  const height = opts.height ?? 1.5;
  const forwardYaw = opts.forwardYaw ?? 0;   // yaw so the model faces +Z

  const group = new THREE.Group();
  const squash = new THREE.Group();          // land/jump squash (pivot at feet)
  const flip = new THREE.Group();            // double-jump flip (pivot at belly)
  const inner = new THREE.Group();
  flip.position.y = height * 0.5;
  inner.position.y = -height * 0.5;
  group.add(squash);
  squash.add(flip);
  flip.add(inner);

  const model = gltf.scene;
  inner.add(model);
  const bb = bindPoseBox(model);
  model.scale.setScalar(height / Math.max(bb.max.y - bb.min.y, 1e-6));
  model.rotation.y = forwardYaw;
  const bb2 = bindPoseBox(model);
  model.position.y -= bb2.min.y;
  model.position.x -= (bb2.min.x + bb2.max.x) / 2;
  model.position.z -= (bb2.min.z + bb2.max.z) / 2;

  /* clone materials so tint washes never touch a shared asset material */
  const tinted = [];
  model.traverse((o) => {
    if (o.isMesh && o.material) {
      o.material = o.material.clone();
      if (o.material.emissive) tinted.push(o.material);
    }
    /* The avatar is a third-person subject: it is on screen essentially always,
       and its skinned bounding volume is the same stale-skeleton trap that
       bindPoseBox exists to dodge — culling it can only ever be wrong here. */
    if (o.isMesh) o.frustumCulled = false;
  });

  const shadowMat = new THREE.MeshBasicMaterial({
    color: 0x000000, transparent: true, opacity: 0.34, depthWrite: false
  });
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.62, 20), shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.renderOrder = 1;
  group.add(shadow);

  /* ---- clip state machine (role-addressed, see resolveRoles) ---- */
  const mixer = new THREE.AnimationMixer(model);
  const { roles, alias } = resolveRoles(gltf.animations);
  const actions = {};
  for (const role in roles) actions[role] = mixer.clipAction(roles[role]);
  /* A real jump clip is a one-shot arc, not a loop: hold its last pose for the
     rest of the hang time instead of re-launching mid-air. Assets that only
     have a run to paddle with keep looping. */
  if (alias.air === "jump") {
    actions.air.setLoop(THREE.LoopOnce);
    actions.air.clampWhenFinished = true;
  }
  /* stride per locomotion role, in the SAME units the rig reports speed in */
  const stride = {};
  for (const role of ["walk", "run"]) {
    if (actions[role]) stride[role] = measureStride(model, roles[role]);
  }
  let current = null;
  function play(role, fade = 0.16, hz = null) {
    const a = actions[role];
    if (!a) return;
    if (hz != null) a.timeScale = hz * roles[role].duration;
    if (current === a) return;
    a.reset().fadeIn(fade).play();
    if (current) current.fadeOut(fade);
    current = a;
  }
  /* speed (u/s) → cycles/s for `role`, from the measured stride when there is
     one, else the old speed01 ramp so an unmeasurable rig still animates */
  function gaitHz(role, speed, speed01) {
    const s = stride[role];
    if (!s) return role === "run" ? 1.55 + 1.15 * speed01 : 0.85 + 1.05 * speed01;
    return clamp(Math.abs(speed) / s, GAIT_HZ_MIN, GAIT_HZ_MAX);
  }
  play("idle", 0);

  /* ---- wrapper-level feel (same springs as chibi-cattle) ---- */
  let squashP = 1, squashV = 0;
  let flipT = Infinity;
  let dashT = Infinity;
  /* one clock per emote, so an asset with no emote clips still gets the
     procedural version — and the two can run together where a clip exists */
  const emoteT = { spin: Infinity, flex: Infinity, bow: Infinity, moo: Infinity, denoise: Infinity };
  let emoteLeft = 0;            // seconds an emote clip still owns the body
  let tintK = 0;
  const INNER_Y = inner.position.y;   // moo lifts from here, denoise jitters around it
  const tintColor = new THREE.Color(0x86d7ea);
  const FLIP_S = 0.55, DASH_S = 0.45;

  function update(dt, t, pose) {
    const speed01 = clamp(pose.speed01 ?? 0, 0, 1);
    /* real ground speed drives cadence; speed01 only picks the gait */
    const speed = pose.speed ?? speed01 * 9.8;
    const grounded = pose.grounded ?? true;
    const vy = pose.vy ?? 0;

    /* locomotion clips (emotes own the body briefly) */
    if (emoteLeft > 0) emoteLeft -= dt;
    if (emoteLeft <= 0) {
      if (!grounded) play("air", 0.1, AIR_HZ);
      else if (speed01 < 0.04) play("idle", 0.2);
      else if (speed01 < 0.62) play("walk", 0.14, gaitHz("walk", speed, speed01));
      else play("run", 0.14, gaitHz("run", speed, speed01));
    }
    mixer.update(dt);

    /* one-shot emote envelopes (same shapes and durations as chibi-cattle) */
    for (const k in emoteT) if (emoteT[k] < EMOTE_S[k]) emoteT[k] += dt;
    const spinK = emoteT.spin < EMOTE_S.spin ? ease(emoteT.spin / EMOTE_S.spin) : 0;
    const flexK = emoteT.flex < EMOTE_S.flex ? Math.sin((emoteT.flex / EMOTE_S.flex) * Math.PI) : 0;
    const bowK = emoteT.bow < EMOTE_S.bow ? Math.sin((emoteT.bow / EMOTE_S.bow) * Math.PI) : 0;
    const mooK = emoteT.moo < EMOTE_S.moo ? Math.sin((emoteT.moo / EMOTE_S.moo) * Math.PI) : 0;
    /* group.rotation.y belongs to the rig's heading, so the spin rides `inner` */
    inner.rotation.y = spinK > 0 ? TAU * spinK : 0;
    const flexS = 1 + 0.13 * flexK;
    if (inner.scale.x !== flexS) inner.scale.setScalar(flexS);

    /* lean & air pitch on the wrapper (never fights the node clips) */
    const dashK = dashT < DASH_S ? 1 - dashT / DASH_S : 0;
    const airPitch = grounded ? 0 : clamp(-vy * 0.045, -0.3, 0.42);
    flip.rotation.z = 0;
    if (flipT < FLIP_S) {
      flipT += dt;
      flip.rotation.x = TAU * ease(clamp(flipT / FLIP_S, 0, 1));
      if (flipT >= FLIP_S) flip.rotation.x = 0;
    } else {
      flip.rotation.x = -0.2 * ease(dashK) + airPitch + 0.42 * bowK;
    }

    /* squash & stretch spring */
    const stretchTarget = grounded ? 1 : 1 + clamp(Math.abs(vy) * 0.02, 0, 0.16);
    squashV += (stretchTarget - squashP) * 90 * dt;
    squashV *= Math.exp(-11 * dt);
    squashP += squashV * dt;
    const sy = clamp(squashP, 0.62, 1.3);
    squash.scale.set(1 + (1 - sy) * 0.55, sy, 1 + (1 - sy) * 0.55);
    squash.scale.z *= 1 + 0.22 * ease(dashK);
    if (dashT < DASH_S + 1) dashT += dt;

    /* denoise egg: positional jitter on the wrapper; moo: a short bob, which
       is the most a bone-agnostic adapter can do without a named head node */
    const jitK = emoteT.denoise < EMOTE_S.denoise
      ? 1 - emoteT.denoise / EMOTE_S.denoise : 0;
    inner.position.x = jitK > 0
      ? (Math.sin(t * 71) * 0.5 + Math.sin(t * 113)) * 0.02 * jitK : 0;
    inner.position.z = jitK > 0 ? Math.sin(t * 93) * 0.02 * jitK : 0;
    inner.position.y = INNER_Y + 0.09 * mooK;

    /* tint wash decay */
    if (tintK > 0.003) {
      tintK *= Math.exp(-1.6 * dt);
      for (const m of tinted) {
        m.emissive.copy(tintColor);
        m.emissiveIntensity = tintK;
      }
    } else if (tinted.length && tinted[0].emissiveIntensity !== 0) {
      for (const m of tinted) m.emissiveIntensity = 0;
      tintK = 0;
    }

    /* grounded blob shadow */
    const air = pose.groundY != null ? Math.max(0, group.position.y - pose.groundY) : 0;
    shadow.position.y = (pose.groundY != null ? pose.groundY - group.position.y : 0) + 0.03;
    const k = 1 / (1 + air * 0.55);
    shadow.scale.setScalar(k);
    shadowMat.opacity = 0.34 * k;
  }

  return {
    group,
    update,
    onJump(count) {
      squashV += count === 2 ? 3.2 : 2.4;
      if (count === 2) { flipT = 0; flip.rotation.x = 0; }
    },
    onLand(impact) {
      squashV -= clamp(impact * 0.28, 0.6, 3.4);
    },
    onDash() { dashT = 0; },
    emote(name) {
      if (!(name in emoteT)) return;
      emoteT[name] = 0;
      /* Play a matching clip when the asset has one; the wrapper envelope runs
         either way, so an asset with no emote clips still emotes. `emoteLeft`
         only exists to stop locomotion from stealing the body back, so it
         stays 0 when there is no clip to protect. */
      const role = EMOTE_ROLE[name];
      if (role && actions[role]) {
        play(role, 0.08);
        emoteLeft = EMOTE_S[name];
      }
    },
    setTint(color, k = 0.6) {
      tintColor.setHex(color);
      tintK = k;
    },
    dispose() {
      mixer.stopAllAction();
      model.traverse((o) => {
        if (o.isMesh) {
          o.geometry.dispose();
          if (o.material.map) o.material.map.dispose();
          o.material.dispose();
        }
      });
      shadow.geometry.dispose();
      shadowMat.dispose();
    }
  };

}
