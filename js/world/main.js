/* Agreement Ranch — open-world tour of the MV-SAM3D pipeline.
   Bootstrap, render loop, TRAVEL⇄DWELL state machine, UI wiring,
   and the seekable ?tour=1 clock (window.__world) for the recorder. */

import * as THREE from "../../vendor/three.module.js";
import { OrbitControls } from "../../vendor/OrbitControls.js";
import { GLTFLoader } from "../../vendor/GLTFLoader.js";
import { CSS2DRenderer } from "../../vendor/CSS2DRenderer.js";
import { STATIONS, OVERVIEW, buildTimeline, poseAt, travelPose, pathTravelPose, arcPose, dwellPose } from "./rail.js?v=20260812-view-routing";
import { buildEnvironment } from "./environment.js?v=20260812-sequential-carry";
import { buildStations, loadAgreementPayload, startStationTextures } from "./stations.js?v=20260813-rgbd-pointcloud";
import { needsFullSourceTextures } from "./source-texture-policy.js";
import { initPanels, makeStationMarkers } from "./panels.js?v=20260813-rgbd-pointcloud";
import { initTravelCaption } from "./travel-caption.js?v=20260813-rgbd-pointcloud";
import { initStepScrubber } from "./step-scrubber.js?v=20260812-view-routing";
import { initReaderGuide } from "./reader-guide.js?v=20260812-gantry-trigger";
import { initRoam } from "./roam.js?v=20260812-pipeline-review";
import { createPipelineCarry } from "./pipeline-carry.js?v=20260813-rgbd-pointcloud";
/* Version the changed world graph together. An old cached pre-bind-pose avatar
   adapter scales a cloned SkinnedMesh to ~1/900 and leaves only its shadow. */
import { createGlbCattle } from "../lib/glb-cattle.js?v=20260811-fast-dense";
import { loadReconSteps } from "../lib/recon-player.js?v=20260812-virtual-clock";
import { planQuality, readDeviceSignals } from "../lib/device-tier.js";
import {
  createRenderLifecycle,
  handleRenderPageHide,
  handleRenderPageShow
} from "./render-lifecycle.js";

/* ---------- params / flags ---------- */

const params = new URLSearchParams(location.search);
const TOUR = params.get("tour") === "1";
/* The primary route is calf-guided: after the opening arc settles at the gate,
   the visitor automatically takes control of the calf. `?autoroam=0` is the
   explicit opt-out used by manual-entry QA and reduced showcase variants. */
const AUTO_ROAM = !TOUR && params.get("autoroam") !== "0";
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
/* How much world this device can afford, decided once. The recorder is the
   deliverable video, so it always renders at full quality regardless of the
   machine it happens to run on. */
const QUALITY = planQuality({
  ...readDeviceSignals(),
  /* Stage-2 soft-disc composite mode: ?s2blend=additive is the A/B lever
     kept from the shader decision — threaded through planQuality because
     that is the one place all quality knobs live. */
  s2blend: params.get("s2blend"),
  ...(TOUR ? { forceTier: "high" } : {})
});

function parseStep(v) {
  if (!v) return null;
  if (v.includes("/")) {
    const [a, b] = v.split("/").map(Number);
    return a && b ? a / b : null;
  }
  const f = parseFloat(v);
  return Number.isFinite(f) && f > 0 ? f : null;
}
let fixedStep = parseStep(params.get("fixedstep"));

/* ---------- intro overlay = status/diagnostics surface ---------- */

const introEl = document.getElementById("intro");
const statusEl = document.getElementById("introStatus");
const btnEnter = document.getElementById("btnEnter");
const btnExplore = document.getElementById("btnExplore");
const entryToastEl = document.getElementById("entryToast");
const entryToastTitle = entryToastEl.querySelector("[data-entry-toast-title]");
const entryToastBody = entryToastEl.querySelector("[data-entry-toast-body]");
const entryToastKeys = entryToastEl.querySelector("[data-entry-toast-keys]");
const entryToastClose = entryToastEl.querySelector("[data-entry-toast-close]");
const openingGuideEl = document.getElementById("openingGuide");
const guidePanels = [...openingGuideEl.querySelectorAll("[data-guide-panel]")];
const guideTrack = [...openingGuideEl.querySelectorAll(".opening-guide__track span")];
const guideCurrent = openingGuideEl.querySelector("[data-guide-current]");
const guideBack = document.getElementById("guideBack");
const guideNext = document.getElementById("guideNext");
const guideSkip = document.getElementById("guideSkip");
let openingGuideStep = 0;
let fatalLoad = false;
let renderLifecycle = null;
let unloading = false;
let entryToastShowTimer = null;
let entryToastHideTimer = null;

function hideEntryToast(force = false) {
  if (!force && entryToastEl.contains(document.activeElement)) return;
  clearTimeout(entryToastShowTimer);
  clearTimeout(entryToastHideTimer);
  entryToastEl.classList.remove("show");
  entryToastClose.hidden = true;
}

function showEntryToast(destination) {
  const free = destination === "overview";
  entryToastTitle.textContent = free ? "FREE EXPLORE READY" : "GUIDED TRAIL READY";
  entryToastBody.textContent = free
    ? "Drag to orbit, right-drag to pan, and scroll to zoom. Select any exhibit to inspect it; press C to roam as the calf."
    : "You are driving the calf. Follow the amber path with WASD, or choose a numbered station to auto-run there. Drag to look; press C or Esc to leave calf mode.";
  entryToastKeys.textContent = free
    ? "DRAG → ORBIT · RIGHT-DRAG → PAN · SCROLL → ZOOM · C → CALF"
    : "WASD → MOVE · SHIFT → RUN · DRAG → LOOK · 0–8 → AUTO-RUN";
  clearTimeout(entryToastShowTimer);
  clearTimeout(entryToastHideTimer);
  entryToastShowTimer = setTimeout(() => {
    entryToastClose.hidden = false;
    entryToastEl.classList.add("show");
    entryToastHideTimer = setTimeout(() => hideEntryToast(), 9000);
  }, REDUCED ? 80 : 420);
}

entryToastClose.addEventListener("click", () => hideEntryToast(true));
entryToastEl.addEventListener("focusout", () => {
  if (entryToastEl.classList.contains("show")) {
    entryToastHideTimer = setTimeout(() => hideEntryToast(), 1200);
  }
});

window.addEventListener("pagehide", (event) => {
  handleRenderPageHide({
    event,
    lifecycle: renderLifecycle,
    onFinalUnload: () => { unloading = true; }
  });
});
window.addEventListener("pageshow", (event) => {
  handleRenderPageShow({ event, lifecycle: renderLifecycle });
});

const showStatus = (msg) => {
  if (!fatalLoad) statusEl.textContent = msg;
};
const showFatal = (msg, err) => {
  fatalLoad = true;
  console.error(err || msg);
  statusEl.innerHTML =
    `<span style="color:#e4574b">WORLD ERROR</span><br>` +
    `<span>${msg}</span><br>` +
    (err ? `<span style="color:#5c6873">${String(err).slice(0, 220)}</span><br>` : "") +
    `<span style="color:#5c6873">PRESS RETRY TO FETCH A FRESH COPY · CHROME/EDGE/FIREFOX RECOMMENDED</span>`;
  btnEnter.textContent = "RETRY LOAD";
  btnEnter.disabled = false;
  btnExplore.disabled = true;
  /* Core failures happen before the normal ENTER listener is installed. */
  btnEnter.onclick = () => location.reload();
};

function renderOpeningGuide(nextStep) {
  openingGuideStep = Math.max(0, Math.min(guidePanels.length - 1, nextStep));
  openingGuideEl.dataset.step = String(openingGuideStep);
  guideCurrent.textContent = String(openingGuideStep + 1).padStart(2, "0");
  guidePanels.forEach((panel, i) => { panel.hidden = i !== openingGuideStep; });
  guideTrack.forEach((marker, i) => marker.classList.toggle("active", i <= openingGuideStep));
  guideBack.disabled = openingGuideStep === 0;
  const atLastStep = openingGuideStep === guidePanels.length - 1;
  guideNext.textContent = atLastStep
    ? "START TRAIL →"
    : "NEXT →";
  guideNext.disabled = atLastStep && btnEnter.disabled;
  guideSkip.disabled = btnEnter.disabled;
}

guideBack.addEventListener("click", () => renderOpeningGuide(openingGuideStep - 1));
guideNext.addEventListener("click", () => {
  if (openingGuideStep < guidePanels.length - 1) renderOpeningGuide(openingGuideStep + 1);
  else btnEnter.click();
});
guideSkip.addEventListener("click", () => btnEnter.click());
openingGuideEl.addEventListener("keydown", (event) => {
  if (event.key === "ArrowLeft") {
    renderOpeningGuide(openingGuideStep - 1);
    event.preventDefault();
  } else if (event.key === "ArrowRight") {
    if (openingGuideStep < guidePanels.length - 1) renderOpeningGuide(openingGuideStep + 1);
    event.preventDefault();
  }
});
renderOpeningGuide(0);

/* ---------- main ---------- */

async function main() {
  if (TOUR) document.body.classList.add("tour");

  const probe = document.createElement("canvas");
  if (!probe.getContext("webgl2") && !probe.getContext("webgl")) {
    showFatal("WEBGL IS NOT AVAILABLE IN THIS BROWSER / REMOTE SESSION.\nENABLE HARDWARE ACCELERATION OR TRY ANOTHER BROWSER.");
    return;
  }

  const wrap = document.getElementById("worldWrap");
  const canvas = document.getElementById("gl");
  /* preserveDrawingBuffer only when the W2 recorder (?tour=1) reads frames
     off this canvas — it costs an extra copy per frame on some GPUs */
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: QUALITY.antialias, preserveDrawingBuffer: TOUR
  });
  renderer.setPixelRatio(QUALITY.pixelRatio);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.5;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 400);
  camera.position.copy(OVERVIEW.pos);
  camera.lookAt(OVERVIEW.target);

  const css2d = new CSS2DRenderer();
  css2d.domElement.className = "labels";
  wrap.appendChild(css2d.domElement);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  /* Evidence inspection should follow the pointer instead of pulling every
     zoom toward screen centre. Slightly calmer rates keep dense boards and
     point clouds controllable without changing the authored rail camera. */
  controls.zoomToCursor = true;
  controls.rotateSpeed = 0.72;
  controls.zoomSpeed = 0.82;
  controls.panSpeed = 0.76;
  controls.enablePan = true;
  controls.minDistance = 4;
  controls.maxDistance = 18;
  controls.minPolarAngle = 0.55;
  controls.maxPolarAngle = 1.45;
  controls.enabled = false;

  /* mouse mapping (overview AND dwell): left = orbit, right = pan,
     wheel = zoom, Ctrl+left = dolly-zoom. */
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  /* Ctrl+left: swap the LEFT action BEFORE OrbitControls sees the pointerdown
     (capture phase on the parent — target-phase listener order would lose).
     OrbitControls latches the action at pointerdown, so releasing Ctrl
     mid-drag simply finishes the dolly; the next press re-evaluates. */
  wrap.addEventListener("pointerdown", (e) => {
    controls.mouseButtons.LEFT = e.ctrlKey ? THREE.MOUSE.DOLLY : THREE.MOUSE.ROTATE;
  }, true);
  const restoreLeft = () => { controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE; };
  window.addEventListener("pointerup", restoreLeft);
  window.addEventListener("pointercancel", restoreLeft);
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  function resize() {
    const w = wrap.clientWidth, h = wrap.clientHeight;
    renderer.setSize(w, h, false);
    css2d.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", resize);
  resize();

  /* ---- first paint: terrain/sky/props + points payload ---- */
  const gltfLoader = new GLTFLoader();
  const loadStamp = new Date().toLocaleTimeString([], { hour12: false });
  showStatus(`OPENING AGREEMENT RANCH ${loadStamp} · WORLD SHELL + PAPER EVIDENCE`);
  let env, payload;
  try {
    /* The two 10+ MB reconstruction traces are evidence for stations 03/04,
       not prerequisites for seeing the ranch. They load during travel below. */
    [env, payload] = await Promise.all([
      buildEnvironment(scene, gltfLoader, showStatus),
      loadAgreementPayload()
    ]);
  } catch (err) {
    showFatal("FAILED TO LOAD THE WORLD'S CORE ASSETS.", err);
    return;
  }
  /* canvas-textured plaques need the faces resident before first draw */
  try {
    await Promise.all([
      document.fonts.load("30px 'Archivo Black'"),
      document.fonts.load("500 30px 'IBM Plex Mono'")
    ]);
  } catch { /* fallback fonts are acceptable */ }
  const stations = buildStations(scene, payload, null, null, QUALITY);
  const pipelineCarry = createPipelineCarry({
    scene, camera, payload, hudEl: document.getElementById("carryStatus"),
    getProcessState: (i) => stations.pipelineProcessState(i),
    getStationTarget: (i, kind) => stations.pipelineTarget(i, kind),
    startProcess: (i, request) => stations.beginPipelineProcess(i, request),
    setAgreementGhosted: (on) => stations.setAgreementGhosted(on)
  });
  const markerEls = makeStationMarkers(scene, (i) => navStation(i));

  /* invisible per-station hit volumes: clicking an exhibit rail-travels there */
  const hitTargets = STATIONS.map((s, i) => {
    const m = new THREE.Mesh(
      new THREE.CylinderGeometry(8.0, 8.0, 12, 12),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    m.position.set(s.pos.x, 6.0, s.pos.z);
    m.userData.station = i;
    scene.add(m);
    return m;
  });
  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();
  const finePointer = matchMedia("(pointer: fine)").matches;

  /* One cheap world-space cue is shared by hover, the final travel approach,
     and arrival. It makes the invisible click volumes legible without adding
     nine animated objects or a full-screen outline pass. */
  const stationTargetRing = new THREE.Mesh(
    new THREE.RingGeometry(7.35, 7.72, 48),
    new THREE.MeshBasicMaterial({
      color: 0xe39b2d,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide
    })
  );
  stationTargetRing.name = "shared-station-target-ring";
  stationTargetRing.rotation.x = -Math.PI / 2;
  stationTargetRing.position.y = 0.08;
  stationTargetRing.renderOrder = 5;
  stationTargetRing.visible = false;
  scene.add(stationTargetRing);

  /* ---- UI ---- */
  const panels = initPanels({
    panelEl: document.getElementById("stationPanel"),
    dotsEl: document.getElementById("dots"),
    chipEl: document.getElementById("stationChip"),
    onGoto: (i) => navStation(i),
    onFamily: (i) => stations.setFeatureFamily(i)
  });
  const readerGuide = initReaderGuide();
  /* when the FEATURES auto-cycle resumes after idle, clear the chip highlight */
  stations.featureUnpinCallback = () => panels.clearFamilyActive();
  /* one-line handoff narration while riding a leg (also the tour's caption) */
  const travelCaption = initTravelCaption();
  /* pause/scrub the recon replay while dwelling at 03 / 04 (desktop, non-tour) */
  const stepScrubber = initStepScrubber();

  /* ---- roam mode: the free-roam calf (world glue lives in roam.js) ----
     The calf and the ambient herd now share ONE rig — environment.js parses
     assets/world/cow_quaternius.glb once and hands out a clone — so the animal
     you drive is the animal you see grazing, instead of a procedural chibi cow
     next to a herd of GLB cows. glb-cattle keeps the rig's game feel on wrapper
     groups, so only the look changed, not the controls.

     ?avatar=chibi keeps the old procedural calf (also the automatic fallback
     if the GLB never arrived), ?avatar=cube keeps the Kenney candidate for A/B. */
  let roamAvatar = null;
  const avatarKind = params.get("avatar") || "herd";
  try {
    if (avatarKind === "cube") {
      const cowGltf = await new Promise((res, rej) => gltfLoader.load(
        "assets/world/candidates/cow_cubepet_kenney.glb", res, undefined, rej));
      roamAvatar = createGlbCattle(cowGltf, { height: 1.5 });
    } else if (avatarKind !== "chibi" && env.cowAsset) {
      roamAvatar = createGlbCattle(env.cowAsset, { height: 1.5 });
    }
  } catch (err) {
    console.warn(`${avatarKind} avatar unavailable, falling back to chibi:`, err);
  }
  const roamBtn = document.getElementById("btnRoam");
  const roam = initRoam({
    avatar: roamAvatar,
    scene, camera, canvas, env, stations, panels,
    setMarkerFocus,
    /* a roam approach must arm the same deferred loads as a rail arrival —
       otherwise the S1/S2 source-image boards stay black */
    requestModelsForStation: (i) => {
      requestModelsForStation(i);
      if (needsFullSourceTextures(i)) startStationTextures();
    },
    onGuideStation: (i) => {
      if (i === null) readerGuide.overview();
      else readerGuide.show(i);
    },
    onStationEnter: (i, t, subject, heading) => {
      pipelineCarry.enterStation(i, t, subject, heading);
    },
    onStationLeave: () => {
      pipelineCarry.reconcileStation(null, worldTime, roam.subject, roam.heading);
    },
    chipEl: document.getElementById("stationChip"),
    hintEl: document.querySelector(".hint"),
    onExitRequest: (kind) => exitRoam(kind)
  });
  roamBtn.addEventListener("click", () => {
    roamBtn.blur();   // keep Space/Enter flowing to the document, not the button
    if (mode === "roam") exitRoam("station");
    else enterRoam();
  });

  /* ---- state machine ---- */
  let worldTime = 0;
  let mode = TOUR ? "tour-wait" : "intro";  // intro | travel | dwell | overview | roam | tour
  let worldEntered = false;
  let pendingEntryToast = null;
  let active = -1;                          // station highlighted in UI
  let travel = null;                        // {kind, from, a, b, final, start, dur}
  let lastStation = 0;
  const timeline = buildTimeline();
  let tourTime = 0;
  let tourLeg = null;   // travel leg the tour is riding (null while dwelling)
  let hoveredStation = -1;
  let pressedStation = -1;
  let approachStation = -1;
  let arrivalStation = -1;
  let arrivalStart = -Infinity;

  function revealEntryToast(destination) {
    if (pendingEntryToast !== destination) return;
    pendingEntryToast = null;
    showEntryToast(destination);
  }

  const poseNow = () => ({
    pos: camera.position.clone(),
    target: controls.enabled ? controls.target.clone()
      : camera.position.clone().add(camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(10))
  });

  function applyPose(p) {
    camera.position.copy(p.pos);
    camera.lookAt(p.target);
    controls.target.copy(p.target);
  }

  function setMarkerFocus(i) {
    markerEls.forEach((el, j) => {
      const fade = i !== -1 && i !== null && Math.abs(j - i) > 1;
      el.classList.toggle("faded", fade);
    });
  }

  const stationTargetingAllowed = () =>
    finePointer && (mode === "dwell" || mode === "overview");

  function stationAtPointer(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || clientX < r.left || clientX > r.right ||
        clientY < r.top || clientY > r.bottom) return -1;
    pointerNdc.set(
      ((clientX - r.left) / r.width) * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1
    );
    raycaster.setFromCamera(pointerNdc, camera);
    return raycaster.intersectObjects(hitTargets, false)[0]?.object.userData.station ?? -1;
  }

  function setHoveredStation(i) {
    if (i === hoveredStation) return;
    if (hoveredStation >= 0) markerEls[hoveredStation].classList.remove("targeted");
    hoveredStation = i;
    if (hoveredStation >= 0) markerEls[hoveredStation].classList.add("targeted");
    canvas.classList.toggle("station-targetable", hoveredStation >= 0);
  }

  function setPressedStation(i) {
    if (i === pressedStation) return;
    if (pressedStation >= 0) markerEls[pressedStation].classList.remove("pressed");
    pressedStation = i;
    if (pressedStation >= 0) markerEls[pressedStation].classList.add("pressed");
    canvas.classList.toggle("station-pressed", pressedStation >= 0);
  }

  function clearInteractionTargeting() {
    setPressedStation(-1);
    setHoveredStation(-1);
  }

  function setApproachStation(i) {
    if (i === approachStation) return;
    if (approachStation >= 0) markerEls[approachStation].classList.remove("approaching");
    approachStation = i;
    if (approachStation >= 0) markerEls[approachStation].classList.add("approaching");
  }

  function clearArrivalFeedback() {
    setApproachStation(-1);
    if (arrivalStation >= 0) {
      markerEls[arrivalStation].classList.remove("arrived");
      markerEls[arrivalStation].style.removeProperty("--arrival-pulse");
      markerEls[arrivalStation].style.removeProperty("--arrival-glow");
    }
    arrivalStation = -1;
    arrivalStart = -Infinity;
    stationTargetRing.visible = false;
  }

  function clearWorldTargetFeedback() {
    clearInteractionTargeting();
    clearArrivalFeedback();
  }

  function showTargetRing(i, color, opacity, scale) {
    const p = STATIONS[i].pos;
    stationTargetRing.position.x = p.x;
    stationTargetRing.position.z = p.z;
    stationTargetRing.material.color.setHex(color);
    stationTargetRing.material.opacity = opacity;
    stationTargetRing.scale.setScalar(scale);
    stationTargetRing.visible = opacity > 0.002;
  }

  function updateWorldTargetFeedback() {
    /* Arrival owns the shared ring briefly; then hover can take it back. All
       phases derive from worldTime, so fixed-step capture and seeking never
       race CSS timers. Reduced motion keeps only an opacity confirmation. */
    if (arrivalStation >= 0 && mode === "dwell") {
      const k = Math.min(1, Math.max(0, (worldTime - arrivalStart) / 1.05));
      const fade = 1 - k;
      const easeOut = 1 - (1 - k) * (1 - k);
      const pulse = REDUCED ? fade : Math.sin(Math.PI * k);
      markerEls[arrivalStation].style.setProperty("--arrival-pulse", pulse.toFixed(3));
      markerEls[arrivalStation].style.setProperty("--arrival-glow", `${(5 + 17 * pulse).toFixed(1)}px`);
      showTargetRing(arrivalStation, 0x86d7ea, 0.64 * fade,
        REDUCED ? 1 : 0.86 + 0.30 * easeOut);
      if (k >= 1) clearArrivalFeedback();
      return;
    }

    if (approachStation >= 0 && mode === "travel" && travel) {
      const k = Math.min(1, Math.max(0, (worldTime - travel.start) / travel.dur));
      const a = Math.min(1, Math.max(0, (k - 0.76) / 0.24));
      showTargetRing(approachStation, 0xe39b2d, 0.18 + 0.36 * a,
        REDUCED ? 1 : 0.94 + 0.06 * a);
      return;
    }

    if (hoveredStation >= 0 && stationTargetingAllowed()) {
      const pressed = hoveredStation === pressedStation;
      const breathe = REDUCED ? 0 : Math.sin(worldTime * 4.2) * 0.012;
      showTargetRing(hoveredStation, 0xe39b2d, pressed ? 0.62 : 0.42,
        (pressed ? 0.97 : 1) + breathe);
      return;
    }
    stationTargetRing.visible = false;
  }

  /* "waiting" → "armed" (the gate has settled) → "spent". Not a timer: the
     tour recorder and ?fixedstep QA drive the world clock themselves, so a
     wall-clock setTimeout would desynchronise from the world it fires into. */
  let autoRoam = AUTO_ROAM ? "waiting" : "spent";

  const dwellCenter = new THREE.Vector3();  // pan clamp anchor while dwelling
  function enterDwell(i) {
    clearInteractionTargeting();
    clearArrivalFeedback();
    mode = "dwell";
    active = i;
    lastStation = i;
    applyPose(dwellPose(i, 0));
    /* free exploration: wheel-zoom range scales with the exhibit's framing */
    const d = STATIONS[i].cam.distanceTo(STATIONS[i].look);
    controls.minDistance = Math.max(2.2, d * 0.28);
    /* Room to back off and to get above the exhibit. The arrival pose itself is
       authored per station (rail.js `cam`) and drives the ?tour=1 video, so it
       is left alone — this only widens where a visitor may go from there.
       0.10 rad is ~6° off straight down, enough for a plan view of the boards. */
    controls.maxDistance = d * 7.0;
    controls.minPolarAngle = 0.10;
    controls.maxPolarAngle = 1.56;
    controls.enablePan = true;    // right-drag pans, clamped near the exhibit
    dwellCenter.copy(STATIONS[i].look);
    controls.enabled = true;
    controls.update();
    panels.showStation(i);
    readerGuide.show(i);
    stations.setActive(i, worldTime);
    env.setActiveLeg(i);   // panels.showStation above owns the dock leg link
    travelCaption.hide();
    /* the scrubber binds to the recon stations only; TOUR never dwells here
       (applyTour drives stations directly), so this path stays interactive */
    if (i === 3 || i === 4) stepScrubber.attach(stations.reconPlayers[i], i);
    else stepScrubber.detach();
    setMarkerFocus(i);
    document.getElementById("stationChip").classList.add("show");
    requestModelsForStation(i);
    arrivalStation = i;
    arrivalStart = worldTime;
    markerEls[i].classList.add("arrived");
    /* Arm the calf's entrance on the FIRST arrival only — wherever that is: a
       visitor who jumps straight to 03 gets met at 03. It fires on the next
       frame rather than inside this call, because enterDwell is mid-transition
       here and re-entering the state machine from its own body invites the bug
       where the panel opens for a mode that no longer exists. */
    if (autoRoam === "waiting") autoRoam = "armed";
    else revealEntryToast("guided");
  }

  function startTravel(kind, b, dur, opts = {}) {
    const from = poseNow();
    const final = opts.final ?? b;
    const to = opts.to ?? null;
    clearWorldTargetFeedback();
    controls.enabled = false;
    panels.hidePanel();
    readerGuide.hide();
    stepScrubber.detach();
    /* narrate the leg before the reduced-motion return so that path is not
       silently caption-less (enterDwell clears it on arrival) */
    if (kind === "rail" || kind === "direct") travelCaption.show(lastStation, b);
    else travelCaption.hide();
    if (REDUCED || dur <= 0) {
      if (kind === "overview") { finishOverview(); return; }
      enterDwell(final);
      return;
    }
    travel = { kind, from, to, a: lastStation, b, final, start: worldTime, dur };
    mode = "travel";
    stations.clearActive();   // wide lighting while the camera flies past stations
    active = kind === "overview" ? -1 : final;
    panels.setDots(active);
    setMarkerFocus(null);
    /* rail AND direct ride the pipeline (direct is backward travel — without
       it the previous dwell's leg stayed lit all the way home); arc/overview
       hops leave the pipeline, so their leg cue goes dark. The dock link only
       lights for a single-leg ride: a multi-hop passes several legs and
       picking one would lie. */
    if (kind === "rail" || kind === "direct") {
      env.setActiveLeg(Math.min(lastStation, b));
      panels.setLeg(Math.abs(b - lastStation) === 1 ? Math.min(lastStation, b) : -1);
    } else {
      panels.setLeg(-1);
    }
  }

  function finishOverview() {
    clearWorldTargetFeedback();
    mode = "overview";
    applyPose(OVERVIEW);
    /* overview is a full orbit camera over the ranch: orbit / zoom / clamped pan */
    controls.minDistance = 18;
    controls.maxDistance = 160;
    controls.minPolarAngle = 0.08;
    controls.maxPolarAngle = 1.42;
    controls.enablePan = true;
    controls.enabled = true;
    controls.update();
    panels.showPipeline();
    readerGuide.overview();
    env.setActiveLeg(-1);
    travelCaption.hide();
    stepScrubber.detach();
    stations.clearActive();   // relight every station for the wide view
    setMarkerFocus(-1);
    const chip = document.getElementById("stationChip");
    chip.textContent = "OVERVIEW — AGREEMENT RANCH";
    chip.classList.add("show");
    revealEntryToast("overview");
  }

  function stationTravelSeconds(legs) {
    return Math.min(12, Math.max(1, legs) * 2);
  }

  function directTravelSeconds(fromPose, toPose) {
    const speed = 10.0; // world units per second after the initial look turn
    const turnSeconds = 0.7;
    return Math.min(12, Math.max(2, turnSeconds + fromPose.pos.distanceTo(toPose.pos) / speed));
  }

  function gotoStation(i) {
    if (mode === "tour" || mode === "tour-wait") return;
    /* leaving roam via any station navigation: drop the calf, arc-travel */
    if (mode === "roam") {
      roam.exit();
      pipelineCarry.setEnabled(false);
      setRoamChrome(false);
    }
    if (i === active && mode === "dwell") return;
    /* Start large exhibit assets during travel, not after arrival. */
    requestModelsForStation(i);
    if (needsFullSourceTextures(i)) startStationTextures();
    const cameFrom = mode === "dwell" ? lastStation : null;
    if (cameFrom !== null) {
      const legs = Math.abs(i - cameFrom);
      if (!legs) return;
      if (i < cameFrom) {
        const to = dwellPose(i, 0);
        startTravel("direct", i, directTravelSeconds(poseNow(), to), { final: i, to });
      } else {
        startTravel("rail", i, stationTravelSeconds(legs), { final: i });
      }
    } else {
      startTravel("arc", i, 2.4); // from intro/overview/travel: slower raised arc
    }
  }

  /* Every station-navigation affordance — dock dots, panel rows, in-world
     markers, the dock arrows — funnels through here. Roam has no movement
     input on a touch device, so a dot tap that exits roam and flies the
     camera off is the opposite of what a phone user wants: while roaming,
     the same tap sends the calf running there instead. Only the 🐮 button,
     C and Esc leave roam. */
  function navStation(i) {
    if (mode === "roam") { roam.travelTo(i); return; }
    gotoStation(i);
  }

  function toggleOverview() {
    if (mode === "tour" || mode === "tour-wait") return;
    if (mode === "roam") { exitRoam("overview"); return; }
    if (mode === "overview") gotoStation(lastStation);
    else startTravel("overview", -1, 1.8);
  }

  /* ---- roam enter/exit (mode transitions stay in main; roam.js is inert) ---- */
  /* roam chrome is two flags: the dock toggle, and a body class the stylesheet
     uses to swap in the touch legend — the desktop keyboard hint is
     display:none under 640px, which left phone roamers with no legend at all */
  function setRoamChrome(on) {
    roamBtn.classList.toggle("active", on);
    document.body.classList.toggle("roaming", on);
  }
  function enterRoam() {
    if (mode !== "dwell" && mode !== "overview") return;
    clearWorldTargetFeedback();
    mode = "roam";
    travel = null;
    controls.enabled = false;
    panels.hidePanel();
    stations.clearActive();
    setMarkerFocus(null);
    setRoamChrome(true);
    readerGuide.overview();
    travelCaption.hide();
    stepScrubber.detach();
    pipelineCarry.setEnabled(true);
    roam.enter(lastStation, worldTime);   // spawn beside the last dwelled station
    revealEntryToast("guided");
  }
  function exitRoam(kind) {
    if (mode !== "roam") return;
    if (kind === "overview") {
      roam.exit();
      pipelineCarry.setEnabled(false);
      setRoamChrome(false);
      startTravel("overview", -1, 1.8);
    } else {
      gotoStation(roam.nearestStationIndex());  // handles roam.exit() itself
    }
  }

  function updateTravel() {
    const k = Math.min(1, (worldTime - travel.start) / travel.dur);
    setApproachStation(travel.kind !== "overview" && k >= 0.76 ? travel.final : -1);
    let p;
    if (travel.kind === "rail") {
      p = Math.abs(travel.b - travel.a) > 1
        ? pathTravelPose(travel.a, travel.b, k, travel.from, dwellPose(travel.b, 0))
        : travelPose(travel.a, travel.b, k, travel.from, dwellPose(travel.b, 0));
    } else if (travel.kind === "direct") {
      const turnFrac = Math.min(0.35, 0.7 / travel.dur);
      if (k < turnFrac) {
        const tk = k / turnFrac;
        const e = tk * tk * (3 - 2 * tk);
        p = {
          pos: travel.from.pos.clone(),
          target: travel.from.target.clone().lerp(travel.to.target, e)
        };
      } else {
        const mk = (k - turnFrac) / (1 - turnFrac);
        const e = mk * mk * (3 - 2 * mk);
        p = {
          pos: travel.from.pos.clone().lerp(travel.to.pos, e),
          target: travel.to.target.clone()
        };
      }
    } else if (travel.kind === "arc") {
      p = arcPose(travel.from, dwellPose(travel.b, 0), k, 8);
    } else { // overview
      p = arcPose(travel.from, OVERVIEW, k, 4);
    }
    applyPose(p);
    if (k >= 1) {
      const t = travel;
      travel = null;
      if (t.kind === "overview") finishOverview();
      else enterDwell(t.final);
    }
  }

  /* ---- tour clock + recorder API ---- */
  function applyTour(t) {
    const p = poseAt(timeline, t);
    applyPose(p);
    const leg = p.leg ?? null;
    if (leg !== tourLeg) {
      tourLeg = leg;
      if (leg !== null) travelCaption.showLeg(leg);
      else travelCaption.hide();
    }
    if (p.station !== active) {
      active = p.station;
      panels.setDots(active === null ? -1 : active);
      if (active !== null) {
        requestModelsForStation(active);
        if (needsFullSourceTextures(active)) startStationTextures();
        stations.setActive(active, t);
        env.setActiveLeg(active);
      } else {
        stations.clearActive();
      }
      setMarkerFocus(active === null ? null : active);
    }
  }

  /* ---- loop ---- */
  const clock = new THREE.Clock();
  const _panV = new THREE.Vector3();
  function renderFrame() {
    const dt = fixedStep !== null ? fixedStep : Math.min(clock.getDelta(), 0.05);
    if (mode === "tour") {
      tourTime = Math.min(tourTime + dt, timeline.duration);
      worldTime = tourTime;
      applyTour(tourTime);
    } else {
      worldTime += dt;
      /* the calf lets itself in, the frame after the station settles */
      if (autoRoam === "armed") {
        autoRoam = "spent";
        if (mode === "dwell") enterRoam();
      }
      if (mode === "travel") updateTravel();
      else if (mode === "roam") roam.update(dt, worldTime);
      else if (mode === "dwell") {
        /* right-drag pan stays near the exhibit while allowing wider inspection */
        _panV.subVectors(controls.target, dwellCenter);
        const pd = _panV.length();
        if (pd > 10) controls.target.copy(dwellCenter).addScaledVector(_panV, 10 / pd);
        if (controls.target.y < 0.3) controls.target.y = 0.3;
        controls.update();
      }
      else if (mode === "overview") {
        /* keep panning inside the ranch */
        controls.target.x = Math.min(72, Math.max(-72, controls.target.x));
        controls.target.z = Math.min(72, Math.max(-72, controls.target.z));
        controls.target.y = Math.min(16, Math.max(-1, controls.target.y));
        controls.update();
      }
    }
    updateWorldTargetFeedback();
    /* the calf's live position drives both rigs' shutter bursts */
    env.update(worldTime, roam.subject);
    stations.update(worldTime, roam.subject);
    pipelineCarry.update(dt, worldTime, roam.subject, roam.heading);
    stepScrubber.update();   // playhead/label track the player's virtual clock
    /* after the camera for this frame is final, before anything is drawn */
    stations.updateModelLod(camera);
    renderer.render(scene, camera);
    css2d.render(scene, camera);
  }
  renderLifecycle = createRenderLifecycle({ renderer, frame: renderFrame });
  if (unloading) renderLifecycle.dispose();

  window.__world = {
    durationSeconds: timeline.duration,
    seekSeconds(s) {
      /* the recorder may seek from any interactive state — drop the calf */
      if (mode === "roam") {
        roam.exit();
        pipelineCarry.setEnabled(false);
        setRoamChrome(false);
      }
      clearWorldTargetFeedback();
      /* and drop the scrubber: a scrubbed pause must not ride into the
         recorder's clock (it froze station 03 for a whole tour dwell) */
      stepScrubber.detach();
      mode = "tour";
      controls.enabled = false;
      tourTime = Math.min(Math.max(s, 0), timeline.duration);
      worldTime = tourTime;
      applyTour(tourTime);
    },
    setFixedStep(dtOrNull) { fixedStep = dtOrNull; },
    get mode() { return mode; },
    get station() { return mode === "dwell" ? lastStation : active; },
    get worldTime() { return worldTime; },
    /* QA hooks */
    get rendering() { return renderLifecycle.isRunning; },
    get renderInfo() {
      const r = renderer.info.render;
      return { calls: r.calls, triangles: r.triangles, points: r.points, programs: renderer.info.programs.length };
    },
    get camDistance() { return camera.position.distanceTo(controls.target); },
    get camPos() { return camera.position.toArray(); },
    get camTarget() { return controls.target.toArray(); },
    get scrub() { return stepScrubber.qaState; },
    get openingGuide() {
      return { step: openingGuideStep, total: guidePanels.length, entered: worldEntered };
    },
    /* Attribute the frame's cost to named scene children. renderInfo says the
       ranch is expensive; this says WHICH exhibit is paying, which is what a
       culling regression needs to assert against. */
    sceneCost() {
      scene.updateMatrixWorld(true);
      const frustum = new THREE.Frustum().setFromProjectionMatrix(
        new THREE.Matrix4().multiplyMatrices(
          camera.projectionMatrix, camera.matrixWorldInverse));
      const sphere = new THREE.Sphere();
      const rows = [];
      for (const child of scene.children) {
        let drawn = 0, hidden = 0, points = 0;
        child.traverse((o) => {
          if (o.isPoints) points += o.geometry?.drawRange?.count ?? 0;
          if (!o.isMesh || !o.geometry?.attributes?.position) return;
          const idx = o.geometry.index;
          const count = idx ? idx.count : o.geometry.attributes.position.count;
          const tris = (count / 3) * (o.isInstancedMesh ? o.count : 1);
          for (let p = o; p; p = p.parent) if (!p.visible) { hidden += tris; return; }
          if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
          sphere.copy(o.geometry.boundingSphere).applyMatrix4(o.matrixWorld);
          if (frustum.intersectsSphere(sphere)) drawn += tris;
        });
        if (drawn || hidden || points) {
          rows.push({ name: child.name || child.type, drawn, hidden, points });
        }
      }
      rows.sort((a, b) => b.drawn - a.drawn);
      return rows;
    },
    /* Where a named object lands on screen, in CSS pixels. "Is the panel
       covering the board?" is a question about pixels, and eyeballing a
       screenshot answers it far less reliably than projecting the corners. */
    screenRect(name) {
      scene.updateMatrixWorld(true);
      let found = null;
      scene.traverse((o) => { if (!found && o.name === name) found = o; });
      if (!found) return null;
      const box = new THREE.Box3().setFromObject(found);
      if (box.isEmpty()) return null;
      const v = new THREE.Vector3();
      const w = renderer.domElement.clientWidth;
      const h = renderer.domElement.clientHeight;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      let behind = false;
      for (let i = 0; i < 8; i++) {
        v.set(i & 1 ? box.max.x : box.min.x,
              i & 2 ? box.max.y : box.min.y,
              i & 4 ? box.max.z : box.min.z).project(camera);
        if (v.z > 1) behind = true;
        const sx = (v.x * 0.5 + 0.5) * w, sy = (-v.y * 0.5 + 0.5) * h;
        minX = Math.min(minX, sx); maxX = Math.max(maxX, sx);
        minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
      }
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY, behind };
    },
    get captureFlash() { return stations.captureFlash; },
    get gateFlash() { return env.gateFlash; },
    get quality() { return { ...QUALITY }; },
    get modelLod() { return stations.modelLodStats; },
    get compareLodState() { return stations.compareLodState; },
    setModelLodEnabled: (on) => stations.setModelLodEnabled(on),
    /* prop collision against the real built layout — the reachability walk
       alone cannot tell a solid fence from a no-op collider, since a calf that
       ignores fences also arrives everywhere */
    collideProbe: (x, z, r = 0.8, clearance = 0) => ({ ...env.collide(x, z, r, clearance) }),
    get barGrowth() { return stations.barGrowth; },
    get weighBars() { return stations.weighBars; },
    get futureState() { return stations.deploymentState; },
    get reconState() { return stations.reconState; },
    get fusionReconState() { return stations.fusionReconState; },
    get pipelineState() { return pipelineCarry.qaState; },
    pipelineProcessState(i) { return stations.pipelineProcessState(i); },
    /* FEATURES station (S6, index 6) */
    setFeatureFamily: (i) => stations.setFeatureFamily(i),
    get featureState() { return stations.featureState; },
    get featureValues() { return stations.featureValues; },
    get featureFinalModelReady() { return stations.featureFinalModelReady; },
    /* roam mode (free-roam calf) — QA + recorder hooks */
    roam: {
      enter: () => enterRoam(),
      exit: (kind = "station") => exitRoam(kind),
      press: (action, isDown = true) => roam.press(action, isDown),
      orbit: (dx, dy) => roam.orbit(dx, dy),
      zoom: (delta) => roam.zoom(delta),
      teleport: (x, z, heading) => roam.teleport(x, z, heading),
      goto: (i) => roam.travelTo(i),
      get state() { return roam.qaState; }
    }
  };
  window.__worldReady = false;

  /* ---- input ---- */
  function stepStation(delta) {
    let next;
    if (mode === "dwell") next = lastStation + delta;
    /* roaming: step from where the hooves actually are, not from the stale
       dwell index — otherwise ←/→ would fling the calf across the ranch */
    else if (mode === "roam") next = roam.nearestStationIndex() + delta;
    else if (mode === "travel" && travel && travel.kind !== "overview") next = travel.final + delta;
    else next = lastStation; // from overview: first arrow returns to the current station
    navStation(Math.min(STATIONS.length - 1, Math.max(0, next)));
  }
  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea")) return;
    if (mode === "tour" || mode === "tour-wait" || mode === "intro") return;
    if (mode === "roam") return;   // roam.js owns the keyboard while roaming
    if (e.key === "ArrowRight") stepStation(1);
    else if (e.key === "ArrowLeft") stepStation(-1);
    else if (e.key === "Escape") toggleOverview();
    else if (e.key === "c" || e.key === "C") enterRoam();
    else if (/^[0-9]$/.test(e.key)) {
      const i = parseInt(e.key, 10);
      if (i < STATIONS.length) gotoStation(i);
    }
  });
  document.getElementById("btnPrev").addEventListener("click", () => stepStation(-1));
  document.getElementById("btnNext").addEventListener("click", () => stepStation(1));

  /* click/tap (not drag): raycast exhibits → rail-travel; touch fallback advances */
  let tapStart = null;
  let hoverFrame = 0;
  let pendingHover = null;
  canvas.addEventListener("pointermove", (e) => {
    if (tapStart && Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y) >= 8) {
      tapStart.dragged = true;
      clearInteractionTargeting();
      pendingHover = null;
      return;
    }
    if (!stationTargetingAllowed()) {
      clearInteractionTargeting();
      pendingHover = null;
      return;
    }
    pendingHover = { x: e.clientX, y: e.clientY };
    if (hoverFrame) return;
    hoverFrame = requestAnimationFrame(() => {
      hoverFrame = 0;
      const p = pendingHover;
      pendingHover = null;
      if (!p || !stationTargetingAllowed() || tapStart?.dragged) return;
      setHoveredStation(stationAtPointer(p.x, p.y));
    });
  });
  canvas.addEventListener("pointerleave", () => {
    tapStart = null;
    pendingHover = null;
    clearInteractionTargeting();
  });
  canvas.addEventListener("pointerdown", (e) => {
    /* roam owns the canvas pointer (any drag orbits the follow camera). The
       pointerup guard below already refuses to act, but arming a tap here at
       all would let a mode flip mid-gesture fire a stray station raycast —
       and on touch that reads as the calf being yanked away mid-drag. */
    if (mode === "roam") { tapStart = null; clearInteractionTargeting(); return; }
    /* left button only — right-drag pans and Ctrl+left dollies, never a tap */
    if (e.button !== 0 || e.ctrlKey) { tapStart = null; clearInteractionTargeting(); return; }
    tapStart = { x: e.clientX, y: e.clientY, t: performance.now(), touch: e.pointerType === "touch" };
    if (stationTargetingAllowed()) {
      const station = stationAtPointer(e.clientX, e.clientY);
      setHoveredStation(station);
      setPressedStation(station);
    }
  });
  canvas.addEventListener("pointerup", (e) => {
    setPressedStation(-1);
    if (!tapStart) return;
    const info = tapStart;
    tapStart = null;
    const moved = Math.hypot(e.clientX - info.x, e.clientY - info.y);
    if (info.dragged || moved >= 8 || performance.now() - info.t > 400) return;
    if (mode !== "dwell" && mode !== "overview") return;
    const station = stationAtPointer(e.clientX, e.clientY);
    if (station >= 0) {
      gotoStation(station);
    } else if (info.touch && mode === "dwell") {
      gotoStation(Math.min(STATIONS.length - 1, lastStation + 1));
    }
  });
  window.addEventListener("pointerup", () => setPressedStation(-1));
  window.addEventListener("pointercancel", () => {
    tapStart = null;
    pendingHover = null;
    clearInteractionTargeting();
  });

  function enterWorld(destination) {
    if (worldEntered) return;
    if (fatalLoad) {
      location.reload();
      return;
    }
    worldEntered = true;
    pendingEntryToast = destination;
    document.activeElement?.blur?.(); // keep movement keys flowing to the world
    introEl.classList.add("hidden");
    renderLifecycle.start();
    if (destination === "overview") {
      /* EXPLORE FREELY means the paper map, not an involuntary mode switch.
         The primary CALF-GUIDED route keeps the automatic entrance. */
      autoRoam = "spent";
      finishOverview();
    } else {
      gotoStation(0);  // arc down to the ranch gate, then auto-enter the calf
    }
  }

  btnEnter.addEventListener("click", () => enterWorld("guided"));
  btnExplore.addEventListener("click", () => enterWorld("overview"));

  /* ---- on-demand exhibit GLBs: keep READY/ENTER free of ~35 MB parsing ---- */
  const modelRequests = new Map();
  const pauseForPaint = () => new Promise((resolve) => {
    if ("requestIdleCallback" in window) requestIdleCallback(resolve, { timeout: 250 });
    else requestAnimationFrame(() => resolve());
  });
  function requestModel(key) {
    if (modelRequests.has(key)) return modelRequests.get(key);
    stations.markModelLoading(key);
    const request = (async () => {
      let lastError = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await fetch(`assets/cases/case_001/models/${key}.glb`);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const buf = await response.arrayBuffer();
          const gltf = await new Promise((res, rej) =>
            gltfLoader.parse(buf, "assets/cases/case_001/models/", res, rej));
          /* agreement/entropy/average ship POSITION + COLOR_0 only (no
             materials): glTF's default metallic=1.0 material renders them
             near-black — replace it. trellis2 carries its own textured
             material (no COLOR_0), leave that one untouched. */
          gltf.scene.traverse((o) => {
            /* CowDB's RGB+D baseline is geometry-only XYZ. Keep it visibly a
               point cloud and use one display colour rather than fabricating
               per-point RGB evidence that is absent from the source PLY. */
            if (o.isPoints) {
              o.material = new THREE.PointsMaterial({
                color: 0x86d7ea,
                size: QUALITY.tier === "low" ? 0.032 : 0.024,
                sizeAttenuation: true,
                transparent: true,
                opacity: 0.92,
                depthWrite: false
              });
              o.userData.evidenceKind = "rgbd-point-cloud";
              return;
            }
            if (!o.isMesh) return;
            const colAttr = o.geometry && o.geometry.getAttribute("color");
            if (!colAttr) return;
            o.material = new THREE.MeshStandardMaterial({
              vertexColors: true, metalness: 0.0, roughness: 0.85
            });
            /* these meshes also ship without NORMAL — without it every light
               term is zero and the model renders black */
            if (!o.geometry.getAttribute("normal")) o.geometry.computeVertexNormals();
            /* mild lift: the baked vertex colors are linear and dark (mean
               ~0.15); a gentle gamma keeps the dark-brown coat honest while
               letting the white face/legs read under dawn light */
            if (!o.geometry.userData.colorLifted) {
              o.geometry.userData.colorLifted = true;
              const a = colAttr.array;
              const u8 = a instanceof Uint8Array;
              for (let i = 0; i < a.length; i++) {
                if (colAttr.itemSize === 4 && i % 4 === 3) continue; // skip alpha
                a[i] = u8
                  ? Math.round(255 * Math.pow(a[i] / 255, 0.92))
                  : Math.pow(a[i], 0.92);
              }
              colAttr.needsUpdate = true;
            }
          });
          stations.attachModel(key, gltf.scene);
          return gltf.scene;
        } catch (err) {
          lastError = err;
          if (attempt === 0 && !unloading) {
            await new Promise((resolve) => setTimeout(resolve, 700));
          }
        }
      }
      if (!unloading) console.warn(`model ${key} failed to load after retry:`, lastError);
      stations.markModelUnavailable(key);
      return null;
    })();
    modelRequests.set(key, request);
    /* Keep successful promises cached; failures can retry on a later visit. */
    request.then((scene) => {
      if (!scene) modelRequests.delete(key);
    });
    return request;
  }

  let compareSequence = null;
  const traceRequests = new Map();
  function requestTraceForStation(i) {
    const baseUrl = i === 3
      ? "assets/recon"
      : i === 4
        ? "assets/recon_multiview"
        : null;
    if (!baseUrl) return Promise.resolve(null);
    const state = i === 3 ? stations.reconState : stations.fusionReconState;
    if (state?.ready) return Promise.resolve(true);
    if (traceRequests.has(i)) return traceRequests.get(i);

    stations.markReconLoading(i);
    const request = (async () => {
      const stepsPayload = await loadReconSteps(baseUrl);
      if (!stepsPayload) {
        stations.markReconUnavailable(i);
        return null;
      }
      pipelineCarry.installReconTrace(i, stepsPayload);
      stations.installReconTrace(i, stepsPayload, worldTime);
      return stepsPayload;
    })().catch((err) => {
      /* loadReconSteps is fail-soft, but keep the station safe if a future
         decoder or install step throws after the fetch has succeeded. */
      console.warn(`station ${i} reconstruction trace install failed:`, err);
      stations.markReconUnavailable(i);
      return null;
    });
    traceRequests.set(i, request);
    request.then((stepsPayload) => {
      /* A transient network miss may recover on a later visit. Successful
         traces stay represented by the player's ready state. */
      if (!stepsPayload) traceRequests.delete(i);
    });
    return request;
  }

  function requestModelsForStation(i) {
    /* Guided route prefetch: S02 hides S03's transfer; S03 does the same for
       S04. traceRequests de-duplicates direct jumps and later revisits. */
    if (i === 2) requestTraceForStation(3);
    if (i === 3) {
      requestTraceForStation(3);
      requestTraceForStation(4);
    }
    if (i === 4) {
      requestTraceForStation(4);
      /* The carried token is the compact final multi-view trace. Warm the
         selected Agreement surface here so the S5 pickup can replace that
         token without exposing network/normal-build cost at the workbench. */
      requestModel("agreement");
    }
    if (i === 5) {
      if (!compareSequence) {
        /* Fetch/parse one GLB at a time and yield a paint between attachments. */
        compareSequence = (async () => {
          for (const key of ["agreement", "rgbd", "entropy", "average", "trellis2"]) {
            await requestModel(key);
            await pauseForPaint();
          }
        })().finally(() => { compareSequence = null; });
      }
    } else if (i === 6) {
      /* Features station displays the final agreement surface. */
      requestModel("agreement");
    }
  }

  /* ---- ready ---- */
  /* The deterministic recorder may seek anywhere immediately, so it is the
     one route that deliberately waits for both evidence traces. */
  if (TOUR) {
    showStatus(`PREPARING RECORDER TOUR ${loadStamp} · RECONSTRUCTION TRACES`);
    await Promise.all([requestTraceForStation(3), requestTraceForStation(4)]);
  }
  const traceStatus = TOUR
    ? (stations.reconState.ready && stations.fusionReconState.ready
      ? "REAL SINGLE + MULTI-VIEW TRACES"
      : "REAL TRACE UNAVAILABLE")
    : "RECON TRACES LOAD ON ARRIVAL";
  showStatus(`READY ${loadStamp} · STATIONS 0–${STATIONS.length - 1} · ${traceStatus}`);
  btnEnter.disabled = false;
  btnExplore.disabled = false;
  renderOpeningGuide(openingGuideStep);
  window.__worldReady = true;
  /* Keep the first viewport inside the Three.js world: the live ranch renders
     behind the route choice instead of presenting an unrelated static page. */
  if (!TOUR) renderLifecycle.start();
  if (TOUR) {
    introEl.classList.add("hidden");
    worldEntered = true;
    mode = "tour";
    renderLifecycle.start();
    for (const key of ["agreement", "entropy", "average", "trellis2"]) requestModel(key);
  }
}

main().catch((err) => showFatal("FAILED TO INITIALISE AGREEMENT RANCH.", err));
