/* Environment: early-dawn sky, low-poly terrain, CC0 props (Quaternius farm
   set), ambient cow herd, grass, fireflies and the glowing rail path ribbon.
   Everything animated here is a pure function of worldTime so the tour clock
   stays deterministic/seekable. */

import * as THREE from "../../vendor/three.module.js";
import { clone as cloneSkinned } from "../../vendor/SkeletonUtils.js";
import { STATIONS } from "./rail.js?v=20260813-camera-mount-review";
import { instanceTemplate } from "../lib/three-perf.js";
import { createBlobShadow } from "../lib/blob-shadow.js";
import { createColliderSet } from "../lib/obb-collider.js";
import { createCameraFlash } from "../lib/camera-flash.js";

const AMBER = 0xe39b2d, ICE = 0x86d7ea;
/* early dawn: deep-blue zenith, warm bright horizon, lifted fog */
const FOG = 0x465062;
const TAU = Math.PI * 2;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

/* World-space camera-housing origins for the future gate. Station 08 reuses these
   exact points for the photo-to-conveyor handoff, so the flying images cannot
   drift away from the physical cameras if the rig is adjusted again. */
export const FUTURE_RIG_CAPTURE_POINTS = Object.freeze([
  Object.freeze({ id: "left",  x: -40, y: 2.45, z: -0.56 }),
  Object.freeze({ id: "right", x: -40, y: 2.45, z: 4.56 }),
  Object.freeze({ id: "top",   x: -40, y: 3.02, z: 2.0 })
]);
export const FUTURE_RIG_PROXIMITY = Object.freeze({
  x: -40, z: 2, radius: 2.8
});
/* The visible deployment line is north of the physical weigh gate. A separate
   trigger lets a roaming calf start the machinery by approaching what the
   visitor can actually see, rather than an invisible point 12 units south. */
export const FUTURE_FACTORY_PROXIMITY = Object.freeze({
  x: -40, z: 14, radius: 5.2
});

/* ---------- herd gait: clip phase from distance, not wall-clock ----------
   A leg cycle ticking at a fixed rate while the body eases through a turn is
   exactly the "sliding on ice" read, and the lane cow's cosine ease brings it
   to a FULL STOP at each end while its legs kept walking on the spot. Driving
   the clip from ground distance plants the hooves at every speed.

   Everything here stays a pure function of worldTime — update() must remain
   seekable for the tour recorder, so per-frame accumulation is not an option
   and the arc lengths are solved instead. */

/* Ground covered per Walk loop, MEASURED off the rig rather than guessed: the
   cycle is authored in place, so the distance the body must travel for zero
   slip is exactly the hoof's fore-aft excursion in the body frame. Sampling
   the four ankle bones over one cycle at the herd's 1.45-unit fit gives
   0.687–0.743, mean 0.71. (The first pass at this used 1.45, reverse-engineered
   from the old wall-clock pacing — but that pacing WAS the bug, so the cows
   kept skating at exactly 2x foot speed. Measure the rig, not the symptom.) */
export const HERD_STRIDE = 0.71;

/* Lane profile: how much of a constant-speed triangle is mixed into the cosine
   ease. Pure cosine (0) brings the cow to a dead stop at each end, and a dead
   stop is worse than the skating it replaced — the animal pivots 180° with its
   legs frozen mid-stride. At 0.55 the ends still slow to ~44% of mid-lane
   speed, so the turn reads as a slow pivot that keeps stepping. */
export const LANE_EASE = 0.55;

/* Position along the lane, 0..1. Both terms rise and fall together, which is
   what lets laneArc below sum their arc lengths instead of integrating. */
export function laneU(p) {
  const cos = 0.5 - 0.5 * Math.cos(p);
  const tri = 0.5 + Math.asin(Math.sin(p - Math.PI / 2)) / Math.PI;
  return (1 - LANE_EASE) * cos + LANE_EASE * tri;
}

/* ---------- grazing herd: behaviour looked up, never simulated ----------
   Randomness and seekability are the two requirements, and a simulation cannot
   have both: steering, boids, or a state machine with random timers all
   accumulate state per frame, so the tour recorder's seek would land the cows
   somewhere else than the playthrough did.

   The way out is to stop simulating randomness and start LOOKING IT UP. A cow's
   plan at time t is a function of hash(seed, floor(t / HERD_SLOT)) — an O(1)
   query that answers identically every time it is asked, yet reads as nothing
   like a pattern as t runs forward. The price is that cows cannot react to each
   other (that needs state); with six animals in one paddock, separate home
   ranges buy more than avoidance would. */

export const HERD_SLOT = 11.0;   // seconds per decision

/* Where this cow decides to be after decision n.

   vnoise is SMOOTH in its arguments, so consecutive decisions land NEAR each
   other — a few steps between bites, which is what grazing cattle actually do —
   while the low-frequency drift still walks the animal across its range over a
   couple of minutes. Sampling the pen uniformly per slot would instead send it
   sprinting corner to corner forever, which is the animatronic read this whole
   rewrite exists to kill. */
export function herdWaypoint(spec, n, out = {}) {
  const u = vnoise(spec.seed * 0.7 + n * 0.34, spec.seed * 1.9);
  const v = vnoise(spec.seed * 1.3, spec.seed * 0.5 + n * 0.29);
  out.x = spec.x0 + (spec.x1 - spec.x0) * penFit(u);
  out.z = spec.z0 + (spec.z1 - spec.z0) * penFit(v);
  return out;
}

/* Stretch the noise to use the pen, but SATURATE SMOOTHLY instead of clamping.

   The clamp this replaces pinned 44.7% of waypoints to a pen edge, and when two
   consecutive decisions pinned to the same edge the hop was EXACTLY zero — 2.07%
   of all hops. A zero hop means atan2(0, 0), which is 0, so the cow snapped to
   face +Z having travelled nowhere: the purest possible form of "limbs still,
   body turning". tanh reaches 0.027..0.973 of the span, so it covers the pen
   just as well while never producing two identical waypoints. */
function penFit(u) {
  return 0.5 + 0.5 * Math.tanh((u - 0.5) * 3.6);
}

/* Fraction of a slot spent walking; the rest is spent head-down. Biased low on
   purpose — a herd that is always in transit reads as a screensaver. */
export function herdTravelFrac(spec, n) {
  return 0.30 + 0.34 * hash2(spec.seed + 5171, n);
}

/* How far the head goes down this slot. Some slots the cow just stands and
   looks around, which is the beat that makes the others read as grazing. */
export function herdGrazeDepth(spec, n) {
  const u = hash2(spec.seed + 31, n);
  return u < 0.26 ? 0.12 * u / 0.26 : 0.45 + 0.55 * ((u - 0.26) / 0.74);
}

/* Ground speed at which the walk clip reaches full weight.

   This is the leg/body contract, not a taste knob. The crossfade applies only
   `w` of the clip's foot motion, so the feet counter the body by w·v while the
   body actually travels v — every bit of (1−w)·v is ground the legs never paid
   for, which is precisely the "limbs still, body sliding" read.

   The first pass used 0.55, picked to look like a brisk walk. But the schedule's
   own speeds sit far below that: over 800 slots the median PEAK speed is 0.443
   and only 41% of slots reach 0.55 at all, so the walk clip topped out at weight
   0.81 in a MEDIAN slot and 19.7% of all ground the herd covered was unpaid
   glide. Putting the reference under the measured distribution drops that to
   1.5%, and the blend still takes ~0.4 s at a median pace — an ordinary
   animation crossfade, not a snap. */
const GRAZE_WALK_REF = 0.12;

const wrapPi = (a) => a - TAU * Math.round(a / TAU);
const _w1 = {}, _w2 = {}, _wa = {}, _wb = {};

/* Heading comes from a weighted sum of the last few hops, never from the single
   hop the cow happens to be on.

   One hop is a poor heading source precisely because the hops are short by
   design: their direction is noisy, and 3.2% of slots demanded more than a
   radian of turn for under 0.15 units of travel — a body pivoting on planted
   feet. Summing the recent hops keeps the animal pointed where it has actually
   been going, and unlike a single hop the sum cannot collapse to zero. */
const DIR_WEIGHTS = [1, 0.55, 0.3, 0.16];
function baselineDir(spec, n) {
  let sx = 0, sz = 0;
  for (let j = 0; j < DIR_WEIGHTS.length; j++) {
    herdWaypoint(spec, n - j - 1, _wa);
    herdWaypoint(spec, n - j, _wb);
    sx += (_wb.x - _wa.x) * DIR_WEIGHTS[j];
    sz += (_wb.z - _wa.z) * DIR_WEIGHTS[j];
  }
  return Math.atan2(sx, sz);
}

/* Everything the renderer needs about one cow at time t, in closed form. */
export function herdPoseAt(spec, t, out = {}) {
  const s = Math.max(0, t) / HERD_SLOT;
  const n = Math.floor(s);
  const f = s - n;
  herdWaypoint(spec, n - 1, _w1);
  herdWaypoint(spec, n, _w2);
  const tf = herdTravelFrac(spec, n);
  const k = f < tf ? f / tf : 1;
  const e = k * k * (3 - 2 * k);
  const dx = _w2.x - _w1.x, dz = _w2.z - _w1.z;
  const len = Math.hypot(dx, dz);
  out.x = _w1.x + dx * e;
  out.z = _w1.z + dz * e;
  /* distance WITHIN this slot; it resets at the seam, which is safe only
     because speed is 0 on both sides of the seam (asserted in the tests) —
     the walk clip is faded out there, so the phase reset is unobservable */
  out.dist = len * e;
  /* d(smoothstep)/dk = 6k(1−k), scaled into units per second */
  out.speed = f < tf ? len * 6 * k * (1 - k) / (tf * HERD_SLOT) : 0;
  /* how much of the walk clip the renderer blends in — kept HERE rather than at
     the call site so the tests measure the same leg/body relationship the
     renderer applies, instead of a restatement of it that can drift */
  out.walkWeight = clamp(out.speed / GRAZE_WALK_REF, 0, 1);
  const hPrev = baselineDir(spec, n - 1);
  const hCur = baselineDir(spec, n);
  /* The turn rides `e` — the SAME eased curve that moves the body — so rotation
     is paid for by ground covered exactly as translation is. The earlier version
     front-loaded the whole turn into the first 30% of the walk, where the body
     has barely started moving, which is how the animal ended up coming about on
     legs that were still fading in.

     Continuous across the seam by construction: e reaches 1, so slot n ends on
     baselineDir(n), which is what slot n+1 starts from.

     This is the ONLY thing that may turn the body. A body that rotates while the
     walk clip is faded out reads as drift exactly as loudly as one that slides,
     so the grazing look-around lives on the neck (see GRAZE_SCAN_YAW), not here. */
  out.heading = hPrev + wrapPi(hCur - hPrev) * e;
  out.grazeDepth = herdGrazeDepth(spec, n);
  return out;
}

/* ∫|dU/dp| for laneU, in whole traverses. Closed form for both terms, and the
   triangle's |du/dp| is the constant 1/π, so each half-period still contributes
   exactly one crossing however the mix is set. */
export function laneArc(p) {
  const k = Math.floor(p / Math.PI);
  const cos = 0.5 * (2 * k + 1 - Math.cos(p - k * Math.PI));
  return (1 - LANE_EASE) * cos + LANE_EASE * (p / Math.PI);
}

export function setGait(mixer, dur, dist) {
  const loops = dist / HERD_STRIDE;
  mixer.setTime((loops - Math.floor(loops)) * dur);
}

/* Measured off the rig: neck.rotation.x −1.35 drops the muzzle to y≈0.36 and
   pushes it forward, which is the grazing reach. Going further curls the head
   under rather than lowering it, and pitching the Head bone as well makes it
   worse — so the neck does all the work. */
const GRAZE_NECK = -1.35;
const GRAZE_CHEW = 0.07;
/* A grazing cow reaches new grass with its NECK; its body stays planted.

   This sweep used to ride cow.rotation.y, which meant the body swung ±0.26 rad
   with the walk clip at zero weight — 60% of the herd's time was spent turning
   on frozen legs, and rotation with planted feet reads as drift just as loudly
   as sliding does. On the neck it keeps the life and leaves the body genuinely
   still: the body only turns while the animal is stepping.

   neck.rotation.y is the clean yaw axis — measured, ±0.5 rad swings the muzzle
   ±0.24 units sideways while holding its height, where rotation.z drops it. */
const GRAZE_SCAN_YAW = 0.45;
const _pose = {};

/* ---------- deterministic value noise ---------- */

function hash2(ix, iz) {
  let h = (ix * 374761393 + iz * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

/* Flat pads under stations + barn + herd paddock so exhibits sit level. */
const PADS = [
  ...STATIONS.map((s) => ({ x: s.pos.x, z: s.pos.z, r: 9 })),
  { x: -24, z: -40, r: 13 },  // barn
  { x: -40, z: 2, r: 13 },    // paddock
  { x: -40, z: 14, r: 9 }     // Station 08 northbound factory line
];

export function groundHeight(x, z) {
  let h = (vnoise(x * 0.045, z * 0.045) - 0.5) * 2.4 +
          (vnoise(x * 0.16 + 7.3, z * 0.16 + 3.1) - 0.5) * 0.7;
  let f = 1;
  for (const p of PADS) {
    const d = Math.hypot(x - p.x, z - p.z) - p.r;
    const k = d <= 0 ? 0 : Math.min(1, d / 8);
    f = Math.min(f, k * k * (3 - 2 * k));
  }
  return h * f;
}

/* ---------- terrain ---------- */

function buildTerrain() {
  const geo = new THREE.PlaneGeometry(160, 160, 96, 96);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const cA = new THREE.Color(0x2d4030), cB = new THREE.Color(0x4d5e41);
  const tmp = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const h = groundHeight(x, z);
    pos.setY(i, h);
    const n = vnoise(x * 0.11 + 31, z * 0.11 + 17);
    tmp.copy(cA).lerp(cB, Math.min(1, n * 0.8 + h * 0.28 + 0.15));
    colors[i * 3] = tmp.r; colors[i * 3 + 1] = tmp.g; colors[i * 3 + 2] = tmp.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, flatShading: true, roughness: 1, metalness: 0
  });
  return new THREE.Mesh(geo, mat);
}

/* ---------- dawn sky dome (horizon amber glow + baked sun disc) ---------- */

/* sun at ~15° elevation — early dawn, decisively above the horizon */
const SUN_EL = 0.262;
const SUN_DIR = new THREE.Vector3(Math.cos(0.6) * Math.cos(SUN_EL), Math.sin(SUN_EL), Math.sin(0.6) * Math.cos(SUN_EL)).normalize();

function buildSky() {
  const geo = new THREE.SphereGeometry(230, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { uSunDir: { value: SUN_DIR } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDir;
      varying vec3 vDir;
      void main() {
        vec3 zenith = vec3(0.10, 0.16, 0.30);             // deep dawn blue
        vec3 horizon = vec3(0.60, 0.46, 0.30);            // warm bright band
        vec3 amber = vec3(0.95, 0.66, 0.26);
        float hz = pow(1.0 - clamp(vDir.y, 0.0, 1.0), 2.6);
        vec3 col = mix(zenith, horizon, hz);
        float d = max(dot(normalize(vDir), uSunDir), 0.0);
        col += amber * pow(d, 5.0) * 0.28 * hz;           // wide horizon wash
        col += amber * pow(d, 70.0) * 0.45;               // near-sun glow
        col += vec3(1.0, 0.85, 0.55) * smoothstep(0.9992, 0.9996, d); // disc
        gl_FragColor = vec4(col, 1.0);
      }
    `
  });
  return new THREE.Mesh(geo, mat);
}

/* ---------- instanced grass + drifting fireflies ---------- */

function buildGrass() {
  const geo = new THREE.ConeGeometry(0.05, 0.4, 4);
  geo.translate(0, 0.2, 0);
  const mat = new THREE.MeshStandardMaterial({ color: 0x3a5233, roughness: 1, flatShading: true });
  const n = 700;
  const mesh = new THREE.InstancedMesh(geo, mat, n);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < n; i++) {
    const a = hash2(i, 11) * Math.PI * 2;
    const r = 6 + Math.sqrt(hash2(i, 23)) * 66;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    q.setFromAxisAngle(up, hash2(i, 37) * Math.PI);
    const sc = 0.7 + hash2(i, 53) * 1.5;
    s.set(sc, sc * (0.7 + hash2(i, 71)), sc);
    m.compose(new THREE.Vector3(x, groundHeight(x, z), z), q, s);
    mesh.setMatrixAt(i, m);
  }
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

function buildFireflies() {
  const n = 140;
  const pos = new Float32Array(n * 3);
  const phase = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const st = STATIONS[i % STATIONS.length].pos;
    pos[i * 3] = st.x + (hash2(i, 3) - 0.5) * 22;
    pos[i * 3 + 1] = 0.6 + hash2(i, 5) * 2.6;
    pos[i * 3 + 2] = st.z + (hash2(i, 7) - 0.5) * 22;
    phase[i] = hash2(i, 9) * Math.PI * 2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aPhase", new THREE.BufferAttribute(phase, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute float aPhase;
      uniform float uTime;
      varying float vA;
      void main() {
        vec3 p = position;
        p.x += sin(uTime * 0.21 + aPhase * 1.7) * 1.2;
        p.y += sin(uTime * 0.6 + aPhase) * 0.45;
        p.z += cos(uTime * 0.17 + aPhase * 2.3) * 1.2;
        vA = 0.35 + 0.65 * (0.5 + 0.5 * sin(uTime * 1.4 + aPhase * 3.0));
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = 42.0 / -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vA;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float d = dot(c, c);
        if (d > 0.25) discard;
        gl_FragColor = vec4(0.89, 0.61, 0.18, vA * (1.0 - d * 4.0));
      }
    `
  });
  return new THREE.Points(geo, mat);
}

/* ---------- glowing rail path ribbon (ground projection of the tour) ---------- */

function buildPathRibbon() {
  const curve = new THREE.CatmullRomCurve3(
    STATIONS.map((s) => new THREE.Vector3(s.pos.x, 0, s.pos.z)),
    false, "centripetal", 0.5);

  /* curve param at each station (centripetal params are not uniform) */
  const probe = new THREE.Vector3();
  const stT = STATIONS.map((s) => {
    let best = 0, bd = Infinity;
    for (let i = 0; i <= 600; i++) {
      const u = i / 600;
      curve.getPoint(u, probe);
      const d = (probe.x - s.pos.x) ** 2 + (probe.z - s.pos.z) ** 2;
      if (d < bd) { bd = d; best = u; }
    }
    return best;
  });

  const SEG = 360, W = 1.15;
  const positions = new Float32Array((SEG + 1) * 2 * 3);
  const aT = new Float32Array((SEG + 1) * 2);
  const aSide = new Float32Array((SEG + 1) * 2);
  const idx = [];
  const p = new THREE.Vector3(), tan = new THREE.Vector3(), side = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i <= SEG; i++) {
    const u = i / SEG;
    curve.getPoint(u, p);
    curve.getTangent(u, tan);
    side.crossVectors(up, tan).normalize();
    for (let k = 0; k < 2; k++) {
      const sgn = k === 0 ? -1 : 1;
      const x = p.x + side.x * sgn * W, z = p.z + side.z * sgn * W;
      const j = i * 2 + k;
      /* +0.32: the analytic height can dip below the coarse terrain mesh */
      positions[j * 3] = x;
      positions[j * 3 + 1] = groundHeight(x, z) + 0.32;
      positions[j * 3 + 2] = z;
      aT[j] = u;
      aSide[j] = sgn;
    }
    if (i < SEG) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("aT", new THREE.BufferAttribute(aT, 1));
  geo.setAttribute("aSide", new THREE.BufferAttribute(aSide, 1));
  geo.setIndex(idx);

  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uLeg: { value: new THREE.Vector2(-2, -1) }  // active leg t-range, none by default
    },
    vertexShader: /* glsl */ `
      attribute float aT;
      attribute float aSide;
      varying float vT;
      varying float vSide;
      void main() {
        vT = aT;
        vSide = aSide;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec2 uLeg;
      varying float vT;
      varying float vSide;
      void main() {
        float edge = 1.0 - abs(vSide);                       // soft ribbon edges
        /* chevrons flowing in tour order (V-shape via |side| offset) */
        float c = fract(vT * 90.0 - uTime * 0.45 + abs(vSide) * 0.32);
        float chev = smoothstep(0.02, 0.16, c) * smoothstep(0.52, 0.36, c);
        float act = step(uLeg.x - 0.002, vT) * step(vT, uLeg.y + 0.002);
        vec3 amber = vec3(0.89, 0.61, 0.18);
        float glow = (0.55 + 1.1 * chev) * mix(0.6, 1.9, act);
        float a = edge * (0.5 + 0.5 * chev) * mix(0.55, 1.0, act);
        gl_FragColor = vec4(amber * glow, a);
      }
    `
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 1;

  return {
    mesh,
    setLeg(i) {
      if (i != null && i >= 0 && i < STATIONS.length - 1) {
        mat.uniforms.uLeg.value.set(stT[i], stT[i + 1]);
      } else {
        mat.uniforms.uLeg.value.set(-2, -1);
      }
    },
    tick(t) { mat.uniforms.uTime.value = t; }
  };
}

/* ---------- GLB prop helpers ---------- */

function loadGLB(loader, url) {
  return new Promise((res, rej) => loader.load(url, res, undefined, rej));
}

function fitHeight(obj, h) {
  const bb = new THREE.Box3().setFromObject(obj);
  const s = h / Math.max(bb.max.y - bb.min.y, 1e-6);
  obj.scale.setScalar(s);
  return obj;
}

/* Rest an object on the terrain at (x,z). */
function settle(obj, x, z, ry = 0) {
  obj.position.set(x, 0, z);
  obj.rotation.y = ry;
  obj.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(obj);
  obj.position.y += groundHeight(x, z) - bb.min.y;
  return obj;
}

function liftMaterials(root, amount = 0.05) {
  root.traverse((o) => {
    if (o.isMesh && o.material && o.material.emissive) {
      o.material = o.material.clone();
      o.material.emissive.setScalar(amount);
    }
  });
}

/* ---------- build ---------- */

export async function buildEnvironment(scene, loader, onNote = () => {}) {
  scene.background = new THREE.Color(FOG);
  scene.fog = new THREE.Fog(FOG, 48, 165);

  /* dawn lights: warm key at ~15° + generous cool-blue sky fill */
  const key = new THREE.DirectionalLight(0xf2b458, 4.0);
  key.position.copy(SUN_DIR).multiplyScalar(110);
  scene.add(key, key.target);
  scene.add(new THREE.HemisphereLight(0xbcd7e8, 0x33402e, 1.35));
  scene.add(new THREE.AmbientLight(0x46505e, 0.85));

  scene.add(buildSky());
  scene.add(buildTerrain());
  scene.add(buildGrass());
  const fireflies = buildFireflies();
  scene.add(fireflies);
  const ribbon = buildPathRibbon();
  scene.add(ribbon.mesh);

  /* Solid ground-plane props the roaming calf must not walk through. Only
     things you could shoulder-check are registered — the exhibits stay
     walk-through on purpose, since half of them are holograms and all of them
     are places the calf is meant to stand. */
  const colliders = createColliderSet();

  /* ---- props ---- */
  const P = "assets/world/";
  onNote("STAGING PROPS · 0.7 MB");
  const [barnG, fenceG, hayG, pineG, cowBuf] = await Promise.all([
    loadGLB(loader, P + "barn_big_quaternius.glb"),
    loadGLB(loader, P + "fence_quaternius.glb"),
    loadGLB(loader, P + "hay_quaternius.glb"),
    loadGLB(loader, P + "pinetree_quaternius.glb"),
    fetch(P + "cow_quaternius.glb").then((r) => {
      if (!r.ok) throw new Error(`cow glb → HTTP ${r.status}`);
      return r.arrayBuffer();
    })
  ]);

  /* barn near S6 */
  const barn = fitHeight(barnG.scene, 8.5);
  liftMaterials(barn, 0.04);
  settle(barn, -24, -40, 0.75);
  scene.add(barn);
  {
    /* footprint measured off the placed model rather than guessed. The world
       AABB is a little larger than the yawed barn, and deliberately so: solving
       back to the barn's own axes is singular near 45° (it sits at 43°), and a
       slightly generous hull around a building nobody should touch is free. */
    const bb = new THREE.Box3().setFromObject(barn);
    const half = bb.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    const mid = bb.getCenter(new THREE.Vector3());
    colliders.addBox(mid.x, mid.z, half.x, half.z);
  }

  /* fence template — normalize so its long axis is local X */
  const FENCE_TOP = 1.1;   // also the collision ceiling: jumpable by design
  const fenceProto = new THREE.Group();
  {
    const f = fitHeight(fenceG.scene, FENCE_TOP);
    const bb = new THREE.Box3().setFromObject(f);
    const size = bb.getSize(new THREE.Vector3());
    if (size.z > size.x) f.rotation.y = Math.PI / 2;
    fenceProto.add(f);
  }
  const fenceLen = (() => {
    const bb = new THREE.Box3().setFromObject(fenceProto);
    return Math.max(bb.max.x - bb.min.x, 0.8);
  })();

  /* fences render as InstancedMesh (one draw call per template mesh) —
     fenceLine only records placements, instanceTemplate bakes them below */
  const fencePlacements = [];
  function fenceLine(x0, z0, x1, z1) {
    const dx = x1 - x0, dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    const n = Math.max(1, Math.round(len / fenceLen));
    const ry = Math.atan2(-dz, dx);
    for (let i = 0; i < n; i++) {
      const k = (i + 0.5) / n;
      fencePlacements.push({ x: x0 + dx * k, z: z0 + dz * k, ry });
    }
    /* one collider per RUN, not per rendered instance: a roaming calf only
       needs the wall, and 18 boxes beat 80. FENCE_TOP is the fitHeight above
       local ground, so a calf at the top of its jump arc clears it. */
    colliders.addSegment(x0, z0, x1, z1, 0.2, FENCE_TOP);
  }

  /* herd paddock split into two holding areas with a short walk-through lane. */
  const PAD = { x: -40, z: 2, w: 20, d: 15 };
  const S1 = STATIONS[1].pos;   // CAPTURE pen (station 0 is the gate)
  const PAD_X0 = PAD.x - PAD.w / 2, PAD_X1 = PAD.x + PAD.w / 2;
  const PAD_Z0 = PAD.z - PAD.d / 2, PAD_Z1 = PAD.z + PAD.d / 2;
  const LANE = {
    x0: PAD.x - 2.2,
    x1: PAD.x + 2.2,
    z0: PAD.z - 2.2,
    z1: PAD.z + 2.2
  };

  /* Gate openings. Station 01 sits inside its capture pen, while the herd
     paddock still needs a real exit for the guide calf and lane animal. Both
     gaps are wide enough for the calf's 0.8 u hull with room to spare, and
     stationApproach() below steers auto-runs through them. Station 08 now sits
     outside to the north-east, reached without entering the paddock. */
  const GATE = 1.9;                     // half-width of an opening
  const PEN_GATE = { x: S1.x - 4, z: S1.z };        // capture pen, facing the ranch gate
  const PADDOCK_GATE = { x: PAD_X1, z: PAD.z };     // paddock, on the weigh-lane axis

  fenceLine(PAD_X0, PAD_Z0, LANE.x0, PAD_Z0);
  fenceLine(LANE.x0, PAD_Z0, LANE.x1, PAD_Z0);
  fenceLine(PAD_X0, PAD_Z1, LANE.x0, PAD_Z1);
  fenceLine(LANE.x0, PAD_Z1, LANE.x1, PAD_Z1);
  fenceLine(PAD_X0, PAD_Z0, PAD_X0, PAD_Z1);
  fenceLine(LANE.x0, PAD_Z0, LANE.x0, LANE.z0);
  fenceLine(LANE.x0, LANE.z1, LANE.x0, PAD_Z1);

  fenceLine(LANE.x1, PAD_Z0, PAD_X1, PAD_Z0);
  fenceLine(LANE.x1, PAD_Z1, PAD_X1, PAD_Z1);
  /* east side, split around the paddock gate — it lines up with the weigh lane
     so walking in IS walking the lane the future gate would meter */
  fenceLine(PAD_X1, PAD_Z0, PAD_X1, PADDOCK_GATE.z - GATE);
  fenceLine(PAD_X1, PADDOCK_GATE.z + GATE, PAD_X1, PAD_Z1);
  fenceLine(LANE.x1, PAD_Z0, LANE.x1, LANE.z0);
  fenceLine(LANE.x1, LANE.z1, LANE.x1, PAD_Z1);

  fenceLine(LANE.x0, LANE.z0, LANE.x1, LANE.z0);
  fenceLine(LANE.x0, LANE.z1, LANE.x1, LANE.z1);

  fenceLine(S1.x - 4, S1.z - 4, S1.x + 4, S1.z - 4);
  fenceLine(S1.x - 4, S1.z + 4, S1.x + 4, S1.z + 4);
  /* west side, split around the pen gate — the side the amber path arrives on */
  fenceLine(S1.x - 4, S1.z - 4, S1.x - 4, PEN_GATE.z - GATE);
  fenceLine(S1.x - 4, PEN_GATE.z + GATE, S1.x - 4, S1.z + 4);
  fenceLine(S1.x + 4, S1.z - 4, S1.x + 4, S1.z + 4);

  const laneMat = new THREE.MeshStandardMaterial({ color: 0x2b3227, roughness: 0.95 });
  const laneBed = new THREE.Mesh(
    new THREE.BoxGeometry(LANE.x1 - LANE.x0, 0.045, LANE.z1 - LANE.z0 - 0.55),
    laneMat
  );
  laneBed.position.set(PAD.x, groundHeight(PAD.x, PAD.z) + 0.035, PAD.z);
  scene.add(laneBed);

  /* future weight-estimation gate: left, right, and overhead cameras over the lane. */
  const rigX = PAD.x;
  const rigZ = PAD.z;
  const rigMastMat = new THREE.MeshStandardMaterial({ color: 0x1b222a, roughness: 0.72, metalness: 0.25 });
  const rigAccentMat = new THREE.MeshStandardMaterial({ color: 0x11151a, emissive: 0x86d7ea, emissiveIntensity: 0.28, roughness: 0.48 });
  /* dark glass at rest, but it needs an emissive channel to have something to
     flash — the shutter burst below drives this one intensity for all three */
  const lensMat = new THREE.MeshStandardMaterial({
    color: 0x05070a, roughness: 0.35, metalness: 0.2,
    emissive: ICE, emissiveIntensity: 0.18
  });
  const rigLenses = [];
  for (const z of [LANE.z0 - 0.55, LANE.z1 + 0.55]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 3.25, 10), rigMastMat);
    post.position.set(rigX, groundHeight(rigX, z) + 1.62, z);
    scene.add(post);
    colliders.addCircle(rigX, z, 0.22);   // too tall to hop, thin enough to skirt
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.16, LANE.z1 - LANE.z0 + 1.55), rigMastMat);
  beam.position.set(rigX, groundHeight(rigX, rigZ) + 3.25, rigZ);
  scene.add(beam);
  const cattleAim = new THREE.Vector3(
    rigX, groundHeight(rigX, rigZ) + 1.15, rigZ);
  for (const spec of FUTURE_RIG_CAPTURE_POINTS.slice(0, 2)) {
    const cam = new THREE.Group();
    cam.name = `futureRigCamera-${spec.id}`;
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.28, 0.32), rigAccentMat);
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.14, 0.2, 16), lensMat);
    lens.rotation.x = Math.PI / 2;
    /* Camera groups aim local +Z at the animal; keep every lens on +Z so the
       north camera cannot accidentally point out of the gantry again. */
    lens.position.z = 0.34;
    cam.add(body, lens);
    rigLenses.push(lens);
    cam.position.set(spec.x, spec.y, spec.z);
    cam.lookAt(cattleAim);
    scene.add(cam);
  }
  {
    const spec = FUTURE_RIG_CAPTURE_POINTS[2];
    const cam = new THREE.Group();
    cam.name = `futureRigCamera-${spec.id}`;
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.24, 0.42), rigAccentMat);
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 0.22, 16), lensMat);
    lens.rotation.x = Math.PI / 2;
    lens.position.z = 0.3;
    cam.add(body, lens);
    rigLenses.push(lens);
    cam.position.set(spec.x, spec.y, spec.z);
    /* Tiny z offset avoids the straight-down lookAt singularity while keeping
       the top camera visibly aimed at the lane centre. */
    cam.lookAt(cattleAim.clone().add(new THREE.Vector3(0, 0, 0.12)));
    scene.add(cam);
  }

  /* Same shutter burst as station 01's research gantry — the two rigs are meant
     to rhyme, and the weigh gate is the one an animal is supposed to walk
     through. Its footprint is the lane bed, tested in world space because this
     rig is built in world space rather than inside a station group. */
  const rigFlash = createCameraFlash({
    lensMaterial: lensMat,
    lenses: rigLenses,
    glow: 1.05,
    contains: (subject) =>
      /* fire at the optical centre, not across almost the entire lane */
      Math.abs(subject.x - rigX) < 0.55
      && subject.z > LANE.z0 - 0.9 && subject.z < LANE.z1 + 0.9
  });

  const rigSign = (() => {
    const c = document.createElement("canvas");
    c.width = 520; c.height = 96;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#0c0f13";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.strokeStyle = "#86d7ea";
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, c.width - 4, c.height - 4);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#86d7ea";
    ctx.font = "500 32px 'IBM Plex Mono', monospace";
    ctx.fillText("FUTURE RGB WEIGH GATE", c.width / 2, c.height / 2 + 1);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(2.8, 0.52),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true })
    );
    sign.position.set(rigX, groundHeight(rigX, rigZ) + 3.62, LANE.z1 + 0.4);
    sign.rotation.x = -0.1;
    return sign;
  })();
  scene.add(rigSign);

  /* path-side accents */
  fenceLine(-22, 28, -14, 22);
  fenceLine(2, 22, 8, 26);
  fenceLine(22, -2, 26, -8);

  /* fence wings flanking the ranch gate (station 0), along the arch line */
  fenceLine(-46.1, 45.3, -42.5, 51.6);
  fenceLine(-49.9, 38.7, -53.5, 32.4);

  /* bake every recorded fence placement into instanced meshes */
  scene.add(instanceTemplate(fenceProto, fencePlacements, groundHeight));

  /* pines ring the world edge, away from stations — instanced like the fences */
  const pineBB = new THREE.Box3().setFromObject(pineG.scene);
  const pineProtoH = Math.max(pineBB.max.y - pineBB.min.y, 1e-6);
  const pinePlacements = [];
  for (let i = 0; i < 30; i++) {
    const a = (i / 30) * Math.PI * 2 + hash2(i, 91) * 0.3;
    const r = 56 + hash2(i, 97) * 22;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (STATIONS.some((s) => Math.hypot(x - s.pos.x, z - s.pos.z) < 15)) continue;
    pinePlacements.push({
      x, z,
      ry: hash2(i, 103) * Math.PI * 2,
      scale: (6 + hash2(i, 101) * 5) / pineProtoH
    });
  }
  scene.add(instanceTemplate(pineG.scene, pinePlacements, groundHeight));

  /* hay bales */
  /* Keep the south bale clear of the widened 06→07 guide ribbon. */
  [[-20, 40], [-2, 14], [20, 20], [26, -14], [15, -66], [-32, -12]].forEach(([x, z], i) => {
    const h = 1.1 + hash2(i, 113) * 0.3;
    const hay = fitHeight(hayG.scene.clone(true), h);
    settle(hay, x, z, hash2(i, 127) * Math.PI);
    scene.add(hay);
    colliders.addCircle(x, z, 0.95, h);   // round bale: a circle is the true shape
  });

  /* ---- ambient herd (one rigged cow, cloned five times) ----
     Object3D.clone() leaves every SkinnedMesh bound to the ORIGINAL skeleton,
     so the copies would collapse onto the source's pose; SkeletonUtils.clone()
     rebinds each clone to its own bones. That is the only reason this used to
     re-parse the 331 KB GLB six times (six buffer copies, six texture/material
     sets, ~6× the decode). One parse now, five clones. */
  onNote("WAKING THE HERD");
  const pickClip = (anims, name) =>
    anims.find((c) => c.name.toLowerCase() === name.toLowerCase()) ||
    anims.find((c) => c.name.toLowerCase().includes(name.toLowerCase())) ||
    anims[0];

  const cows = [];
  /* the player calf's copy of this same rig, handed out below */
  let cowAsset = null;
  /* The two holding areas the fences already divide the paddock into. Cows
     graze inside one of them for good: the herd has no collision, so keeping
     each animal in its own fenced half is what stops it walking through a rail
     — cheaper and more reliable than teaching six cows to avoid geometry. */
  /* The deployment conveyor is outside the north fence, so the west grazers can
     once again use their full holding area without crossing any machinery. */
  const GRAZE_W = { x0: PAD_X0 + 1.7, x1: LANE.x0 - 1.4, z0: PAD_Z0 + 1.7, z1: PAD_Z1 - 1.7 };
  const GRAZE_E = { x0: LANE.x1 + 1.4, x1: PAD_X1 - 1.7, z0: PAD_Z0 + 1.7, z1: PAD_Z1 - 1.7 };
  const HERD = [
    /* `t0` desynchronises the decision slots: without it all four cows would
       set off at the same instant, which reads as choreography, not a herd. */
    { kind: "graze", ...GRAZE_W, seed: 17, t0: 0.0 },
    { kind: "graze", ...GRAZE_W, seed: 8231, t0: 4.1 },
    { kind: "graze", ...GRAZE_E, seed: 4409, t0: 7.3 },
    { kind: "graze", ...GRAZE_E, seed: 60127, t0: 2.6 },
    /* these two have jobs: the lane cow trips the station-08 weigh gate, and
       the pen cow is the subject of the station-01 capture exhibit */
    { kind: "lane", x0: LANE.x0 + 0.65, x1: LANE.x1 - 0.65, z: PAD.z, speed: 0.28, phase: 0.35 },
    { kind: "pen",  x: S1.x + 0.4, z: S1.z - 0.3, ry: 2.2 }
  ];
  try {
    /* single parse — nothing else reads cowBuf, so no defensive .slice() copy */
    const cowGltf = await new Promise((res, rej) => loader.parse(cowBuf, P, res, rej));
    /* The player calf rides this same rig, so hand it a copy HERE — before the
       herd's fit and material lift mutate the source. Taking it later would
       ship the calf a pre-scaled scene, and glb-cattle's own fit REPLACES
       scale rather than composing with it, so the calf would come out at
       height/1.45 of what it asked for. One 324 KB parse feeds both. */
    cowAsset = { scene: cloneSkinned(cowGltf.scene), animations: cowGltf.animations };
    /* Fit and lift the emissive ONCE, on the source: liftMaterials clones the
       material it touches, so doing it before the copies makes the whole herd
       one material set (and one program) instead of six. */
    const cowProto = fitHeight(cowGltf.scene, 1.45);
    liftMaterials(cowProto, 0.05);
    /* Clone up front, while the source is still a bare cow — it becomes herd
       member 0 and picks up a blob-shadow child below, which a later clone()
       would happily drag along. */
    const bodies = HERD.map((_, i) => (i === 0 ? cowProto : cloneSkinned(cowProto)));

    /* One geometry + one material + one 64² ramp behind all six discs. The
       ambient herd never fades or resizes its shadow (only the player calf
       does, mid-jump), so per-cow copies would be six uploads of identical
       pixels; Mesh.clone() shares both by reference. */
    const blobProto = createBlobShadow(0.9, 0.35);

    for (const [i, spec] of HERD.entries()) {
      const cow = bodies[i];
      /* One mixer per cow, all six reading the same clip object: a clip is
         immutable keyframe data, and each mixer resolves its bindings against
         its own root, so update() below can still give every cow its own time
         and speed. */
      const mixer = new THREE.AnimationMixer(cow);
      const entry = { cow, mixer, spec };
      if (spec.kind === "graze") {
        /* Two actions blended by speed rather than one clip stepped by hand.
           The blend is what lets the walk phase reset at each decision seam
           without anyone seeing it: the walk action's weight is 0 there. */
        const walkClip = pickClip(cowGltf.animations, "Walk");
        const idleClip = pickClip(cowGltf.animations, "Idle");
        entry.walk = mixer.clipAction(walkClip);
        entry.idle = mixer.clipAction(idleClip);
        entry.walk.play();
        entry.idle.play();
        entry.walkDur = walkClip.duration;
        entry.idleDur = idleClip.duration;
        entry.neck = cow.getObjectByName("Neck");
        const start = herdWaypoint(spec, -1);
        settle(cow, start.x, start.z, 0);
        /* keep the settle offset so the cow rides the terrain as it wanders */
        entry.yOff = cow.position.y - groundHeight(start.x, start.z);
      } else {
        const clip = pickClip(cowGltf.animations, spec.kind === "lane" ? "Walk" : "Idle");
        if (clip) mixer.clipAction(clip).play();
        entry.dur = clip ? clip.duration : 1;
        if (spec.kind === "lane") {
          spec.len = Math.abs(spec.x1 - spec.x0);
          spec.s0 = laneArc(spec.phase * TAU);
          settle(cow, spec.x0, spec.z, Math.PI / 2);
        } else {
          settle(cow, spec.x, spec.z, spec.ry);
        }
      }
      /* soft blob shadow */
      const blob = blobProto.clone();
      cow.add(blob);
      blob.position.y = 0.02 - cow.position.y + groundHeight(cow.position.x, cow.position.z);
      scene.add(cow);
      cows.push(entry);
    }
  } catch (err) {
    console.warn("herd unavailable:", err);
  }

  /* the herd cow that walks the weigh lane — it trips the gate exactly the way
     the exhibit says a real animal would, without anyone driving it */
  const laneCow = cows.find((c) => c.spec.kind === "lane") || null;

  /* animate: pure function of worldTime → deterministic under seeking.
     `subject` is the driven calf's world position, or null outside roam. */
  function update(t, subject = null) {
    fireflies.material.uniforms.uTime.value = t;
    ribbon.tick(t);
    for (const entry of cows) {
      const { cow, mixer, spec, dur } = entry;
      const phase = spec.phase || 0;
      if (spec.kind === "graze") {
        herdPoseAt(spec, t + spec.t0, _pose);
        cow.position.x = _pose.x;
        cow.position.z = _pose.z;
        cow.position.y = groundHeight(_pose.x, _pose.z) + entry.yOff;
        /* walk/idle crossfade driven by real speed, so the legs come up as the
           animal sets off and settle as it arrives */
        const w = _pose.walkWeight;
        entry.walk.setEffectiveWeight(w);
        entry.idle.setEffectiveWeight(1 - w);
        entry.walk.time = ((_pose.dist / HERD_STRIDE) % 1) * entry.walkDur;
        entry.idle.time = (t * 0.31 + spec.t0) % entry.idleDur;
        /* dt of 0: the clip times are authored above, the mixer only applies
           them. Stepping the mixer instead would reintroduce the accumulated
           state this whole design exists to avoid. */
        mixer.update(0);
        /* head down to the grass, and the slow look-around — AFTER the clips
           have written the bones, so the offsets ride on top of the breathing
           idle instead of fighting it. Both live on the neck: the body must not
           move at all while the legs are faded out. */
        if (entry.neck) {
          const g = (1 - w) * _pose.grazeDepth;
          entry.neck.rotation.x += GRAZE_NECK * g
            + GRAZE_CHEW * g * Math.sin(t * 3.9 + spec.seed);
          /* gated on (1−w), not on g: a cow standing head-up in a shallow slot
             should still be looking around */
          entry.neck.rotation.y +=
            GRAZE_SCAN_YAW * (1 - w) * Math.sin(t * 0.21 + spec.seed);
        }
        cow.rotation.y = _pose.heading;
      } else if (spec.kind === "lane") {
        const p = t * spec.speed + phase * TAU;
        cow.position.x = spec.x0 + (spec.x1 - spec.x0) * laneU(p);
        cow.position.z = spec.z + Math.sin(t * 0.55 + phase) * 0.12;
        /* Sweep the 180° about-face rather than snapping it mid-stride. The
           window is wide (0.45) because LANE_EASE keeps the cow walking through
           the turn: it covers ~0.3 units while coming about, which is a slow
           pivot rather than a rigid spin. */
        cow.rotation.y = (Math.PI / 2) * clamp(Math.sin(p) / 0.45, -1, 1);
        setGait(mixer, dur, Math.abs(laneArc(p) - spec.s0) * spec.len);
      } else {
        /* standing cows: idle has no ground contact to honour */
        mixer.setTime(((t + phase * 3) % dur + dur) % dur);
      }
    }
    rigFlash.tick(t, [subject, laneCow ? laneCow.cow.position : null]);
  }

  /* the leg from the current station to the next glows brighter (route guidance) */
  const setActiveLeg = (i) => ribbon.setLeg(i);

  const collideOut = { x: 0, z: 0, hit: false };
  const collide = (x, z, r, clearance) =>
    colliders.resolve(x, z, r, clearance, collideOut);

  /* Waypoints an auto-run must clear before aiming at station i. Fenced ground
     works in BOTH directions and the exit leg is the one that bites: a calf
     standing in the capture pen and sent to station 02 aims straight through
     the pen's east rail and grinds there, because the only gate is west. */
  const ENCLOSURES = [
    {
      station: 1,
      mouth: { x: PEN_GATE.x - 1.9, z: PEN_GATE.z },
      holds: (x, z) => Math.abs(x - S1.x) < 4 && Math.abs(z - S1.z) < 4
    },
    {
      /* Station 08 is outside this enclosure. Any auto-run that starts among
         the cattle must leave through the east mouth before aiming at it. */
      station: null,
      mouth: { x: PADDOCK_GATE.x + 1.9, z: PADDOCK_GATE.z },
      holds: (x, z) => x > PAD_X0 && x < PAD_X1 && z > PAD_Z0 && z < PAD_Z1
    }
  ];
  function stationApproach(i, fromX, fromZ) {
    const exits = [], entries = [];
    for (const e of ENCLOSURES) {
      const within = e.holds(fromX, fromZ);
      if (within && e.station !== i) exits.push(e.mouth);        // walk out first
      else if (!within && e.station === i) entries.push(e.mouth); // then walk in
    }
    /* The path-side accent between 04 and 05 deliberately follows the glowing
       curve, but a calf aims at station centres in a straight line. Route round
       its south-east end in either direction instead of wedging on the rail. */
    const skirtsCompareFence =
      (i === 5 && fromX > 20 && fromZ > -10)
      || (i === 4 && fromX < 20 && fromZ < -10);
    const openPasture = skirtsCompareFence ? [{ x: 28, z: -10 }] : [];
    return [...exits, ...openPasture, ...entries];
  }

  return {
    update, setActiveLeg, groundHeight, collide, stationApproach, cowAsset,
    get gateFlash() { return rigFlash.state; }
  };
}
