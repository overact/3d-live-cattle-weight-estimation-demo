/* Interruptible cattle-led paper tour.

   This module owns presentation policy only: narration, completion state, and
   step order. It knows nothing about Three.js or the DOM. Movement and input
   stay behind the injected roam contract, so manual and automatic control
   always drive the same cattle rig and collision path. */

export const AUTO_TOUR_KEY = "KeyT";

export const AUTO_TOUR_STEPS = Object.freeze([
  {
    index: 0, number: "00", title: "From three views to one weight.",
    narration: "Welcome to Agreement Ranch. How can three photos help estimate a cow's weight? Follow one animal from left, right, and top views to a shared 3D shape, body measurements, and a weight estimate. Along the way, we will stop at two comparison exhibits.",
    speech: "Welcome to Agreement Ranch. How can three photos help estimate a cow's weight? Follow one animal from left, right, and top views to a shared three D shape, body measurements, and a weight estimate. Along the way, we will stop at two comparison exhibits.",
  },
  {
    index: 1, number: "01", title: "Capture three views at once.",
    narration: "We start with matched left, right, and top RGB views of the same animal. Each view reveals a different part of the body. Together, they give reconstruction more information than one image alone.",
    speech: "We start with matched left, right, and top R G B views of the same animal. Each view reveals a different part of the body. Together, they give reconstruction more information than one image alone.",
  },
  {
    index: 2, number: "02", title: "Isolate the animal.",
    narration: "Next, SAM 3 separates the cattle from the background in every image. Grass, fences, and sky fall away, leaving clean silhouettes for reconstruction.",
    speech: "Next, Sam three separates the cattle from the background in every image. Grass, fences, and sky fall away, leaving clean silhouettes for reconstruction.",
  },
  {
    index: 3, number: "03", title: "Build a single-view reference.",
    narration: "First, a comparison: what can one image produce? This recorded single-view run builds a coarse shape in fifty steps, then refines it in twenty-five more. It is our baseline. Next, we will start from all three images and reconstruct them together.",
    speech: "First, a comparison: what can one image produce? This recorded single-view run builds a coarse shape in fifty steps, then refines it in twenty-five more. It is our baseline. Next, we will start from all three images and reconstruct them together.",
  },
  {
    index: 4, number: "04", title: "Fuse the views by agreement.",
    narration: "Here is our main idea: views that agree get more influence. At each step, the three views propose updates. We compare them with their shared average and give closer updates more weight. This fusion builds and refines one shared 3D animal across both stages. The colored field shows agreement during Stage 1.",
    speech: "Here is our main idea: views that agree get more influence. At each step, the three views propose updates. We compare them with their shared average and give closer updates more weight. This fusion builds and refines one shared three D animal across both stages. The colored field shows agreement during stage one.",
  },
  {
    index: 5, number: "05", title: "Compare five reconstruction routes.",
    narration: "With the reconstructions ready, we place five routes side by side: agreement fusion, simple averaging, entropy weighting, TRELLIS.2, and RGB plus depth. Each route continues through the same feature extraction and weight estimator, making the final results easy to compare.",
    speech: "With the reconstructions ready, we place five routes side by side. Agreement fusion, simple averaging, entropy weighting, Trellis point two, and R G B plus depth. Each route continues through the same feature extraction and weight estimator, making the final results easy to compare.",
  },
  {
    index: 6, number: "06", title: "Turn geometry into measurements.",
    narration: "How does shape become kilograms? We extract dimensions, volume-related features, density, and shape statistics. Eleven regression models predict weight from the same feature vector. A final Ridge model combines their predictions. Here, normalized-space overlays make those feature groups easy to inspect.",
    speech: "How does shape become kilograms? We extract dimensions, volume-related features, density, and shape statistics. Eleven regression models predict weight from the same feature vector. A final Ridge model combines their predictions. Here, normalized-space overlays make those feature groups easy to inspect.",
  },
  {
    index: 7, number: "07", title: "See the result across 103 cattle.",
    narration: "Across 103 cattle and five-fold cross-validation, agreement fusion reaches a MAPE of 2.22% and an R² of 0.69. Those figures summarize the full journey from images to estimated weight.",
    speech: "Across 103 cattle and five-fold cross validation, agreement fusion reaches a MAPE of 2.22 percent and an R squared of 0.69. Those figures summarize the full journey from images to estimated weight.",
  },
  {
    index: 8, number: "08", title: "Watch the full pipeline run.",
    narration: "To finish, imagine the workflow on a farm: capture three views, reconstruct the animal, measure its shape, and estimate its weight. This deployment animation uses our recorded example, with an illustrative 480 kg display. The idea is simple: three images, useful 3D geometry, one weight estimate.",
    speech: "To finish, imagine the workflow on a farm: capture three views, reconstruct the animal, measure its shape, and estimate its weight. This deployment animation uses our recorded example, with an illustrative four hundred and eighty kilogram display. The idea is simple: three images, useful three D geometry, one weight estimate.",
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
  let exhibitMessage = "";
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
    exhibitMessage = state.message || "";
    completion.narration ||= !!state.narration;
    completion.exhibit ||= !!state.exhibit;
  }

  function snapshot() {
    const current = step();
    return {
      active,
      phase,
      phaseLabel: exhibitMessage || (phase === "approach"
        ? `RUNNING TO STEP ${current.number}`
        : completion.narration && !completion.exhibit
          ? `WATCHING STEP ${current.number}`
          : `EXPLAINING STEP ${current.number}`),
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
    exhibitMessage = "";
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
      exhibitMessage = "";
      lastStopReason = null;
      travelTo(stepIndex);
      emitState("start");
      emitFrame();
      return stepIndex;
    },

    selectStep(nextIndex) {
      if (!active) return false;
      cancelTravel();
      startIndex = clampTourStepIndex(nextIndex);
      completedSteps = 0; cycleElapsed = 0;
      // A new narration visit, not a stop/start of the presentation mode.
      // The voice adapter clears its dedupe key even when reselecting a Step.
      beginApproach(startIndex, "start");
      emitFrame();
      return true;
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
