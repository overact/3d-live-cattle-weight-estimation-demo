/* Short, low-gain synthesized cues. One context, no downloads or autoplay.
   Sounds are created only after START/RESUME; pause/exit silence immediately. */
export function createRaceAudio() {
  let context=null, master=null, analyser=null, muted=false, enabled=false, hoof=0, cues=0;
  let pending=[], peak=0, lastError="", unlockId=0, musicAt=0, musicStep=0, musicNotes=0;
  const melody=[76,79,81,79,76,74,72,74,76,79,84,81,79,76,74,72];
  const samples=new Float32Array(256),volume=.28;
  const voices=new Set();
  try { muted=localStorage.getItem("ranch-race-muted")==="true"; } catch { /* optional */ }
  function silence() {
    for(const osc of voices) {try {osc.stop();} catch { /* already stopped */ }}
    voices.clear(); hoof=0; pending=[]; musicAt=0; musicStep=0;
  }
  function unlock() {
    silence();
    enabled=true;
    const id=++unlockId;
    try {
      if(!context){
        const Audio=window.AudioContext||window.webkitAudioContext;
        if(!Audio){lastError="Audio unavailable";return;}
        context=new Audio(); master=context.createGain();master.gain.value=muted?0:volume;
        analyser=context.createAnalyser();analyser.fftSize=256;
        master.connect(analyser);analyser.connect(context.destination);
      }
      context.resume().then(()=>{
        if(!enabled||id!==unlockId)return;
        lastError="";const queued=pending;pending=[];queued.forEach(args=>tone(...args));
      }).catch(()=>{lastError="Tap to enable audio";});
    } catch {lastError="Audio unavailable";}
  }
  function tone(frequency,duration=0.12,type="sine",delay=0,end=frequency,level=.35,music=false) {
    if(!enabled||muted)return;
    if(context?.state!=="running"){
      if(!music&&pending.length<8)pending.push([frequency,duration,type,delay,end,level]);return;
    }
    if(voices.size>=16)return;
    const osc=context.createOscillator(),gain=context.createGain(),at=context.currentTime+delay;
    osc.type=type;osc.frequency.setValueAtTime(frequency,at);osc.frequency.exponentialRampToValueAtTime(end,at+duration);
    gain.gain.setValueAtTime(0,at);gain.gain.linearRampToValueAtTime(level,at+.008);gain.gain.exponentialRampToValueAtTime(.001,at+duration);
    osc.connect(gain);gain.connect(master);voices.add(osc);
    osc.onended=()=>{voices.delete(osc);osc.disconnect();gain.disconnect();};
    osc.start(at);osc.stop(at+duration+.02);if(music)musicNotes++;else cues++;
  }
  function play(kind) {
    if(kind==="hit")tone(110,.24,"triangle",0,45);
    else if(kind==="boost"||kind==="jump")tone(220,.18,"sine",0,760);
    else if(kind==="tick")tone(440,.08,"triangle");
    else if(kind==="finish")[523,659,784,1047].forEach((f,i)=>tone(f,.22,"sine",i*.11));
    else if(kind)[660,990].forEach((f,i)=>tone(f,.12,"sine",i*.08));
  }
  return {
    unlock,play,
    stop(){enabled=false;unlockId++;silence();if(context?.state==="running")context.suspend().catch(()=>{});},
    toggle(){muted=!muted;if(master)master.gain.value=muted?0:volume;if(muted)silence();else unlock();
      try{localStorage.setItem("ranch-race-muted",String(muted));}catch{/* optional */}return muted;},
    update(dt,speed,grounded){
      if(analyser&&enabled){analyser.getFloatTimeDomainData(samples);for(const n of samples)peak=Math.max(peak,Math.abs(n));}
      if(enabled&&!muted&&context?.state==="running") {
        // Audio-clock lookahead keeps the soft 100 BPM ranch loop independent
        // of player speed. No timers survive pause, restart or leaving the race.
        musicAt=Math.max(musicAt,context.currentTime);
        while(musicAt<context.currentTime+.18) {
          const hz=440*2**((melody[musicStep%melody.length]-69)/12),delay=musicAt-context.currentTime;
          tone(hz,.24,"triangle",delay,hz,.075,true);
          if(musicStep%2===0){const bass=[130.81,174.61,130.81,196][Math.floor(musicStep/4)%4];tone(bass,.42,"sine",delay,bass,.10,true);}
          musicStep++;musicAt+=.3;
        }
      }
      if(!enabled||muted||!grounded||Math.abs(speed)<1){hoof=0;return;}
      hoof+=dt;if(hoof>Math.max(.12,.48-Math.abs(speed)*.025)){hoof=0;tone(210,.08,"triangle",0,90);}
    },
    get state(){return {muted,enabled,context:context?.state??"not-started",voices:voices.size,cues,musicNotes,musicStep,pending:pending.length,peak,lastError};}
  };
}
