/* Roam mode — the world-coupled glue over two reusable lib modules:
   chibi-cattle.js (avatar) + third-person-rig.js (input/physics/camera).

   A Q-version calf explores Agreement Ranch on foot. Walking into a station
   pad arms the exhibit (lights, panel, ribbon leg, marker focus) exactly like
   a dwell, a speech bubble narrates the step in calf-persona, and F fires a
   per-station easter egg. Everything here is additive: entering roam adds the
   avatar + trail to the scene, exiting removes them — zero cost otherwise. */

import * as THREE from "../../vendor/three.module.js";
import { CSS2DObject } from "../../vendor/CSS2DRenderer.js";
import { STATIONS } from "./rail.js?v=20260812-view-routing";
import { createChibiCattle } from "../lib/chibi-cattle.js";
import { createThirdPersonRig, turnToward } from "../lib/third-person-rig.js?v=20260812-steering";

const AMBER = 0xe39b2d, ICE = 0x86d7ea;
const REDUCED_MOTION = typeof matchMedia !== "undefined" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;
const COARSE_POINTER = typeof matchMedia !== "undefined" &&
  matchMedia("(pointer: coarse)").matches;

/* First-load coaching. Each prompt retires the moment the visitor does the
   thing, so someone who is already driving never gets lectured, and nobody
   reads a wall of controls before they have touched anything.

   The touch list is a different lesson, not a translation of the same one:
   there is no WASD on a phone, and telling a phone user to hold W is how a
   tutorial teaches people to distrust it. */
const COACH_KEYS = [
  { text: "Hold W or ↑ — walk with me.", flag: "moved" },
  { text: "SHIFT to gallop. SPACE twice for a front flip.", flag: "sprang" },
  { text: "Press 0–8 and I'll run you there myself.", flag: "sent" }
];
const COACH_TOUCH = [
  { text: "Drag anywhere to look around.", flag: "looked" },
  { text: "Tap a number below — I'll walk us there.", flag: "sent" }
];
const COACH_PROMPT_S = 6;    // how long a prompt stays up
const COACH_PATIENCE_S = 10; // ignoring a prompt is an answer: move on

/* ---- calf-persona narration + easter eggs (all numbers are the paper's) ---- */
const SPOTS = [
  {
    greet: "MOO! Welcome to Agreement Ranch — I'm your calf guide. Follow the amber path!",
    egg: { line: "Every pixel here comes from a real paper. Even me. (arXiv 2601.17791)", act: "bow" }
  },
  {
    greet: "Three cameras — left, right, top — and not a single scale in sight.",
    egg: { line: "Captured! 103 of my cousins did this exact walk.", act: "flash" }
  },
  {
    greet: "SAM 3 keeps the cow, drops the world. I am 100% cow.",
    egg: { line: "Segmented! Everything that is not cow… gone.", act: "mask" }
  },
  {
    greet: "One masked RGB view reconstructs me here — 50 sparse steps, then 25 latent steps.",
    egg: { line: "Feeling voxelly… Stage 2 will smooth me right out.", act: "denoise" }
  },
  {
    greet: "Now all three views reconstruct me together, weighted by agreement — not by average.",
    egg: { line: "See? Left, right, top — one cow.", act: "merge" }
  },
  {
    greet: "Agreement fusion beat the depth-sensor baseline. RGB only.",
    egg: { line: "R² 0.69 vs 0.65 — and nobody bought a depth sensor.", act: "spin" }
  },
  {
    greet: "5941 points, five paper feature groups — plus a hull view to inspect.",
    egg: { line: "Behold my PCA ratios. And these hull volumes!", act: "flex" }
  },
  {
    greet: "Across 103 cattle, geometry-based weight estimation reached 2.22% MAPE and 9.16 kg MAE.",
    egg: { line: "That is the paper's 5-fold dataset result — not this cow's individual prediction.", act: "hop" }
  },
  {
    greet: "Next stop for the herd: a walk-through RGB weigh gate.",
    egg: { line: "No crush, no contact. Just a calf, walking. See you there. MOO!", act: "bow" }
  }
];
const MOOS = ["MOOOO~", "moo.", "MOO MOO!", "哞~"];
const NOWHERE = "…nothing here but excellent grass. MOO.";
/* idle chatter — surfaces controls and paper lore while wandering */
const TIPS = [
  "Tip: press E — I'm faster than I look.",
  "Tip: Space twice. The flip is free.",
  "Tip: 0–8, or tap a number — I'll run you there myself.",
  "The amber path always knows the way home.",
  "103 cousins volunteered for this paper. Heroes, all of them.",
  "Press F near an exhibit — I know things.",
  "No scales were harmed in this pipeline. None were used.",
  "哞~ (that's MOO in Chinese)"
];
const TRAVEL_SUFFIX = ["Keep up!", "Follow me!", "This way — MOO!", "Hooves, don't fail me now."];

const ROAM_HINT = "WASD MOVE · L-DRAG VIEW · SHIFT RUN · SPACE ×2 · E DASH · F EGG · M MOO · 0-8 OR TAP A DOT · C/ESC EXIT";
const ROAM_CHIP = "ROAM — FOLLOW THE AMBER PATH";
const R_ENTER = 8.6, R_LEAVE = 10.8;   // station pad hysteresis (pads are r≈9)
/* where the camera has finished craning up to the wide ranch view. Well beyond
   R_LEAVE: the lift should read as leaving the exhibit behind, not as a second
   thing that happens at the same moment the panel closes. */
const R_FRAME_OUT = 26;
const clamp01 = (x) => Math.min(1, Math.max(0, x));

/* Distance to the nearest exhibit → camera framing, 0..1. Continuous even
   though ARRIVAL is hysteretic: the crane should already be coming down as you
   walk in, not snap at the moment the narration fires. Exported so the curve
   can be asserted without a GPU. */
export function framingForDistance(d) {
  const k = clamp01((R_FRAME_OUT - d) / (R_FRAME_OUT - R_ENTER));
  return k * k * (3 - 2 * k);
}

/* keyboard → abstract rig actions (rig knows nothing about key codes) */
const KEYMAP = {
  KeyW: "forward", ArrowUp: "forward",
  KeyS: "back", ArrowDown: "back",
  KeyA: "left", ArrowLeft: "left",
  KeyD: "right", ArrowRight: "right",
  ShiftLeft: "run", ShiftRight: "run"
};

/* ---------- tiny WebAudio synth (lazy — first use is a key gesture) ---------- */

let actx = null;
function audio() {
  if (actx === null) {
    try { actx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch { actx = false; }
  }
  if (actx && actx.state === "suspended") actx.resume().catch(() => {});
  return actx;
}
function mooSound() {
  const ctx = audio();
  if (!ctx) return;
  const t0 = ctx.currentTime;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(0.15, t0 + 0.07);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.62);
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(820, t0);
  lp.frequency.exponentialRampToValueAtTime(340, t0 + 0.55);
  const o1 = ctx.createOscillator();
  o1.type = "sawtooth";
  o1.frequency.setValueAtTime(172, t0);
  o1.frequency.exponentialRampToValueAtTime(112, t0 + 0.5);
  const o2 = ctx.createOscillator();
  o2.type = "triangle";
  o2.frequency.setValueAtTime(86, t0);
  o2.frequency.exponentialRampToValueAtTime(58, t0 + 0.5);
  o1.connect(lp); o2.connect(lp); lp.connect(gain); gain.connect(ctx.destination);
  o1.start(t0); o2.start(t0);
  o1.stop(t0 + 0.65); o2.stop(t0 + 0.65);
}
function jingleSound() {
  const ctx = audio();
  if (!ctx) return;
  [659.25, 783.99, 987.77].forEach((f, i) => {
    const t0 = ctx.currentTime + i * 0.085;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(0.06, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.22);
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.value = f;
    o.connect(g); g.connect(ctx.destination);
    o.start(t0); o.stop(t0 + 0.24);
  });
}

/* ---------- amber dash/land particle trail (one draw call) ---------- */

function buildTrail() {
  const N = 40;
  const pos = new Float32Array(N * 3);
  const birth = new Float32Array(N).fill(-100);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aBirth", new THREE.BufferAttribute(birth, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    uniforms: { uT: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute float aBirth;
      uniform float uT;
      varying float vA;
      void main() {
        float age = uT - aBirth;
        vA = 1.0 - clamp(age / 0.62, 0.0, 1.0);
        vec3 p = position + vec3(0.0, age * 0.8, 0.0);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = vA > 0.0 ? (46.0 / -mv.z) * (0.4 + 0.6 * vA) : 0.0;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vA;
      void main() {
        if (vA <= 0.0) discard;
        vec2 c = gl_PointCoord - 0.5;
        float d = dot(c, c);
        if (d > 0.25) discard;
        gl_FragColor = vec4(0.89, 0.61, 0.18, vA * (1.0 - d * 4.0) * 0.9);
      }
    `
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  let head = 0;
  return {
    points,
    emit(x, y, z, t, jitter = 0.22) {
      const i = head++ % N;
      /* deterministic jitter (worldTime-seeded — no Math.random) */
      pos[i * 3] = x + Math.sin(t * 61 + i * 2.3) * jitter;
      pos[i * 3 + 1] = y + Math.sin(t * 47 + i * 4.1) * jitter * 0.5;
      pos[i * 3 + 2] = z + Math.cos(t * 53 + i * 3.7) * jitter;
      birth[i] = t;
      geo.attributes.position.needsUpdate = true;
      geo.attributes.aBirth.needsUpdate = true;
    },
    burst(x, y, z, t, n = 7) {
      for (let k = 0; k < n; k++) this.emit(x, y + 0.15, z, t, 0.55);
    },
    tick(t) { mat.uniforms.uT.value = t; },
    dispose() { geo.dispose(); mat.dispose(); }
  };
}

/* ---------- S4 egg: three ice ghost-calves (left/right/top views) merge ---------- */

function buildGhosts() {
  /* pale ice — must read against S4's own ice/amber exhibit cloud */
  const mat = new THREE.MeshBasicMaterial({
    color: 0xc4ecf7, transparent: true, opacity: 0.6, depthWrite: false
  });
  const bodyGeo = new THREE.SphereGeometry(0.5, 12, 8);
  const headGeo = new THREE.SphereGeometry(0.34, 12, 8);
  const group = new THREE.Group();
  const ghosts = [];
  /* the three capture views in the CALF's frame (camera sits behind the calf,
     so its left/right/top are the screen's left/right/top): [side, up, fwd] */
  const FROM = [[-3.2, 0.7, 0], [3.2, 0.7, 0], [0, 3.6, 0]];
  for (const local of FROM) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(bodyGeo, mat);
    body.scale.set(1, 0.82, 1.3);
    const head = new THREE.Mesh(headGeo, mat);
    head.position.set(0, 0.45, 0.62);
    g.add(body, head);
    group.add(g);
    ghosts.push({ g, local, from: new THREE.Vector3() });
  }
  let t = Infinity;
  const DUR = 1.35;
  const center = new THREE.Vector3();
  return {
    group,
    get active() { return t < DUR; },
    /* abort a mid-flight merge — otherwise a re-enter would replay it at the
       stale center captured by the previous start() */
    reset() {
      t = Infinity;
      group.visible = false;
    },
    start(pos, heading) {
      center.copy(pos).add({ x: 0, y: 0.75, z: 0 });
      const right = { x: Math.cos(heading), z: -Math.sin(heading) };
      for (const gh of ghosts) {
        gh.from.set(right.x * gh.local[0], gh.local[1], right.z * gh.local[0]);
        gh.g.rotation.y = heading;
      }
      t = 0;
    },
    update(dt) {
      if (t >= DUR) { group.visible = false; return; }
      t += dt;
      const k = Math.min(1, t / DUR);
      const e = k * k * (3 - 2 * k);
      group.visible = true;
      mat.opacity = 0.42 * (1 - e * e);
      for (const { g, from } of ghosts) {
        g.position.copy(center).add(from).lerp(center, e);
        g.scale.setScalar(1 - 0.85 * e);
      }
    },
    dispose() { bodyGeo.dispose(); headGeo.dispose(); mat.dispose(); }
  };
}

/* ---------- dash ribbon: glowing trail band, distance-sampled ---------- */

function buildRibbon() {
  const N = 26;                     // ring of trail samples (oldest fades out)
  const LIFE = 0.55;
  const HALF_W = 0.24;
  const verts = N * 2;
  const pos = new Float32Array(verts * 3);
  const birth = new Float32Array(verts).fill(-100);
  const side = new Float32Array(verts);
  const idx = [];
  for (let i = 0; i < N - 1; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aBirth", new THREE.BufferAttribute(birth, 1));
  geo.setAttribute("aSide", new THREE.BufferAttribute(side, 1));
  geo.setIndex(idx);
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide, fog: false,
    uniforms: { uT: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute float aBirth;
      attribute float aSide;
      uniform float uT;
      varying float vA;
      varying float vSide;
      void main() {
        vA = 1.0 - clamp((uT - aBirth) / ${LIFE.toFixed(2)}, 0.0, 1.0);
        vSide = aSide;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vA;
      varying float vSide;
      void main() {
        if (vA <= 0.0) discard;
        float core = 1.0 - abs(vSide);              // hot white core, soft edges
        vec3 col = mix(vec3(0.89, 0.61, 0.18), vec3(1.0, 0.93, 0.75), core * 0.7);
        gl_FragColor = vec4(col, vA * vA * (0.25 + 0.55 * core));
      }
    `
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  const samples = [];               // js-side ring: {x, y, z}
  let last = null;
  const up = new THREE.Vector3(0, 1, 0);
  const dir = new THREE.Vector3(), sideV = new THREE.Vector3();
  function rebuild(t) {
    const n = samples.length;
    for (let i = 0; i < n; i++) {
      const s = samples[i];
      const prev = samples[Math.max(0, i - 1)];
      const next = samples[Math.min(n - 1, i + 1)];
      dir.set(next.x - prev.x, 0, next.z - prev.z);
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
      sideV.crossVectors(up, dir).normalize().multiplyScalar(HALF_W);
      for (let k = 0; k < 2; k++) {
        const j = i * 2 + k;
        const sgn = k === 0 ? -1 : 1;
        pos[j * 3] = s.x + sideV.x * sgn;
        pos[j * 3 + 1] = s.y;
        pos[j * 3 + 2] = s.z + sideV.z * sgn;
        birth[j] = s.t;
        side[j] = sgn;
      }
    }
    /* park unused ring capacity on the last sample, already faded out */
    for (let i = n; i < N; i++) {
      for (let k = 0; k < 2; k++) birth[i * 2 + k] = -100;
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.aBirth.needsUpdate = true;
    geo.attributes.aSide.needsUpdate = true;
  }
  return {
    mesh,
    /* distance-based sampling → framerate-independent trail density */
    emit(x, y, z, t) {
      if (last && Math.hypot(x - last.x, z - last.z) < 0.14) return;
      last = { x, y, z };
      samples.push({ x, y, z, t });
      if (samples.length > N) samples.shift();
      rebuild(t);
    },
    tick(t) { mat.uniforms.uT.value = t; },
    reset() {
      samples.length = 0;
      last = null;
      birth.fill(-100);
      geo.attributes.aBirth.needsUpdate = true;
    },
    dispose() { geo.dispose(); mat.dispose(); }
  };
}

/* ---------- dash afterimages: pooled amber silhouettes, 0.4 s fade ---------- */

function buildEchoes() {
  const N = 4;
  const bodyGeo = new THREE.SphereGeometry(0.5, 10, 7);
  const headGeo = new THREE.SphereGeometry(0.36, 10, 7);
  const group = new THREE.Group();
  const slots = [];
  for (let i = 0; i < N; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: AMBER, transparent: true, opacity: 0, depthWrite: false
    });
    const g = new THREE.Group();
    const body = new THREE.Mesh(bodyGeo, mat);
    body.scale.set(1, 0.82, 1.3);
    body.position.y = 0.72;
    const head = new THREE.Mesh(headGeo, mat);
    head.position.set(0, 1.14, 0.62);
    g.add(body, head);
    g.visible = false;
    group.add(g);
    slots.push({ g, mat, born: -10 });
  }
  let next = 0, lastSpawn = -10;
  const LIFE = 0.4;
  return {
    group,
    spawn(pos, heading, t) {
      if (t - lastSpawn < 0.07) return;
      lastSpawn = t;
      const s = slots[next++ % N];
      s.g.position.copy(pos);
      s.g.rotation.y = heading;
      s.born = t;
    },
    update(t) {
      for (const s of slots) {
        const k = (t - s.born) / LIFE;
        if (k >= 0 && k < 1) {
          s.g.visible = true;
          s.mat.opacity = 0.38 * (1 - k);
          s.g.scale.set(1 - 0.15 * k, 1 - 0.1 * k, 1 + 0.35 * k);  // motion smear
        } else {
          s.g.visible = false;
        }
      }
    },
    reset() {
      for (const s of slots) { s.born = -10; s.g.visible = false; }
      lastSpawn = -10;
    },
    dispose() {
      bodyGeo.dispose();
      headGeo.dispose();
      for (const s of slots) s.mat.dispose();
    }
  };
}

/* ---------- roam mode ---------- */

export function initRoam({
  scene, camera, canvas, env, stations, panels,
  setMarkerFocus, requestModelsForStation, chipEl, hintEl, onExitRequest,
  onGuideStation = null,
  onStationEnter = null,
  onStationLeave = null,
  avatar = null
}) {
  /* any object honouring the chibi-cattle contract can play the calf.
     The ~100 ms one-piece SDF body normally arrives from a Web Worker (zero
     main-thread cost, so it can start immediately without touching the load
     path); a sync build on first enter is the safety net. */
  let cattle = avatar || null;
  let bodyData = null;
  let bodyBuiltBy = "pending";
  if (!cattle) {
    try {
      const worker = new Worker(
        new URL("../lib/chibi-body.worker.js", import.meta.url), { type: "module" });
      const bail = setTimeout(() => worker.terminate(), 12000);
      worker.onmessage = (e) => {
        clearTimeout(bail);
        if (!cattle) { bodyData = e.data; bodyBuiltBy = "worker"; }
        worker.terminate();
      };
      worker.onerror = (err) => {
        clearTimeout(bail);
        worker.terminate();
        console.warn("calf body worker failed; will build on demand:", err.message || err);
      };
      worker.postMessage({});
    } catch (err) {
      console.warn("calf body worker unavailable; will build on demand:", err);
    }
  }
  const rig = createThirdPersonRig({
    camera,
    groundFn: env.groundHeight,
    /* ranch props push the calf back instead of letting it walk through
       fences and barn walls; env owns the shape list because it owns the
       layout that produced them */
    collideFn: env.collide,
    bounds: { radius: 74 }
  });
  const trail = buildTrail();
  const ribbon = buildRibbon();
  const ghosts = buildGhosts();
  const echoes = buildEchoes();

  let active = false;
  let worldT = 0;
  let nearI = -1;
  let framing01 = 0;   // camera framing this frame (QA-visible)
  let dropping = false;      // sky-drop entrance in progress
  let hasDropped = false;    // the entrance plays once per page load
  let autoFace = null;       // {i, left}: turning to face a station's exhibit
  let dashLeft = 0;          // seconds of dash-trail emission remaining
  let eggCooldown = 0;
  let mooIdx = 0;
  let autoTravel = null;     // {i}: calf is auto-running to station i
  let travelIdx = 0;
  let chatterT = 0;          // quiet time before the calf offers a tip
  let chatterIdx = 0;
  /* coaching runs once per page load, not once per roam entry */
  const COACH = COARSE_POINTER ? COACH_TOUCH : COACH_KEYS;
  const learned = { moved: false, sprang: false, sent: false, looked: false };
  let coachStep = 0;
  let coachUp = false;       // the current prompt is on screen
  let coachAge = 0;
  const visited = new Set();

  /* speech bubble — CSS2D above the calf's head */
  const bubbleEl = document.createElement("div");
  bubbleEl.className = "cow-bubble hud-mono";
  const bubbleObj = new CSS2DObject(bubbleEl);
  bubbleObj.position.set(0, 2.3, 0);
  function ensureCattle() {
    if (!cattle) {
      if (bodyBuiltBy !== "worker") bodyBuiltBy = "sync";
      cattle = createChibiCattle(bodyData ? { bodyData } : {});
    }
    if (!bubbleObj.parent) cattle.group.add(bubbleObj);
    return cattle;
  }
  let bubbleLeft = 0;
  function say(text, seconds = 4.5) {
    bubbleEl.textContent = text;
    bubbleEl.classList.add("show");
    bubbleLeft = seconds;
  }
  function hushBubble() {
    bubbleEl.classList.remove("show");
    bubbleLeft = 0;
  }

  /* full-screen triple flash (S1 egg) — DOM only, zero GL cost */
  const flashEl = document.createElement("div");
  flashEl.id = "roamFlash";
  document.body.appendChild(flashEl);

  /* rig events → avatar beats + particles */
  rig.onJump = (n) => { if (cattle) cattle.onJump(n); };
  rig.onLand = (impact) => {
    if (cattle) cattle.onLand(impact);
    if (impact > 6.5) trail.burst(rig.state.pos.x, rig.state.pos.y, rig.state.pos.z, worldT);
    /* sky-drop touchdown: extra dust ring */
    if (impact > 15) trail.burst(rig.state.pos.x, rig.state.pos.y + 0.35, rig.state.pos.z, worldT, 9);
  };
  rig.onDash = () => {
    if (!cattle) return;
    cattle.onDash();
    dashLeft = 0.42;
    /* launch burst at the take-off point */
    const p = rig.state.pos;
    trail.burst(p.x, p.y + 0.35, p.z, worldT, 9);
  };

  /* ---- station proximity (hysteresis so the panel doesn't flicker) ---- */
  function nearestStation() {
    let best = -1, bd = Infinity;
    for (let i = 0; i < STATIONS.length; i++) {
      const s = STATIONS[i].pos;
      const d = Math.hypot(rig.state.pos.x - s.x, rig.state.pos.z - s.z);
      if (d < bd) { bd = d; best = i; }
    }
    return { i: best, d: bd };
  }
  function enterStation(i) {
    nearI = i;
    stations.setActive(i, worldT);
    env.setActiveLeg(i);
    panels.showStation(i);        // also sets chip text + dots
    onGuideStation?.(i);
    setMarkerFocus(i);
    requestModelsForStation(i);
    /* The pipeline token treats arrival as the interaction. Hand it the live
       cattle pose so capture/process/return arcs begin at the visible avatar,
       not at a stale station center. */
    onStationEnter?.(i, worldT, cattle?.group.position || rig.state.pos, rig.state.heading);
    say(SPOTS[i].greet, visited.has(i) ? 3.2 : 5.5);
    visited.add(i);
  }
  function leaveStation() {
    const leaving = nearI;
    nearI = -1;
    onStationLeave?.(leaving, worldT);
    stations.clearActive();
    panels.hidePanel();
    panels.setDots(-1);
    onGuideStation?.(null);
    setMarkerFocus(null);
    chipEl.textContent = ROAM_CHIP;
  }

  /* ---- digit-key auto-run: the calf runs you to the station itself ---- */
  function faceExhibit(i) {
    autoFace = { i, left: 1.4 };
    rig.boostChase();
  }
  function travelTo(i) {
    /* Numeric auto-run knows the destination before proximity detection does;
       arm its evidence transfer while the calf is still travelling. */
    requestModelsForStation(i);
    if (i === nearI) {
      faceExhibit(i);   // already here: just turn to the exhibit
      say(`Right here — STATION 0${i}. Look!`, 2.5);
      return;
    }
    /* Station 01 stands inside fenced ground. Station 08 is outside, but an
       auto-run that STARTS among the cattle still needs the east-gate exit.
       env hands back whichever enclosure legs are required before the target. */
    const p = rig.state.pos;
    const legs = env.stationApproach(i, p.x, p.z);
    legs.push({ x: STATIONS[i].pos.x, z: STATIONS[i].pos.z });
    autoTravel = { i, legs, closest: Infinity, stall: 0 };
    learned.sent = true;
    rig.press("run", true);
    say(`MOO-ving out — 0${i} ${STATIONS[i].name}. ${TRAVEL_SUFFIX[travelIdx++ % TRAVEL_SUFFIX.length]}`, 3.5);
  }
  function cancelAuto() {
    if (!autoTravel) return;
    autoTravel = null;
    rig.setAutoDir(null);
    rig.press("run", false);
  }

  /* ---- easter eggs ---- */
  function fireEgg() {
    if (eggCooldown > 0) return;
    eggCooldown = 1.4;
    if (nearI < 0) { say(NOWHERE, 2.6); return; }
    const egg = SPOTS[nearI].egg;
    say(egg.line, 5);
    jingleSound();
    switch (egg.act) {
      case "bow": cattle.emote("bow"); break;
      case "spin": cattle.emote("spin"); break;
      case "flex": cattle.emote("flex"); break;
      case "flash":
        flashEl.classList.remove("go");
        void flashEl.offsetWidth;   // restart the CSS animation
        flashEl.classList.add("go");
        break;
      case "mask": cattle.setTint(ICE, 0.85); cattle.emote("flex"); break;
      case "denoise": cattle.setTint(AMBER, 0.75); cattle.emote("denoise"); break;
      case "merge": ghosts.start(rig.state.pos, rig.state.heading); break;
      case "hop":
        if (rig.state.grounded) { rig.state.vy = 6.5; rig.state.grounded = false; cattle.onJump(1); }
        cattle.emote("moo");
        break;
    }
  }

  /* ---- input (document-level, inert unless roam is active) ---- */
  /* The coach listens to INTENT, not to keycodes: the same actions arrive from
     the keyboard, from the recorder, and from the QA press() hook, and a calf
     that is visibly galloping should not still be asking you to try walking. */
  function markLearned(action) {
    if (action === "run" || action === "jump" || action === "dash") learned.sprang = true;
    else if (action !== "egg" && action !== "moo") learned.moved = true;
  }

  function onKeyDown(e) {
    if (!active || e.target.closest("input, textarea")) return;
    const action = KEYMAP[e.code];
    if (action) {
      cancelAuto();            // manual steering takes over from auto-run
      autoFace = null;
      markLearned(action);
      rig.press(action, true);
      e.preventDefault();
      return;
    }
    if (e.repeat) return;
    const digit = /^(?:Digit|Numpad)([0-8])$/.exec(e.code);
    if (digit) {
      travelTo(parseInt(digit[1], 10));
      return;
    }
    switch (e.code) {
      case "Space": markLearned("jump"); rig.press("jump", true); e.preventDefault(); break;
      case "KeyE": markLearned("dash"); rig.press("dash", true); break;
      case "KeyF": fireEgg(); break;
      case "KeyM":
        cattle.emote("moo");
        mooSound();
        say(MOOS[mooIdx++ % MOOS.length], 1.6);
        break;
      /* exit keys flip the mode mid-event — stop the event here so main.js's
         later-registered keydown listener doesn't act on the new mode too */
      case "KeyC": e.stopImmediatePropagation(); onExitRequest("station"); break;
      case "Escape": e.stopImmediatePropagation(); onExitRequest("overview"); break;
    }
  }
  function onKeyUp(e) {
    if (!active) return;
    const action = KEYMAP[e.code];
    if (action) rig.press(action, false);
  }
  function onWheel(e) {
    if (!active) return;
    e.preventDefault();
    rig.zoom(e.deltaY * 0.004);
  }
  /* left-drag orbits the follow camera (main.js tap/orbit handlers are
     dwell/overview-gated, so roam owns the pointer while active) */
  let dragging = false, dragX = 0, dragY = 0;
  function onPointerDown(e) {
    if (!active || e.button !== 0 || e.ctrlKey) return;
    dragging = true;
    dragX = e.clientX;
    dragY = e.clientY;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* fine */ }
  }
  function onPointerMove(e) {
    if (!active || !dragging) return;
    learned.looked = true;
    rig.orbit(e.clientX - dragX, e.clientY - dragY);
    dragX = e.clientX;
    dragY = e.clientY;
  }
  function onPointerUp(e) {
    if (!dragging) return;
    dragging = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* fine */ }
  }
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("keyup", onKeyUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
  /* alt-tab away must not leave movement keys latched */
  window.addEventListener("blur", () => rig.releaseAll());

  const savedHint = hintEl ? hintEl.textContent : "";

  return {
    get active() { return active; },
    get heading() { return rig.state.heading; },

    /* spawn beside station i facing its exhibit — dropped in from the sky,
       camera already waiting at the ground framing */
    enter(i, t) {
      ensureCattle();
      worldT = t;
      const s = STATIONS[i];
      const dir = new THREE.Vector3(s.cam.x - s.pos.x, 0, s.cam.z - s.pos.z).normalize();
      const x = s.pos.x + dir.x * 3.6, z = s.pos.z + dir.z * 3.6;
      rig.teleport(x, z, Math.atan2(s.look.x - x, s.look.z - z));
      /* The sky-drop entrance plays once per page load; later enters spawn
         grounded so station-hopping stays snappy. It is also skipped outright
         under prefers-reduced-motion — this used to be opt-in via a keypress,
         but the calf now shows itself in unasked, so an unrequested 11 u fall
         is exactly the kind of motion that setting exists to refuse. */
      if (!hasDropped && !REDUCED_MOTION) {
        rig.drop(11);
        dropping = true;
      } else {
        dropping = false;
      }
      hasDropped = true;
      autoFace = null;
      rig.snapCamera();
      scene.add(cattle.group, trail.points, ribbon.mesh, ghosts.group, echoes.group);
      ghosts.reset();
      echoes.reset();
      ribbon.reset();
      bubbleEl.style.display = "";
      active = true;
      nearI = -1;
      dashLeft = 0;
      eggCooldown = 0;
      chatterT = 0;
      chipEl.textContent = ROAM_CHIP;
      chipEl.classList.add("show");
      if (hintEl) hintEl.textContent = ROAM_HINT;
    },

    exit() {
      if (!active) return;
      active = false;
      dropping = false;
      autoFace = null;
      dragging = false;
      cancelAuto();
      rig.releaseAll();
      hushBubble();
      /* CSS2DRenderer never removes the div with the group — hide it hard so
         it can't ghost at its last screen position during the exit travel */
      bubbleEl.style.display = "none";
      ghosts.reset();
      echoes.reset();
      ribbon.reset();
      rig.resetFov();
      scene.remove(cattle.group, trail.points, ribbon.mesh, ghosts.group, echoes.group);
      if (nearI !== -1) onStationLeave?.(nearI, worldT);
      nearI = -1;
      if (hintEl) hintEl.textContent = savedHint;
    },

    nearestStationIndex() { return nearestStation().i; },
    travelTo,

    update(dt, t) {
      worldT = t;
      if (!active) return;

      /* auto-run steering: aim at the target station until inside its pad */
      if (autoTravel) {
        const leg = autoTravel.legs[0];
        const finalLeg = autoTravel.legs.length === 1;
        const dx = leg.x - rig.state.pos.x, dz = leg.z - rig.state.pos.z;
        const d = Math.hypot(dx, dz);
        if (d < (finalLeg ? 3.4 : 1.8)) {
          if (finalLeg) {
            const arrived = autoTravel.i;
            cancelAuto();
            faceExhibit(arrived);   // settle facing the exhibit, camera follows
          } else {
            autoTravel.legs.shift();          // through the gate, now the exhibit
            autoTravel.closest = Infinity;
            autoTravel.stall = 0;
          }
        } else {
          rig.setAutoDir({ x: dx / d, z: dz / d });
          /* straight-line steering can wedge against a prop the waypoints did
             not anticipate. Hand control back with a word rather than grind
             into a fence for the rest of the session. */
          if (d < autoTravel.closest - 0.35) {
            autoTravel.closest = d;
            autoTravel.stall = 0;
          } else if ((autoTravel.stall += dt) > 3) {
            cancelAuto();
            say("Hmf — something's in my way. Steer me round with WASD?", 3.2);
          }
        }
      }

      rig.update(dt);
      const st = rig.state;

      /* ease the calf (and the boosted camera) around to the exhibit */
      if (autoFace) {
        autoFace.left -= dt;
        const lk = STATIONS[autoFace.i].look;
        const want = Math.atan2(lk.x - st.pos.x, lk.z - st.pos.z);
        st.heading = turnToward(st.heading, want, 6 * dt);
        let dh = (want - st.heading) % (Math.PI * 2);
        if (dh > Math.PI) dh -= Math.PI * 2;
        if (dh < -Math.PI) dh += Math.PI * 2;
        if (Math.abs(dh) < 0.04 || autoFace.left <= 0) autoFace = null;
      }
      cattle.group.position.copy(st.pos);
      cattle.group.rotation.y = st.heading;
      cattle.update(dt, t, {
        speed01: st.speed01,
        speed: st.speed,     // u/s — GLB avatars set gait cadence from this
        run01: st.run01,
        grounded: st.grounded,
        vy: st.vy,
        groundY: st.groundY
      });

      /* dash trail: ribbon band + particles + amber afterimage silhouettes.
         The ribbon keeps sampling while momentum stays above run speed, so it
         streams out through the whole burst, not just the input window. */
      trail.tick(t);
      ribbon.tick(t);
      if (dashLeft > 0 || Math.abs(st.speed) > 10.5) {
        ribbon.emit(st.pos.x, st.pos.y + 0.66, st.pos.z, t);
      }
      if (dashLeft > 0) {
        dashLeft -= dt;
        trail.emit(st.pos.x, st.pos.y + 0.45, st.pos.z, t);
        trail.emit(st.pos.x, st.pos.y + 0.75, st.pos.z, t, 0.3);
        trail.emit(st.pos.x, st.pos.y + 0.3, st.pos.z, t, 0.5);
        echoes.spawn(st.pos, st.heading, t);
      }
      echoes.update(t);
      ghosts.update(dt);

      /* the entrance ends the moment the hooves hit the pasture */
      if (dropping && st.grounded) dropping = false;

      /* Station proximity with hysteresis — armed only once on the ground, so
         the narration starts after the landing, not mid-air. This runs BEFORE
         the bubble timers on purpose: an arrival line is content and the coach
         is not, and when both wanted the same frame the coach used to speak
         first and be overwritten before anyone could read it. */
      if (!dropping) {
        const near = nearestStation();
        framing01 = framingForDistance(near.d);
        rig.setFraming(framing01);
        if (nearI === -1 && near.d < R_ENTER) enterStation(near.i);
        else if (nearI !== -1 && (near.i !== nearI || near.d > R_LEAVE)) {
          if (near.d < R_ENTER && near.i !== nearI) { leaveStation(); enterStation(near.i); }
          else if (near.d > R_LEAVE) leaveStation();
        }
      }

      /* timers */
      if (eggCooldown > 0) eggCooldown -= dt;
      if (bubbleLeft > 0) {
        bubbleLeft -= dt;
        chatterT = 0;
        if (bubbleLeft <= 0) hushBubble();
      } else if (coachStep < COACH.length && !coachUp && !dropping) {
        /* the calf teaches its own controls before the idle tips start. Each
           prompt is said ONCE — re-saying it on expiry would both nag and reset
           the patience clock, so the sequence could never finish. */
        say(COACH[coachStep].text, COACH_PROMPT_S);
        coachUp = true;
      } else if (!autoTravel && !dropping) {
        /* quiet for a while → the calf offers a tip (deterministic cadence) */
        chatterT += dt;
        if (chatterT > 24) {
          chatterT = 0;
          say(TIPS[chatterIdx++ % TIPS.length], 4.5);
        }
      }

      /* Retire the current lesson as soon as the visitor does the thing —
         checked outside the bubble branch so a lesson learned mid-prompt still
         counts, and so a visitor who was already driving before the calf opened
         its mouth skips the whole sequence without seeing a word of it. The
         patience clock only runs while a prompt is actually up. */
      if (coachStep < COACH.length) {
        const got = learned[COACH[coachStep].flag];
        if (coachUp) coachAge += dt;
        if (got || (coachUp && coachAge > COACH_PATIENCE_S)) {
          if (got && coachUp && bubbleLeft > 0.8) bubbleLeft = 0.8;  // acknowledge, then move on
          coachStep++;
          coachUp = false;
          coachAge = 0;
        }
      }
    },

    /* QA / recorder hooks */
    press(action, isDown) {
      if (action === "egg") { fireEgg(); return; }
      if (action === "moo") { if (cattle) cattle.emote("moo"); return; }
      if (isDown) markLearned(action);
      rig.press(action, isDown);
    },
    /* Same reason `press` is exposed: the camera QA must drive the real
       gesture path, not a parallel one that can drift from it. */
    orbit(dx, dy) { rig.orbit(dx, dy); },
    zoom(delta) { rig.zoom(delta); },
    /* Deterministic QA hook for spatial triggers. It still uses the real rig
       and the next normal update performs station leave/enter hysteresis. */
    teleport(x, z, heading = rig.state.heading) {
      if (![x, z, heading].every(Number.isFinite)) return false;
      rig.teleport(x, z, heading);
      if (cattle) cattle.group.position.copy(rig.state.pos);
      rig.snapCamera();
      return true;
    },
    /* Live world position of the driven calf, or null when nobody is driving.
       The capture rig watches this to fire its shutters — a live reference, not
       a copy, so the render loop reads it without allocating per frame. */
    get subject() { return active && cattle ? cattle.group.position : null; },
    get qaState() {
      const st = rig.state;
      return {
        active,
        pos: [st.pos.x, st.pos.y, st.pos.z],
        heading: st.heading,
        camYaw: rig.camYaw,
        grounded: st.grounded,
        vy: st.vy,
        jumps: st.jumps,
        speed: st.speed,
        dashCooldown: st.dashCooldown,
        nearStation: nearI,
        framing: framing01,
        autoTarget: autoTravel ? autoTravel.i : null,
        /* xz alignment between heading and the near station's exhibit */
        lookDot: (() => {
          if (nearI < 0) return null;
          const lk = STATIONS[nearI].look;
          const dx = lk.x - st.pos.x, dz = lk.z - st.pos.z;
          const dl = Math.hypot(dx, dz) || 1;
          return (Math.sin(st.heading) * dx + Math.cos(st.heading) * dz) / dl;
        })(),
        bodyBuild: {
          by: bodyBuiltBy,
          ms: bodyData ? Math.round(bodyData.buildMs) : null
        },
        coach: { step: coachStep, of: COACH.length, up: coachUp, learned: { ...learned } },
        visited: [...visited],
        bubble: bubbleEl.classList.contains("show") ? bubbleEl.textContent : null
      };
    }
  };
}
