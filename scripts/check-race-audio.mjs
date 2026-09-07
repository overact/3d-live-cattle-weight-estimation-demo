import assert from "node:assert/strict";
import { createRaceAudio } from "../js/world/race-audio.js?v=20260907-ranch-drive-v6";
let context;
const param=()=>({value:0,setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}});
const node=()=>({connect(){},disconnect(){}});
class Audio {
  constructor(){context=this;this.state="suspended";this.currentTime=0;this.destination={};this.resolvers=[];}
  createGain(){return {...node(),gain:param()};}
  createAnalyser(){return {...node(),getFloatTimeDomainData(a){a.fill(.01);}};}
  createOscillator(){return {...node(),frequency:param(),start(){},stop(){this.onended?.();}};}
  resume(){return new Promise(resolve=>this.resolvers.push(resolve));}
  suspend(){this.state="suspended";return Promise.resolve();}
  completeResume(){this.state="running";this.resolvers.splice(0).forEach(resolve=>resolve());}
}
globalThis.window={AudioContext:Audio};
globalThis.localStorage={getItem:()=>null,setItem(){}};
const audio=createRaceAudio();audio.unlock();audio.play("gate");
assert.equal(audio.state.cues,0);assert.equal(audio.state.pending,2);
context.completeResume();await Promise.resolve();
assert.equal(audio.state.pending,0);assert.equal(audio.state.cues,2,"first cues wait for audio unlock instead of disappearing");
audio.stop();audio.unlock();audio.play("finish");audio.stop();
const before=audio.state.cues;context.completeResume();await Promise.resolve();
assert.equal(audio.state.cues,before,"late resume cannot play after pause or exit");
assert.equal(audio.state.pending,0);assert.equal(audio.state.voices,0);
audio.unlock();context.completeResume();await Promise.resolve();audio.toggle();audio.play("hit");
assert.equal(audio.state.muted,true);assert.equal(audio.state.cues,before);
audio.toggle();context.completeResume();await Promise.resolve();
audio.update(.016,0,true);
assert.equal(audio.state.musicNotes,2,"music plays even when standing still");
context.currentTime+=.3;audio.update(.016,0,false);
assert.equal(audio.state.musicNotes,3,"music continues while airborne");
audio.stop();const notes=audio.state.musicNotes;
context.currentTime+=10;audio.update(.016,0,true);
assert.equal(audio.state.musicNotes,notes,"paused/exited race schedules no music");
audio.unlock();context.completeResume();await Promise.resolve();audio.update(.016,0,true);
assert.equal(audio.state.musicNotes,notes+2,"resume starts a single fresh loop without catch-up bursts");
audio.toggle();context.currentTime+=10;audio.update(.016,5,true);
assert.equal(audio.state.musicNotes,notes+2,"mute silences both music and effects");
console.log("Race audio verified: delayed unlock, first cues, pause/exit cancellation, bounded queue and mute.");
