/* camera-flash.js — the shutter burst both RGB rigs fire when an animal walks
   under them: station 01's research gantry and station 08's weigh gate.

   A capture in this pipeline IS three synchronised shutters, so a rig fires as
   one unit rather than per camera. One envelope drives three things at once:

     - emissive spike on the shared lens material
     - a physical swell of the lens itself
     - an additive glow card per lens

   The emissive alone was not enough. ACES tone mapping rolls the highlight off
   hard, so pushing emissiveIntensity reads as "the lamp turned on", not as a
   flash. The swell and the additive card are what sell the shutter — brightness
   that also has SIZE is what the eye reads as a burst.

   The envelope is a pure function of (t, start): nothing has to thread dt in,
   and a tour seek can never leave the lamps stuck bright. */

import * as THREE from "../../vendor/three.module.js";

/* one 64² radial ramp behind every glow card in the world */
let glowTex = null;
function flashTexture() {
  if (glowTex) return glowTex;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0.00, "rgba(255,255,255,1)");
  g.addColorStop(0.18, "rgba(255,248,230,0.9)");
  g.addColorStop(0.48, "rgba(255,214,140,0.28)");
  g.addColorStop(1.00, "rgba(255,190,90,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c);
  glowTex.colorSpace = THREE.SRGBColorSpace;
  return glowTex;
}

export const FLASH_DEFAULTS = {
  peak: 16,        // emissiveIntensity at the top of a pulse
  swell: 1.15,     // extra lens radius, ×k
  glow: 1.25,      // world size of the glow card at full pulse
  pulses: 3,       // a burst, not a blink — this rig takes three views
  gap: 0.13,       // seconds between pulses
  decay: 0.075     // e-folding time of one pulse
};

export function createCameraFlash({
  lensMaterial,          // shared emissive material of this rig's lenses
  lenses = [],           // lens meshes (cylinders with a local +Y axis)
  contains,              // (worldPos) => boolean — is the subject under the rig
  ...opts
} = {}) {
  const O = { ...FLASH_DEFAULTS, ...opts };
  const base = lensMaterial.emissiveIntensity ?? 0;
  const span = O.pulses * O.gap + 0.4;

  /* One SpriteMaterial for the whole rig: the cameras always fire together, so
     they always share an opacity, and sprites already share the ramp texture. */
  const glowMat = new THREE.SpriteMaterial({
    map: flashTexture(),
    blending: THREE.AdditiveBlending,
    transparent: true, depthWrite: false, opacity: 0, fog: false
  });
  const cards = lenses.map((lens) => {
    const card = new THREE.Sprite(glowMat);
    card.visible = false;
    card.renderOrder = 3;
    /* hung off the lens's PARENT, not the lens: the lens scale is animated and
       a child sprite would compound the swell into its own size */
    (lens.parent || lens).add(card);
    card.position.copy(lens.position);
    return card;
  });

  /* A COUNT, not a flag. With one subject these are the same thing, but the
     weigh gate watches two: a calf parked under the rig would otherwise latch
     the flag true and silently swallow the herd cow's arrival for as long as
     the visitor stood there. Firing on a rising count means every new animal
     gets its capture regardless of who else is loitering. */
  let start = -Infinity, inside = 0, k = 0;

  function envelope(age) {
    if (!(age >= 0 && age < span)) return 0;
    let v = 0;
    for (let i = 0; i < O.pulses; i++) {
      const d = age - i * O.gap;
      if (d >= 0) v = Math.max(v, Math.exp(-d / O.decay));
    }
    return v;
  }

  function apply(next) {
    k = next;
    lensMaterial.emissiveIntensity = base + (O.peak - base) * k;
    const s = 1 + O.swell * k;
    for (const lens of lenses) lens.scale.set(s, 1, s);
    const on = k > 0.004;
    glowMat.opacity = Math.min(1, k * 1.2);
    const g = O.glow * (0.4 + 0.6 * k);
    for (const card of cards) {
      card.visible = on;
      card.scale.set(g, g, 1);
    }
  }

  return {
    /* Edge-triggered: standing under the rig must not machine-gun, but walking
       out and back in is a fresh capture and should fire again. `subject` may
       be one position or several — the weigh gate watches both the driven calf
       and the herd cow that walks its lane. */
    tick(t, subject) {
      const list = !subject ? [] : (Array.isArray(subject) ? subject : [subject]);
      let n = 0;
      for (const p of list) if (p && contains(p)) n++;
      if (n > inside) start = t;
      inside = n;
      const next = envelope(t - start);
      if (next !== k) apply(next);
    },
    /* fire without a subject — for scripted moments and QA */
    fire(t) { start = t; },
    /* when the current burst began, so callers can hang their own beats
       (station 01's photo boards) off the same clock */
    get startedAt() { return start; },
    get state() {
      return { inZone: inside > 0, inside, k, emissive: lensMaterial.emissiveIntensity };
    }
  };
}
