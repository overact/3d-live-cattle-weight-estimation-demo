/* chibi-cattle.js — reusable Q-version (chibi) cattle avatar (no app coupling).
   Primitive-sphere rig with procedural gaits: idle / walk / run / airborne,
   double-jump front flip, dash stretch, landing squash, and one-shot emotes.

   The module owns look + motion only. A controller feeds it an abstract pose
   each frame via update(dt, t, pose) and fires events (onJump/onLand/onDash) —
   it knows nothing about input, physics, or the hosting scene, so any project
   (and any future skinned replacement) can sit behind the same contract.

     const cow = createChibiCattle();
     scene.add(cow.group);
     cow.update(dt, worldT, { speed01, run01, grounded, vy, groundY });
     cow.onJump(2); cow.onLand(6.2); cow.onDash();
     cow.emote("spin" | "flex" | "bow" | "moo" | "denoise");
     cow.setTint(0x86d7ea, 0.6);   // easter-egg emissive wash (0 clears)

   group origin = ground under the hooves, +Z = forward. 19 draw calls, 9
   shared materials, 4 shader programs (standard skinned+vertexColors for the
   hide, standard+vertexColors for the painted head, plain standard, basic). */

import * as THREE from "../../vendor/three.module.js";
import { buildCalfBodyData, createCoatPainter, CALF_PALETTE, HIP_Y, LEG_XZ } from "./chibi-body-core.js";
import { softBlobTexture } from "./blob-shadow.js";

/* red-brown hide, white face/underline/socks — the Hereford-type animal the
   paper reconstructs (assets/cases/case_001/views/rgb_left.png) */
const PALETTE = { ...CALF_PALETTE, amber: 0xe39b2d, horn: 0xd9c7a4 };

const TAU = Math.PI * 2;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const ease = (k) => k * k * (3 - 2 * k);

/* The one-piece SDF body (smooth-union torso+legs, surface nets, auto-skin)
   lives in chibi-body-core.js — pure math shared verbatim with the Web Worker
   that normally prebuilds it off the main thread. */

export function createChibiCattle(opts = {}) {
  const palette = { ...PALETTE, ...(opts.palette || {}) };

  /* smooth shading — faceted spheres read "rough"; the world's flat-shaded
     terrain still frames the calf as the soft, toy-like exception */
  const mats = {
    hide: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88 }),
    painted: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88 }),
    coat: new THREE.MeshStandardMaterial({ color: palette.coat, roughness: 0.88 }),
    muzzle: new THREE.MeshStandardMaterial({ color: palette.muzzle, roughness: 0.72 }),
    horn: new THREE.MeshStandardMaterial({ color: palette.horn, roughness: 0.5 }),
    dark: new THREE.MeshStandardMaterial({ color: palette.dark, roughness: 0.8 }),
    amber: new THREE.MeshStandardMaterial({ color: palette.amber, roughness: 0.55 }),
    highlight: new THREE.MeshBasicMaterial({ color: 0xffffff }),
    /* own material, not the shared createBlobShadow() one: update() fades and
       shrinks this blob mid-jump, and softBlobTexture() hands back a fresh
       ramp per call, so dispose() below owns both outright */
    shadow: new THREE.MeshBasicMaterial({
      color: 0x000000, map: softBlobTexture(), transparent: true,
      opacity: 0.34, depthWrite: false
    })
  };
  const geos = [];
  const sphere = (r, w = 24, h = 16) => {
    const g = new THREE.SphereGeometry(r, w, h);
    geos.push(g);
    return g;
  };
  const mesh = (geo, mat, sx = 1, sy = 1, sz = 1) => {
    const m = new THREE.Mesh(geo, mat);
    m.scale.set(sx, sy, sz);
    return m;
  };

  /* Bake the shared coat pattern onto a loose (unskinned) part, evaluating the
     painter at the vertex's RIG-space rest position. The white face therefore
     continues across the head/torso seam instead of ending at a mesh edge. */
  const paintCoat = createCoatPainter(palette);
  const paintPart = (m, ox, oy, oz) => {
    const pos = m.geometry.attributes.position;
    const col = new Float32Array(pos.count * 3);
    const rgb = [0, 0, 0];
    for (let i = 0; i < pos.count; i++) {
      paintCoat(pos.getX(i) * m.scale.x + ox, pos.getY(i) * m.scale.y + oy,
        pos.getZ(i) * m.scale.z + oz, rgb);
      col[i * 3] = rgb[0]; col[i * 3 + 1] = rgb[1]; col[i * 3 + 2] = rgb[2];
    }
    m.geometry.setAttribute("color", new THREE.BufferAttribute(col, 3));
    return m;
  };

  /* ---- hierarchy: group → squash → flip(center pivot) → body/head/legs ---- */
  const group = new THREE.Group();
  const squash = new THREE.Group();          // land/jump squash-stretch (pivot at feet)
  const flip = new THREE.Group();            // double-jump front flip (pivot at belly)
  flip.position.y = 0.72;
  const rig = new THREE.Group();             // everything, offset back under the flip pivot
  rig.position.y = -0.72;
  group.add(squash);
  squash.add(flip);
  flip.add(rig);

  /* one-piece torso+legs: seamless SDF mesh, skinned to root + 4 leg bones.
     bodyPivot still carries the head/tail assemblies; its bob/lean values are
     mirrored onto the root bone each frame so hide and head move as one.
     opts.bodyData = prebuilt arrays from the worker; falls back to a sync
     build (~140 ms) only if the worker never delivered. It must have been
     built from the SAME palette — the head is painted here on the main thread,
     so a mismatch would show up as a two-tone calf at the neck. */
  const data = opts.bodyData || buildCalfBodyData(palette);
  const bodyGeo = new THREE.BufferGeometry();
  bodyGeo.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
  bodyGeo.setAttribute("normal", new THREE.BufferAttribute(data.normal, 3));
  bodyGeo.setAttribute("color", new THREE.BufferAttribute(data.color, 3));
  bodyGeo.setAttribute("skinIndex", new THREE.BufferAttribute(data.skinIndex, 4));
  bodyGeo.setAttribute("skinWeight", new THREE.BufferAttribute(data.skinWeight, 4));
  bodyGeo.setIndex(new THREE.BufferAttribute(data.index, 1));
  geos.push(bodyGeo);
  const skinned = new THREE.SkinnedMesh(bodyGeo, mats.hide);
  const rootBone = new THREE.Bone();
  const legBones = LEG_XZ.map((L) => {
    const b = new THREE.Bone();
    b.position.set(L.x, HIP_Y, L.z);
    rootBone.add(b);
    return b;
  });
  skinned.add(rootBone);
  rig.add(skinned);
  skinned.updateMatrixWorld(true);
  skinned.bind(new THREE.Skeleton([rootBone, ...legBones]));

  const bodyPivot = new THREE.Group();
  bodyPivot.position.y = 0.72;
  rig.add(bodyPivot);

  /* big chibi head */
  const headPivot = new THREE.Group();
  headPivot.position.set(0, 0.42, 0.66);
  bodyPivot.add(headPivot);
  /* the head carries the white face itself — painted from the same field as
     the hide, so the red poll and cheeks fray into it exactly like the body.
     Denser than the other spheres on purpose: 24×16 quantises that boundary
     into visible facets. */
  const head = paintPart(mesh(sphere(0.46, 48, 32), mats.painted, 1.0, 0.94, 1.0), 0, 1.14, 0.66);
  headPivot.add(head);
  /* muzzle: bovine heads read by their PROFILE — a broad pink nose carried
     well forward and down off the cranium is what stops it looking like a
     bear cub from the side */
  const muzzle = mesh(sphere(0.26), mats.muzzle, 1.16, 0.82, 1.02);
  muzzle.position.set(0, -0.2, 0.42);
  headPivot.add(muzzle);
  for (const s of [-1, 1]) {
    const nostril = mesh(sphere(0.045, 8, 6), mats.dark, 1, 1.25, 0.7);
    nostril.position.set(s * 0.1, -0.17, 0.64);
    headPivot.add(nostril);
  }
  const eyes = [];
  for (const s of [-1, 1]) {
    const eye = mesh(sphere(0.075, 12, 10), mats.dark);
    eye.position.set(s * 0.25, 0.045, 0.38);
    /* unlit catchlight — the single cheapest cuteness upgrade there is */
    const glint = mesh(sphere(0.026, 8, 6), mats.highlight);
    glint.position.set(0.024, 0.028, 0.058);
    eye.add(glint);
    headPivot.add(eye);
    eyes.push(eye);
  }
  /* red curly poll between the horns — Herefords keep colour above the face */
  const forelock = mesh(sphere(0.17), mats.coat, 1.15, 0.6, 0.95);
  forelock.position.set(0, 0.4, 0.12);
  headPivot.add(forelock);
  const horns = [];
  for (const s of [-1, 1]) {
    /* a calf's are stubby waxy buds, not cow horns */
    const horn = new THREE.Mesh(new THREE.ConeGeometry(0.062, 0.15, 8), mats.horn);
    geos.push(horn.geometry);
    horn.position.set(s * 0.25, 0.42, 0.03);
    horn.rotation.z = -s * 0.62;
    headPivot.add(horn);
    horns.push(horn);
  }
  const ears = [];
  for (const s of [-1, 1]) {
    /* cattle ears stick STRAIGHT out sideways and sweep back; the old
       up-and-drooping angle is a puppy's, and it dominated the side view */
    const earPivot = new THREE.Group();
    earPivot.position.set(s * 0.4, 0.15, -0.04);
    const ear = mesh(sphere(0.15), mats.coat, 1.7, 0.8, 0.46);
    ear.position.x = s * 0.19;
    earPivot.add(ear);
    earPivot.rotation.z = s * 0.2;
    earPivot.rotation.y = -s * 0.28;
    headPivot.add(earPivot);
    ears.push(earPivot);
  }
  /* amber ear tag — 103 animals in the study wear one */
  const tag = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.08, 0.02), mats.amber);
  geos.push(tag.geometry);
  tag.position.set(0.5, 0.1, 0.02);
  tag.rotation.z = 0.3;
  headPivot.add(tag);

  /* gait targets: the skinned leg bones (diagonal trot pairs) */
  const legs = LEG_XZ.map((L, i) => ({ bone: legBones[i], phase: L.phase, front: L.front }));

  /* tail with dark tuft */
  const tailPivot = new THREE.Group();
  tailPivot.position.set(0, 0.98, -0.6);
  rig.add(tailPivot);
  const tailGeo = new THREE.CylinderGeometry(0.052, 0.07, 0.38, 8);
  geos.push(tailGeo);
  tailGeo.translate(0, -0.19, 0);
  const tailRope = new THREE.Mesh(tailGeo, mats.coat);
  tailPivot.add(tailRope);
  const tuft = mesh(sphere(0.11, 10, 8), mats.dark);
  tuft.position.y = -0.42;
  tailPivot.add(tuft);
  tailPivot.rotation.x = 0.35;

  /* blob shadow — counter-offset each frame so it stays on the ground */
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.8, 20), mats.shadow);
  geos.push(shadow.geometry);
  shadow.rotation.x = -Math.PI / 2;
  shadow.renderOrder = 1;
  group.add(shadow);

  /* ---- animation state ---- */
  let stride = 0;                 // gait phase
  let squashP = 1, squashV = 0;   // spring around scale 1
  let flipT = Infinity;           // seconds since double jump
  let dashT = Infinity;           // seconds since dash
  const emotes = { spin: Infinity, flex: Infinity, bow: Infinity, moo: Infinity, denoise: Infinity };
  let tintK = 0;
  const tintColor = new THREE.Color(0x86d7ea);
  const tinted = [mats.hide, mats.painted, mats.coat, mats.muzzle];

  const FLIP_S = 0.55, DASH_S = 0.45;
  const EMOTE_S = { spin: 0.65, flex: 0.9, bow: 1.1, moo: 0.55, denoise: 1.2 };

  function update(dt, t, pose) {
    const speed01 = clamp(pose.speed01 ?? 0, 0, 1);
    const run01 = clamp(pose.run01 ?? 0, 0, 1);
    const grounded = pose.grounded ?? true;
    const vy = pose.vy ?? 0;

    /* gait phase only advances while moving on the ground */
    if (grounded) stride += dt * (5.5 + 9.5 * speed01) * (speed01 > 0.03 ? 1 : 0);
    const swing = 0.34 + 0.62 * speed01;

    for (const leg of legs) {
      if (grounded) {
        leg.bone.rotation.x = Math.sin(stride + leg.phase) * swing * Math.min(1, speed01 * 6);
      } else {
        /* airborne tuck: front legs reach forward, back legs trail */
        const target = leg.front ? -0.85 : 0.9;
        leg.bone.rotation.x += (target + Math.sin(t * 9 + leg.phase) * 0.12 - leg.bone.rotation.x) * Math.min(1, dt * 10);
      }
    }

    /* body: trot bounce + breathing + lean */
    const bounce = grounded ? Math.abs(Math.sin(stride)) * 0.05 * speed01 : 0;
    const breathe = 0.012 * Math.sin(t * 2.1);
    bodyPivot.position.y = 0.72 + bounce + breathe;
    const airPitch = grounded ? 0 : clamp(-vy * 0.045, -0.3, 0.42);
    const dashK = dashT < DASH_S ? 1 - dashT / DASH_S : 0;
    bodyPivot.rotation.x = -0.16 * run01 - 0.22 * ease(dashK) + airPitch;
    bodyPivot.rotation.z = Math.sin(stride) * 0.045 * speed01;
    /* the one-piece hide follows the head/tail pivot exactly */
    rootBone.position.y = bodyPivot.position.y - 0.72;
    rootBone.rotation.x = bodyPivot.rotation.x;
    rootBone.rotation.z = bodyPivot.rotation.z;

    /* head: counter-bob, idle scan, moo lift */
    const idleK = grounded ? 1 - Math.min(1, speed01 * 4) : 0;
    const mooK = emotes.moo < EMOTE_S.moo ? Math.sin((emotes.moo / EMOTE_S.moo) * Math.PI) : 0;
    headPivot.rotation.x = 0.05 * Math.sin(stride + Math.PI) * speed01 - 0.5 * mooK
      + 0.06 * Math.sin(t * 0.9) * idleK;
    headPivot.rotation.y = 0.3 * Math.sin(t * 0.53) * idleK;

    /* deterministic idle blinks (sharp sin peaks ≈ every few seconds) */
    const blink = Math.sin(t * 1.31) > 0.988 || Math.sin(t * 0.97 + 2.1) > 0.992 ? 0.12 : 1;
    for (const eye of eyes) eye.scale.y = blink;

    /* ears: idle waggle, pinned back at speed / dash */
    const pin = Math.max(run01, dashK);
    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? -1 : 1;
      ears[i].rotation.z = s * (0.2 + 0.12 * Math.sin(t * 1.7 + s * 2.1) * idleK);
      ears[i].rotation.x = -0.55 * pin;
    }

    /* tail: swish speeds up with gait and excitement */
    const wag = Math.max(speed01, mooK, dashK);
    tailPivot.rotation.x = 0.35 + 0.1 * Math.sin(t * 1.3);
    tailPivot.rotation.z = Math.sin(t * (2.5 + 7 * wag)) * (0.25 + 0.4 * wag);

    /* squash & stretch spring (critically damped-ish) */
    const stretchTarget = grounded ? 1 : 1 + clamp(Math.abs(vy) * 0.02, 0, 0.16);
    squashV += (stretchTarget - squashP) * 90 * dt;
    squashV *= Math.exp(-11 * dt);
    squashP += squashV * dt;
    const sy = clamp(squashP, 0.62, 1.3);
    squash.scale.set(1 + (1 - sy) * 0.55, sy, 1 + (1 - sy) * 0.55);
    /* dash: extra forward stretch */
    squash.scale.z *= 1 + 0.22 * ease(dashK);

    /* double-jump front flip */
    if (flipT < FLIP_S) {
      flipT += dt;
      flip.rotation.x = TAU * ease(clamp(flipT / FLIP_S, 0, 1));
      if (flipT >= FLIP_S) flip.rotation.x = 0;
    }

    /* one-shot emotes */
    for (const k in emotes) if (emotes[k] < EMOTE_S[k]) emotes[k] += dt;
    const spinK = emotes.spin < EMOTE_S.spin ? ease(emotes.spin / EMOTE_S.spin) : 0;
    rig.rotation.y = spinK > 0 ? TAU * spinK : 0;
    const flexK = emotes.flex < EMOTE_S.flex ? Math.sin((emotes.flex / EMOTE_S.flex) * Math.PI) : 0;
    if (flexK > 0) {
      rootBone.scale.setScalar(1 + 0.13 * flexK);
      headPivot.rotation.x -= 0.28 * flexK;
    } else if (rootBone.scale.x !== 1) {
      rootBone.scale.setScalar(1);
    }
    const bowK = emotes.bow < EMOTE_S.bow ? Math.sin((emotes.bow / EMOTE_S.bow) * Math.PI) : 0;
    if (bowK > 0) {
      bodyPivot.rotation.x += 0.42 * bowK;
      headPivot.rotation.x += 0.3 * bowK;
    }
    const jitK = emotes.denoise < EMOTE_S.denoise ? 1 - emotes.denoise / EMOTE_S.denoise : 0;
    if (jitK > 0) {
      rig.position.x = (Math.sin(t * 71) * 0.5 + Math.sin(t * 113)) * 0.02 * jitK;
      rig.position.z = Math.sin(t * 93) * 0.02 * jitK;
    } else {
      rig.position.x = 0;
      rig.position.z = 0;
    }
    if (dashT < DASH_S + 1) dashT += dt;

    /* emissive tint decays on its own — eggs "wash" then fade */
    if (tintK > 0.003) {
      tintK *= Math.exp(-1.6 * dt);
      for (const m of tinted) {
        m.emissive.copy(tintColor);
        m.emissiveIntensity = tintK;
      }
    } else if (tinted[0].emissiveIntensity !== 0) {
      for (const m of tinted) m.emissiveIntensity = 0;
      tintK = 0;
    }

    /* blob shadow: counter the jump so it stays glued to the terrain */
    const air = pose.groundY != null ? Math.max(0, group.position.y - pose.groundY) : 0;
    shadow.position.y = (pose.groundY != null ? pose.groundY - group.position.y : 0) + 0.03;
    const k = 1 / (1 + air * 0.55);
    shadow.scale.setScalar(k);
    mats.shadow.opacity = 0.34 * k;
  }

  return {
    group,
    update,
    onJump(count) {
      squashV += count === 2 ? 3.2 : 2.4;   // stretch impulse upward
      if (count === 2) { flipT = 0; flip.rotation.x = 0; }
    },
    onLand(impact) {
      squashV -= clamp(impact * 0.28, 0.6, 3.4);  // squash impulse
    },
    onDash() { dashT = 0; },
    emote(name) { if (name in emotes) emotes[name] = 0; },
    setTint(color, k = 0.6) {
      tintColor.setHex(color);
      tintK = k;
    },
    dispose() {
      for (const g of geos) g.dispose();
      mats.shadow.map.dispose();
      for (const k in mats) mats[k].dispose();
    }
  };
}
