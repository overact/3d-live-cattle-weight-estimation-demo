/* Calf-carried evidence chain.

   The progression state is independent from Three.js objects: arrive with the
   previous artifact, deliver it, wait for the real station process, then pick
   up the result. Scene objects only render that state. This prevents a pretty
   transition from claiming reconstruction finished before the trace did. */

import * as THREE from "../../vendor/three.module.js";
import { STATIONS } from "./rail.js?v=20260812-view-routing";
import { displayViewUrl, sharedTex } from "./stations.js?v=20260813-feedback";

const AMBER = 0xe39b2d;
const ICE = 0x86d7ea;
const VIEWS = "assets/cases/case_001/views/";
const REDUCED_MOTION = typeof matchMedia !== "undefined" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

export const ARTIFACT_STAGES = [
  { key: "none", label: "NO EVIDENCE YET" },
  { key: "photos", label: "3 CAPTURED RGB VIEWS" },
  { key: "masked", label: "3 MASKED CATTLE RGB VIEWS" },
  { key: "single", label: "SINGLE-VIEW SAM3D RESULT" },
  { key: "multiview", label: "MULTI-VIEW STAGE-2 RESULT" },
  { key: "agreement", label: "SELECTED AGREEMENT MODEL" },
  { key: "delivered", label: "MODEL DELIVERED TO FEATURES" },
  { key: "weight", label: "WEIGHT ESTIMATE READY" },
  { key: "deployment", label: "DEPLOYMENT DEMO READY" }
];

/* One-slot inventory recipes. A station accepts exactly one artifact kind and
   produces the next one; completing Step 06 leaves the slot empty so Step 01
   can start another full run. These rules, rather than a monotonic level
   number, are the gameplay contract. */
export const STATION_RECIPES = Object.freeze({
  1: Object.freeze({ inputStage: 0, outputStage: 1, outputCount: 3, method: "RGB capture" }),
  2: Object.freeze({ inputStage: 1, inputCount: 3, outputStage: 2, outputCount: 3,
    outputVariant: "single-view-next", method: "SAM 3 segmentation" }),
  /* Step 03 borrows ONE masked left view while right + top stay with the calf.
     Its single-view 3D result remains on the workcell; after processing, only
     the borrowed left view returns and reunites the triptych for Step 04. */
  3: Object.freeze({ inputStage: 2, inputVariant: "single-view-next", inputCount: 1,
    depositVisual: "masked-single", outputStage: 3, outputCount: 1,
    carryReturnStage: 2, carryReturnVariant: "multi-view-next", carryReturnCount: 3,
    retainedCount: 2,
    method: "single-view reconstruction" }),
  4: Object.freeze({ inputStage: 2, inputVariant: "multi-view-next", inputCount: 3,
    outputStage: 4, method: "multi-view reconstruction" }),
  5: Object.freeze({ inputStage: 4, inputCount: 1, outputStage: 5, method: "Agreement selection" }),
  6: Object.freeze({ inputStage: 5, inputCount: 1, outputStage: 0,
    method: "feature and weight estimation" })
});

export const SUBMISSION_STATION = Object.freeze({ 1: 2, 4: 5, 5: 6 });

export function submissionStationForArtifact(cargoStage, cargoVariant = null) {
  if (cargoStage === 2) return cargoVariant === "multi-view-next" ? 4 : 3;
  return SUBMISSION_STATION[cargoStage] || null;
}

export function stationAcceptsArtifact(station, cargoStage, cargoVariant = null) {
  const recipe = STATION_RECIPES[station];
  if (!recipe || recipe.inputStage !== cargoStage) return false;
  /* Variant-bearing recipes are deliberately fail-closed: a generic Stage-2
     token must never be accepted by both the single- and multi-view machines. */
  return recipe.inputVariant
    ? recipe.inputVariant === cargoVariant
    : cargoVariant === null || cargoVariant === undefined;
}

export const TRACE_TOKEN_ROTATIONS = Object.freeze({
  single: Object.freeze([-Math.PI / 2, 0, Math.PI]),
  multiview: Object.freeze([-Math.PI / 2, 0, -Math.PI / 2])
});

export function artifactStageForStation(station) {
  if (!Number.isFinite(station)) return 0;
  return Math.min(ARTIFACT_STAGES.length - 1, Math.max(0, Math.trunc(station)));
}

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (x) => {
  const k = clamp01(x);
  return k * k * (3 - 2 * k);
};

function textureMaterial(url, tint = 0xffffff, onReady = null, onError = null) {
  const mat = new THREE.MeshBasicMaterial({
    color: tint, side: THREE.DoubleSide, transparent: true, opacity: 0.98
  });
  sharedTex(displayViewUrl(url), (tex) => {
    mat.map = tex;
    mat.color.setHex(0xffffff);
    mat.needsUpdate = true;
    onReady?.();
  }, onError);
  return mat;
}

function maskedTextureMaterial(rgbUrl, maskUrl, onReady = null, onError = null) {
  const mat = new THREE.MeshBasicMaterial({
    color: 0x151b22, side: THREE.DoubleSide, transparent: true,
    opacity: 0.98, alphaTest: 0.035
  });
  let rgbReady = false, maskReady = false, notified = false;
  const ready = () => {
    if (!notified && rgbReady && maskReady) {
      notified = true;
      onReady?.();
    }
  };
  /* Keep the real RGB as the color map and use SAM 3's white cattle mask only
     as alpha. The carried result is therefore a cattle cutout, not a binary
     silhouette pretending to be the model input. */
  sharedTex(displayViewUrl(rgbUrl), (tex) => {
    mat.map = tex;
    mat.color.setHex(0xffffff);
    rgbReady = true;
    mat.needsUpdate = true;
    ready();
  }, onError);
  sharedTex(displayViewUrl(maskUrl), (tex) => {
    mat.alphaMap = tex;
    maskReady = true;
    mat.needsUpdate = true;
    ready();
  }, onError);
  return mat;
}

function framedCard(url, tint = AMBER, onReady = null, maskUrl = null, onError = null) {
  const g = new THREE.Group();
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(0.78, 0.5, 0.045),
    new THREE.MeshStandardMaterial({
      color: 0x141a21, emissive: tint, emissiveIntensity: 0.16, roughness: 0.72
    })
  );
  const material = maskUrl
    ? maskedTextureMaterial(url, maskUrl, onReady, onError)
    : textureMaterial(url, 0xffffff, onReady, onError);
  const image = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.42), material);
  image.position.z = 0.026;
  g.add(frame, image);
  return g;
}

function buildCards(kind) {
  const g = new THREE.Group();
  const triptych = [
    { rgb: "rgb_left.png", mask: "mask_left.png", slot: -1, z: 0 },
    { rgb: "rgb_top.png", mask: "mask_top_aligned.png", slot: 0, z: 0.08 },
    { rgb: "rgb_right.png", mask: "mask_right.png", slot: 1, z: 0 }
  ];
  const specs = kind === "masked-single"
    ? triptych.slice(0, 1)
    : kind === "masked-retained"
      ? triptych.slice(1)
      : triptych;
  /* TextureLoader is asynchronous in the browser. Unit tests intentionally
     run without Image; there the render adapter is considered ready while the
     simulation still exercises every process-completion gate. */
  const waitForTextures = typeof Image !== "undefined";
  const visual = {
    group: g, billboard: true, followHeading: false,
    ready: !waitForTextures, textureCount: 0,
    maskedRgb: kind === "masked" || kind === "masked-single" || kind === "masked-retained",
    cardCount: specs.length, kind
  };
  const onCardReady = () => {
    visual.textureCount++;
    if (visual.textureCount === specs.length) {
      visual.ready = true;
      visual.failed = false;
    }
  };
  const onCardError = () => { visual.failed = true; };
  specs.forEach((spec, i) => {
    const rgbUrl = `${VIEWS}${spec.rgb}`;
    const maskUrl = kind === "masked" || kind === "masked-single" || kind === "masked-retained"
      ? `${VIEWS}${spec.mask}` : null;
    const card = framedCard(rgbUrl, kind === "photos" ? AMBER : ICE,
      waitForTextures ? onCardReady : null, maskUrl,
      waitForTextures ? onCardError : null);
    /* Partial Step 03 visuals preserve the full triptych's slots. This keeps
       left from jumping to centre on submission and lets its return merge
       cleanly with top/right, which stayed at slots 0/+1 beside the calf. */
    const slot = spec.slot;
    card.position.set(slot * 0.54, Math.abs(slot) * -0.08, spec.z);
    card.rotation.z = slot * -0.13;
    g.add(card);
  });
  return visual;
}

/* The exporter stores Stage-2 Gaussians voxel-major and strongest-first. A
   miniature uses the first Gaussian from every final-frame voxel, retaining
   the true geometry and optional model RGB without carrying all eight splats. */
export function extractFinalStage2(stepsPayload) {
  const counts = stepsPayload?.counts;
  const positions = stepsPayload?.positions;
  if (!Array.isArray(counts) || !counts.length || !positions) return null;
  const perVoxel = Math.max(1, Math.trunc(stepsPayload.stage2PerVoxel || 1));
  const finalCount = counts.at(-1);
  if (!Number.isFinite(finalCount) || finalCount <= 0 || finalCount % perVoxel) return null;
  const finalFrame = counts.length - 1;
  const positionBase = counts.slice(0, finalFrame).reduce((sum, n) => sum + n, 0) * 3;
  const pointCount = finalCount / perVoxel;
  const xyz = new Float32Array(pointCount * 3);
  let rgb = null;
  const rgba = stepsPayload.stage2Rgba;
  const stage2Start = Array.isArray(stepsPayload.stages)
    ? stepsPayload.stages[0] : finalFrame;
  const rgbaBase = counts.slice(stage2Start, finalFrame).reduce((sum, n) => sum + n, 0) * 4;
  if (rgba && rgba.length >= rgbaBase + finalCount * 4) rgb = new Float32Array(pointCount * 3);
  for (let source = 0, out = 0; source < finalCount; source += perVoxel, out++) {
    const p = positionBase + source * 3;
    xyz[out * 3] = positions[p];
    xyz[out * 3 + 1] = positions[p + 1];
    xyz[out * 3 + 2] = positions[p + 2];
    if (rgb) {
      const c = rgbaBase + source * 4;
      rgb[out * 3] = rgba[c] / 255;
      rgb[out * 3 + 1] = rgba[c + 1] / 255;
      rgb[out * 3 + 2] = rgba[c + 2] / 255;
    }
  }
  return { positions: xyz, colors: rgb, pointCount, perVoxel };
}

function buildTraceToken({ kind, targetLen, color }) {
  const g = new THREE.Group();
  const headingPivot = new THREE.Group();
  const oriented = new THREE.Group();
  const points = new THREE.Points(
    new THREE.BufferGeometry().setAttribute(
      "position", new THREE.BufferAttribute(new Float32Array(0), 3)),
    new THREE.PointsMaterial({
      color, size: 0.025, transparent: true, opacity: 0.92,
      depthWrite: false, sizeAttenuation: true
    })
  );
  oriented.add(points);
  /* Single-view body length is raw X; multi-view body length is raw Y. */
  oriented.rotation.set(...TRACE_TOKEN_ROTATIONS[kind]);
  headingPivot.add(oriented);
  g.add(headingPivot);
  const token = {
    group: g,
    billboard: false,
    followHeading: true,
    counterSpin: null,
    ready: false,
    installTrace(stepsPayload) {
      const final = extractFinalStage2(stepsPayload);
      if (!final) return false;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(final.positions, 3));
      if (final.colors) geo.setAttribute("color", new THREE.BufferAttribute(final.colors, 3));
      geo.computeBoundingBox();
      const box = geo.boundingBox;
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      points.geometry.dispose();
      points.geometry = geo;
      points.position.copy(center).multiplyScalar(-1);
      points.material.vertexColors = !!final.colors;
      points.material.color.setHex(final.colors ? 0xffffff : color);
      points.material.needsUpdate = true;
      oriented.scale.setScalar(targetLen / Math.max(size.x, size.y, size.z, 1e-6));
      token.ready = true;
      token.pointCount = final.pointCount;
      return true;
    }
  };
  return token;
}

function pointCow(payload, { color = ICE, halo = false, targetLen = 1.55 } = {}) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(payload.positions, 3));
  geo.computeBoundingBox();
  const box = geo.boundingBox;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const points = new THREE.Points(
    geo,
    new THREE.PointsMaterial({
      color, size: halo ? 0.032 : 0.025, transparent: true,
      opacity: halo ? 0.22 : 0.9, depthWrite: false,
      blending: halo ? THREE.AdditiveBlending : THREE.NormalBlending,
      sizeAttenuation: true
    })
  );
  points.position.sub(center);
  const oriented = new THREE.Group();
  oriented.add(points);
  if (halo) {
    const glow = points.clone();
    glow.material = points.material.clone();
    glow.material.color.setHex(AMBER);
    glow.material.size *= 1.9;
    glow.material.opacity = 0.12;
    glow.material.blending = THREE.AdditiveBlending;
    oriented.add(glow);
  }
  oriented.rotation.set(-Math.PI / 2, 0, -Math.PI / 2);
  oriented.scale.setScalar(targetLen / Math.max(size.x, size.y, size.z, 1e-6));
  return oriented;
}

function buildAgreement(payload) {
  const g = new THREE.Group();
  const cow = pointCow(payload, { color: ICE, halo: true, targetLen: 1.45 });
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.88, 0.025, 6, 42),
    new THREE.MeshBasicMaterial({ color: AMBER, transparent: true, opacity: 0.72 })
  );
  ring.rotation.x = Math.PI / 2;
  g.add(cow, ring);
  return {
    group: g, billboard: false, followHeading: true,
    counterSpin: ring, ready: true
  };
}

function machinePoint(station) {
  const s = STATIONS[station];
  const towardCamera = s.cam.clone().sub(s.pos).setY(0).normalize();
  return s.pos.clone().addScaledVector(towardCamera, 0.7)
    .add(new THREE.Vector3(0, 2.35, 0));
}

export function createPipelineCarry({
  scene,
  camera,
  payload,
  hudEl = null,
  getProcessState = () => null,
  getStationTarget = () => null,
  startProcess = () => {},
  setAgreementGhosted = () => {}
}) {
  const root = new THREE.Group();
  root.name = "calfPipelineCarry";
  root.visible = false;
  scene.add(root);

  /* Step 03 borrows only the left card. Top and right stay beside the cattle
     throughout deposit, processing, and return, so they need a render root
     independent from the card travelling to the workcell. */
  const retainedRoot = new THREE.Group();
  retainedRoot.name = "calfPipelineRetainedViews";
  retainedRoot.visible = false;
  scene.add(retainedRoot);

  const pulse = new THREE.Mesh(
    new THREE.TorusGeometry(0.78, 0.035, 8, 48),
    new THREE.MeshBasicMaterial({
      color: AMBER, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false
    })
  );
  pulse.rotation.x = Math.PI / 2;
  pulse.visible = false;
  scene.add(pulse);

  const sparksN = 32;
  const sparksPos = new Float32Array(sparksN * 3);
  const sparks = new THREE.Points(
    new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(sparksPos, 3)),
    new THREE.PointsMaterial({
      color: ICE, size: 0.075, transparent: true, opacity: 0,
      depthWrite: false, blending: THREE.AdditiveBlending
    })
  );
  sparks.visible = false;
  scene.add(sparks);

  const visuals = [
    null,
    buildCards("photos"),
    buildCards("masked"),
    buildTraceToken({ kind: "single", targetLen: 1.05, color: 0xe8e4da }),
    buildTraceToken({ kind: "multiview", targetLen: 1.25, color: ICE }),
    buildAgreement(payload),
    buildCards("masked-single")
  ];
  const retainedVisual = buildCards("masked-retained");
  [...visuals.slice(1), retainedVisual].forEach((visual) => {
    visual.group.visible = false;
    visual.group.traverse((o) => {
      const materials = o.material
        ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const mat of materials) {
        mat.userData.pipelineBaseOpacity = mat.opacity ?? 1;
        mat.transparent = true;
      }
    });
    if (visual === retainedVisual) retainedRoot.add(visual.group);
    else root.add(visual.group);
  });
  retainedVisual.group.visible = true;

  let stage = 0;               // most recently completed interaction (QA/HUD)
  let cargoStage = 0;          // one-slot logical inventory
  let cargoVariant = null;     // disambiguates which masked recipe comes next
  let cargoCount = 0;
  let displayStage = 0;        // render adapter; may show an uncollected output
  let displayVisualIndex = 0;  // Step 03 deposits one card while cargo is a triptych
  let station = 0;
  let proximityStation = null;
  let phase = "idle";          // idle | deposit | waiting | pickup
  let pendingStation = null;
  let transition = null;
  let waitReadyAt = Infinity;
  let outputReadySince = null;
  let enabled = false;
  let ghosted = false;
  let weightReady = false;
  let cycleCount = 0;
  let nextRunId = 1;
  let activeRunId = null;
  let hudConfirmUntil = 0;
  let retainedViewsActive = false;
  const submitCounts = new Array(7).fill(0);
  const collectCounts = new Array(6).fill(0);
  let lastRejection = null;
  let lastHeading = 0;
  const follow = new THREE.Vector3();
  const retainedFollow = new THREE.Vector3();
  let followReady = false;
  const target = new THREE.Vector3();

  function setGhosted(on) {
    ghosted = !!on;
    setAgreementGhosted(ghosted && enabled);
  }

  function updateHud(message = null, next = null, visualState = null) {
    if (!hudEl) return;
    const show = stage > 0 || phase !== "idle" || !!message;
    const hudState = visualState || (phase === "idle" ? "steady" : phase);
    hudEl.classList.toggle("show", show);
    hudEl.classList.toggle("processing",
      hudState === "deposit" || hudState === "waiting" || hudState === "pickup");
    for (const state of ["deposit", "waiting", "pickup", "confirmed", "rejected"]) {
      hudEl.classList.toggle(state, hudState === state);
    }
    hudEl.dataset.phase = hudState;
    const label = hudEl.querySelector("[data-carry-label]");
    const nextEl = hudEl.querySelector("[data-carry-next]");
    const submitAt = submissionStationForArtifact(cargoStage, cargoVariant);
    const defaultNext = submitAt
      ? `SUBMIT ONLY AT STEP ${String(submitAt).padStart(2, "0")}`
      : stage === 6
        ? "CONTINUE TO STEP 07 · VIEW WEIGHT RESULTS"
        : stage === 7
          ? "CONTINUE TO STEP 08 · VIEW DEPLOYMENT"
          : "RETURN TO STEP 01 · START ANOTHER RUN";
    const currentArtifact = cargoStage || displayStage || stage;
    const artifactLabel = cargoStage === 2 && cargoVariant === "single-view-processing"
      ? "2/3 MASKED VIEWS HELD · LEFT VIEW PROCESSING"
      : cargoStage === 2 && cargoVariant === "single-view-next"
      ? "3 MASKED RGB VIEWS · LEFT VIEW NEXT"
      : cargoStage === 2 && cargoVariant === "multi-view-next"
        ? "3 MASKED RGB VIEWS · MULTI-VIEW NEXT"
        : ARTIFACT_STAGES[currentArtifact].label;
    if (label) label.textContent = message || artifactLabel;
    if (nextEl) nextEl.textContent = next || defaultNext;
  }

  function setVisualAlpha(index, alpha) {
    const visual = visuals[index];
    if (!visual) return;
    visual.group.traverse((o) => {
      const materials = o.material
        ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const mat of materials) {
        const base = mat.userData.pipelineBaseOpacity ?? mat.opacity ?? 1;
        mat.opacity = base * clamp01(alpha);
      }
    });
  }

  function setDisplay(nextStage, visualIndex = nextStage) {
    if (displayVisualIndex) {
      setVisualAlpha(displayVisualIndex, 1);
      visuals[displayVisualIndex].group.visible = false;
    }
    displayStage = nextStage;
    displayVisualIndex = visualIndex || 0;
    if (displayVisualIndex) visuals[displayVisualIndex].group.visible = true;
    root.visible = enabled && displayVisualIndex > 0;
  }

  function stationTarget(stationIndex, kind) {
    const exact = getStationTarget(stationIndex, kind);
    if (exact?.isVector3) return exact.clone();
    if (Array.isArray(exact) && exact.length >= 3) return new THREE.Vector3(...exact);
    return machinePoint(stationIndex);
  }

  function carrierTarget(subject, heading = lastHeading) {
    if (!subject) return target.copy(machinePoint(Math.max(1, station)));
    lastHeading = Number.isFinite(heading) ? heading : lastHeading;
    const rightX = Math.cos(lastHeading), rightZ = -Math.sin(lastHeading);
    return target.set(
      subject.x + rightX * 1.32,
      subject.y + 1.95,
      subject.z + rightZ * 1.32
    );
  }

  function startEffects(at) {
    pulse.position.copy(at);
    pulse.visible = enabled && !REDUCED_MOTION;
    sparks.visible = enabled && !REDUCED_MOTION;
  }

  function stopEffects() {
    pulse.visible = false;
    sparks.visible = false;
    pulse.material.opacity = 0;
    sparks.material.opacity = 0;
  }

  function beginPickup(stationIndex, outputStage, t, visualIndex = outputStage) {
    /* Step 03 returns the borrowed photo from the same input slot where it was
       submitted. Starting at the 3D output would falsely imply that the
       resident reconstruction transformed back into a photo. */
    const at = stationTarget(stationIndex, stationIndex === 3 ? "input" : "output");
    setDisplay(outputStage, visualIndex);
    setVisualAlpha(visualIndex, 0);
    root.position.copy(at);
    root.scale.setScalar(0.12);
    transition = {
      kind: "pickup", station: stationIndex, from: at, t0: t,
      duration: REDUCED_MOTION ? 0.18 : 1.0,
      boost: stationIndex === 5 ? 1.25 : 1
    };
    phase = "pickup";
    hudConfirmUntil = 0;
    outputReadySince = null;
    if (stationIndex === 5) setGhosted(true);
    startEffects(at);
    if (stationIndex === 3) {
      updateHud("SINGLE-VIEW 3D COMPLETE · STAYS ON WORKCELL",
        "LEFT VIEW RETURNING · RIGHT + TOP HELD");
    } else {
      updateHud("RESULT READY · COLLECTING",
        `STEP ${String(stationIndex).padStart(2, "0")} COMPLETE`);
    }
  }

  function beginDeposit(stationIndex, t) {
    const recipe = STATION_RECIPES[stationIndex];
    if (recipe.depositVisual === "masked-single") {
      /* Select the left masked frame at the moment of submission. The other
         two views remain on their own cattle-following root. During the throw
         the original triptych remains the atomic logical input; after the left
         card lands, logical cargo becomes the two held views. */
      retainedViewsActive = true;
      retainedRoot.position.copy(root.position);
      retainedFollow.copy(root.position);
      retainedRoot.quaternion.copy(camera.quaternion);
      retainedRoot.visible = enabled;
      setDisplay(recipe.inputStage, 6);
    }
    const at = stationTarget(stationIndex, "input");
    transition = {
      kind: "deposit", station: stationIndex, from: root.position.clone(), at, t0: t,
      duration: REDUCED_MOTION ? 0.18 : (stationIndex === 6 ? 1.2 : 0.86),
      boost: stationIndex === 6 ? 1.7 : 1,
      inputCount: recipe.inputCount || 1,
      inputVariant: recipe.inputVariant || null
    };
    phase = "deposit";
    hudConfirmUntil = 0;
    startEffects(at);
    const label = stationIndex === 3
      ? "LEFT MASKED VIEW · SUBMITTING"
      : stationIndex === 6
      ? "DELIVERING MODEL · FEATURE EXTRACTION"
      : "DELIVERING EVIDENCE TO WORKCELL";
    const next = stationIndex === 3
      ? "2/3 VIEWS HELD · RIGHT + TOP STAY WITH CATTLE"
      : "INPUT LOCKED · PROCESS STARTING";
    updateHud(label, next);
  }

  function finishDeposit(t) {
    const i = pendingStation;
    const recipe = STATION_RECIPES[i];
    if (displayVisualIndex) setVisualAlpha(displayVisualIndex, 1);
    root.scale.setScalar(1);
    /* Normal recipes consume their whole one-slot item. Step 03 is partial:
       only the submitted left card leaves, while two retained cards stay in
       the logical slot and visible beside the cattle. */
    if (i === 3) {
      cargoStage = recipe.inputStage;
      cargoVariant = "single-view-processing";
      cargoCount = recipe.retainedCount;
    } else {
      cargoStage = 0;
      cargoVariant = null;
      cargoCount = 0;
    }
    setDisplay(0);
    transition = null;
    outputReadySince = null;
    submitCounts[i]++;
    if (i <= 5) {
      startProcess(i, {
        runId: activeRunId, t,
        inputStage: recipe.inputStage,
        inputVariant: recipe.inputVariant || null,
        inputCount: recipe.inputCount || 1,
        outputStage: recipe.outputStage,
        outputVariant: recipe.outputVariant || null,
        outputCount: recipe.outputCount || 1
      });
    }
    if (i === 2) {
      phase = "waiting";
      pulse.position.copy(stationTarget(2, "output"));
      updateWaitingHud(2);
    } else if (i === 3) {
      phase = "waiting";
      pulse.position.copy(stationTarget(3, "output"));
      updateHud("LEFT VIEW · SINGLE-VIEW SAM3D",
        "2/3 VIEWS HELD · LEFT VIEW PROCESSING");
    } else if (i === 4) {
      phase = "waiting";
      pulse.position.copy(stationTarget(4, "output"));
      updateHud("MULTI-VIEW SAM3D RECONSTRUCTION", "THREE-VIEW TRACE · STAGE 1 → STAGE 2");
    } else if (i === 5) {
      phase = "waiting";
      waitReadyAt = t + (REDUCED_MOTION ? 0.05 : 1.0);
      pulse.position.copy(stationTarget(5, "output"));
      updateHud("COMPARING RECONSTRUCTION METHODS", "AGREEMENT PLINTH · SELECTING RESULT");
    } else if (i === 6) {
      stage = 6;
      weightReady = true;
      cycleCount++;
      activeRunId = null;
      pendingStation = null;
      phase = "idle";
      hudConfirmUntil = t + (REDUCED_MOTION ? 0.18 : 0.65);
      setGhosted(false);
      stopEffects();
      updateHud("MODEL DELIVERED · FEATURE + WEIGHT PIPELINE",
        "CONTINUE TO STEP 07 · VIEW RESULTS", "confirmed");
    }
  }

  function updateWaitingHud(stationIndex) {
    if (stationIndex === 1) {
      updateHud("CAPTURING THREE RGB VIEWS", "WALK UNDER THE CAMERA GANTRY · WAIT FOR THE PRINTS");
    } else if (stationIndex === 2) {
      updateHud("SAM 3 SEGMENTING CATTLE", "MASKED RGB CUTOUTS MUST APPEAR BEFORE PICKUP");
    } else if (stationIndex === 3) {
      updateHud("LEFT VIEW · SINGLE-VIEW SAM3D",
        "2/3 VIEWS HELD · LEFT VIEW PROCESSING");
    } else if (stationIndex === 4) {
      updateHud("MULTI-VIEW SAM3D RECONSTRUCTION", "THREE-VIEW TRACE · STAGE 1 → STAGE 2");
    } else if (stationIndex === 5) {
      updateHud("COMPARING RECONSTRUCTION METHODS", "AGREEMENT PLINTH · SELECTING RESULT");
    } else {
      updateHud();
    }
  }

  function enterStation(nextStation, t, subject, heading) {
    station = nextStation;
    proximityStation = nextStation;
    carrierTarget(subject, heading);
    lastRejection = null;
    hudConfirmUntil = 0;

    if (pendingStation !== null) {
      if (nextStation === pendingStation) {
        const failedProcess = getProcessState(nextStation);
        const retryable = phase === "waiting" &&
          (failedProcess?.loadState === "unavailable" || visuals[nextStation]?.failed);
        if (retryable) {
          const retryRecipe = STATION_RECIPES[nextStation];
          activeRunId = nextRunId++;
          outputReadySince = null;
          startProcess(nextStation, {
            runId: activeRunId, t,
            inputStage: retryRecipe.inputStage,
            inputVariant: retryRecipe.inputVariant || null,
            inputCount: retryRecipe.inputCount || 1,
            outputStage: retryRecipe.outputStage,
            outputVariant: retryRecipe.outputVariant || null,
            outputCount: retryRecipe.outputCount || 1
          });
          if (nextStation === 3) {
            updateHud("RETRYING LEFT-VIEW WORKCELL",
              "2/3 VIEWS HELD · LEFT REMAINS SUBMITTED");
          } else {
            updateHud("RETRYING THIS WORKCELL", "INPUT STAYS COMMITTED · WAIT FOR A NEW OUTPUT");
          }
          return true;
        }
        if (phase === "waiting") updateWaitingHud(nextStation);
        else updateHud();
        return true;
      }
      if (pendingStation === 3) {
        updateHud("2/3 VIEWS HELD · LEFT VIEW PROCESSING",
          "RETURN TO STEP 03 TO REUNITE", "rejected");
      } else {
        updateHud(
          `STEP ${String(pendingStation).padStart(2, "0")} STILL PROCESSING`,
          `RETURN TO STEP ${String(pendingStation).padStart(2, "0")}`,
          "rejected"
        );
      }
      lastRejection = "process-pending";
      return false;
    }

    const recipe = STATION_RECIPES[nextStation] || null;
    if (recipe) {
      if (!stationAcceptsArtifact(nextStation, cargoStage, cargoVariant)) {
        const targetStation = submissionStationForArtifact(cargoStage, cargoVariant) || 1;
        if (cargoStage) {
          const variantMismatch = recipe.inputStage === cargoStage;
          updateHud(
            variantMismatch
              ? `${ARTIFACT_STAGES[cargoStage].label} · COMPLETE THE PRIOR RECIPE`
              : `${ARTIFACT_STAGES[cargoStage].label} · WRONG WORKCELL`,
            variantMismatch
              ? `SUBMIT THE SINGLE LEFT VIEW AT STEP 03 BEFORE STEP 04`
              : `THIS ITEM CAN ONLY BE SUBMITTED AT STEP ${String(targetStation).padStart(2, "0")}`,
            "rejected"
          );
          lastRejection = variantMismatch ? "out-of-sequence" : "wrong-station";
        } else {
          const sourceStation = Math.max(1, recipe.inputStage);
          updateHud(
            `STEP ${String(nextStation).padStart(2, "0")} NEEDS ${ARTIFACT_STAGES[recipe.inputStage].label}`,
            `COLLECT IT FROM STEP ${String(sourceStation).padStart(2, "0")} FIRST`,
            "rejected"
          );
          lastRejection = "missing-input";
        }
        return false;
      }

      pendingStation = nextStation;
      activeRunId = nextRunId++;
      if (nextStation === 1) {
        stage = 0;
        weightReady = false;
        submitCounts[1]++;
        phase = "waiting";
        outputReadySince = null;
        pulse.position.copy(stationTarget(1, "output"));
        startEffects(pulse.position);
        startProcess(1, {
          runId: activeRunId, t,
          inputStage: recipe.inputStage,
          inputVariant: null,
          inputCount: 0,
          outputStage: recipe.outputStage,
          outputVariant: null,
          outputCount: recipe.outputCount
        });
        updateWaitingHud(1);
      } else {
        beginDeposit(nextStation, t);
      }
      return true;
    }

    /* Result/deployment stops never accept physical cargo. They stay readable,
       but the held artifact remains in the slot and its sole valid workcell is
       reported instead of silently consuming it. */
    if (nextStation === 7 || nextStation === 8) {
      if (cargoStage) {
        const targetStation = submissionStationForArtifact(cargoStage, cargoVariant);
        updateHud(
          `${ARTIFACT_STAGES[cargoStage].label} · NOT SUBMITTED`,
          `THIS ITEM CAN ONLY BE SUBMITTED AT STEP ${String(targetStation).padStart(2, "0")}`,
          "rejected"
        );
        lastRejection = "wrong-station";
        return false;
      }
      if (!weightReady || (nextStation === 8 && stage !== 7 && stage !== 8)) {
        updateHud(
          nextStation === 7 ? "WEIGHT RESULT NOT READY" : "VIEW STEP 07 BEFORE DEPLOYMENT",
          nextStation === 7 ? "DELIVER THE AGREEMENT MODEL TO STEP 06" : "FOLLOW THE RESULT FLOW IN ORDER",
          "rejected"
        );
        lastRejection = "result-not-ready";
        return false;
      }
      stage = nextStation;
      phase = "idle";
      updateHud();
      return true;
    }

    if (nextStation !== 0) {
      updateHud(
        "NO PIPELINE RECIPE AT THIS STOP",
        "HELD ITEMS REMAIN WITH THE CATTLE",
        "rejected"
      );
      lastRejection = "no-recipe";
      return false;
    }
    return false;
  }

  /* A proximity enter is a durable condition, not a one-frame button press.
     This quiet reconciliation is what lets a model that lands one frame later
     immediately submit to the workcell the cattle is already standing in. */
  function reconcileStation(nextStation, t, subject, heading) {
    if (nextStation === null || nextStation === undefined) {
      proximityStation = null;
      outputReadySince = null;
      /* Pickup can only START while the cattle is at the output workcell. Once
         the return arc has started the result is already secured, so let it
         land even if the cattle crosses into the next station. This preserves
         the real leave-S5 -> enter-S6 auto-submit sequence. */
      if (transition?.kind === "pickup") {
        if (transition.station === 3) {
          updateHud("LEFT VIEW RETURNING · RIGHT + TOP HELD",
            "REJOINING 3/3 MASKED VIEWS");
        } else {
          updateHud("RESULT SECURED · RETURNING TO CATTLE",
            "NEXT MATCHING WORKCELL WILL AUTO-SUBMIT");
        }
      } else if (phase === "waiting" && pendingStation !== null) {
        if (pendingStation === 3) {
          updateHud("2/3 VIEWS HELD · LEFT VIEW PROCESSING",
            "RETURN TO STEP 03 TO REUNITE");
        } else {
          updateHud("WORKCELL CONTINUES WHILE YOU EXPLORE",
            `RETURN TO STEP ${String(pendingStation).padStart(2, "0")} TO COLLECT`);
        }
      }
      return false;
    }
    proximityStation = nextStation;
    station = nextStation;
    carrierTarget(subject, heading);
    if (pendingStation !== null || transition || phase !== "idle") {
      return pendingStation === nextStation;
    }
    const recipe = STATION_RECIPES[nextStation];
    if (!recipe || !stationAcceptsArtifact(nextStation, cargoStage, cargoVariant)) return false;
    return enterStation(nextStation, t, subject, heading);
  }

  function updateSparks(t, energy, boost = 1) {
    const a = sparks.geometry.attributes.position.array;
    for (let i = 0; i < sparksN; i++) {
      const p = i / sparksN;
      const ang = p * Math.PI * 2 + t * (1.8 + (i % 3) * 0.22);
      const r = (0.35 + p * 0.85) * boost;
      a[i * 3] = pulse.position.x + Math.cos(ang) * r;
      a[i * 3 + 1] = pulse.position.y + Math.sin(t * 3 + i) * 0.34 * boost;
      a[i * 3 + 2] = pulse.position.z + Math.sin(ang) * r;
    }
    sparks.geometry.attributes.position.needsUpdate = true;
    sparks.material.opacity = Math.min(0.9, 0.72 * energy * boost);
  }

  function updateTransition(dt, t, home) {
    const tr = transition;
    const k = clamp01((t - tr.t0) / tr.duration);
    const q = smooth(k);
    if (tr.kind === "deposit") {
      root.position.lerpVectors(tr.from, tr.at, q);
      root.position.y += REDUCED_MOTION ? 0 : Math.sin(q * Math.PI) * 0.72;
      root.scale.setScalar(1 - q * 0.2);
      setVisualAlpha(displayVisualIndex, 1 - q);
    } else {
      root.position.lerpVectors(tr.from, home, q);
      root.position.y += REDUCED_MOTION ? 0 : Math.sin(q * Math.PI) * 0.78;
      root.scale.setScalar(0.12 + q * 0.88);
      setVisualAlpha(displayVisualIndex, q);
    }
    const energy = Math.sin(k * Math.PI);
    pulse.material.opacity = 0.72 * energy;
    pulse.scale.setScalar((0.55 + energy * 1.15) * tr.boost);
    pulse.rotation.z = t * 1.7;
    updateSparks(t, energy, tr.boost);
    if (k < 1) return;

    if (tr.kind === "deposit") {
      finishDeposit(t);
      return;
    }
    stage = tr.station;
    const recipe = STATION_RECIPES[tr.station];
    cargoStage = recipe.carryReturnStage ?? recipe.outputStage;
    cargoVariant = recipe.carryReturnVariant ?? recipe.outputVariant ?? null;
    cargoCount = recipe.carryReturnCount ?? recipe.outputCount ?? (cargoStage ? 1 : 0);
    root.scale.setScalar(1);
    activeRunId = null;
    collectCounts[tr.station]++;
    pendingStation = null;
    phase = "idle";
    hudConfirmUntil = t + (REDUCED_MOTION ? 0.18 : 0.65);
    transition = null;
    if (tr.station === 3) {
      /* The returning left card has reached the two retained cards. Swap the
         render adapter to the complete triptych only now, never earlier. */
      retainedViewsActive = false;
      retainedRoot.visible = false;
      setDisplay(recipe.carryReturnStage);
    }
    setVisualAlpha(displayVisualIndex, 1);
    follow.copy(home);
    followReady = true;
    root.position.copy(follow);
    stopEffects();
    updateHud(tr.station === 3 ? "3/3 MASKED VIEWS REUNITED" : "EVIDENCE SECURED",
      tr.station === 3 ? "READY FOR STEP 04 · MULTI-VIEW INPUT" : null, "confirmed");
  }

  function update(dt, t, subject, heading) {
    const home = carrierTarget(subject, heading).clone();
    if (hudConfirmUntil && t >= hudConfirmUntil) {
      hudConfirmUntil = 0;
      updateHud();
    }
    root.visible = enabled && displayVisualIndex > 0;
    retainedRoot.visible = enabled && retainedViewsActive;
    if (retainedViewsActive) {
      retainedFollow.lerp(home, 1 - Math.exp(-Math.max(0, dt) * 7.5));
      retainedRoot.position.copy(retainedFollow);
      retainedRoot.position.y += REDUCED_MOTION ? 0 : Math.sin(t * 2.2) * 0.035;
      retainedRoot.quaternion.copy(camera.quaternion);
    }
    if (!enabled) {
      stopEffects();
      return;
    }

    if (!transition && pendingStation === null && phase === "idle" && !hudConfirmUntil &&
        proximityStation !== null) {
      reconcileStation(proximityStation, t, subject, heading);
    }

    if (transition) {
      updateTransition(dt, t, home);
    } else if (phase === "waiting") {
      pulse.visible = !REDUCED_MOTION;
      sparks.visible = !REDUCED_MOTION;
      const energy = 0.18 + 0.18 * Math.sin(t * 3.2) ** 2;
      pulse.material.opacity = energy;
      pulse.scale.setScalar(0.8 + energy);
      pulse.rotation.z = t * 0.9;
      updateSparks(t, energy * 0.8, 0.8);
      if (pendingStation >= 1 && pendingStation <= 5) {
        const process = getProcessState(pendingStation);
        const visual = visuals[pendingStation];
        const currentRun = process?.runId === activeRunId;
        if (currentRun && (process?.loadState === "unavailable" || visual?.failed)) {
          if (pendingStation === 3) {
            updateHud("LEFT-VIEW OUTPUT UNAVAILABLE",
              "2/3 VIEWS HELD · RE-ENTER STEP 03 TO RETRY", "rejected");
          } else {
            updateHud("OUTPUT ASSET UNAVAILABLE",
              `NOT COLLECTED · RE-ENTER STEP ${String(pendingStation).padStart(2, "0")} TO RETRY`,
              "rejected");
          }
        } else {
          const outputIsVisible = process?.outputVisible !== false;
          const atOutputStation = proximityStation === pendingStation;
          const ready = atOutputStation && currentRun && process?.ready &&
            process?.completed && outputIsVisible &&
            visual?.ready && (pendingStation !== 5 || t >= waitReadyAt);
          if (!ready) {
            outputReadySince = null;
          } else if (outputReadySince === null) {
            /* Arm first, pick up later. This guarantees the completed output
               survives at least one rendered frame on its workcell before the
               carried copy starts fading and flying toward the cattle. */
            outputReadySince = t;
            if (pendingStation === 3) {
              updateHud("SINGLE-VIEW 3D COMPLETE · STAYS ON WORKCELL",
                "LEFT VIEW READY · RETURNING TO HELD PAIR");
            } else {
              updateHud("OUTPUT READY · MATERIALIZING", "VISIBLE ON WORKCELL · PICKUP NEXT");
            }
          } else if (t - outputReadySince >= (REDUCED_MOTION ? 0.02 : 0.18)) {
            /* Process readiness belongs to the workcell, while the carried
               artifact comes from its recipe. Step 03 displays the completed
               reconstruction there, then returns only the borrowed left view
               to rejoin right + top beside the cattle. */
            const recipe = STATION_RECIPES[pendingStation];
            const carriedStage = recipe.carryReturnStage ?? recipe.outputStage;
            beginPickup(pendingStation, carriedStage, t,
              pendingStation === 3 ? 6 : recipe.outputStage);
          }
        }
      }
    } else if (displayVisualIndex) {
      const kp = 1 - Math.exp(-Math.max(0, dt) * 7.5);
      if (!followReady) {
        follow.copy(home);
        followReady = true;
      } else {
        follow.lerp(home, kp);
      }
      root.position.copy(follow);
      root.position.y += REDUCED_MOTION ? 0 : Math.sin(t * 2.2) * 0.035;
    }

    if (!displayVisualIndex) return;
    const visual = visuals[displayVisualIndex];
    if (visual.billboard) visual.group.quaternion.copy(camera.quaternion);
    else if (visual.followHeading) visual.group.rotation.y = lastHeading;
    if (visual.counterSpin) visual.counterSpin.rotation.z = -t * 0.88;
  }

  updateHud();
  return {
    setEnabled(on) {
      enabled = !!on;
      root.visible = enabled && displayVisualIndex > 0;
      retainedRoot.visible = enabled && retainedViewsActive;
      setAgreementGhosted(enabled && ghosted);
      if (!enabled) {
        proximityStation = null;
        stopEffects();
      }
    },
    enterStation,
    reconcileStation,
    installReconTrace(stationIndex, stepsPayload) {
      return stationIndex === 3 || stationIndex === 4
        ? !!visuals[stationIndex].installTrace?.(stepsPayload)
        : false;
    },
    update,
    get qaState() {
      const partialStep3 = pendingStation === 3 && cargoStage === 2;
      const returningLeft = partialStep3 && transition?.kind === "pickup";
      return {
        stage,
        displayStage,
        displayVisualIndex,
        cargoStage,
        cargoVariant,
        cargoViewCount: cargoCount,
        heldViewCount: partialStep3 ? 2 : cargoCount,
        inTransitViewCount: partialStep3 && (phase === "deposit" || phase === "pickup") ? 1 : 0,
        submittedViewCount: partialStep3 && phase === "waiting" ? 1 : 0,
        processingViewCount: partialStep3 && phase === "waiting" &&
          outputReadySince === null ? 1 : 0,
        returningViewCount: returningLeft ? 1 : 0,
        retainedViewCount: retainedViewsActive ? retainedVisual.cardCount : 0,
        station,
        kind: ARTIFACT_STAGES[cargoStage || stage].key,
        cargoKind: cargoStage ? ARTIFACT_STAGES[cargoStage].key : null,
        renderKind: displayStage ? ARTIFACT_STAGES[displayStage].key : null,
        renderViewCount: displayVisualIndex ? (visuals[displayVisualIndex].cardCount || 1) : 0,
        phase,
        pendingStation,
        transitioning: !!transition,
        waiting: phase === "waiting",
        outputReadySeen: outputReadySince !== null,
        hasCargo: cargoStage > 0,
        nextStation: pendingStation ?? submissionStationForArtifact(cargoStage, cargoVariant) ??
          (stage === 6 ? 7 : stage === 7 ? 8 : 1),
        cycleCount,
        weightReady,
        submitCounts: submitCounts.slice(),
        collectCounts: collectCounts.slice(),
        lastRejection,
        activeRunId,
        nextRunId,
        proximityStation,
        ghosted,
        position: (retainedViewsActive ? retainedRoot : root).position.toArray(),
        transferPosition: root.position.toArray(),
        tracePoints: {
          single: visuals[3].pointCount || 0,
          multiview: visuals[4].pointCount || 0
        },
        visualReady: visuals.map((visual) => visual?.ready ?? false),
        retainedVisualReady: retainedVisual.ready,
        maskedRgb: !!visuals[2].maskedRgb
      };
    }
  };
}
