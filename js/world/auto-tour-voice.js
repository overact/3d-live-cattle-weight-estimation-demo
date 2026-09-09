/* English voice-over adapter for the interactive auto tour.

   Speech is driven by director state transitions rather than render frames:
   narration begins once the cattle reaches a Step, is cancelled before the
   next run, and stops synchronously when the visitor takes control. */

export function createAutoTourVoice({
  Audio = globalThis.Audio,
  now = () => performance.now()
} = {}) {
  const available = typeof Audio === "function";
  let enabled = available;
  let speaking = false;
  let queued = false;
  let requests = 0;
  let completions = 0;
  let cancellations = 0;
  let lastKey = null;
  let lastText = "";
  let lastVoice = "";
  let lastError = "";
  let current = null;
  let startedAt = 0;
  let readingMs = 0;
  let finished = false;
  let generation = 0;
  let audio = null;

  function cancel() {
    generation += 1; // late callbacks from cancelled audio cannot release a new Step
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      audio = null;
    }
    cancellations += 1;
    speaking = false;
    queued = false;
  }

  function speak(state) {
    if (state?.phase !== "dwell") return false;
    // Keep the spoken transcript available to the HUD and caption fallback.
    const text = String(state.speech || state.narration || "").trim();
    if (!text) return false;
    const key = `${state.cycleNumber ?? 0}:${state.completedSteps ?? 0}:${state.stepIndex ?? 0}`;
    if (key === lastKey) return false;
    cancel();
    lastKey = key;
    lastText = text;
    lastError = "";
    current = state;
    startedAt = now();
    readingMs = Math.max(5000, text.split(/\s+/).length / 145 * 60000 + 1000);
    finished = false;
    if (!available || !enabled) return true; // readable, paced captions without audio
    const requestGeneration = generation;
    const fail = (error) => {
      if (requestGeneration !== generation) return;
      cancel();
      lastError = error;
    };
    if (!Number.isInteger(state.stepIndex) || state.stepIndex < 0 || state.stepIndex > 8) {
      fail("audio-step-unavailable");
      return true;
    }
    lastVoice = "Sulafat";
    queued = true;
    requests += 1;
    try {
      const clip = new Audio(new URL(
        `../../assets/audio/sulafat/step-${String(state.stepIndex).padStart(2, "0")}.mp3`,
        import.meta.url
      ).href);
      audio = clip;
      clip.preload = "auto";
      clip.onloadedmetadata = () => {
        if (requestGeneration !== generation) return;
        if (Number.isFinite(clip.duration)) readingMs = Math.max(readingMs, clip.duration * 1000 + 1000);
      };
      clip.onplaying = () => {
        if (requestGeneration !== generation) return;
        speaking = true; queued = false;
      };
      clip.onended = () => {
        if (requestGeneration !== generation) return;
        speaking = false;
        queued = false;
        finished = true;
        completions += 1;
      };
      clip.onerror = () => fail("audio-load-failed");
      clip.play()?.catch(() => fail("audio-play-failed"));
    } catch {
      fail("audio-play-failed");
    }
    return true;
  }

  return {
    handleState(state = {}) {
      if (state.type === "start") {
        cancel();
        current = null;
        lastKey = null;
      } else if (state.type === "stop" ||
                 (state.type === "phase" && state.phase === "approach")) {
        cancel();
        current = null;
      } else if (state.type === "phase" && state.phase === "dwell") {
        speak(state);
      }
      return this.qaState;
    },

    toggle(currentState = null) {
      if (!available) return this.qaState;
      enabled = !enabled;
      if (!enabled) cancel();
      else {
        lastKey = null;
        speak(currentState || current);
      }
      return this.qaState;
    },

    stop() { cancel(); current = null; },

    get qaState() {
      const elapsed = now() - startedAt;
      if (current && ((queued && elapsed > 15000) ||
          (speaking && elapsed > readingMs * 2 + 5000))) {
        cancel();
        lastError = "audio-timeout";
      }
      const captionMode = !available || !enabled || !!lastError;
      const complete = !current || finished || (captionMode && elapsed >= readingMs);
      return {
        available,
        enabled,
        speaking,
        queued,
        blocking: !complete,
        complete,
        captionMode,
        readingMs,
        requests,
        completions,
        cancellations,
        lastText,
        lastVoice,
        lastError,
        provider: "Gemini TTS · Sulafat (prerecorded)"
      };
    }
  };
}
