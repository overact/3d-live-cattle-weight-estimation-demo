import assert from "node:assert/strict";
import * as THREE from "../vendor/three.module.js";
import { createThirdPersonRig } from "../js/lib/third-person-rig.js?v=20260907-ranch-drive-v6";
import { createRaceRules, CHECKPOINTS, CHECKPOINT_CAPTURE_RADIUS, trackPoint, trackHeading, RACE_LIMIT, TRACK,
  ROUTE_LENGTH, PICKUPS, OBSTACLES, obstaclePoint, obstacleContact, RIVALS, rivalProgress, RIVAL_SPEED_SCALE } from "../js/world/race-rules.js?v=20260907-ranch-drive-v6";
const TAU=Math.PI*2;
assert.ok(ROUTE_LENGTH>260,"race uses the ranch-wide trail, not the old oval");
for(let i=0;i<=1200;i++)for(const lane of [-TRACK.width/2,TRACK.width/2]){
  const p=trackPoint(i/1200*TAU,lane);
  assert.ok(Math.hypot(p.x,p.z)<74,"whole course remains within the controller boundary");
}
const race=createRaceRules(),start=trackPoint(0);
assert.equal(CHECKPOINT_CAPTURE_RADIUS,6);
for(let i=0;i<CHECKPOINTS.length-1;i++)for(const side of [-1,1]){
  race.start();race.update(3,start);
  for(const gate of CHECKPOINTS.slice(0,i))race.update(.01,trackPoint(gate.angle),false);
  assert.equal(race.state.next,i);
  race.pause();race.resume();
  race.update(.01,trackPoint(CHECKPOINTS[i].angle,side*6.1),false);
  assert.equal(race.state.next,i,"outside capture radius must not collect");
  race.update(.01,trackPoint(CHECKPOINTS[i].angle,side*5.5),false);
  assert.equal(race.state.next,i+1,"all six gates auto-collect from either side of the road");
}
race.start();race.update(3,start);
race.update(.01,trackPoint(CHECKPOINTS[1].angle,5),false);
assert.equal(race.state.next,0,"proximity cannot collect a future gate out of order");
race.start();race.update(3,start);
const nearGate=trackPoint(CHECKPOINTS[0].angle,5.7),gh=trackHeading(CHECKPOINTS[0].angle);
const graze=d=>({x:nearGate.x+Math.sin(gh)*d,z:nearGate.z+Math.cos(gh)*d});
race.pause();race.resume();race.update(.01,graze(-2),false);
assert.equal(race.state.next,0);
race.update(.01,graze(2),false);
assert.equal(race.state.next,1,"swept proximity catches a fast pass with both endpoints outside");
race.reset();
race.update(20,trackPoint(CHECKPOINTS[0].angle));assert.equal(race.state.next,0);
race.start();race.update(1,start);race.pause();race.update(20,start);
assert.equal(race.state.countdown,2);assert.equal(race.state.elapsed,0);
race.resume();race.update(2,start);assert.equal(race.state.phase,"racing");
race.update(.1,trackPoint(TAU));assert.equal(race.state.next,0,"cannot skip gates");
race.pause();const elapsed=race.state.elapsed;race.update(10,trackPoint(1));
assert.equal(race.state.elapsed,elapsed);assert.equal(race.useItem(),false);race.resume();
function lap(airborne){
  race.start();race.update(3,start);
  for(let i=0;i<=1600;i++)race.update(30/1600,trackPoint(i/1600*TAU),!airborne);
  // Finish plane is just past the endpoint (avoid roundoff at exact equality).
  const p=trackPoint(TAU),h=trackHeading(TAU);
  race.update(.01,{x:p.x+Math.sin(h)*.1,z:p.z+Math.cos(h)*.1},!airborne);
  return race.state;
}
let result=lap(false);
assert.equal(result.phase,"finished");assert.equal(result.next,7);
assert.ok(result.hits>=8);assert.equal(result.penalty,result.hits*2);
assert.equal(result.bonus,2);assert.equal(result.result.medal,"BRONZE");
assert.ok(Math.abs(result.result.score-(result.elapsed+result.penalty-2))<1e-8);
result=lap(true);assert.equal(result.hits,0);assert.ok(result.cleared>=8);
assert.equal(result.result.beatGhost,true);assert.equal(result.result.rank,1);
assert.equal(result.progress,1);assert.equal(result.rank,result.result.rank);
const fh=trackHeading(TAU),fp=trackPoint(TAU);
const finishPosition=(side,forward)=>({x:fp.x+Math.cos(fh)*side+Math.sin(fh)*forward,z:fp.z-Math.sin(fh)*side+Math.cos(fh)*forward});
function prepareFinish(){
  race.start();race.update(3,start);
  for(const gate of CHECKPOINTS.slice(0,-1))race.update(.01,trackPoint(gate.angle),false);
  assert.equal(race.state.next,6);
}
for(const side of [-5,5]){
  prepareFinish();
  for(const p of [finishPosition(side,-2),finishPosition(side,2),finishPosition(0,2)])race.update(.1,p,false);
  assert.equal(race.state.phase,"racing","passing beside the checkerboard must not finish");
  race.pause();race.update(.1,fp,false);assert.equal(race.state.phase,"paused");race.resume();
  race.update(.1,finishPosition(0,2),false);race.update(.1,finishPosition(0,-2),false);
  assert.equal(race.state.result.finished,true,"return crossing must recover a missed finish");
  prepareFinish();race.update(.1,finishPosition(side,.5),false);race.update(.1,finishPosition(0,.5),false);
  assert.equal(race.state.result.finished,true,"side entry beyond the old plane must finish");
}
prepareFinish();race.update(.1,fp,false);assert.equal(race.state.result.finished,true,"exact line arrival counts");
prepareFinish();race.update(.1,finishPosition(0,-10),false);race.update(.1,finishPosition(0,10),false);
assert.equal(race.state.phase,"racing","teleport across the area cannot fabricate a swept finish");
for(const kind of ["boost","shield","clock"]){
  race.start();race.update(3,start);
  const item=PICKUPS.find(p=>p.kind===kind);
  race.update(.01,trackPoint(item.angle,item.lane),false);
  assert.equal(race.state.item,kind);assert.equal(race.useItem(),true);
  assert.equal(race.state.item,null);assert.equal(race.useItem(),false);
  if(kind==="boost"){
    race.update(.1,trackPoint(item.angle,item.lane),false);
    assert.ok(race.state.speedScale>1);
    race.pause();const t=race.state.boost;race.update(30,start);assert.equal(race.state.boost,t);
    race.resume();race.update(4,trackPoint(item.angle,item.lane));assert.equal(race.state.boost,0);
  }
  if(kind==="shield"){
    const o=OBSTACLES[0];race.update(.01,obstaclePoint(o,race.state.elapsed+.01),true);
    assert.equal(race.state.shield,0);assert.equal(race.state.hits,0);
  }
  if(kind==="clock")assert.equal(race.state.bonus,3);
}
race.start();race.update(3,start);race.update(.1,{x:60,z:0});
assert.equal(race.state.offroad,true);assert.ok(race.state.speedScale<1);
race.update(RACE_LIMIT,start);assert.equal(race.state.result.finished,false);
race.reset();assert.equal(race.state.hurdles.length,0);assert.equal(race.state.pickups.length,0);
assert.equal(race.state.item,null);assert.equal(race.state.boost,0);assert.equal(race.state.shield,0);
for(let i=0;i<RIVALS.length;i++){
  assert.equal(rivalProgress(0,i),0);assert.equal(rivalProgress(RIVALS[i].seconds,i),1);
  let previous=0;
  for(let j=0;j<100;j++){const p=rivalProgress(j/100*RIVALS[i].seconds,i);assert.ok(p>=previous);previous=p;}
}
const rig=createThirdPersonRig({camera:new THREE.PerspectiveCamera(55,1,.1,400),groundFn:()=>2.5});
assert.equal(RIVAL_SPEED_SCALE,.85);
assert.ok(Math.abs(RIVALS[0].seconds-26/.85)<1e-9);
assert.ok(Math.abs(RIVALS[1].seconds-31/.85)<1e-9);
const hurdle=OBSTACLES[0], hp=obstaclePoint(hurdle,0), hh=trackHeading(hurdle.angle);
const ahead=d=>({x:hp.x+Math.sin(hh)*d,z:hp.z+Math.cos(hh)*d});
assert.equal(obstacleContact(hurdle,ahead(-2),ahead(-1.5),0),false,"no premature hit metres before the visible bar");
assert.equal(obstacleContact(hurdle,ahead(-1),ahead(1),0),true,"fast movement cannot tunnel through a rail");
race.start();race.update(3,start);race.update(.1,hp,false,.1);
assert.equal(race.state.hits,1,"being airborne is not enough if hooves have not cleared the obstacle");
race.update(.1,hp,true);assert.equal(race.state.hits,1,"remaining in contact cannot spam penalties");
race.update(.1,ahead(5),true);race.update(.1,ahead(6),true);race.update(.1,hp,true);
assert.equal(race.state.hits,2,"re-entering a previously hit obstacle remains dangerous");
assert.ok(race.state.events.filter(e=>e.sound==="hit").length===2,"effects retain every event, not only the last message");
rig.teleport(3,4,1.2);assert.equal(rig.state.heading,1.2);
assert.equal(rig.state.groundY,2.5);assert.equal(rig.state.speed01,0);assert.equal(rig.state.dashCooldown,0);
console.log("Race verified: ranch route, countdown/pause, ordered finish, 13 obstacles, three items, fair rivals, slowdown, restart, spawn pose.");
