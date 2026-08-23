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
const PIXEL_RATIO_FLOOR = { low: 0.8, mid: 1, high: 1 };

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
    /* Static signals choose the ceiling; sustained frame time chooses where the
       live renderer sits below it. Never supersample a 1x display, and keep the
       floor explicit so a slow high-DPR device can shed fill-rate without
       silently turning the world into a permanently blurry canvas. */
    pixelRatioFloor: Math.min(
      devicePixelRatio,
      PIXEL_RATIO_CAP[tier],
      PIXEL_RATIO_FLOOR[tier]
    ),
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

/* Runtime fill-rate governor. The hardware hints above are necessarily coarse:
   a phone may have a fast GPU, while a Retina laptop can be thermally limited.
   This pure state machine reacts only after a sustained window, changes one
   small DPR step at a time, and waits much longer before restoring quality.
   `observe()` returns a new ratio only when the renderer needs reallocation. */
export class AdaptivePixelRatio {
  constructor({
    maxPixelRatio = 1,
    minPixelRatio = 1,
    enabled = true,
    /* RAF cadence includes the display refresh cap. Treating 30/40 Hz as GPU
       overload would lower resolution without buying a single extra frame, so
       only sustained sub-25-fps delivery steps down. Conversely, 16.67 ms is a
       healthy 60 Hz frame and must be allowed to restore quality. */
    slowFrameMs = 40,
    fastFrameMs = 17.5,
    slowWindowMs = 1400,
    fastWindowMs = 6000,
    cooldownMs = 1800,
    downStep = 0.25,
    upStep = 0.125,
    smoothing = 0.08
  } = {}) {
    this.maxPixelRatio = Math.max(0.5, maxPixelRatio);
    this.minPixelRatio = Math.min(
      this.maxPixelRatio,
      Math.max(0.5, minPixelRatio)
    );
    this.currentPixelRatio = this.maxPixelRatio;
    this.enabled = enabled && this.maxPixelRatio > this.minPixelRatio;
    this.slowFrameMs = slowFrameMs;
    this.fastFrameMs = Math.min(fastFrameMs, slowFrameMs);
    this.slowWindowMs = slowWindowMs;
    this.fastWindowMs = fastWindowMs;
    this.cooldownDurationMs = cooldownMs;
    this.downStep = downStep;
    this.upStep = upStep;
    this.smoothing = smoothing;
    this.changes = 0;
    this.resetWindow();
  }

  resetWindow() {
    this.ewmaFrameMs = null;
    this.slowAccumMs = 0;
    this.fastAccumMs = 0;
    this.cooldownMs = 0;
    this.longFrameStreak = 0;
  }

  setEnabled(on, { resetRatio = false } = {}) {
    this.enabled = !!on && this.maxPixelRatio > this.minPixelRatio;
    this.resetWindow();
    if (!resetRatio || this.currentPixelRatio === this.maxPixelRatio) return null;
    this.currentPixelRatio = this.maxPixelRatio;
    return this.currentPixelRatio;
  }

  observe(frameMs) {
    /* Ignore tab restores, debugger pauses and first-load stalls: reducing the
       drawing buffer cannot repair a one-off 500 ms network/decode pause. Two
       consecutive long frames, however, are a genuine very-slow renderer and
       must be allowed to downshift instead of getting ignored forever. */
    if (!this.enabled || !Number.isFinite(frameMs) || frameMs <= 0 || frameMs > 1000) {
      return null;
    }
    if (frameMs > 250) {
      this.longFrameStreak += 1;
      if (this.longFrameStreak < 2) return null;
    } else {
      this.longFrameStreak = 0;
    }
    const sampleMs = Math.min(frameMs, 100);

    this.ewmaFrameMs = this.ewmaFrameMs === null
      ? sampleMs
      : this.ewmaFrameMs + (sampleMs - this.ewmaFrameMs) * this.smoothing;

    if (this.cooldownMs > 0) {
      this.cooldownMs = Math.max(0, this.cooldownMs - sampleMs);
      return null;
    }

    if (this.ewmaFrameMs > this.slowFrameMs) {
      this.slowAccumMs += sampleMs;
      this.fastAccumMs = 0;
    } else if (this.ewmaFrameMs < this.fastFrameMs) {
      this.fastAccumMs += sampleMs;
      this.slowAccumMs = Math.max(0, this.slowAccumMs - sampleMs * 0.5);
    } else {
      this.slowAccumMs = Math.max(0, this.slowAccumMs - sampleMs * 0.25);
      this.fastAccumMs = Math.max(0, this.fastAccumMs - sampleMs * 0.5);
    }

    let next = null;
    if (this.slowAccumMs >= this.slowWindowMs &&
        this.currentPixelRatio > this.minPixelRatio) {
      next = Math.max(this.minPixelRatio, this.currentPixelRatio - this.downStep);
    } else if (this.fastAccumMs >= this.fastWindowMs &&
               this.currentPixelRatio < this.maxPixelRatio) {
      next = Math.min(this.maxPixelRatio, this.currentPixelRatio + this.upStep);
    }

    if (next === null || Math.abs(next - this.currentPixelRatio) < 1e-6) return null;
    this.currentPixelRatio = next;
    this.slowAccumMs = 0;
    this.fastAccumMs = 0;
    this.cooldownMs = this.cooldownDurationMs;
    this.changes += 1;
    return next;
  }

  get stats() {
    return {
      enabled: this.enabled,
      currentPixelRatio: this.currentPixelRatio,
      minPixelRatio: this.minPixelRatio,
      maxPixelRatio: this.maxPixelRatio,
      ewmaFrameMs: this.ewmaFrameMs,
      changes: this.changes,
      cooldownMs: this.cooldownMs
    };
  }
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
