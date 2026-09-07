/* Deterministic arcade rules; the scientific stations are not game scores. */
export const RIVAL_SPEED_SCALE=.85;
export const RACE_LIMIT=100, GHOST_SECONDS=26/RIVAL_SPEED_SCALE, TRACK={width:6};
// Generous proximity pickup for ordinary gates; the finish keeps its own area.
export const CHECKPOINT_CAPTURE_RADIUS=6;
export const ROUTE=[[-40,46],[-30,46],[-15,46],[-15,35],[-20,33],[-12,31],[-10,25],[12,33],[28,24],[34,12],[35,-20],[18,-20],[13,-25],[2,-30],[-8,-31],[-25,-18],[-25,14],[-39,23],[-40,46]].map(([x,z])=>({x,z}));
const TAU=Math.PI*2;
const lengths=ROUTE.slice(1).map((p,i)=>Math.hypot(p.x-ROUTE[i].x,p.z-ROUTE[i].z));
const offsets=[0]; lengths.forEach(n=>offsets.push(offsets.at(-1)+n));
export const ROUTE_LENGTH=offsets.at(-1);
export const RIVALS=[
  {name:"ENTROPY",seconds:GHOST_SECONDS,lane:-1.05,color:0x86d7ea},
  {name:"AVERAGE",seconds:31/RIVAL_SPEED_SCALE,lane:1.05,color:0xd6a5ed}
];
export const CHECKPOINTS=[
  [1,"LEFT VIEW","L","Collect the first view beside the capture pen."],
  [2,"RIGHT VIEW","R","Round the pen for a complementary view."],
  [3,"TOP VIEW","T","Complete your three-view capture."],
  [6,"SAM3 MASKS","MASK","Pass segmentation, then follow the trail east."],
  [9,"AGREEMENT FUSION","FUSE","Merge views beside the multi-view station."],
  [13,"SHAPE FEATURES","SHAPE","Deliver body shape at the southern feature station."],
  [18,"ENSEMBLE → FINISH","kg","Return past weighing and deployment to the finish."]
].map(([waypoint,label,short,hint])=>({waypoint,label,short,hint,angle:offsets[waypoint]/ROUTE_LENGTH*TAU}));
function segmentAt(angle){
  const d=Math.max(0,Math.min(1,angle/TAU))*ROUTE_LENGTH;
  let i=0;while(i<lengths.length-1&&d>offsets[i+1])i++;
  return {i,t:(d-offsets[i])/lengths[i]};
}
export function trackPoint(angle,lane=0){
  const {i,t}=segmentAt(angle),a=ROUTE[i],b=ROUTE[i+1];
  const dx=(b.x-a.x)/lengths[i],dz=(b.z-a.z)/lengths[i];
  return {x:a.x+(b.x-a.x)*t+dz*lane,z:a.z+(b.z-a.z)*t-dx*lane};
}
export function trackHeading(angle){
  const {i}=segmentAt(angle);return Math.atan2(ROUTE[i+1].x-ROUTE[i].x,ROUTE[i+1].z-ROUTE[i].z);
}
function projection(p,a,b){
  const x=b.x-a.x,z=b.z-a.z;
  const t=Math.max(0,Math.min(1,((p.x-a.x)*x+(p.z-a.z)*z)/(x*x+z*z||1)));
  return {t,distance:Math.hypot(p.x-a.x-t*x,p.z-a.z-t*z)};
}
export function routeLocation(p){
  let best={distance:Infinity,progress:0};
  for(let i=0;i<lengths.length;i++){
    const q=projection(p,ROUTE[i],ROUTE[i+1]);
    if(q.distance<best.distance)best={distance:q.distance,progress:(offsets[i]+q.t*lengths[i])/ROUTE_LENGTH};
  }
  return best;
}
export const OBSTACLES=[
  [.085,0,"hurdle"],[.16,0,"hurdle"],[.23,-1.3,"bale"],[.285,0,"hurdle"],
  [.36,0,"sweeper"],[.43,1.25,"bale"],[.49,0,"hurdle"],[.56,0,"sweeper"],
  [.64,0,"hurdle"],[.71,-1.2,"bale"],[.79,0,"sweeper"],[.87,0,"hurdle"],[.94,0,"hurdle"]
].map(([u,lane,kind],id)=>({id,angle:u*TAU,lane,kind}));
export const HURDLE_ANGLES=OBSTACLES.map(o=>o.angle);
export const PICKUPS=[
  [.025,0,"boost"],[.12,1.5,"shield"],[.205,0,"boost"],[.31,-1.4,"clock"],
  [.40,0,"shield"],[.465,-1.3,"boost"],[.60,1.4,"clock"],[.68,0,"shield"],
  [.75,1.4,"boost"],[.835,0,"clock"],[.91,-1.4,"boost"]
].map(([u,lane,kind],id)=>({id,angle:u*TAU,lane,kind}));
export function obstaclePoint(o,time){
  return trackPoint(o.angle,o.kind==="sweeper"?Math.sin(time*2.5+o.id)*2:o.lane);
}
export function obstacleDimensions(o) {
  return o.kind==="hurdle" ? {width:4.8,depth:.28,height:.65}
    : o.kind==="bale" ? {width:1.7,depth:1.7,height:1.1} : {width:1.4,depth:1.4,height:.85};
}
export function obstacleContact(o,from,to,time) {
  const p=obstaclePoint(o,time),h=trackHeading(o.angle),c=Math.cos(h),s=Math.sin(h);
  const local=q=>({x:(q.x-p.x)*c-(q.z-p.z)*s,z:(q.x-p.x)*s+(q.z-p.z)*c});
  const a=local(from),b=local(to),d=obstacleDimensions(o);
  let enter=0,exit=1;
  for(const [key,extent] of [["x",d.width/2+.65],["z",d.depth/2+.55]]) {
    const delta=b[key]-a[key];
    if(Math.abs(delta)<1e-8){if(Math.abs(a[key])>extent)return false;continue;}
    const t1=(-extent-a[key])/delta,t2=(extent-a[key])/delta;
    enter=Math.max(enter,Math.min(t1,t2));exit=Math.min(exit,Math.max(t1,t2));
    if(enter>exit)return false;
  }
  return true;
}
export function rivalProgress(elapsed,i){
  // Fixed start acceleration and straight-line surges, never rubber-banding.
  const u=Math.max(0,Math.min(1,elapsed/RIVALS[i].seconds));
  return u-.018*Math.sin(TAU*u)+.006*Math.sin(TAU*3*u);
}
// Match the visible 7 × 1.4m checkerboard. Once all gates are collected,
// entering it from either side completes the lap, including a missed-line return.
function finishContact(from,to) {
  const p=trackPoint(TAU),h=trackHeading(TAU),c=Math.cos(h),s=Math.sin(h);
  const local=q=>({x:(q.x-p.x)*c-(q.z-p.z)*s,z:(q.x-p.x)*s+(q.z-p.z)*c});
  const a=local(from),b=local(to);
  let enter=0,exit=1;
  for(const [key,extent] of [["x",3.5],["z",.7]]) {
    const delta=b[key]-a[key];
    if(Math.abs(delta)<1e-8){if(Math.abs(a[key])>extent)return false;continue;}
    const t1=(-extent-a[key])/delta,t2=(extent-a[key])/delta;
    enter=Math.max(enter,Math.min(t1,t2));exit=Math.min(exit,Math.max(t1,t2));
    if(enter>exit)return false;
  }
  return true;
}
export function createRaceRules(){
  let state,previous=null,contacts=new Set();
  function reset(){
    state={phase:"ready",countdown:3,elapsed:0,next:0,penalty:0,bonus:0,hits:0,cleared:0,
      hurdles:[],pickups:[],item:null,shield:0,boost:0,stun:0,offroad:false,speedScale:1,
      progress:0,rank:3,event:0,events:[],sound:"",message:"THE WHOLE RANCH IS YOUR COURSE.",result:null};
    previous=null;contacts=new Set();
  }
  const event=(message,sound)=>{
    state.message=message;state.sound=sound;state.event++;
    state.events.push({id:state.event,message,sound});
    if(state.events.length>16)state.events.shift();
  };
  reset();
  return {
    reset,
    start(){reset();state.phase="countdown";},
    useItem(){
      if(state.phase!=="racing"||!state.item)return false;
      const item=state.item;state.item=null;
      if(item==="boost"){state.boost=3.5;event("SIGNAL BOOST · FASTER FOR 3.5s","boost");}
      if(item==="shield"){state.shield=1;event("MASK SHIELD · NEXT HIT BLOCKED","shield");}
      if(item==="clock"){state.bonus+=3;event("EFFICIENT INFERENCE · −3s","clock");}
      return true;
    },
    pause(){
      if(!["racing","countdown"].includes(state.phase))return false;
      state.resumePhase=state.phase;state.phase="paused";return true;
    },
    resume(){if(state.phase!=="paused")return false;state.phase=state.resumePhase;previous=null;return true;},
    update(dt,position,grounded=true,clearance=grounded?0:2){
      if(!position||!Number.isFinite(dt)||dt<=0)return state;
      if(state.phase==="countdown"){
        state.countdown=Math.max(0,state.countdown-dt);
        if(state.countdown===0){state.phase="racing";event("GO · FOLLOW THE RANCH TRAIL","go");}
        previous={...position};return state;
      }
      if(state.phase!=="racing")return state;
      state.elapsed+=dt;state.boost=Math.max(0,state.boost-dt);state.stun=Math.max(0,state.stun-dt);
      const from=previous||position;
      const safeFrom=Math.hypot(position.x-from.x,position.z-from.z)>8?position:from;
      const crossed=p=>projection(p,safeFrom,position).distance;
      const location=routeLocation(position);
      // The finish shares the start vertex; nearest-segment ties must not
      // briefly send a last-leg racer back to 0% / last place.
      if(state.next===CHECKPOINTS.length-1 && location.progress<.08)location.progress=1;
      state.offroad=location.distance>TRACK.width/2+1;
      state.progress=Math.min(location.progress,CHECKPOINTS[state.next]?.angle/TAU??1);
      const gate=CHECKPOINTS[state.next],last=state.next===CHECKPOINTS.length-1;
      if(gate&&(last?finishContact(safeFrom,position):crossed(trackPoint(gate.angle))<=CHECKPOINT_CAPTURE_RADIUS)){
        state.next++;event(gate.label+" · COLLECTED","gate");
        if(state.next===5){state.bonus+=2;event("THREE VIEWS AGREE · −2s FUSION BONUS","gate");}
      }
      const touching=new Set();
      for(const o of OBSTACLES){
        if(obstacleContact(o,safeFrom,position,state.elapsed)){
          const clears=clearance>=obstacleDimensions(o).height;
          if(clears){
            if(!state.hurdles.includes(o.id)){state.hurdles.push(o.id);state.cleared++;event("CLEAN SIGNAL · OBSTACLE CLEARED","jump");}
            continue;
          }
          touching.add(o.id);
          if(contacts.has(o.id))continue;
          if(!state.hurdles.includes(o.id))state.hurdles.push(o.id);
          if(state.shield){state.shield=0;event("MASK SHIELD · NOISE BLOCKED","shield");}
          else{state.hits++;state.penalty+=2;state.stun=1.1;event("NOISE HIT · +2s · SLOWED","hit");}
        }
      }
      contacts=touching;
      for(const item of PICKUPS){
        if(state.item||state.pickups.includes(item.id))continue;
        if(crossed(trackPoint(item.angle,item.lane))<1.65){
          state.pickups.push(item.id);state.item=item.kind;
          event(item.kind.toUpperCase()+" COLLECTED · Q / TAP TO USE","pickup");
        }
      }
      state.speedScale=Math.max(.35,(state.boost>0?1.55:1)*(state.stun>0?.4:1)*(state.offroad?.6:1));
      const score=Math.max(0,state.elapsed+state.penalty-state.bonus);
      state.rank=1+RIVALS.filter((_,i)=>rivalProgress(state.elapsed,i)>state.progress).length;
      previous={...position};
      if(state.next===CHECKPOINTS.length||state.elapsed>=RACE_LIMIT){
        const finished=state.next===CHECKPOINTS.length;
        state.phase="finished";state.speedScale=1;
        const rank=finished?1+RIVALS.filter(r=>r.seconds<=score).length:3;
        state.rank=rank;if(finished)state.progress=1;
        state.result={finished,score,rank,beatGhost:finished&&score<GHOST_SECONDS,
          medal:!finished?"TRY AGAIN":rank===1?"GOLD":rank===2?"SILVER":"BRONZE"};
        event(finished?"PIPELINE COMPLETE":"TIME UP · TRY A NEW LINE","finish");
      }
      return state;
    },
    get state(){return {...state,events:state.events.map(e=>({...e})),hurdles:[...state.hurdles],pickups:[...state.pickups]};}
  };
}
