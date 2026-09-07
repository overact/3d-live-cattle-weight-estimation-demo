/* English voice-over adapter for the interactive auto tour.

   Speech is driven by director state transitions rather than render frames:
   narration begins once the cattle reaches a Step, is cancelled before the
   next run, and stops synchronously when the visitor takes control. */

function selectEnglishVoice(synth) {
  const voices = typeof synth?.getVoices === "function" ? synth.getVoices() : [];
  const english = voices.filter((voice) => /^en(?:-|_)/i.test(voice.lang || ""));
  const neuralNames = /natural|neural|premium|enhanced|online/i;
  const polishedNames = /aria|jenny|guy|andrew|ava|samantha|daniel|google.*english/i;
  const legacyNames = /espeak|festival|flite/i;
  return english
    .map((voice, order) => ({
      voice,
      order,
      score: (neuralNames.test(voice.name || "") ? 40 : 0) +
        (polishedNames.test(voice.name || "") ? 20 : 0) +
        (/^en(?:-|_)US/i.test(voice.lang || "") ? 6 : 0) +
        (voice.default ? 1 : 0) -
        (legacyNames.test(voice.name || "") ? 30 : 0)
    }))
    .sort((a, b) => b.score - a.score || a.order - b.order)[0]?.voice || null;
}

export function createAutoTourVoice({
  synth = globalThis.speechSynthesis,
  Utterance = globalThis.SpeechSynthesisUtterance,
  now = () => performance.now()
} = {}) {
  const available = !!synth && typeof synth.speak === "function" && typeof Utterance === "function";
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

  function cancel() {
    generation += 1; // late callbacks from cancelled utterances cannot release a new Step
    if (available) synth.cancel();
    cancellations += 1;
    speaking = false;
    queued = false;
  }

  function speak(state) {
    if (state?.phase !== "dwell") return false;
    /* The subtitle can keep compact notation (RGB, R², 2.22%), while the
       spoken copy uses words and punctuation that browser voices phrase well. */
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
    const utterance = new Utterance(text);
    utterance.lang = "en-US";
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;
    const voice = selectEnglishVoice(synth);
    if (voice) {
      utterance.voice = voice;
      lastVoice = voice.name || "";
    } else {
      lastVoice = "Browser default English";
    }
    utterance.onstart = () => {
      if (requestGeneration !== generation) return;
      speaking = true; queued = false;
    };
    utterance.onend = () => {
      if (requestGeneration !== generation) return;
      speaking = false;
      queued = false;
      finished = true;
      completions += 1;
    };
    utterance.onerror = (event) => {
      if (requestGeneration !== generation) return;
      speaking = false;
      queued = false;
      lastError = String(event?.error || "speech-error");
    };
    queued = true;
    requests += 1;
    try { synth.speak(utterance); }
    catch { utterance.onerror({ error: "synthesis-failed" }); }
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
      if (current && ((queued && elapsed > 5000) ||
          (speaking && elapsed > readingMs * 2 + 5000))) {
        cancel();
        lastError = "speech-timeout";
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
        provider: "Browser speech synthesis"
      };
    }
  };
}
