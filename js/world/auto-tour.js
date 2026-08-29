/* Interruptible cattle-led paper tour.

   This module owns presentation policy only: narration, completion state, and
   step order. It knows nothing about Three.js or the DOM. Movement and input
   stay behind the injected roam contract, so manual and automatic control
   always drive the same cattle rig and collision path. */

export const AUTO_TOUR_KEY = "KeyT";

export const AUTO_TOUR_STEPS = Object.freeze([
  {
    index: 0, number: "00", title: "From three views to one weight.",
    narration: "Welcome to Agreement Ranch. We start with three RGB images—left, right, and top—and follow them through reconstruction, measurement, and weight estimation. By the end of the tour, those three views become one number in kilograms.",
    speech: "Welcome to Agreement Ranch. We start with three R G B images, from the left, right, and top, and follow them through reconstruction, measurement, and weight estimation. By the end of the tour, those three views become one number in kilograms.",
  },
  {
    index: 1, number: "01", title: "Capture three views at once.",
    narration: "First, three synchronized cameras photograph the animal from the left, right, and top. Each camera sees a different part of the body, and together the views provide a fuller picture of its shape.",
    speech: "First, three synchronized cameras photograph the animal from the left, right, and top. Each camera sees a different part of the body, and together the views provide a fuller picture of its shape.",
  },
  {
    index: 2, number: "02", title: "Isolate the animal.",
    narration: "Next, SAM 3 separates the cattle from the background in every image. Grass, fences, and sky fall away, leaving clean silhouettes for reconstruction.",
    speech: "Next, Sam three separates the cattle from the background in every image. Grass, fences, and sky fall away, leaving clean silhouettes for reconstruction.",
  },
  {
    index: 3, number: "03", title: "Build a single-view reference.",
    narration: "We begin reconstruction with a single view. Fifty steps establish the coarse body shape, and twenty-five more sharpen the geometry. This gives us a clear reference for what one image can produce.",
    speech: "We begin reconstruction with a single view. Fifty steps establish the coarse body shape, and twenty-five more sharpen the geometry. This gives us a clear reference for what one image can produce.",
  },
  {
    index: 4, number: "04", title: "Fuse the views by agreement.",
    narration: "Now the other views join in. When their updates point to the same geometry, the method gives them more influence. When they conflict, it gives them less. That agreement forms the shared body shape, which a second stage then refines.",
    speech: "Now the other views join in. When their updates point to the same geometry, the method gives them more influence. When they conflict, it gives them less. That agreement forms the shared body shape, which a second stage then refines.",
  },
  {
    index: 5, number: "05", title: "Compare five reconstruction routes.",
    narration: "With the reconstructions ready, we place five routes side by side: agreement fusion, simple averaging, entropy weighting, TRELLIS.2, and RGB plus depth. Each route continues through the same feature extraction and weight estimator, making the final results easy to compare.",
    speech: "With the reconstructions ready, we place five routes side by side. Agreement fusion, simple averaging, entropy weighting, Trellis point two, and R G B plus depth. Each route continues through the same feature extraction and weight estimator, making the final results easy to compare.",
  },
  {
    index: 6, number: "06", title: "Turn geometry into measurements.",
    narration: "The point cloud now becomes a compact set of body measurements: length, width, height, volume, density, and shape statistics. Together, these measurements form the feature vector used by the weight regressor.",
    speech: "The point cloud now becomes a compact set of body measurements. Length, width, height, volume, density, and shape statistics. Together, these measurements form the feature vector used by the weight regressor.",
  },
  {
    index: 7, number: "07", title: "See the result across 103 cattle.",
    narration: "Across 103 cattle and five-fold cross-validation, agreement fusion reaches a MAPE of 2.22% and an R² of 0.69. Those figures summarize the full journey from images to estimated weight.",
    speech: "Across 103 cattle and five-fold cross validation, agreement fusion reaches a MAPE of 2.22 percent and an R squared of 0.69. Those figures summarize the full journey from images to estimated weight.",
  },
  {
    index: 8, number: "08", title: "Watch the full pipeline run.",
    narration: "To finish, watch the whole pipeline move as one. Three cameras capture the animal, reconstruction builds the point cloud, feature extraction measures the body, and the display settles at 480 kg. Three images in; one weight estimate out.",
    speech: "To finish, watch the whole pipeline move as one. Three cameras capture the animal, reconstruction builds the point cloud, feature extraction measures the body, and the display settles at 480 kilograms. Three images in. One weight estimate out.",
    /* The deployment line itself supplies the completion event. The cattle
       remains standing; no authored emote competes with the hand-off. */
  }
]);

export function clampTourStepIndex(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(AUTO_TOUR_STEPS.length - 1, Math.max(0, Math.round(parsed)));
}

export function createAutoTour({
  travelTo = () => {},
  press = () => {},
  getRoamState = () => ({}),
  getCompletionState = () => ({ narration: true, exhibit: true }),
  cancelTravel = () => {},
  onFrame = () => {},
  onState = () => {}
} = {}) {
  let active = false;
  let stepIndex = 0;
  let startIndex = 0;
  let phase = "idle";
  let phaseElapsed = 0;
  let cycleElapsed = 0;
  let wallElapsed = 0;
  let cycleNumber = 0;
  let completedSteps = 0;
  let completion = { narration: false, exhibit: false };
  let lastStopReason = null;

  const step = () => AUTO_TOUR_STEPS[stepIndex];
  const arrived = () => {
    const state = getRoamState() || {};
    return state.nearStation === stepIndex &&
      state.grounded !== false && state.autoTarget == null;
  };

  /* Promise.all semantics without allocating promises in the render loop.
     Each signal is latched: a looping exhibit may move on after reaching its
     result, but that completion event still counts for the current visit. */
  function latchCompletion() {
    if (phase !== "dwell") return;
    const state = getCompletionState({ stepIndex, step: step(), completion }) || {};
    completion.narration ||= !!state.narration;
    completion.exhibit ||= !!state.exhibit;
  }

  function snapshot() {
    const current = step();
    return {
      active,
      phase,
      phaseLabel: phase === "approach"
        ? `RUNNING TO STEP ${current.number}`
        : completion.narration && !completion.exhibit
          ? `WATCHING STEP ${current.number}`
          : `EXPLAINING STEP ${current.number}`,
      stepIndex,
      stepNumber: current.number,
      title: current.title,
      narration: current.narration,
      speech: current.speech,
      phaseElapsed,
      cycleElapsed,
      progress: Math.min(1, completedSteps / AUTO_TOUR_STEPS.length),
      wallElapsed,
      cycleNumber,
      completedSteps,
      startIndex,
      completion: { ...completion },
      lastStopReason
    };
  }

  function emitFrame() {
    const state = snapshot();
    onFrame({ ...state, phase: state.phaseLabel });
  }

  function emitState(type, extra = {}) {
    onState({ type, ...snapshot(), ...extra });
  }

  function beginApproach(nextIndex, eventType = "phase") {
    stepIndex = clampTourStepIndex(nextIndex);
    phase = "approach";
    phaseElapsed = 0;
    completion = { narration: false, exhibit: false };
    travelTo(stepIndex);
    emitState(eventType);
  }

  function beginDwell() {
    phase = "dwell";
    phaseElapsed = 0;
    completion = { narration: false, exhibit: false };
    emitState("phase");
  }

  function finishDwell() {
    completedSteps += 1;
    const nextIndex = (stepIndex + 1) % AUTO_TOUR_STEPS.length;
    if (completedSteps >= AUTO_TOUR_STEPS.length) {
      completedSteps = 0;
      cycleElapsed = 0;
      cycleNumber += 1;
      emitState("cycle");
    }
    beginApproach(nextIndex);
  }

  return {
    start(nearestStep = 0) {
      if (active) this.stop("restart");
      active = true;
      startIndex = clampTourStepIndex(nearestStep);
      stepIndex = startIndex;
      phase = "approach";
      phaseElapsed = 0;
      cycleElapsed = 0;
      wallElapsed = 0;
      cycleNumber = 0;
      completedSteps = 0;
      completion = { narration: false, exhibit: false };
      lastStopReason = null;
      travelTo(stepIndex);
      emitState("start");
      emitFrame();
      return stepIndex;
    },

    stop(reason = "manual") {
      if (!active) return false;
      active = false;
      lastStopReason = reason;
      cancelTravel();
      for (const action of ["run", "jump", "dash"]) press(action, false);
      emitState("stop", { reason });
      emitFrame();
      return true;
    },

    update(dt) {
      if (!active || !Number.isFinite(dt) || dt <= 0) return snapshot();
      wallElapsed += dt;
      cycleElapsed += dt;
      phaseElapsed += dt;

      if (phase === "approach") {
        if (arrived()) beginDwell();
      } else {
        latchCompletion();
        if (completion.narration && completion.exhibit) finishDwell();
      }
      emitFrame();
      return snapshot();
    },

    get active() { return active; },
    get qaState() { return snapshot(); }
  };
}
