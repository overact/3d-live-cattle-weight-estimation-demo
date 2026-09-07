import * as THREE from "../../vendor/three.module.js";
import { clone as cloneSkinned } from "../../vendor/SkeletonUtils.js";
import { createGlbCattle } from "../lib/glb-cattle.js?v=20260907-ranch-drive-v6";
import { createRaceRules, TRACK, CHECKPOINTS, CHECKPOINT_CAPTURE_RADIUS, OBSTACLES, PICKUPS, RIVALS, ROUTE, ROUTE_LENGTH,
  obstaclePoint, obstacleDimensions, rivalProgress, trackPoint, trackHeading } from "./race-rules.js?v=20260907-ranch-drive-v6";
import { createRaceAudio } from "./race-audio.js?v=20260907-ranch-drive-v6";
import { STATIONS } from "./rail.js?v=20260907-ranch-drive-v6";

const AMBER = 0xe39b2d, ICE = 0x86d7ea, GREEN = 0x9ed2a4;
const clockText = value => `${Math.max(0, value).toFixed(1)}s`;

/* The race owns its overlay and a single hidden-by-default scene root. Replays
   reuse these objects; neither assets nor listeners grow with each lap. */
export function createRanchRace({ scene, roam, env, cowAsset, onExit }) {
  const rules = createRaceRules();
  const roadHeight=(x,z)=>Math.max(env.groundHeight(x,z),env.surfaceHeight(x,z))+.14;
  const audio = createRaceAudio();
  const root = new THREE.Group();
  root.name = "agreementSprint";
  root.visible = false;
  scene.add(root);
  let active = false, built = false, savedPose = null;
  const rivals = [], obstacleMeshes = [], pickupMeshes = [];
  let lastCount = 0, wasGrounded = true, oldDash = 0;
  let elapsedVisual = 0, lastEvent = -1, flashLeft = 0, previousPhase = "";
  let best = null;
  try { const n = Number(localStorage.getItem("agreement-sprint-best-v2")); if (n > 0) best = n; } catch { /* optional */ }
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const gates = [], effects = [];
  let playerMarker, shieldShell;
  const viewSlots = [...document.querySelectorAll("[data-race-view]")];
  const hud = document.getElementById("raceHud");
  const $ = id => document.getElementById(id);
  const nodes = Object.fromEntries(["raceTime", "raceGate", "raceObjective", "raceHint", "raceStatus",
    "racePanel", "racePanelTitle", "racePanelBody", "raceStart", "racePause", "raceCount",
    "raceProgress", "raceGhost", "raceBest", "raceDash", "raceMinimapPlayer", "raceMinimapGhost", "raceItem", "raceSound", "raceRank"]
    .map(id => [id, $(id)]));

  function label(text, color = "#f4eee2", scale = 5) {
    const canvas = document.createElement("canvas"); canvas.width = 512; canvas.height = 96;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#14191e"; ctx.fillRect(0, 0, 512, 96);
    ctx.fillStyle = color; ctx.fillRect(0, 90, 512, 6);
    ctx.font = "700 34px Archivo, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(text, 256, 45, 490);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: true }));
    sprite.scale.set(scale, scale * 96 / 512, 1);
    return sprite;
  }
  function build() {
    if (built) return;
    built = true;
    const vertices = [], indices = [];
    const laneSteps = 12, roadSteps = 640;
    for (let i = 0; i <= roadSteps; i++) {
      const a = i / roadSteps * Math.PI * 2;
      for (let l = 0; l <= laneSteps; l++) {
        const p = trackPoint(a, TRACK.width * (l / laneSteps - .5));
        vertices.push(p.x, roadHeight(p.x, p.z), p.z);
      }
      if (i < roadSteps) for (let l = 0; l < laneSteps; l++) {
        const j = i * (laneSteps + 1) + l, next = j + laneSteps + 1;
        indices.push(j, j + 1, next, j + 1, next + 1, next);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setIndex(indices); geometry.computeVertexNormals();
    const road=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({color:0x35444b,roughness:1,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1}));
    road.name="raceRoad"; root.add(road);
    // Incoming/outgoing strip normals differ at sharp corners, including the
    // shared start/finish. Fill those joins instead of leaving triangular gaps.
    const joins=[];
    for(const p of ROUTE.slice(0,-1))for(let i=0;i<32;i++){
      for(const q of [p,
        {x:p.x+Math.cos(i/32*Math.PI*2)*TRACK.width/2,z:p.z+Math.sin(i/32*Math.PI*2)*TRACK.width/2},
        {x:p.x+Math.cos((i+1)/32*Math.PI*2)*TRACK.width/2,z:p.z+Math.sin((i+1)/32*Math.PI*2)*TRACK.width/2}])
        joins.push(q.x,roadHeight(q.x,q.z)+.005,q.z);
    }
    const joinGeo=new THREE.BufferGeometry();joinGeo.setAttribute("position",new THREE.Float32BufferAttribute(joins,3));joinGeo.computeVertexNormals();
    const junctions=new THREE.Mesh(joinGeo,road.material);junctions.name="raceJunctions";root.add(junctions);
    const curbs = new THREE.InstancedMesh(new THREE.BoxGeometry(0.32, 0.1, 1.35),
      new THREE.MeshBasicMaterial({ color: AMBER }), 160);
    const matrix = new THREE.Object3D();
    for (let i = 0; i < 160; i++) {
      const a = Math.floor(i / 2) / 80 * Math.PI * 2;
      const p = trackPoint(a, (i % 2 ? 1 : -1) * TRACK.width / 2);
      matrix.position.set(p.x, roadHeight(p.x,p.z) + 0.06, p.z);
      matrix.rotation.y = trackHeading(a); matrix.updateMatrix(); curbs.setMatrixAt(i, matrix.matrix);
    }
    root.add(curbs);
    const arrowGeo = new THREE.BufferGeometry();
    arrowGeo.setAttribute("position", new THREE.Float32BufferAttribute([-.25,0,-.3, .25,0,-.3, 0,0,.45], 3));
    const arrows = new THREE.InstancedMesh(arrowGeo, new THREE.MeshBasicMaterial({ color: AMBER, side: THREE.DoubleSide }), 38);
    for (let i = 0; i < 38; i++) {
      const a = i / 38 * Math.PI * 2, p = trackPoint(a);
      matrix.position.set(p.x, roadHeight(p.x,p.z) + .02, p.z);
      matrix.rotation.y = trackHeading(a); matrix.updateMatrix(); arrows.setMatrixAt(i,matrix.matrix);
    }
    root.add(arrows);
    const finish = new THREE.Group(), fp = trackPoint(0);
    finish.position.set(fp.x, roadHeight(fp.x,fp.z) + .02, fp.z); finish.rotation.y = trackHeading(Math.PI*2);
    const lightTile = new THREE.MeshBasicMaterial({color: 0xeae4d6, side: THREE.DoubleSide});
    const darkTile = new THREE.MeshBasicMaterial({color: 0x263139, side: THREE.DoubleSide});
    for (let row=0;row<2;row++) for(let col=0;col<10;col++) {
      const tile = new THREE.Mesh(new THREE.PlaneGeometry(.7,.7), (row+col)%2 ? lightTile : darkTile);
      tile.rotation.x = -Math.PI/2; tile.position.set((col-4.5)*.7,0,(row-.5)*.7); finish.add(tile);
    }
    root.add(finish);
    playerMarker = new THREE.Mesh(new THREE.RingGeometry(.75,.81,32),
      new THREE.MeshBasicMaterial({color:AMBER,transparent:true,opacity:.7,side:THREE.DoubleSide,depthWrite:false}));
    playerMarker.rotation.x = -Math.PI/2; root.add(playerMarker);
    shieldShell = new THREE.Mesh(new THREE.SphereGeometry(1.1,16,12),
      new THREE.MeshBasicMaterial({color:ICE,wireframe:true,transparent:true,opacity:.4,depthWrite:false}));
    shieldShell.scale.set(1,1.05,1.3); root.add(shieldShell);
    CHECKPOINTS.forEach((checkpoint, i) => {
      const p = trackPoint(checkpoint.angle), g = new THREE.Group();
      g.position.set(p.x, env.groundHeight(p.x, p.z), p.z); g.rotation.y = trackHeading(checkpoint.angle);
      const material = new THREE.MeshBasicMaterial({ color: AMBER });
      for (const x of [-3.5, 3.5]) {
        const pole = new THREE.Mesh(new THREE.BoxGeometry(0.16, 3.8, 0.16), material);
        pole.position.set(x, 1.9, 0); g.add(pole);
      }
      const beam = new THREE.Mesh(new THREE.BoxGeometry(7.2, 0.14, 0.2), material);
      beam.position.y = 3.8; g.add(beam);
      const sign = label(`${String(i + 1).padStart(2, "0")} · ${checkpoint.label}`, "#e8b652", 6.2);
      sign.position.y = 4.55; g.add(sign);
      const token = new THREE.Mesh(new THREE.OctahedronGeometry(0.46), material);
      token.position.y = 1.6; g.add(token);
      root.add(g); gates.push({ group: g, token, material, sign });
    });
    for (const obstacle of OBSTACLES) {
      const p = obstaclePoint(obstacle,0), g = new THREE.Group();
      g.position.set(p.x, env.groundHeight(p.x, p.z), p.z); g.rotation.y = trackHeading(obstacle.angle);
      const dim=obstacleDimensions(obstacle);
      const rail = new THREE.Mesh(obstacle.kind === "bale" ? new THREE.CylinderGeometry(.85,.85,dim.height,12)
        : new THREE.BoxGeometry(dim.width,dim.height,dim.depth),
        new THREE.MeshStandardMaterial({ color: obstacle.kind === "bale" ? 0xc29a4a : 0xb8673f, roughness: 0.8 }));
      rail.position.y = dim.height/2; g.add(rail); g.userData.obstacleId=obstacle.id;
      const sign = label(obstacle.kind === "sweeper" ? "DRIFT · DODGE" : "NOISE · JUMP", "#f1b08a", 2.1); sign.position.y = 1.35; g.add(sign);
      root.add(g); obstacleMeshes.push(g);
    }
    for (const item of PICKUPS) {
      const color = item.kind === "boost" ? AMBER : item.kind === "shield" ? ICE : GREEN;
      const g = new THREE.Group(), p = trackPoint(item.angle,item.lane);
      g.position.set(p.x,env.groundHeight(p.x,p.z)+1.15,p.z);
      const token = new THREE.Mesh(item.kind === "shield" ? new THREE.IcosahedronGeometry(.48)
        : item.kind === "clock" ? new THREE.TorusGeometry(.36,.1,8,20) : new THREE.OctahedronGeometry(.52),
        new THREE.MeshStandardMaterial({color,emissive:color,emissiveIntensity:.5,metalness:.2,roughness:.4}));
      g.add(token);
      const sign=label(item.kind.toUpperCase(),"#f4eee2",1.7);sign.position.y=.85;g.add(sign);
      root.add(g);pickupMeshes.push(g);
    }
    // Reusable checkpoint rings give local feedback without fullscreen flashes.
    for (let i = 0; i < 6; i++) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 28),
        new THREE.MeshBasicMaterial({ color: GREEN, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2; ring.visible = false; root.add(ring); effects.push({ ring, age: 10 });
    }
    if (cowAsset) for (const rival of RIVALS) {
      const ghost = createGlbCattle({ scene: cloneSkinned(cowAsset.scene), animations: cowAsset.animations }, { height: 1.5 });
      ghost.group.traverse(o => {
        if (o.isMesh && o.material) {
          o.material.transparent = true; o.material.opacity = 0.5; o.material.depthWrite = false;
          o.material.color?.lerp(new THREE.Color(rival.color), 0.75);
        }
      });
      const tag = label(`${rival.name} · ${rival.seconds.toFixed(1)}s`, `#${rival.color.toString(16)}`, 2.2); tag.position.y = 2.3;
      ghost.group.add(tag); root.add(ghost.group); rivals.push(ghost);
    }
    const minimap = $("raceMinimap");
    const svg = (tag,attrs) => {
      const el=document.createElementNS("http://www.w3.org/2000/svg",tag);
      for(const [key,value] of Object.entries(attrs))el.setAttribute(key,value);
      minimap.insertBefore(el,nodes.raceMinimapGhost);return el;
    };
    const map = p => ({x:60+(p.x+8)*.9,y:62-(p.z-5)*.9});
    svg("rect",{x:22.2,y:58,width:18,height:13.5,fill:"#29423a",stroke:"#657467","stroke-width":.7});
    const routePath=ROUTE.map((p,i)=>`${i?"L":"M"}${map(p).x},${map(p).y}`).join(" ");
    svg("path",{d:routePath,fill:"none",stroke:"#56636a","stroke-width":4,"stroke-linejoin":"round"});
    svg("path",{d:routePath,fill:"none",stroke:"#e39b2d","stroke-width":1,"stroke-dasharray":"2 2"});
    for (const station of STATIONS) {
      const p=map(station.pos);
      svg("text",{x:p.x,y:p.y,fill:"#bac9ce","font-size":7,"text-anchor":"middle"}).textContent=station.num;
      // Lightweight world landmarks retain the ranch layout without bringing
      // scientific animations or station triggers into the racing simulation.
      const marker=label(`${station.num} · ${station.name}`,"#94b4ba",3.8);
      marker.position.set(station.pos.x,env.groundHeight(station.pos.x,station.pos.z)+3,station.pos.z);
      root.add(marker);
    }
    CHECKPOINTS.forEach((checkpoint, i) => {
      const p = trackPoint(checkpoint.angle);
      const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("cx", map(p).x);
      dot.setAttribute("cy", map(p).y);
      dot.setAttribute("r", "3"); dot.setAttribute("class", "race-map-gate"); dot.dataset.gate = i;
      minimap.insertBefore(dot, nodes.raceMinimapGhost);
    });
  }
  function resetPosition() {
    const p = trackPoint(0);
    roam.releaseInputs(); roam.teleport(p.x, p.z, trackHeading(0));
  }
  function start() {
    if (!active) return;
    audio.unlock(); lastCount = 0; oldDash = 0; wasGrounded = true;
    resetPosition(); rules.start(); lastEvent = -1; flashLeft = 0;
    for (const effect of effects) { effect.age = 10; effect.ring.visible = false; }
    update(0);
    document.activeElement?.blur?.();
  }
  function pause() {
    if (rules.pause()) { audio.stop(); roam.releaseInputs(); update(0); }
  }
  function resume() { audio.unlock(); rules.resume(); update(0); document.activeElement?.blur?.(); }
  function useItem() { if (rules.useItem()) update(0); }
  function primaryAction() {
    if (rules.state.phase === "paused") resume(); else start();
  }
  nodes.raceStart.addEventListener("click", primaryAction);
  nodes.racePause.addEventListener("click", pause);
  nodes.raceItem.addEventListener("click", useItem);
  nodes.raceSound.addEventListener("click", () => {
    if(!audio.state.muted && audio.state.context!=="running")audio.unlock();else audio.toggle();
    if (["paused","ready"].includes(rules.state.phase)) audio.stop(); update(0);
  });
  $("raceRestart").addEventListener("click", start);
  $("raceExit").addEventListener("click", () => onExit());
  document.addEventListener("keydown", e => {
    if (!active || e.target.closest("input,textarea,select,[contenteditable=true]")) return;
    const menu=["ready","paused","finished"].includes(rules.state.phase);
    if(e.code==="Space"&&!menu&&rules.state.phase!=="countdown")return;
    if (!["KeyP", "KeyR", "KeyQ", "Escape", "Enter", "Space"].includes(e.code)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.repeat) return;
    if (e.code === "Escape") onExit();
    else if (e.code === "KeyQ") useItem();
    else if (e.code === "KeyR") start();
    else if (e.code === "KeyP") rules.state.phase === "paused" ? resume() : pause();
    else if (["ready", "paused", "finished"].includes(rules.state.phase)) primaryAction();
  }, true);
  window.addEventListener("blur", () => { if (active) pause(); });
  document.addEventListener("visibilitychange", () => { if (active && document.hidden) pause(); });
  for (const button of document.querySelectorAll("[data-race-action]")) {
    const action = button.dataset.raceAction;
    button.addEventListener("pointerdown", e => {
      e.preventDefault();
      if (!active || rules.state.phase !== "racing") return;
      button.setPointerCapture(e.pointerId);
      roam.press(action, true);
      if (action === "forward") roam.press("run", true);
    });
    const release = () => { roam.press(action, false); if (action === "forward") roam.press("run", false); };
    button.addEventListener("pointerup", release); button.addEventListener("pointercancel", release);
    button.addEventListener("lostpointercapture", release);
  }
  function update(dt) {
    if (!active) return;
    const pose = roam.qaState;
    const p = { x: pose.pos[0], z: pose.pos[2] };
    rules.update(dt, p, pose.grounded, Math.max(0,pose.pos[1]-env.groundHeight(p.x,p.z)));
    const s = rules.state;
    hud.dataset.phase=s.phase;
    roam.setRaceSpeed(s.speedScale);
    roam.setRaceBoost(s.phase === "racing" && s.boost>0);
    nodes.raceSound.textContent = audio.state.muted ? "SOUND OFF" : audio.state.lastError ||
      (s.phase === "racing" && audio.state.context!=="running" ? "TAP FOR SOUND" : "SOUND ON");
    nodes.raceSound.setAttribute("aria-pressed",String(!audio.state.muted));
    nodes.raceRank.textContent = `${s.result?.rank ?? s.rank} / 3 · ${s.offroad ? "OFF TRAIL · SLOW" : s.boost > 0 ? "BOOST " + s.boost.toFixed(1) + "s" : s.shield ? "SHIELD ACTIVE" : "POSITION"}`;
    nodes.raceItem.disabled = !s.item || s.phase !== "racing";
    nodes.raceItem.textContent = s.item ? `Q · USE ${s.item.toUpperCase()}` : "ITEM SLOT · COLLECT ON TRAIL";
    if (s.phase === "countdown" && Math.ceil(s.countdown) !== lastCount) {
      lastCount = Math.ceil(s.countdown); audio.play("tick");
    }
    if (s.phase === "racing") {
      audio.update(dt,pose.speed,pose.grounded);
      if (wasGrounded && !pose.grounded) audio.play("jump");
      if (pose.dashCooldown > oldDash + .2) audio.play("boost");
    }
    wasGrounded=pose.grounded; oldDash=pose.dashCooldown;
    elapsedVisual += s.phase === "paused" ? 0 : dt;
    if (s.event !== lastEvent) {
      const events=s.events.filter(e=>e.id>lastEvent);
      for(const e of events){audio.play(e.sound);if(e.sound==="hit")roam.raceImpact();}
      lastEvent = s.event; flashLeft = 2.5;
      nodes.raceStatus.textContent = events.map(e=>e.message).join(" · ") || s.message;
      if (s.phase === "racing" && s.next > 0 && !reduced) {
        const effect = effects.find(e => e.age > 0.8) || effects[0];
        effect.age = 0; effect.ring.position.set(p.x, env.groundHeight(p.x, p.z) + 0.12, p.z);
      }
    }
    flashLeft = Math.max(0, flashLeft - dt);
    nodes.raceStatus.classList.toggle("show", flashLeft > 0 && s.phase === "racing");
    if (s.phase === "finished" && previousPhase !== "finished") {
      roam.releaseInputs();
      if (s.result.finished && (best === null || s.result.score < best)) {
        best = s.result.score;
        try { localStorage.setItem("agreement-sprint-best-v2", String(best)); } catch { /* optional */ }
      }
      if (s.result.finished) roam.celebrate();
    }
    previousPhase = s.phase;
    nodes.raceTime.textContent = clockText(s.elapsed);
    nodes.raceGate.textContent = `${Math.min(s.next, 7)} / 7`;
    viewSlots.forEach((slot,i) => {
      slot.classList.toggle("collected", s.next > i);
      const kind = s.next >= 4 ? "mask" : "rgb";
      if (slot.dataset.kind !== kind) {
        slot.dataset.kind = kind;
        const view = slot.dataset.raceView;
        const img = slot.querySelector("img");
        img.src = `assets/world/thumbs/${kind}_${view}${kind === "mask" && view === "top" ? "_aligned" : ""}.webp`;
        img.alt = `${view} ${kind === "mask" ? "segmentation mask" : "RGB view"}`;
      }
    });
    $("raceViewStage").textContent = s.next >= 5 ? "VIEWS FUSED" : s.next >= 4 ? "MASKS READY" : "COLLECT VIEWS";
    playerMarker.position.set(p.x, roadHeight(p.x,p.z)+.025,p.z);
    playerMarker.scale.setScalar(s.boost>0 ? 1.35 : 1);
    playerMarker.material.color.setHex(s.stun>0 ? 0xe4774f : s.shield ? ICE : AMBER);
    shieldShell.visible=s.shield>0;
    shieldShell.position.set(p.x,pose.pos[1]+.8,p.z);
    const gate = CHECKPOINTS[s.next];
    nodes.raceObjective.textContent = gate ? gate.label : "PIPELINE COMPLETE";
    nodes.raceHint.textContent = gate ? `${Math.ceil(Math.hypot(trackPoint(gate.angle).x - p.x, trackPoint(gate.angle).z - p.z))} m away · ${s.next<CHECKPOINTS.length-1 ? `Auto-collect within ${CHECKPOINT_CAPTURE_RADIUS} m` : "Enter the checkered finish"}` : "Three views. One complete lap.";
    nodes.raceProgress.style.width = `${s.next / 7 * 100}%`;
    nodes.raceGhost.textContent = `RIVALS ${RIVALS.map(r=>r.seconds.toFixed(1)).join(" / ")}s · +${s.penalty}s HITS · −${s.bonus}s BONUS`;
    nodes.raceBest.textContent = best === null ? "SET YOUR FIRST LAP" : `PERSONAL BEST ${clockText(best)}`;
    nodes.raceDash.textContent = pose.dashCooldown > 0 ? `DASH ${pose.dashCooldown.toFixed(1)}s` : "E · DASH READY";
    nodes.raceCount.hidden = s.phase !== "countdown";
    nodes.raceCount.textContent = String(Math.max(1, Math.ceil(s.countdown)));
    const panel = ["ready", "paused", "finished"].includes(s.phase);
    nodes.racePanel.hidden = !panel;
    nodes.racePause.hidden = s.phase !== "racing";
    if (panel) {
      nodes.racePanelTitle.textContent = s.phase === "ready" ? "THREE VIEWS.\nONE FINISH LINE." : s.phase === "paused" ? "TAKE A BREATHER." : `${s.result.medal}${s.result.finished ? " · " + clockText(s.result.score) : ""}`;
      nodes.racePanelBody.textContent = s.phase === "ready"
        ? `Follow the amber trail. Collect six checkpoints automatically as you pass nearby, then cross the checkered finish. Jump obstacles and use items to beat your rivals.`
        : s.phase === "paused" ? "Your race clock is paused. Resume when you are ready."
        : s.result.finished ? `Adjusted place ${s.result.rank}/3. Raw ${clockText(s.elapsed)} + ${s.penalty}s penalties − ${s.bonus}s bonuses. ${s.cleared} clean jumps. Rivals are playful method names, not measured scientific rankings.`
          : `${s.next}/7 gates collected. Follow the amber circuit, hold Shift to run, and use E to dash. Your personal best is kept on this browser only.`;
      nodes.raceStart.textContent = s.phase === "ready" ? "START RACE →" : s.phase === "paused" ? "RESUME →" : "RACE AGAIN →";
    }
    gates.forEach((g, i) => {
      // The start shares the finish line. Keep its billboard out of the chase
      // camera until the final leg, and hide passed signs behind the player.
      g.group.visible = i !== CHECKPOINTS.length - 1 || s.next === CHECKPOINTS.length - 1;
      g.sign.visible = i >= s.next && Math.hypot(p.x - g.group.position.x, p.z - g.group.position.z) > 5;
      g.material.color.setHex(i < s.next ? GREEN : i === s.next ? AMBER : 0x536873);
      g.token.visible = i >= s.next;
      const dot=$('raceMinimap').querySelector(`[data-gate="${i}"]`);
      if(dot) dot.style.fill=i<s.next?"#9ed2a4":i===s.next?"#e39b2d":"#657984";
      if (!reduced) { g.token.rotation.y = elapsedVisual; g.token.position.y = 1.6 + Math.sin(elapsedVisual * 2 + i) * 0.12; }
    });
    for (const effect of effects) {
      effect.age += dt; effect.ring.visible = effect.age < 0.8;
      if (effect.ring.visible) { effect.ring.scale.setScalar(1 + effect.age * 5); effect.ring.material.opacity = (1 - effect.age / 0.8) * 0.65; }
    }
    obstacleMeshes.forEach((g,i) => {
      const p=obstaclePoint(OBSTACLES[i],s.elapsed);
      g.position.set(p.x,env.groundHeight(p.x,p.z),p.z);
    });
    pickupMeshes.forEach((g,i) => {
      g.visible=!s.pickups.includes(i);
      if(!reduced) g.children[0].rotation.y=elapsedVisual*1.6;
    });
    const rivalPositions = RIVALS.map((r,i)=>trackPoint(rivalProgress(s.elapsed,i)*Math.PI*2,r.lane));
    rivals.forEach((ghost,i) => {
      const ghostAngle=rivalProgress(s.elapsed,i)*Math.PI*2, ghostP=rivalPositions[i];
      const jumpDistance=Math.min(...OBSTACLES.map(o=>Math.abs(o.angle-ghostAngle)))*ROUTE_LENGTH/(Math.PI*2);
      const hop=s.phase === "racing" && jumpDistance<2.8 ? Math.sin((1-jumpDistance/2.8)*Math.PI/2)*1.1 : 0;
      ghost.group.position.set(ghostP.x, env.groundHeight(ghostP.x, ghostP.z), ghostP.z);
      ghost.group.position.y+=hop;
      ghost.group.rotation.y = trackHeading(ghostAngle);
      ghost.group.children.at(-1).visible=Math.hypot(ghostP.x-p.x,ghostP.z-p.z)>5;
      ghost.update(s.phase === "racing" ? dt : 0, elapsedVisual,
        { speed: s.phase === "racing" && s.elapsed < RIVALS[i].seconds ? ROUTE_LENGTH/RIVALS[i].seconds : 0,
          grounded: hop === 0, speed01: s.phase === "racing" && s.elapsed < RIVALS[i].seconds ? 1 : 0,
          groundY: ghost.group.position.y-hop });
    });
    for (const [node, position] of [[nodes.raceMinimapPlayer,p],[nodes.raceMinimapGhost,rivalPositions[0]],[$("raceMinimapRival"),rivalPositions[1]]]) {
      node.setAttribute("cx", Math.max(3, Math.min(117, 60+(position.x+8)*.9)));
      node.setAttribute("cy", Math.max(3, Math.min(121, 62-(position.z-5)*.9)));
    }
  }
  return {
    enter() {
      if (active) return;
      build(); savedPose = roam.qaState;
      active = true; root.visible = true; hud.hidden = false;
      document.body.classList.add("race-active");
      env.setRaceMode(true);
      roam.setGameMode(true); resetPosition(); rules.reset(); previousPhase = ""; update(0);
    },
    exit() {
      if (!active) return;
      active = false; root.visible = false; hud.hidden = true;
      audio.stop();
      document.body.classList.remove("race-active");
      env.setRaceMode(false);
      roam.setGameMode(false); roam.releaseInputs();
      if (savedPose) roam.teleport(savedPose.pos[0], savedPose.pos[2], savedPose.heading);
    },
    update, pause, start,
    get active() { return active; },
    get driving() { return active && ["racing", "finished"].includes(rules.state.phase); },
    useItem,
    inspectVisuals() {
      const road=root.getObjectByName("raceRoad");
      if(!road)return {built:false};
      let minClearance=Infinity;
      let roadTriangles=0;
      for(const mesh of [road,root.getObjectByName("raceJunctions")]){
        const p=mesh.geometry.attributes.position,idx=mesh.geometry.index,count=idx?.count??p.count;
        roadTriangles+=count/3;
        for(let i=0;i<count;i+=3){
          let x=0,y=0,z=0;for(let k=0;k<3;k++){const v=idx?idx.getX(i+k):i+k;x+=p.getX(v)/3;y+=p.getY(v)/3;z+=p.getZ(v)/3;}
          minClearance=Math.min(minClearance,y-env.surfaceHeight(x,z));
        }
      }
      return {built:true,roadTriangles,minClearance,obstacles:obstacleMeshes.length,pickups:pickupMeshes.length,
        visiblePickups:pickupMeshes.filter(g=>g.visible).length};
    },
    get state() { return { active, ...rules.state, best, audio: audio.state, rivals: RIVALS.map((r,i)=>({...r,progress:rivalProgress(rules.state.elapsed,i)})) }; }
  };
}
