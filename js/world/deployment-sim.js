/* Station 08 deployment-loop clock.

   This module deliberately knows nothing about Three.js. The world renders the
   returned state, while tests can pin the reader-facing order without a GPU or
   browser: virtual capture -> recorded RGB -> recorded 3D -> simulated kg UI. */

export const DEPLOYMENT_PHASES = Object.freeze([
  Object.freeze({ id: "capture", start: 0.0, end: 2.0 }),
  Object.freeze({ id: "images", start: 2.0, end: 4.2 }),
  Object.freeze({ id: "reconstruct", start: 4.2, end: 7.0 }),
  Object.freeze({ id: "estimate", start: 7.0, end: 12.0 })
]);

export const DEPLOYMENT_PERIOD = DEPLOYMENT_PHASES.at(-1).end;
export const DEPLOYMENT_DEMO_KG = 480;

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (x) => {
  const k = clamp01(x);
  return k * k * (3 - 2 * k);
};

/* Pure spatial trigger used by the Three.js world. Keeping the distance test
   here makes the roam-to-factory handoff independently testable without a
   renderer or a browser. */
export function deploymentProximity(subject, trigger) {
  const sx = subject?.x, sz = subject?.z;
  const tx = trigger?.x, tz = trigger?.z, radius = trigger?.radius;
  if (![sx, sz, tx, tz, radius].every(Number.isFinite) || radius < 0) {
    return { inside: false, distance: Infinity };
  }
  const distance = Math.hypot(sx - tx, sz - tz);
  return { inside: distance <= radius, distance };
}

export function deploymentStateAt(elapsed, { reducedMotion = false } = {}) {
  if (reducedMotion) {
    return {
      phase: "estimate", phaseIndex: 3, cycleTime: DEPLOYMENT_PHASES[3].start,
      phaseProgress: 1, captureProgress: 1, photoCount: 3,
      photoFlightProgress: [1, 1, 1],
      pointFraction: 1, outputProgress: 1, weightReady: true,
      demoKg: DEPLOYMENT_DEMO_KG
    };
  }

  const safe = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
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
  const photoWindows = [[0.18, 1.00], [0.56, 1.38], [0.94, 1.76]];
  const photoFlightProgress = photoWindows.map(([start, end]) =>
    smooth((cycleTime - start) / (end - start)));
  const photoCount = photoFlightProgress.filter((p) => p >= 1).length;
  const pointFraction = smooth(
    (cycleTime - DEPLOYMENT_PHASES[2].start) /
    (DEPLOYMENT_PHASES[2].end - DEPLOYMENT_PHASES[2].start));
  /* In the spatial factory line the completed recorded 3D cow physically
     travels from the reconstruction chamber to estimation before kg appears. */
  const outputProgress = smooth(
    (cycleTime - DEPLOYMENT_PHASES[3].start) / 1.2);
  const weightReady = cycleTime >= DEPLOYMENT_PHASES[3].start + 1.2;

  return {
    phase: phaseDef.id, phaseIndex, cycleTime, phaseProgress,
    captureProgress, photoCount, photoFlightProgress,
    pointFraction, outputProgress, weightReady,
    demoKg: DEPLOYMENT_DEMO_KG
  };
}

/* Interactive triggers run once and park on the finished kg result. The base
   stateAt function remains cyclic for authored timeline use and pure phase
   inspection; callers that represent a visitor-triggered machine use this. */
export function deploymentOneShotStateAt(elapsed, options = {}) {
  const safe = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
  return deploymentStateAt(Math.min(safe, DEPLOYMENT_PERIOD - 1e-3), options);
}
