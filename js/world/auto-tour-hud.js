const LAST_STEP = 8;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function finiteOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function formatClock(seconds) {
  const whole = Math.max(0, Math.floor(finiteOr(seconds, 0)));
  const minutes = Math.floor(whole / 60);
  const remainder = whole % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function isEditableTarget(target) {
  return target instanceof Element &&
    (target.matches("input, textarea, select, [contenteditable]:not([contenteditable='false'])") ||
      !!target.closest("[contenteditable]:not([contenteditable='false'])"));
}

/**
 * Presentation layer for the interruptible, voice-paced ranch tour.
 * The world controller owns lifecycle and calls show(frame) from its clock.
 */
export function initAutoTourHud({ onTakeControl, onStart, onIntroEnter, onToggleVoice } = {}) {
  const root = document.getElementById("autoTourHud");
  const startButton = document.getElementById("btnAutoTour");
  const introStartButton = document.getElementById("btnAutoTourIntro");
  const takeControlButton = document.getElementById("autoTourTakeControl");
  const voiceButton = document.getElementById("autoTourVoice");
  const step = document.getElementById("autoTourStep");
  const title = document.getElementById("autoTourTitle");
  const narration = document.getElementById("autoTourNarration");
  const phase = document.getElementById("autoTourPhase");
  const time = document.getElementById("autoTourTime");
  const progressBar = document.getElementById("autoTourProgress");

  if (![root, startButton, introStartButton, takeControlButton, voiceButton,
        step, title, narration, phase, time, progressBar]
    .every(Boolean)) {
    throw new Error("Automatic tour HUD markup is incomplete");
  }

  const start = typeof onStart === "function" ? onStart : () => {};
  const takeControl = typeof onTakeControl === "function" ? onTakeControl : () => {};
  const toggleVoice = typeof onToggleVoice === "function" ? onToggleVoice : () => null;
  let available = false;
  let visible = false;
  let stepIndex = 0;
  let stepNumber = "00";
  let elapsed = 0;
  let progress = 0;
  let progressPercent = -1;
  let lastClock = "";
  let startRequests = 0;
  let takeControlRequests = 0;
  let voiceToggleRequests = 0;
  let voiceAvailable = false;
  let voiceEnabled = false;
  let voiceSpeaking = false;
  let voiceName = "";

  const applyVoiceState = (state = {}) => {
    voiceAvailable = !!state.available;
    voiceEnabled = voiceAvailable && !!state.enabled;
    voiceSpeaking = voiceEnabled && (!!state.speaking || !!state.queued);
    voiceName = String(state.lastVoice || "");
    voiceButton.disabled = !voiceAvailable;
    voiceButton.setAttribute("aria-pressed", String(voiceEnabled));
    voiceButton.textContent = !voiceAvailable
      ? "VOICE UNAVAILABLE"
      : voiceEnabled
        ? (state.captionMode ? "TEXT TOUR · AUDIO UNAVAILABLE" : voiceSpeaking ? "VOICE PLAYING" : "VOICE ON")
        : "TEXT TOUR · VOICE OFF";
    const voiceSuffix = voiceName ? ` · ${voiceName}` : "";
    voiceButton.title = !voiceAvailable
      ? "English browser voice is unavailable"
      : voiceEnabled
        ? `Mute English narration${voiceSuffix}`
        : `Enable English narration${voiceSuffix}`;
  };

  const updateStartLabel = () => {
    const action = visible ? "Restart" : "Start";
    startButton.setAttribute(
      "aria-label",
      `${action} the English narrated automatic tour. Keyboard shortcut T.`
    );
    startButton.title = `${action} English narrated automatic tour (T)`;
  };

  const requestStart = () => {
    if (!available) return;
    startRequests++;
    start();
  };

  startButton.addEventListener("click", requestStart);
  introStartButton.addEventListener("click", () => {
    if (!available) return;
    if (onIntroEnter) onIntroEnter();
    else requestStart();
  });
  takeControlButton.addEventListener("click", () => {
    takeControlRequests++;
    takeControl();
  });
  voiceButton.addEventListener("click", () => {
    voiceToggleRequests++;
    const state = toggleVoice();
    if (state) applyVoiceState(state);
  });

  window.addEventListener("keydown", (event) => {
    if (!available || event.defaultPrevented || event.repeat ||
        event.ctrlKey || event.altKey || event.metaKey ||
        event.key.toLowerCase() !== "t" || isEditableTarget(event.target)) return;
    event.preventDefault();
    requestStart();
  });

  return {
    show(frame = {}) {
      if (frame.voice) applyVoiceState(frame.voice);
      if (!visible) {
        visible = true;
        root.hidden = false;
        root.setAttribute("aria-hidden", "false");
        document.body.classList.add("auto-tour-active");
        updateStartLabel();
      }

      const nextStepIndex = clamp(Math.round(finiteOr(frame.stepIndex, stepIndex)), 0, LAST_STEP);
      const rawStepNumber = frame.stepNumber ?? String(nextStepIndex).padStart(2, "0");
      const nextStepNumber = String(rawStepNumber).padStart(2, "0");
      if (nextStepIndex !== stepIndex || nextStepNumber !== stepNumber) {
        stepIndex = nextStepIndex;
        stepNumber = nextStepNumber;
        step.textContent = stepNumber;
      }

      /* These are the only nodes inside the live region. Gate writes so the
         render loop cannot cause a screen reader to repeat every frame. */
      if (frame.title != null && String(frame.title) !== title.textContent) {
        title.textContent = String(frame.title);
      }
      if (frame.narration != null && String(frame.narration) !== narration.textContent) {
        narration.textContent = String(frame.narration);
      }
      if (frame.phase != null && String(frame.phase) !== phase.textContent) {
        phase.textContent = String(frame.phase);
      }

      elapsed = Math.max(0, finiteOr(frame.cycleElapsed, elapsed));
      progress = clamp(
        finiteOr(frame.progress, progress),
        0,
        1
      );

      const nextClock = `${formatClock(elapsed)} ELAPSED`;
      if (nextClock !== lastClock) {
        lastClock = nextClock;
        time.textContent = nextClock;
        time.dateTime = `PT${Math.floor(elapsed)}S`;
      }

      const nextPercent = Math.round(progress * 100);
      if (nextPercent !== progressPercent) {
        progressPercent = nextPercent;
        progressBar.style.setProperty("--tour-progress", `${nextPercent}%`);
        progressBar.setAttribute("aria-valuenow", String(nextPercent));
        progressBar.setAttribute("aria-valuetext", `${nextPercent} percent complete`);
      }
    },

    hide() {
      if (!visible) return;
      visible = false;
      root.hidden = true;
      root.setAttribute("aria-hidden", "true");
      document.body.classList.remove("auto-tour-active");
      updateStartLabel();
    },

    setAvailable(on) {
      available = !!on;
      startButton.hidden = !available;
      startButton.disabled = !available;
      startButton.setAttribute("aria-hidden", String(!available));
      introStartButton.disabled = !available;
      if (!available && document.activeElement === startButton) startButton.blur();
    },

    setVoiceState(state) { applyVoiceState(state); },

    get qaState() {
      return {
        available,
        visible,
        stepIndex,
        stepNumber,
        title: title.textContent,
        narration: narration.textContent,
        phase: phase.textContent,
        elapsed,
        progress,
        progressPercent,
        time: time.textContent,
        startRequests,
        takeControlRequests,
        voiceToggleRequests,
        voice: {
          available: voiceAvailable,
          enabled: voiceEnabled,
          speaking: voiceSpeaking,
          name: voiceName,
          label: voiceButton.textContent
        },
        bodyActive: document.body.classList.contains("auto-tour-active")
      };
    }
  };
}
