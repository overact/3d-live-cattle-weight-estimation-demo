import assert from "node:assert/strict";
import { createAutoTourVoice } from "../js/world/auto-tour-voice.js?v=20260829-spoken-tour-v7";

class FakeUtterance {
  constructor(text) { this.text = text; }
}

const spoken = [];
let cancelled = 0;
const synth = {
  getVoices: () => [
    { name: "Plain Default", lang: "en-US", default: true },
    { name: "Test Natural English", lang: "en-GB" }
  ],
  cancel() { cancelled += 1; },
  speak(utterance) {
    spoken.push(utterance);
    utterance.onstart?.();
  }
};

const voice = createAutoTourVoice({ synth, Utterance: FakeUtterance });
assert.equal(voice.qaState.available, true);
assert.equal(voice.qaState.enabled, true);

voice.handleState({ type: "start" });
voice.handleState({ type: "phase", phase: "approach" });
assert.equal(spoken.length, 0, "voice must stay quiet while cattle is travelling");

const dwell = {
  type: "phase", phase: "dwell", cycleNumber: 0, completedSteps: 0,
  stepIndex: 0,
  narration: "RGB subtitle begins after arrival.",
  speech: "R G B narration begins after arrival."
};
voice.handleState(dwell);
assert.equal(spoken.length, 1);
assert.equal(spoken[0].text, dwell.speech, "voice must prefer natural spoken copy over display notation");
assert.equal(spoken[0].lang, "en-US");
assert.equal(spoken[0].voice.name, "Test Natural English");
assert.equal(spoken[0].rate, 1.0);
assert.equal(voice.qaState.lastVoice, "Test Natural English");
assert.equal(voice.qaState.speaking, true);
assert.equal(voice.qaState.blocking, true);
voice.handleState(dwell);
assert.equal(spoken.length, 1, "render/state repetition must not repeat narration");
spoken[0].onend();
assert.equal(voice.qaState.blocking, false, "utterance completion must release the director dwell");
assert.equal(voice.qaState.completions, 1);

voice.handleState({ type: "phase", phase: "approach" });
assert.equal(voice.qaState.speaking, false);
voice.toggle(dwell);
assert.equal(voice.qaState.enabled, false);
voice.toggle(dwell);
assert.equal(voice.qaState.enabled, true);
assert.equal(spoken.length, 2, "re-enabling during a dwell must read the current caption");
voice.handleState({ type: "stop" });
assert.equal(voice.qaState.speaking, false);
assert(cancelled >= 4, "start, travel, toggle and stop must cancel stale speech");

const unavailable = createAutoTourVoice({ synth: null, Utterance: null });
assert.equal(unavailable.qaState.available, false);
assert.equal(unavailable.toggle(dwell).enabled, false);

console.log("English auto-tour voice verified: arrival speech, dedupe, mute, interruption.");
