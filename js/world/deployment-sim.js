/* Station 08 deployment-loop clock.

   This module deliberately knows nothing about Three.js. The world renders the
   returned state, while tests can pin the reader-facing order without a GPU or
   browser: virtual capture -> recorded RGB -> recorded 3D -> simulated kg UI. */

export const DEPLOYMENT_PHASES = Object.freeze([
  Object.freeze({ id: "capture", start: 0.0, end: 3.0 }),
  Object.freeze({ id: "images", start: 3.0, end: 6.0 }),
  Object.freeze({ id: "reconstruct", start: 6.0, end: 10.0 }),
  Object.freeze({ id: "estimate", start: 10.0, end: 15.0 })
]);

export const DEPLOYMENT_PERIOD = DEPLOYMENT_PHASES.at(-1).end;
export const DEPLOYMENT_DEMO_KG = 480;

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (x) => {
  const k = clamp01(x);
  return k * k * (3 - 2 * k);
};

const PHOTO_WINDOWS = Object.freeze([
  Object.freeze([0.35, 1.50]),
  Object.freeze([1.05, 2.20]),
  Object.freeze([1.75, 2.90])
]);

/* A bright but brief shutter envelope. Keeping this in the simulation state
   lets fixed-step capture and real-time rendering see the same three flashes;
   Three.js only decides how to draw the strength. */
const shutterEnvelope = (age) => {
  if (age < 0 || age > 0.42) return 0;
  const attack = clamp01(age / 0.035);
  const decay = Math.exp(-Math.max(0, age - 0.035) / 0.105);
  return attack * decay;
};

export function deploymentStateAt(elapsed, { reducedMotion = false } = {}) {
  if (reducedMotion) {
    return {
      phase: "estimate", phaseIndex: 3, cycleTime: DEPLOYMENT_PHASES[3].start,
      phaseProgress: 1, captureProgress: 1, photoCount: 3,
      photoFlightProgress: [1, 1, 1],
      flashStrengths: [0, 0, 0], activeFlash: -1, cycleIndex: 0,
      pointFraction: 1, outputProgress: 1, weightReady: true,
      demoKg: DEPLOYMENT_DEMO_KG
    };
  }

  const safe = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
  const cycleIndex = Math.floor(safe / DEPLOYMENT_PERIOD);
  const cycleTime = safe % DEPLOYMENT_PERIOD;
  let phaseIndex = DEPLOYMENT_PHASES.findIndex(({ end }) => cycleTime < end);
  if (phaseIndex < 0) phaseIndex = DEPLOYMENT_PHASES.length - 1;
  const phaseDef = DEPLOYMENT_PHASES[phaseIndex];
  const phaseProgress = smooth(
    (cycleTime - phaseDef.start) / Math.max(phaseDef.end - phaseDef.start, 1e-6));

  const captureProgress = smooth(cycleTime / DEPLOYMENT_PHASES[0].end);
  /* Cameras hand off LEFT, RIGHT, TOP during the capture phase. Each photo
     follows its own flight to the conveyor; only an arrived image is counted
     on the carrier. By the images phase all three are aboard in source order. */
  const photoFlightProgress = PHOTO_WINDOWS.map(([start, end]) =>
    smooth((cycleTime - start) / (end - start)));
  const photoCount = photoFlightProgress.filter((p) => p >= 1).length;
  const flashStrengths = PHOTO_WINDOWS.map(([start]) =>
    shutterEnvelope(cycleTime - start));
  let activeFlash = -1;
  let activeFlashStrength = 0.04;
  flashStrengths.forEach((strength, i) => {
    if (strength > activeFlashStrength) {
      activeFlash = i;
      activeFlashStrength = strength;
    }
  });
  const pointFraction = smooth(
    (cycleTime - DEPLOYMENT_PHASES[2].start) /
    (DEPLOYMENT_PHASES[2].end - DEPLOYMENT_PHASES[2].start));
  /* In the spatial factory line the completed recorded 3D cow physically
     travels from the reconstruction chamber to estimation before kg appears. */
  const outputProgress = smooth(
    (cycleTime - DEPLOYMENT_PHASES[3].start) / 1.6);
  const weightReady = cycleTime >= DEPLOYMENT_PHASES[3].start + 1.6;

  return {
    phase: phaseDef.id, phaseIndex, cycleTime, phaseProgress,
    captureProgress, photoCount, photoFlightProgress,
    flashStrengths, activeFlash, cycleIndex,
    pointFraction, outputProgress, weightReady,
    demoKg: DEPLOYMENT_DEMO_KG
  };
}

/* Optional parked state for screenshots or other consumers that need a static
   final result. The live Station 08 exhibit deliberately uses stateAt directly
   so it loops while the visitor remains at the station. */
export function deploymentOneShotStateAt(elapsed, options = {}) {
  const safe = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
  return deploymentStateAt(Math.min(safe, DEPLOYMENT_PERIOD - 1e-3), options);
}

/* A reduced-motion visit still tells the deployment story once. Its semantic
   state advances normally, while shutter pulses are removed and the caller
   can render each stage without conveyor/flight motion. */
export function deploymentReducedMotionStateAt(elapsed) {
  const state = deploymentOneShotStateAt(elapsed);
  return { ...state, flashStrengths: [0, 0, 0], activeFlash: -1 };
}
