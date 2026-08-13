/* device-tier.js — one place to decide how much world a device can afford.

   The renderer, the reconstruction point clouds and the exhibit culler all
   need the same answer to "is this a phone?". Deciding it three times is how
   a build ends up rendering at devicePixelRatio 3 while carefully thinning a
   point cloud that was never the bottleneck.

   `planQuality` is a pure function of measured signals so the policy can be
   unit-tested; `readDeviceSignals` is the only part that touches globals. */

/* Fill rate is the phone bottleneck, and it scales with the SQUARE of the
   pixel ratio: a stock 1080p phone reports devicePixelRatio 3, so an
   unclamped canvas draws 9x the fragments of a CSS-pixel one. Clamping to
   1.5 is the single largest mobile win available here and costs far less
   perceived sharpness than the number suggests, because the panel's physical
   pixels are tiny. */
const PIXEL_RATIO_CAP = { low: 1.5, mid: 1.75, high: 2 };

/* Gaussians per latent voxel to DRAW at each tier. null = draw whatever the
   trace carries. These only bite once a dense trace is exported; against the
   legacy one-per-voxel payload every tier already draws everything. */
const STAGE2_DENSITY = { low: 4, mid: null, high: null };

export function planQuality(signals = {}) {
  const {
    devicePixelRatio = 1,
    viewportWidth = 1920,
    viewportHeight = 1080,
    coarsePointer = false,
    hardwareConcurrency = 8,
    deviceMemory = 8,
    reducedMotion = false,
    forceTier = null,
    s2blend = null
  } = signals;

  const shortEdge = Math.min(viewportWidth, viewportHeight);
  /* A touch device is not automatically weak — a tablet or a touchscreen
     laptop is fine. Pair the coarse pointer with a second signal before
     dropping quality, so desktops with touchscreens are not punished. */
  const weak = hardwareConcurrency <= 4 || deviceMemory <= 4;
  const phoneSized = shortEdge <= 480;

  let tier = "high";
  if (coarsePointer && (phoneSized || weak)) tier = "low";
  else if (coarsePointer || weak) tier = "mid";
  /* ?tier=low is how QA and a presenter on an unknown booth machine exercise
     the degraded path deliberately; an unrecognised value is ignored rather
     than trusted. */
  if (forceTier && Object.hasOwn(PIXEL_RATIO_CAP, forceTier)) tier = forceTier;

  return {
    tier,
    pixelRatio: Math.min(devicePixelRatio, PIXEL_RATIO_CAP[tier]),
    /* MSAA multiplies the very fragment work the pixel-ratio cap is trying to
       reduce, so the weakest tier trades edge quality for frame rate. */
    antialias: tier !== "low",
    stage2Density: STAGE2_DENSITY[tier],
    /* Stage-2 soft-disc composite mode: "additive" is the kept A/B lever
       (?s2blend=additive); anything else means the shipped normal blending. */
    stage2Blending: s2blend === "additive" ? "additive" : "normal",
    /* Someone who asked the OS for less motion is not necessarily on a weak
       device, but the request rides along here so callers read one object. */
    reducedMotion
  };
}

export function readDeviceSignals(view = globalThis) {
  const nav = view.navigator || {};
  const mq = (query) =>
    typeof view.matchMedia === "function" ? view.matchMedia(query).matches : false;
  return {
    devicePixelRatio: view.devicePixelRatio || 1,
    viewportWidth: view.innerWidth || 1920,
    viewportHeight: view.innerHeight || 1080,
    coarsePointer: mq("(pointer: coarse)"),
    hardwareConcurrency: nav.hardwareConcurrency || 8,
    /* Chrome-only; absent on Safari/Firefox, where 8 keeps us out of the
       low tier on a signal we genuinely cannot read. */
    deviceMemory: nav.deviceMemory || 8,
    reducedMotion: mq("(prefers-reduced-motion: reduce)"),
    forceTier: new URLSearchParams(view.location?.search || "").get("tier")
  };
}

export function detectQuality(view = globalThis) {
  return planQuality(readDeviceSignals(view));
}
