import assert from "node:assert/strict";
import fs from "node:fs";
import { createAutoTourVoice } from "../js/world/auto-tour-voice.js?v=20260909-sulafat";
import { AUTO_TOUR_STEPS } from "../js/world/auto-tour.js?v=20260907-ranch-drive-v6";

const clips = [];
let clock = 0;
class FakeAudio {
  constructor(src) { this.src = src; this.duration = 21; clips.push(this); }
  play() { this.onloadedmetadata?.(); this.onplaying?.(); return Promise.resolve(); }
  pause() { this.paused = true; }
  removeAttribute() { this.src = ""; }
  load() {}
}
const voice = createAutoTourVoice({ Audio: FakeAudio, now: () => clock });
const dwell = { type: "phase", phase: "dwell", cycleNumber: 0, completedSteps: 0,
  stepIndex: 0, narration: "Display caption.", speech: "Spoken transcript." };
assert.equal(voice.qaState.available, true);
voice.handleState({ type: "start" });
voice.handleState({ type: "phase", phase: "approach" });
assert.equal(clips.length, 0);
voice.handleState(dwell);
assert.match(clips[0].src, /assets\/audio\/sulafat\/step-00\.mp3$/);
assert.equal(voice.qaState.lastText, dwell.speech);
assert.equal(voice.qaState.lastVoice, "Sulafat");
assert.equal(voice.qaState.speaking, true);
assert.equal(voice.qaState.blocking, true);
assert.equal(voice.qaState.readingMs, 22000);
voice.handleState(dwell);
assert.equal(clips.length, 1, "repeated state must not replay audio");
clips[0].onended();
assert.equal(voice.qaState.complete, true);
voice.handleState({ ...dwell, stepIndex: 1 });
assert.equal(clips[0].paused, true);
clips[0].onended();
clips[0].onerror();
assert.equal(voice.qaState.complete, false, "stale events cannot release the new step");
assert.equal(voice.qaState.lastError, "");
voice.toggle(dwell);
assert.equal(clips[1].paused, true);
assert.equal(voice.qaState.captionMode, true);
voice.toggle(dwell);
assert.equal(clips.length, 3);
voice.handleState({ type: "stop" });
assert.equal(clips[2].paused, true);
assert.equal(voice.qaState.speaking, false);
assert.equal(voice.qaState.complete, true);

class RejectedAudio extends FakeAudio {
  play() { return Promise.reject(new Error("Autoplay blocked")); }
}
const rejected = createAutoTourVoice({ Audio: RejectedAudio, now: () => clock });
rejected.handleState(dwell);
await Promise.resolve();
assert.equal(rejected.qaState.lastError, "audio-play-failed");
assert.equal(rejected.qaState.complete, false);
assert.equal(clips.at(-1).paused, true);
clock += rejected.qaState.readingMs + 1;
assert.equal(rejected.qaState.complete, true);

const missing = createAutoTourVoice({ Audio: FakeAudio, now: () => clock });
missing.handleState(dwell);
clips.at(-1).onerror();
assert.equal(missing.qaState.captionMode, true);
assert.equal(missing.qaState.complete, false);
clock += missing.qaState.readingMs + 1;
assert.equal(missing.qaState.complete, true);

class StuckAudio extends FakeAudio { play() { return new Promise(() => {}); } }
const stuck = createAutoTourVoice({ Audio: StuckAudio, now: () => clock });
stuck.handleState(dwell);
clock += 15001;
assert.equal(stuck.qaState.lastError, "audio-timeout");
assert.equal(clips.at(-1).paused, true);
const unavailable = createAutoTourVoice({ Audio: null, now: () => clock });
unavailable.handleState(dwell);
assert.equal(unavailable.qaState.available, false);
assert.equal(unavailable.qaState.complete, false);
clock += unavailable.qaState.readingMs + 1;
assert.equal(unavailable.qaState.complete, true);

const base = new URL("../assets/audio/sulafat/", import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL("manifest.json", base)));
assert.equal(manifest.voice, "Sulafat");
assert.equal(manifest.steps.length, AUTO_TOUR_STEPS.length);
for (const step of AUTO_TOUR_STEPS) {
  const record = manifest.steps[step.index];
  assert.equal(record.text, step.speech, "recording must match the current tour script");
  assert.equal(record.mp3, `step-${String(step.index).padStart(2, "0")}.mp3`);
  assert(fs.statSync(new URL(record.mp3, base)).size > 1000);
}
console.log("Sulafat tour verified: audio mapping, completion, mute/replay, interruption, stale events, failures and timeout.");
