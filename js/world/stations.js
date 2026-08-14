/* Stations: the ranch gate + eight exhibits along the rail (0–8).
   All in-scene text is canvas-textured (CSS2D would not survive a canvas
   recording); GLB exhibits arrive later via attachModel(). */

import * as THREE from "../../vendor/three.module.js";
import { ConvexGeometry } from "../../vendor/ConvexGeometry.js";
import { STATIONS } from "./rail.js?v=20260813-camera-mount-review";
import {
  FUTURE_FACTORY_PROXIMITY, FUTURE_RIG_CAPTURE_POINTS, FUTURE_RIG_PROXIMITY
} from "./environment.js?v=20260813-camera-mount-review";
import { IO, pad2 } from "./handoff-content.js?v=20260813-rgbd-pointcloud";
import { PIPELINE_BRANCHES, PIPELINE_NODES } from "./pipeline-map.js?v=20260812-view-routing";
import { LightRig, PanelThrottle, ScreenSizeLod } from "../lib/three-perf.js";
import { createDeferredReconPlayer } from "../lib/recon-player.js?v=20260812-virtual-clock";
import { createCameraFlash } from "../lib/camera-flash.js";
import {
  DEPLOYMENT_PERIOD, deploymentOneShotStateAt, deploymentProximity, deploymentStateAt
} from "./deployment-sim.js?v=20260812-sequential-carry";

const AMBER = 0xe39b2d;
const ICE = 0x86d7ea;

/* A reconstruction completion is a semantic boundary, so its accent must be
   one-shot even though the evidence player later loops for inspection. Reuse
   an exhibit ring instead of adding particles or another transparent pass. */
function completionLock(ring, reducedMotion = false) {
  const ice = new THREE.Color(ICE);
  const amber = new THREE.Color(AMBER);
  const mixed = new THREE.Color();
  const DURATION = reducedMotion ? 0.24 : 0.68;
  let wasCompleted = false;
  let startedAt = null;

  function reset() {
    wasCompleted = false;
    startedAt = null;
    ring.scale.setScalar(1);
    ring.material.emissive.copy(ice);
  }

  function update(t, completed, idleIntensity = 0.5) {
    if (completed && !wasCompleted) startedAt = t;
    wasCompleted = completed;
    if (startedAt === null) {
      ring.material.emissive.copy(ice);
      ring.material.emissiveIntensity = idleIntensity;
      ring.scale.setScalar(1);
      return;
    }
    const p = THREE.MathUtils.clamp((t - startedAt) / DURATION, 0, 1);
    const q = THREE.MathUtils.smoothstep(p, 0, 1);
    ring.material.emissive.copy(mixed.copy(ice).lerp(amber, q));
    ring.material.emissiveIntensity = THREE.MathUtils.lerp(idleIntensity, 0.72, q)
      + (reducedMotion ? 0 : Math.sin(Math.PI * p) * 1.05);
    ring.scale.setScalar(reducedMotion ? 1 : 1 + Math.sin(Math.PI * p) * 0.09);
  }

  reset();
  return { reset, update };
}

/* Recon exhibit mounts, and the Stage-2 splat size derived from them.

   Splat size is a SCREEN-space quantity — recon-player's shader computes
   gl_PointSize = uSize * 60/-mv.z, which ignores the mount scale entirely.
   The single-view exhibit uses a larger mount than the Station-04 side pair.
   Tying point size to each mount keeps their surface coverage comparable;
   changing a mount now carries its splat size with it. Stage 1 is left alone —
   6.6k chunky voxels already read solid, and looking blocky is its whole job. */
const RECON_MOUNT_SINGLE = 1.12;      // station 03, both stage clouds
const RECON_MOUNT_MULTIVIEW = 0.75;   // station 04, enlarge the side pair for inspection
const MV_STAGE2_POINT_SIZE = 0.39 * (RECON_MOUNT_MULTIVIEW / 0.60);
const SINGLE_STAGE2_POINT_SIZE =
  MV_STAGE2_POINT_SIZE * (RECON_MOUNT_SINGLE / RECON_MOUNT_MULTIVIEW);  // 0.728
const VIEWS = "assets/cases/case_001/views/";
const DISPLAY_VIEWS = `${VIEWS}display/`;
const GATE_THUMBS = "assets/world/thumbs/";
const GATE_THUMB_FILES = {
  rgb: ["rgb_left.webp", "rgb_right.webp", "rgb_top.webp"],
  mask: ["mask_left.webp", "mask_right.webp", "mask_top_aligned.webp"]
};

/* meta.json keeps the original experiment inputs as provenance. The ranch
   boards use smaller derivatives so display traffic never rewrites that
   provenance or competes with the reconstruction trace. */
export function displayViewUrl(url) {
  if (!url.startsWith(VIEWS)) return url;
  const name = url.slice(VIEWS.length);
  if (/^rgb_(left|right|top)\.png$/.test(name)) {
    return `${DISPLAY_VIEWS}${name.replace(/\.png$/, ".webp")}`;
  }
  if (/^mask_(left|right|top_aligned)\.png$/.test(name)) {
    return `${DISPLAY_VIEWS}${name}`;
  }
  return url;
}

const texLoader = new THREE.TextureLoader();
let stationTexturesStarted = false;
const deferredTextureStarts = [];

export function startStationTextures() {
  if (stationTexturesStarted) {
    /* Re-entering an unavailable source station is a real retry. Successful
       cache entries stay resident; only failed local assets are requested. */
    for (const entry of texCache.values()) {
      if (entry.failed) entry.start?.();
    }
    return;
  }
  stationTexturesStarted = true;
  /* Release in small batches instead of one synchronous loop. Firing all of
     them at once put six 1280x720 decodes on the same millisecond, so their
     GPU uploads landed in the same frame — measured as part of the stall on
     first arrival at station 01. Idle callbacks spread that over a few frames;
     the boards fill in a beat later, which nobody sees. */
  const queue = deferredTextureStarts.splice(0);
  const pump = () => {
    for (let n = 0; n < 2 && queue.length; n++) queue.shift()();
    if (!queue.length) return;
    if ("requestIdleCallback" in window) requestIdleCallback(pump, { timeout: 120 });
    else requestAnimationFrame(pump);
  };
  pump();
}

/* immediate thumbnail-only cache for the gate pipeline board. Its filenames
   are deliberately resolved under assets/world/thumbs/, never case views. */
const gateThumbCache = new Map();
function gateThumbTex(file, onLoad) {
  const url = GATE_THUMBS + file;
  let entry = gateThumbCache.get(url);
  if (!entry) {
    entry = { loaded: false, cbs: [], tex: new THREE.Texture() };
    gateThumbCache.set(url, entry);
    entry.tex = texLoader.load(url, (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      entry.loaded = true;
      for (const cb of entry.cbs.splice(0)) cb(t);
    });
  }
  if (onLoad) {
    if (entry.loaded) onLoad(entry.tex);
    else entry.cbs.push(onLoad);
  }
  return entry.tex;
}

/* shared full-resolution cache for the capture, segmentation, and
   reconstruction boards. Loads remain deferred until the station policy
   requests them, while duplicate URLs still decode only once. */
const texCache = new Map();
export function sharedTex(url, onLoad, onError = null) {
  let entry = texCache.get(url);
  if (!entry) {
    entry = {
      loaded: false, loading: false, failed: false,
      cbs: [], errorCbs: [], tex: new THREE.Texture(), start: null
    };
    texCache.set(url, entry);
    const start = () => {
      if (entry.loading || entry.loaded) return;
      entry.loading = true;
      entry.failed = false;
      entry.tex = texLoader.load(url, (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        entry.loading = false;
        entry.loaded = true;
        for (const cb of entry.cbs.splice(0)) cb(t);
        entry.errorCbs.length = 0;
      }, undefined, (error) => {
        entry.loading = false;
        entry.failed = true;
        /* Preserve success callbacks so a later station re-entry can retry and
           finish the same already-built board/card rather than rebuilding it. */
        for (const cb of entry.errorCbs) cb(error);
      });
    };
    entry.start = start;
    if (stationTexturesStarted) start();
    else deferredTextureStarts.push(start);
  }
  if (onLoad) {
    if (entry.loaded) onLoad(entry.tex);
    else if (!entry.failed) entry.cbs.push(onLoad);
  }
  if (onError) {
    if (entry.failed) onError();
    else if (!entry.loaded) entry.errorCbs.push(onError);
  }
  return entry.tex;
}

/* ---------- payload loader (adapted from js/agreement.js) ---------- */

async function fetchOrThrow(url, as) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return as === "json" ? r.json() : r.arrayBuffer();
}

const b64ToBuf = (s) => {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u.buffer;
};

export async function loadAgreementPayload() {
  let meta, ptsBuf, agrBuf;
  try {
    [meta, ptsBuf, agrBuf] = await Promise.all([
      fetchOrThrow("assets/agreement/meta.json", "json"),
      fetchOrThrow("assets/agreement/points.bin"),
      fetchOrThrow("assets/agreement/agree.bin")
    ]);
    if (!ptsBuf.byteLength || !agrBuf.byteLength) {
      throw new Error("binary fetch returned 0 bytes (proxy stripped octet-stream?)");
    }
  } catch (binErr) {
    console.warn("binary payload failed, falling back to payload.json:", binErr);
    meta = await fetchOrThrow("assets/agreement/payload.json", "json");
    ptsBuf = b64ToBuf(meta.pointsB64);
    agrBuf = b64ToBuf(meta.agreeB64);
  }
  const N = meta.count, S = meta.steps;
  if (ptsBuf.byteLength !== N * 12 || agrBuf.byteLength !== N * S) {
    throw new Error(`payload size mismatch: pts ${ptsBuf.byteLength}B, agree ${agrBuf.byteLength}B`);
  }
  return { meta, positions: new Float32Array(ptsBuf), scalars: new Uint8Array(agrBuf) };
}

/* NIGHTBARN colormap LUT (from agreement.js) */
function buildNightbarnLUT() {
  const stops = [
    [0.0, 32, 58, 84], [0.35, 134, 215, 234], [0.65, 237, 231, 218], [1.0, 227, 155, 45]
  ];
  const data = new Uint8Array(256 * 4);
  const lerp = (a, b, k) => a + (b - a) * k;
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    let j = 0;
    while (j < stops.length - 2 && x > stops[j + 1][0]) j++;
    const k = (x - stops[j][0]) / (stops[j + 1][0] - stops[j][0]);
    data[i * 4] = lerp(stops[j][1], stops[j + 1][1], k);
    data[i * 4 + 1] = lerp(stops[j][2], stops[j + 1][2], k);
    data[i * 4 + 2] = lerp(stops[j][3], stops[j + 1][3], k);
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, 256, 1, THREE.RGBAFormat);
  tex.needsUpdate = true;
  return tex;
}

/* ---------- small builders ---------- */

function canvasPlane(w, h, pxW, pxH, draw, opts = {}) {
  const c = document.createElement("canvas");
  c.width = pxW; c.height = pxH;
  draw(c.getContext("2d"), pxW, pxH);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: tex, transparent: !!opts.transparent })
  );
  mesh.userData.canvas = c;
  mesh.userData.tex = tex;
  return mesh;
}

const MONO = "'IBM Plex Mono', monospace";
const BLACK = "'Archivo Black', 'Archivo', sans-serif";

/* A wide, floor-mounted job strip makes the two reconstruction phases legible
   while the visitor waits beside the machine. It is driven by the same real
   exported trace as the point clouds, so the bar can never finish early. */
function reconstructionGroundProgress(title) {
  const mesh = canvasPlane(7.2, 0.92, 1440, 184, () => {});
  mesh.name = `groundProgress${title.replace(/\W+/g, "")}`;
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(0, 0.045, 2.5);
  mesh.renderOrder = 2;
  const ctx = mesh.userData.canvas.getContext("2d");
  let signature = "";
  let playback = { P: 0, Q: 0, started: false };
  let snapshot = {
    stage: 1, step: 0, stage1: 0, stage2: 0,
    stage1Step: 0, stage2Step: 0,
    started: false, completed: false
  };

  /* Keep the strip on the player's visual clock. `completed` is intentionally
     not used as the fill amount: that flag is a one-shot delivery latch and
     remains true while the reconstruction trace dissolves and loops again. */
  function setPlayback(phases = {}, started = true) {
    playback = {
      P: THREE.MathUtils.clamp(Number.isFinite(phases.P) ? phases.P : 0, 0, 1),
      Q: THREE.MathUtils.clamp(Number.isFinite(phases.Q) ? phases.Q : 0, 0, 1),
      started: !!started
    };
  }

  function update(state = {}, completed = false) {
    /* Floor matches recon-player's frame selection. In particular P=0 maps to
       0/50 (not the old premature 1/50), while P=1 reaches the true 50/50. */
    const stage1Step = playback.started ? Math.floor(playback.P * 50 + 1e-6) : 0;
    const stage2Step = playback.started ? Math.floor(playback.Q * 25 + 1e-6) : 0;
    const s1 = stage1Step / 50;
    const s2 = stage2Step / 25;
    const activeStage = playback.P < 1 ? 1 : 2;
    const step = activeStage === 1 ? stage1Step : stage2Step;
    const nextSignature = `${activeStage}:${stage1Step}:${stage2Step}:${playback.started}:${completed}`;
    if (nextSignature === signature) return;
    signature = nextSignature;
    snapshot = {
      stage: activeStage, step, stage1: s1, stage2: s2,
      stage1Step, stage2Step,
      started: playback.started, completed: !!completed
    };

    const W = 1440, H = 184, pad = 30, gap = 26;
    const barY = 100, barH = 42, barW = (W - pad * 2 - gap) / 2;
    ctx.fillStyle = "#080b0f";
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "#33404a";
    ctx.lineWidth = 5;
    ctx.strokeRect(3, 3, W - 6, H - 6);
    ctx.textBaseline = "middle";
    ctx.font = `500 26px ${MONO}`;
    ctx.textAlign = "left";
    ctx.fillStyle = "#d6dce0";
    ctx.fillText(title, pad, 40);
    ctx.textAlign = "right";
    ctx.fillStyle = completed ? "#86d7ea" : "#8c98a2";
    const status = !playback.started
      ? "WAITING · STAGE 1"
      : completed
        ? "OUTPUT READY · VISUAL LOOP ACTIVE"
        : `ACTIVE · STAGE ${activeStage}`;
    ctx.fillText(status, W - pad, 40);

    const drawBar = (x, value, color, label, steps) => {
      ctx.fillStyle = "#141b22";
      ctx.fillRect(x, barY, barW, barH);
      ctx.fillStyle = color;
      ctx.fillRect(x, barY, barW * value, barH);
      ctx.strokeStyle = "#495560";
      ctx.lineWidth = 3;
      ctx.strokeRect(x, barY, barW, barH);
      ctx.font = `500 22px ${MONO}`;
      ctx.textAlign = "left";
      ctx.fillStyle = value > 0.5 ? "#081015" : "#d6dce0";
      const shownStep = Math.min(steps, Math.round(value * steps));
      ctx.fillText(`${label} · ${shownStep}/${steps}`, x + 16, barY + barH / 2 + 1);
    };
    drawBar(pad, s1, "#e39b2d", "STAGE 1 · SPARSE STRUCTURE", 50);
    drawBar(pad + barW + gap, s2, "#86d7ea", "STAGE 2 · RGB REFINEMENT", 25);
    mesh.userData.tex.needsUpdate = true;
  }

  update();
  return { mesh, setPlayback, update, get state() { return { ...snapshot }; } };
}

function plinth(w = 1.9, h = 1.0, d = 1.4, hot = false) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color: 0x11151a, roughness: 0.85 })
  );
  body.position.y = h / 2;
  const rim = new THREE.Mesh(
    new THREE.BoxGeometry(w + 0.06, 0.05, d + 0.06),
    new THREE.MeshStandardMaterial({
      color: 0x1a1408, emissive: AMBER, emissiveIntensity: hot ? 0.9 : 0.3
    })
  );
  rim.position.y = h;
  g.add(body, rim);
  return g;
}

/* self-lit photo board with a dark frame; texture arrives async */
function photoBoard(url, w = 2.6, h = 1.7, onTextureReady = null, onTextureError = null) {
  const g = new THREE.Group();
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(w + 0.12, h + 0.12, 0.06),
    new THREE.MeshStandardMaterial({ color: 0x0c0f13, roughness: 0.9 })
  );
  const mat = new THREE.MeshBasicMaterial({ color: 0x151b22 });
  const img = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  img.position.z = 0.035;
  sharedTex(url, (tex) => {
    mat.map = tex;
    mat.color.set(0xffffff);
    mat.needsUpdate = true;
    onTextureReady?.();
  }, onTextureError);
  g.add(frame, img);
  return g;
}

/* RGB-preserving SAM cutout: the RGB texture supplies color while the mask is
   alpha, matching the object the cattle actually carries between workcells. */
function maskedPhotoBoard(rgbUrl, maskUrl, w = 2.6, h = 1.7) {
  const g = new THREE.Group();
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(w + 0.12, h + 0.12, 0.06),
    new THREE.MeshStandardMaterial({ color: 0x0c0f13, roughness: 0.9 })
  );
  const dim = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ color: 0x05080b, side: THREE.DoubleSide })
  );
  dim.position.z = 0.034;
  const mat = new THREE.MeshBasicMaterial({
    color: 0x151b22, transparent: true, alphaTest: 0.035,
    side: THREE.DoubleSide, depthWrite: false
  });
  const image = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  image.position.z = 0.038;
  sharedTex(displayViewUrl(rgbUrl), (tex) => {
    mat.map = tex;
    mat.color.setHex(0xffffff);
    mat.needsUpdate = true;
  });
  sharedTex(displayViewUrl(maskUrl), (tex) => {
    mat.alphaMap = tex;
    mat.needsUpdate = true;
  });
  g.add(frame, dim, image);
  return g;
}

function boardLabel(text, w = 2.6) {
  const pxW = Math.round(w * 200);
  return canvasPlane(w, 0.26, pxW, 52, (ctx, W, H) => {
    ctx.fillStyle = "#0c0f13";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#e39b2d";
    let size = 26;
    ctx.font = `500 ${size}px ${MONO}`;
    while (size > 12 && ctx.measureText(text).width > W - 28) {
      ctx.font = `500 ${--size}px ${MONO}`;
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, W / 2, H / 2 + 1);
  });
}

/* every station spot registers with the rig so only the active station's
   neighbourhood stays lit (forward rendering pays per visible light) */
const lightRig = new LightRig(1);

function stationSpot(scene, s, intensity = 50, hotOffset = null) {
  const spot = new THREE.SpotLight(AMBER, intensity, 45, 0.6, 0.75, 1.0);
  const off = hotOffset || new THREE.Vector3(0, 0, 0);
  spot.position.set(s.pos.x + off.x + 2.5, 8.5, s.pos.z + off.z + 2.5);
  spot.target.position.set(s.pos.x + off.x, 1, s.pos.z + off.z);
  scene.add(spot, spot.target);
  lightRig.add(STATIONS.indexOf(s), spot);
  return spot;
}

/* shimmer placeholder shown on a plinth until its GLB arrives */
function shimmerBlock(label) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: 0x232c36, transparent: true, opacity: 0.35,
    emissive: 0x86d7ea, emissiveIntensity: 0.25, roughness: 0.6
  });
  const box = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.9, 0.9), mat);
  box.position.y = 0.55;
  g.add(box);
  if (label) {
    const tag = boardLabel(label, 1.7);
    tag.position.y = 1.35;
    g.add(tag);
  }
  g.userData.shimmerMat = mat;
  return g;
}

/* normalize a GLB clone onto an anchor: longest ground axis → targetLen */
function mountModel(anchor, srcScene, targetLen = 2.5, yaw = 0) {
  const obj = srcScene.clone(true);
  obj.traverse((o) => {
    if (o.isMesh && o.material && o.material.emissive) {
      o.material = o.material.clone();
      o.material.emissive.setScalar(0.045);
    }
  });
  const bb = new THREE.Box3().setFromObject(obj);
  const size = bb.getSize(new THREE.Vector3());
  const s = targetLen / Math.max(size.x, size.z, 1e-6);
  obj.scale.setScalar(s);
  /* Apply the authored comparison yaw before the final bounds pass. A cattle
     crop is asymmetric, so rotating an already-centred AABB can move its final
     visual centre away from the plinth even though its pivot remains at zero. */
  obj.rotation.y = yaw;
  obj.updateMatrixWorld(true);
  bb.setFromObject(obj);
  const c = bb.getCenter(new THREE.Vector3());
  obj.position.set(-c.x, -bb.min.y, -c.z);
  obj.updateMatrixWorld(true);
  bb.setFromObject(obj);
  obj.userData.mountBounds = {
    minY: bb.min.y,
    centerX: bb.getCenter(new THREE.Vector3()).x,
    centerZ: bb.getCenter(new THREE.Vector3()).z
  };
  anchor.clear();
  anchor.add(obj);
  return obj;
}

function tintModel(obj, color, opacity = 0.45) {
  obj.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    o.material = o.material.clone();
    o.material.transparent = true;
    o.material.opacity = opacity;
    o.material.depthWrite = false;
    if (o.material.color) o.material.color.lerp(new THREE.Color(color), 0.42);
    if (o.material.emissive) {
      o.material.emissive.set(color);
      o.material.emissiveIntensity = 0.12;
    }
  });
}

/* yaw a station group so its local +Z faces the dwell camera */
function faceCam(group, s) {
  group.position.copy(s.pos);
  group.rotation.y = Math.atan2(s.cam.x - s.pos.x, s.cam.z - s.pos.z);
}

/* ---------- inter-station handoff plaques (stations 01–07) ----------
   A small static sign above each exhibit naming what the station consumes
   and what it hands to the next one, so the dataflow is readable in-world,
   not only from the side panel. Drawn once — never touched per frame. */

/* y clears each exhibit's tallest signage; z matches the plane that signage
   sits on. Verified against the dwell cameras (rail.js): the steepest case,
   fusion at y 5.35, is ~16° above the view axis vs a 27.5° half-FOV. */
const PLAQUE_LAYOUT = {
  /* The CSS2D station markers float at world y 5.6 over each exhibit center
     (panels.js makeStationMarkers) and render on top of the canvas, so any
     centered plaque whose top crosses ~5.4 collides with its own station's
     badge. Tall exhibits therefore mount the plaque ABOVE the marker band. */
  1: { y: 4.55, z: 0.25 },  // above the gantry beam (BEAM_Y 4.15)
  2: { y: 3.35, z: -0.4 },  // above the three boards (tops ~2.85)
  3: { y: 4.65, z: 0 },     // above the trajectory tag (4.1), below the badge
  4: { y: 6.35, z: 0 },     // readout top ~4.88 → badge 5.6 → plaque
  5: { y: 4.6,  z: 0.2 },   // above the method plaques (hot top ~4.0)
  6: { y: 6.3,  z: 0 },     // features title ~4.85 → badge 5.6 → plaque
  7: { y: 6.35, z: -1.2 }   // results board top 5.1 → badge 5.6 → plaque
};

function roundedPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function handoffPlaque(i) {
  const io = IO[i];
  const rows = [
    ["IN ←", `${pad2(io.in.from)} · ${io.in.label.toUpperCase()}`],
    ["OUT →", io.out.to === null
      ? io.out.label.toUpperCase()
      : `${pad2(io.out.to)} · ${io.out.label.toUpperCase()}`]
  ];
  const plane = canvasPlane(4.3, 0.72, 1076, 180, (ctx, W, H) => {
    roundedPath(ctx, 2, 2, W - 4, H - 4, 26);
    ctx.fillStyle = "rgba(12, 15, 19, 0.92)";
    ctx.fill();
    ctx.strokeStyle = "rgba(227, 155, 45, 0.4)";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.textBaseline = "middle";
    ctx.font = `500 40px ${MONO}`;
    rows.forEach(([tag, text], r) => {
      const y = H * (r ? 0.72 : 0.3);
      ctx.fillStyle = "#e39b2d";
      ctx.fillText(tag, 46, y);
      ctx.fillStyle = "#c8ccd2";
      ctx.fillText(text, 220, y);
    });
  }, { transparent: true });
  plane.name = `plaque${pad2(i)}`;
  return plane;
}

function addHandoffPlaques(scene) {
  for (const idx of Object.keys(PLAQUE_LAYOUT)) {
    /* per-station fail-soft: one bad plaque must not take the other six down */
    try {
      const i = Number(idx);
      if (!IO[i]) continue;
      const g = new THREE.Group();
      faceCam(g, STATIONS[i]);          // same yaw as the exhibit's own group
      const plaque = handoffPlaque(i);
      plaque.position.set(0, PLAQUE_LAYOUT[i].y, PLAQUE_LAYOUT[i].z);
      g.add(plaque);
      g.name = `handoff${pad2(i)}`;     // sceneCost() attributes by this name
      scene.add(g);
    } catch (err) {
      console.warn(`handoff plaque ${idx} skipped:`, err);
    }
  }
}

/* ---------- per-station exhibits ---------- */

/* "04 FUSION" for a pipeline-map cell, looked up by the shared id so the
   board can never drift out of step with the rail's numbering. */
const STATION_BY_ID = new Map(STATIONS.map((s) => [s.id, s]));
function stationTag(ctx, id, cx, y, hot) {
  const s = STATION_BY_ID.get(id);
  if (!s) return;
  ctx.fillStyle = hot ? "#e39b2d" : "#7f8992";
  ctx.font = `500 18px ${MONO}`;
  ctx.fillText(`${s.num}  ${s.name}`, cx, y);
}

/* Station 0 — ranch gate + pipeline intro board. The wooden arch marks the
   walk's start; the big flow board maps the whole method before the first
   exhibit. It uses dedicated low-resolution thumbnails immediately. */
function buildGate(scene, s) {
  const g = new THREE.Group();
  faceCam(g, s);

  const wood = new THREE.MeshStandardMaterial({ color: 0x4d3620, roughness: 0.95 });
  for (const x of [-3.3, 3.3]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.42, 4.8, 0.42), wood);
    post.position.set(x, 2.4, 0);
    const lamp = new THREE.Mesh(
      new THREE.SphereGeometry(0.11, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0x33230a, emissive: AMBER, emissiveIntensity: 1.6 })
    );
    lamp.position.set(x, 4.98, 0);
    g.add(post, lamp);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(7.6, 0.34, 0.5), wood);
  beam.position.set(0, 4.62, 0);
  g.add(beam);

  /* hanging "AGREEMENT RANCH" sign */
  const sign = canvasPlane(5.4, 0.95, 1240, 218, (ctx, W, H) => {
    ctx.fillStyle = "#151007";
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "#e39b2d";
    ctx.lineWidth = 6;
    ctx.strokeRect(5, 5, W - 10, H - 10);
    ctx.textAlign = "center";
    ctx.fillStyle = "#e39b2d";
    ctx.font = `112px ${BLACK}`;
    ctx.fillText("AGREEMENT RANCH", W / 2, 118);
    ctx.fillStyle = "#86d7ea";
    ctx.font = `500 32px ${MONO}`;
    ctx.fillText("INTERACTIVE RESEARCH PREPRINT · EVIDENCE TRAIL · STATIONS 0–8", W / 2, 182);
  });
  sign.position.set(0, 3.92, 0.04);
  for (const x of [-2.3, 2.3]) {
    const link = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.34, 6), wood);
    link.position.set(x, 4.42, 0.04);
    g.add(link);
  }
  g.add(sign);

  /* ---- BIG pipeline flow board (static Canvas2D method map) ----
     Bigger in two independent ways. The CANVAS went 1560→1840 px because six
     210 px cells at a 258 px pitch left the long method terms auto-shrinking to
     14 px with no room for the station names added below. The PLANE went
     7.3→10.0 units because the board is read from the dwell camera ~12 units
     out, where apparent size beats texture crispness — 184 px/unit renders a
     touch softer and a good deal more legible than 214 px/unit did. */
  const thumbRects = [];   // filled by draw(), consumed by async thumb loads
  const board = canvasPlane(10.0, 3.7, 1840, 680, (ctx, W, H) => {
    ctx.fillStyle = "#0b0e12";
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "#2a323c";
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, W - 6, H - 6);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#86d7ea";
    ctx.font = `500 30px ${MONO}`;
    ctx.fillText("THE METHOD MAP — THREE CAMERAS TO KILOGRAMS", W / 2, 44);
    ctx.fillStyle = "#aeb7c0";
    ctx.font = `500 19px ${MONO}`;
    ctx.fillText("RGB  →  SAM3 masks  →  single-view recon  →  multi-view agreement recon  →  features  →  kg", W / 2, 78);

    const arrow = (x0, y0, x1, y1, { dashed = false, color = "#e39b2d" } = {}) => {
      const angle = Math.atan2(y1 - y0, x1 - x0);
      ctx.save();
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 4;
      if (dashed) ctx.setLineDash([10, 7]);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1 - Math.cos(angle) * 14, y1 - Math.sin(angle) * 14);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 - Math.cos(angle - 0.48) * 18, y1 - Math.sin(angle - 0.48) * 18);
      ctx.lineTo(x1 - Math.cos(angle + 0.48) * 18, y1 - Math.sin(angle + 0.48) * 18);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    };

    const thumbSlots = (cx, cy, kind) => {
      for (let i = 0; i < 3; i++) {
        const r = { x: cx - 84 + i * 57, y: cy - 54, w: 52, h: 68, kind, i };
        ctx.fillStyle = kind === "mask" ? "#172a31" : "#1c232c";
        ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.strokeStyle = kind === "mask" ? "#86d7ea" : "#5c6873";
        ctx.lineWidth = 2;
        ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
        if (kind === "mask") {
          ctx.fillStyle = "rgba(134, 215, 234, 0.42)";
          ctx.beginPath();
          ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, 15, 25, -0.35, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.strokeStyle = "#e39b2d";
          ctx.beginPath();
          ctx.moveTo(r.x + 10, r.y + r.h - 12);
          ctx.lineTo(r.x + r.w / 2, r.y + 13);
          ctx.lineTo(r.x + r.w - 9, r.y + r.h - 18);
          ctx.stroke();
        }
        thumbRects.push(r);
      }
      ctx.fillStyle = "#8b95a0";
      ctx.font = `500 16px ${MONO}`;
      ctx.fillText("L   R   T", cx, cy + 34);
    };

    const pointCow = (cx, cy) => {
      const points = [
        [-72, -3], [-64, -22], [-49, -37], [-25, -45], [3, -45], [28, -35], [48, -18],
        [67, -25], [77, -12], [68, 3], [53, 10], [43, 28], [27, 31], [17, 12],
        [-22, 13], [-32, 35], [-48, 35], [-53, 11], [-70, 7], [-82, -5], [-10, -22],
        [15, -22], [37, -10], [0, 1], [-30, -3], [5, 26]
      ];
      ctx.save();
      ctx.strokeStyle = "#4f6975";
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 5]);
      ctx.strokeRect(cx - 88, cy - 58, 176, 116);
      ctx.setLineDash([]);
      for (const [dx, dy] of points) {
        ctx.fillStyle = (dx + dy) % 3 === 0 ? "#e39b2d" : "#86d7ea";
        ctx.beginPath();
        ctx.arc(cx + dx, cy + dy, 4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    };

    const merge = (cx, cy) => {
      const inputs = [[cx - 68, cy - 42], [cx - 68, cy], [cx - 68, cy + 42]];
      for (const [x, y] of inputs) {
        ctx.fillStyle = "#86d7ea";
        ctx.beginPath();
        ctx.arc(x, y, 9, 0, Math.PI * 2);
        ctx.fill();
        arrow(x + 12, y, cx + 36, cy, { color: "#86d7ea" });
      }
      ctx.fillStyle = "#e39b2d";
      ctx.beginPath();
      ctx.arc(cx + 56, cy, 25, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#151007";
      ctx.font = `500 18px ${MONO}`;
      ctx.fillText("1", cx + 56, cy + 1);
    };

    const measure = (cx, cy) => {
      const rightDimensionX = cx + 78;
      ctx.save();
      ctx.strokeStyle = "#86d7ea";
      ctx.lineWidth = 3;
      ctx.strokeRect(cx - 72, cy - 42, 144, 84);
      ctx.strokeStyle = "#e39b2d";
      ctx.beginPath();
      ctx.moveTo(cx - 62, cy - 57); ctx.lineTo(cx + 62, cy - 57);
      ctx.moveTo(cx - 62, cy - 64); ctx.lineTo(cx - 62, cy - 50);
      ctx.moveTo(cx + 62, cy - 64); ctx.lineTo(cx + 62, cy - 50);
      ctx.moveTo(rightDimensionX, cy - 32); ctx.lineTo(rightDimensionX, cy + 32);
      ctx.moveTo(rightDimensionX - 7, cy - 32); ctx.lineTo(rightDimensionX + 7, cy - 32);
      ctx.moveTo(rightDimensionX - 7, cy + 32); ctx.lineTo(rightDimensionX + 7, cy + 32);
      ctx.stroke();
      ctx.fillStyle = "#e39b2d";
      ctx.font = `500 16px ${MONO}`;
      ctx.fillText("L", cx, cy - 73);
      ctx.fillText("H", rightDimensionX - 16, cy);
      ctx.restore();
    };

    const weight = (cx, cy) => {
      const widths = [94, 126, 72, 108];
      widths.forEach((w, i) => {
        ctx.fillStyle = i === 3 ? "#e39b2d" : "#526876";
        ctx.fillRect(cx - 88, cy - 50 + i * 25, w, 14);
      });
      arrow(cx + 43, cy, cx + 54, cy, { color: "#e39b2d" });
      ctx.fillStyle = "#e39b2d";
      ctx.font = `44px ${BLACK}`;
      ctx.fillText("kg", cx + 72, cy + 1);
    };

    const evidenceCards = (cx, cy) => {
      for (const [i, offset] of [[0, -22], [1, 0], [2, 22]]) {
        ctx.fillStyle = i === 2 ? "#1e2b32" : "#141a21";
        ctx.fillRect(cx - 61 + offset, cy - 34 - offset / 4, 95, 65);
        ctx.strokeStyle = i === 2 ? "#86d7ea" : "#44505a";
        ctx.lineWidth = 2;
        ctx.strokeRect(cx - 61 + offset, cy - 34 - offset / 4, 95, 65);
      }
      ctx.fillStyle = "#86d7ea";
      ctx.font = `500 18px ${MONO}`;
      ctx.fillText("✓  ✓  ✓", cx + 5, cy - 2);
    };

    const futureGate = (cx, cy) => {
      ctx.save();
      ctx.strokeStyle = "#e39b2d";
      ctx.lineWidth = 3;
      ctx.setLineDash([8, 6]);
      ctx.strokeRect(cx - 85, cy - 39, 170, 78);
      ctx.setLineDash([]);
      ctx.fillStyle = "#27333a";
      ctx.fillRect(cx - 53, cy - 17, 44, 34);
      ctx.fillRect(cx + 10, cy - 17, 44, 34);
      ctx.fillStyle = "#e39b2d";
      ctx.font = `500 15px ${MONO}`;
      ctx.fillText("RGB", cx - 31, cy + 1);
      ctx.fillText("GATE", cx + 31, cy + 1);
      ctx.restore();
    };

    const nodeY = 276, nodeW = 256, nodeH = 248;
    const nodeX = new Map(PIPELINE_NODES.map((node, i) => [node.id, 170 + i * 300]));
    const drawNode = (node) => {
      const cx = nodeX.get(node.id);
      const hot = node.id === "fusion" || node.id === "weigh";
      ctx.fillStyle = hot ? "#211b10" : "#141a21";
      ctx.fillRect(cx - nodeW / 2, nodeY - nodeH / 2, nodeW, nodeH);
      ctx.strokeStyle = hot ? "#e39b2d" : "#39434e";
      ctx.lineWidth = hot ? 4 : 3;
      ctx.strokeRect(cx - nodeW / 2, nodeY - nodeH / 2, nodeW, nodeH);

      /* Station number + name across the top. The map's cells ARE the dock's
         dots, and this is the only place that says so: read "04 FUSION" here,
         press 4, and you are standing in it. Derived from STATIONS rather than
         restated in pipeline-map.js so the rail stays the single source. */
      stationTag(ctx, node.id, cx, nodeY - nodeH / 2 + 27, hot);

      if (node.token === "triptych") thumbSlots(cx, nodeY - 8, "rgb");
      if (node.token === "masks") thumbSlots(cx, nodeY - 8, "mask");
      if (node.token === "point-cow") pointCow(cx, nodeY - 4);
      if (node.token === "merge") merge(cx, nodeY - 4);
      if (node.token === "measure") measure(cx, nodeY - 4);
      if (node.token === "weight") weight(cx, nodeY - 4);

      ctx.fillStyle = hot ? "#e39b2d" : "#d6dce0";
      let size = node.id === "features" ? 18 : 20;
      ctx.font = `500 ${size}px ${MONO}`;
      while (size > 14 && ctx.measureText(node.label.toUpperCase()).width > nodeW - 24) {
        ctx.font = `500 ${--size}px ${MONO}`;
      }
      ctx.fillText(node.label.toUpperCase(), cx, nodeY + 89);
    };

    for (let i = 0; i < PIPELINE_NODES.length - 1; i++) {
      const x0 = nodeX.get(PIPELINE_NODES[i].id) + nodeW / 2 + 4;
      const x1 = nodeX.get(PIPELINE_NODES[i + 1].id) - nodeW / 2 - 4;
      arrow(x0, nodeY, x1, nodeY);
    }
    PIPELINE_NODES.forEach(drawNode);

    const compare = PIPELINE_BRANCHES.find(({ id }) => id === "compare");
    if (compare?.from === "fusion" && compare.kind === "evidence") {
      const fusionX = nodeX.get(compare.from);
      arrow(fusionX, nodeY + nodeH / 2 + 4, fusionX, 496, { color: "#86d7ea" });
      evidenceCards(fusionX, 548);
      ctx.fillStyle = "#86d7ea";
      ctx.font = `500 18px ${MONO}`;
      ctx.fillText("METHOD COMPARISON", fusionX, 620);
      stationTag(ctx, "compare", fusionX, 650);
    }

    const future = PIPELINE_BRANCHES.find(({ id }) => id === "future");
    if (future?.from === "weigh" && future.kind === "future") {
      const weighX = nodeX.get(future.from);
      arrow(weighX, nodeY + nodeH / 2 + 4, weighX, 496, { dashed: true });
      futureGate(weighX, 548);
      ctx.fillStyle = "#e39b2d";
      ctx.font = `500 18px ${MONO}`;
      ctx.fillText("WALK-THROUGH RGB GATE", weighX, 620);
      stationTag(ctx, "future", weighX, 650);
    }
  }, {});
  /* Moved out along the gate as the board grew: the arch's left post stands a
     unit closer to the camera, so a board that merely clears it in x still gets
     its last cell (07 WEIGH) painted over from this angle. */
  const BOARD = { x: -9.7, y: 2.6, z: -1.25, ry: 0.34 };
  board.position.set(BOARD.x, BOARD.y, BOARD.z);
  board.rotation.y = BOARD.ry;
  board.name = "gateMethodBoard";   // QA measures its screen rect by name
  g.add(board);
  /* board posts, following the board's yaw */
  for (const dx of [-4.8, 4.8]) {
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.1, 4.9, 8),
      new THREE.MeshStandardMaterial({ color: 0x2a323c, roughness: 0.7 })
    );
    post.position.set(
      BOARD.x + Math.cos(BOARD.ry) * dx, 2.45, BOARD.z - Math.sin(BOARD.ry) * dx);
    g.add(post);
  }

  /* fill the thumb slots from the immediate low-resolution gate cache */
  const boardCtx = board.userData.canvas.getContext("2d");
  for (const r of thumbRects) {
    gateThumbTex(GATE_THUMB_FILES[r.kind][r.i], (tex) => {
      try {
        boardCtx.drawImage(tex.image, r.x, r.y, r.w, r.h);
        board.userData.tex.needsUpdate = true;
      } catch { /* thumb is decorative — ignore draw failures */ }
    });
  }

  scene.add(g);
  stationSpot(scene, s, 46);
  /* second pool over the flow board */
  stationSpot(scene, s, 44, new THREE.Vector3(
    Math.sin(g.rotation.y) * BOARD.z + Math.cos(g.rotation.y) * BOARD.x,
    0,
    Math.cos(g.rotation.y) * BOARD.z - Math.sin(g.rotation.y) * BOARD.x));
  return {};
}

function buildCapture(scene, s) {
  const g = new THREE.Group();
  faceCam(g, s);

  /* Camera gantry over the pen (the pen fence + cow live in environment).
     Two masts and a cross-beam carry all three views — the same silhouette
     station 08 uses for the future weigh gate, so the research rig and the
     deployed rig visibly rhyme. It also retires a small fib: CAM T used to
     stand on a side pole at animal height while claiming to be the top view;
     it now hangs off the beam centre looking straight down, which is what
     produced rgb_top.png in the first place.

     One material each instead of one per rig: the old loop built nine. */
  const steel = new THREE.MeshStandardMaterial({ color: 0x2a323c, roughness: 0.7, metalness: 0.2 });
  const shell = new THREE.MeshStandardMaterial({ color: 0x161b21, roughness: 0.5 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: AMBER, emissiveIntensity: 1.4 });
  /* The beam clears the photo boards behind the pen (their tops reach ~2.85)
     and the rig sits a little forward of centre so CAM T hangs over the animal
     rather than over the boards — from the station camera the two would
     otherwise stack into one busy horizontal band. */
  const MAST_X = 3.5, BEAM_Y = 4.15, RIG_Z = 0.25;
  for (const side of [-1, 1]) {
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, BEAM_Y, 10), steel);
    mast.position.set(side * MAST_X, BEAM_Y / 2, RIG_Z);
    g.add(mast);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(MAST_X * 2 + 0.26, 0.18, 0.22), steel);
  beam.position.set(0, BEAM_Y, RIG_Z);
  g.add(beam);

  /* [label, x, y, overhead?] — L/R ride the masts at animal height so the side
     views stay side views; only T looks down. */
  const CAMS = [
    ["CAM L", -MAST_X + 0.28, 2.15, false],
    ["CAM R", MAST_X - 0.28, 2.15, false],
    ["CAM T", 0, BEAM_Y - 0.32, true]
  ];
  const eyes = [];
  const camPos = {};   // "CAM L" → where that lens sits, in g-local space
  for (const [label, x, y, overhead] of CAMS) {
    const head = new THREE.Group();
    head.position.set(x, y, RIG_Z);
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.34), shell);
    const eye = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.16, 12), glass);
    if (overhead) {
      eye.position.y = -0.2;              // cylinder axis is already vertical
    } else {
      eye.rotation.x = Math.PI / 2;
      eye.position.z = 0.24;
      head.rotation.y = Math.atan2(-x, 0.7);   // across the pen at the animal
      head.rotation.x = -0.16;
    }
    head.add(body, eye);
    eyes.push(eye);
    camPos[label] = new THREE.Vector3(x, y, RIG_Z);
    /* tag stays OUT of the head group: aimed cameras would swing their label
       away from the viewer */
    const tag = boardLabel(label, 0.9);
    tag.position.set(x, y + (overhead ? 0.4 : 0.44), RIG_Z);
    g.add(head, tag);
  }

  /* tilted photo boards behind the pen */
  const shots = [["rgb_left.png", "CAM L · RGB", -3.1], ["rgb_top.png", "CAM T · RGB", 0], ["rgb_right.png", "CAM R · RGB", 3.1]];
  const prints = [];
  let printTexturesReady = 0;
  let printTexturesFailed = false;
  shots.forEach(([file, label, x], i) => {
    const b = photoBoard(displayViewUrl(VIEWS + file), 2.6, 1.7,
      () => {
        printTexturesReady++;
        if (printTexturesReady === shots.length) printTexturesFailed = false;
      }, () => { printTexturesFailed = true; });
    b.position.set(x, 2.0, -5.6);
    b.rotation.x = -0.08;
    b.rotation.y = -x * 0.05;
    const tag = boardLabel(label);
    tag.position.set(x, 0.95, -5.5);
    g.add(b, tag);
    /* Each print remembers the lens that took it, so a capture can throw it
       from that lens to this shelf instead of it simply already being there. */
    prints.push({
      mesh: b,
      home: b.position.clone(),
      from: camPos[label.slice(0, 5)] || b.position.clone(),
      delay: i * 0.09,
      flying: false
    });
  });

  scene.add(g);
  stationSpot(scene, s, 44);

  /* ---- shutter burst when an animal walks under the rig ---- */
  const local = new THREE.Vector3();
  const flash = createCameraFlash({
    lensMaterial: glass,
    lenses: eyes,
    glow: 1.35,
    /* the gantry footprint, tested in station-local space so the group's
       faceCam yaw never has to be reasoned about */
    contains: (subject) => {
      g.updateMatrixWorld();
      local.copy(subject);
      g.worldToLocal(local);
      return Math.abs(local.x) < MAST_X && Math.abs(local.z - RIG_Z) < 1.4;
    }
  });

  /* Prints are thrown from the lens that took them. They REST at home rather
     than waiting to be earned: a rail visitor never enters roam, and an empty
     shelf at the station whose whole point is "three RGB frames" would be a
     worse lie than a shelf that was already stocked. A capture re-issues them. */
  const FLY_S = 0.8;
  function tickPrints(age) {
    for (const p of prints) {
      const k = (age - p.delay) / FLY_S;
      if (k < 0) {
        /* Once a new shutter burst begins, a later view must wait at its lens
           instead of remaining as an already-collectible print on the rack. */
        if (Number.isFinite(age)) p.mesh.visible = false;
        p.flying = false;
        continue;
      }
      if (k >= 1) {
        p.mesh.visible = true;
        if (p.flying) {
          p.mesh.position.copy(p.home);
          p.mesh.scale.setScalar(1);
          p.flying = false;
        }
        continue;
      }
      p.mesh.visible = true;
      p.flying = true;
      const e = k * k * (3 - 2 * k);
      p.mesh.position.lerpVectors(p.from, p.home, e);
      p.mesh.position.y += Math.sin(k * Math.PI) * 0.5;   // a little toss
      p.mesh.scale.setScalar(0.12 + 0.88 * e);
    }
  }

  let lastCaptureT = 0;
  let processRunId = null;
  function tickCameras(t, subject) {
    lastCaptureT = t;
    flash.tick(t, subject);
    tickPrints(t - flash.startedAt);
  }

  return {
    tickCameras,
    beginProcess({ runId, t }) {
      processRunId = runId;
      lastCaptureT = t;
      flash.fire(t);
      tickPrints(0);
    },
    pipelineTargets: { input: prints[1].mesh, output: prints[1].mesh },
    get processState() {
      const startedAt = flash.startedAt;
      const age = Number.isFinite(startedAt) ? lastCaptureT - startedAt : -Infinity;
      const outputReady = !printTexturesFailed && printTexturesReady === prints.length && age >= 0.98;
      return {
        runId: processRunId,
        ready: true, completed: outputReady, outputReady,
        loadState: printTexturesFailed ? "unavailable"
          : printTexturesReady === prints.length ? "ready" : "loading",
        progress: Number.isFinite(age) ? THREE.MathUtils.clamp(age / 0.98, 0, 1) : 0,
        outputVisible: outputReady && prints.every((p) => !p.flying)
      };
    },
    /* QA: is the rig lit right now, and are the prints mid-flight */
    get flashState() {
      return { ...flash.state, printsFlying: prints.filter((p) => p.flying).length };
    }
  };
}

function buildSegment(scene, s, reducedMotion = false) {
  const g = new THREE.Group();
  faceCam(g, s);
  const fades = [];
  /* A compact SAM 3 mask scanner frames the existing evidence boards. The
     board cross-fade is still the scientific before/after; the rail, moving
     scan curtain and rollers give the transformation a visible machine verb. */
  const machineSteel = new THREE.MeshStandardMaterial({
    color: 0x25303a, metalness: 0.38, roughness: 0.58
  });
  const machineGlow = new THREE.MeshStandardMaterial({
    color: 0x244b57, emissive: ICE, emissiveIntensity: 0.7, roughness: 0.42
  });
  for (const x of [-4.35, 4.35]) {
    const mast = new THREE.Mesh(new THREE.BoxGeometry(0.14, 3.45, 0.18), machineSteel);
    mast.position.set(x, 2.15, -0.34);
    g.add(mast);
  }
  const rail = new THREE.Mesh(new THREE.BoxGeometry(8.84, 0.16, 0.2), machineSteel);
  rail.position.set(0, 3.84, -0.34);
  const scanCurtain = new THREE.Mesh(
    new THREE.PlaneGeometry(0.34, 2.3),
    new THREE.MeshBasicMaterial({
      color: ICE, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide
    })
  );
  scanCurtain.position.set(-4.0, 2.2, -0.34);
  const rollers = [];
  for (const x of [-4.15, 4.15]) {
    const roller = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.23, 0.28, 16), machineGlow);
    roller.rotation.z = Math.PI / 2;
    roller.position.set(x, 3.82, -0.34);
    rollers.push(roller);
    g.add(roller);
  }
  const machineTag = boardLabel("SAM 3 MASK SCANNER · RGB IN → MASKED CATTLE RGB OUT", 5.4);
  machineTag.position.set(0, 4.38, -0.3);
  g.add(rail, scanCurtain, machineTag);
  const cols = [["left", -2.9], ["top", 0], ["right", 2.9]];
  const inputs = [], outputs = [], outputSeals = [];
  let texturePairsReady = 0;
  let texturePairsFailed = false;
  cols.forEach(([view, x], i) => {
    const rgb = photoBoard(displayViewUrl(`${VIEWS}rgb_${view}.png`));
    rgb.position.set(x, 2.0, -0.5);
    inputs.push(rgb);
    /* The SAM output is the real RGB cattle through the mask, not the binary
       mask itself. A dim plane suppresses the old background while alphaMap
       reveals the color-preserving cattle cutout above it. */
    const dimMat = new THREE.MeshBasicMaterial({
      color: 0x05080b, transparent: true, opacity: 0, depthWrite: false
    });
    const dim = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.7), dimMat);
    dim.position.set(x, 2.0, -0.44);
    const cutoutMat = new THREE.MeshBasicMaterial({
      color: 0x151b22, transparent: true, opacity: 0, alphaTest: 0.035,
      depthWrite: false, side: THREE.DoubleSide
    });
    const cutout = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.7), cutoutMat);
    cutout.position.set(x, 2.0, -0.42);
    cutout.renderOrder = 2;
    outputs.push(cutout);
    /* A line loop adds one cheap draw per output and stays dormant except for
       the real completion edge. It confirms the sealed RGB cutout without
       covering or recolouring the evidence image. */
    const seal = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-1.34, -0.89, 0),
        new THREE.Vector3(1.34, -0.89, 0),
        new THREE.Vector3(1.34, 0.89, 0),
        new THREE.Vector3(-1.34, 0.89, 0)
      ]),
      new THREE.LineBasicMaterial({
        color: ICE, transparent: true, opacity: 0, depthTest: false,
        depthWrite: false, toneMapped: false
      })
    );
    seal.position.set(x, 2.0, -0.38);
    seal.renderOrder = 4;
    seal.visible = false;
    outputSeals.push(seal);
    const maskFile = view === "top" ? "mask_top_aligned.png" : `mask_${view}.png`;
    let rgbReady = false, maskReady = false, counted = false;
    const countPair = () => {
      if (!counted && rgbReady && maskReady) {
        counted = true;
        texturePairsReady++;
        if (texturePairsReady === cols.length) texturePairsFailed = false;
      }
    };
    sharedTex(displayViewUrl(`${VIEWS}rgb_${view}.png`), (tex) => {
      cutoutMat.map = tex;
      cutoutMat.color.setHex(0xffffff);
      rgbReady = true;
      cutoutMat.needsUpdate = true;
      countPair();
    }, () => { texturePairsFailed = true; });
    sharedTex(displayViewUrl(VIEWS + maskFile), (tex) => {
      cutoutMat.alphaMap = tex;
      maskReady = true;
      cutoutMat.needsUpdate = true;
      countPair();
    }, () => { texturePairsFailed = true; });
    const tag = boardLabel(`CAM ${view[0].toUpperCase()} · MASKED CATTLE RGB`);
    tag.position.set(x, 0.95, -0.4);
    g.add(rgb, dim, cutout, seal, tag);
    fades.push({ cutoutMat, dimMat, index: i });
  });
  scene.add(g);
  stationSpot(scene, s, 40);
  const PROCESS_S = 1.45;
  let activeSince = null, lastProcessT = 0, processProgress = 0;
  let processRunId = null;
  let outputWasReady = false, sealStartedAt = null;
  const outputReady = () => !texturePairsFailed && activeSince !== null &&
    processProgress >= 1 && texturePairsReady === cols.length;
  function resetProcess(t, runId = null) {
    processRunId = runId;
    activeSince = t;
    lastProcessT = t;
    processProgress = 0;
    outputWasReady = false;
    sealStartedAt = null;
    for (const f of fades) {
      f.cutoutMat.opacity = 0;
      f.dimMat.opacity = 0;
    }
    for (const seal of outputSeals) {
      seal.visible = false;
      seal.material.opacity = 0;
      seal.scale.setScalar(1);
    }
  }
  return {
    pipelineTargets: { input: inputs[1], output: outputs[1] },
    onActive(t) {
      if (processRunId === null) resetProcess(t);
    },
    beginProcess({ runId, t }) { resetProcess(t, runId); },
    update(t) {
      lastProcessT = t;
      const age = activeSince === null ? 0 : Math.max(0, t - activeSince);
      processProgress = THREE.MathUtils.clamp(age / PROCESS_S, 0, 1);
      for (const f of fades) {
        const start = f.index * 0.12;
        const q = THREE.MathUtils.smoothstep(processProgress, start, Math.min(1, start + 0.7));
        f.cutoutMat.opacity = q;
        f.dimMat.opacity = q * 0.68;
      }
      scanCurtain.position.x = THREE.MathUtils.lerp(-4.0, 4.0, processProgress);
      const settle = THREE.MathUtils.smoothstep(Math.max(0, age - PROCESS_S), 0, 0.38);
      const activeCurtain = 0.18 + 0.22 * Math.sin(t * 4.4) ** 2;
      scanCurtain.material.opacity = THREE.MathUtils.lerp(activeCurtain, 0.035, settle);
      const rollerGlow = 0.45 + 0.55 * Math.sin(t * 3.1) ** 2;
      const rollerSpinT = processProgress < 1 ? t : (activeSince ?? t) + PROCESS_S;
      rollers.forEach((r, i) => {
        r.rotation.x = rollerSpinT * (i ? -2.4 : 2.4);
        r.material.emissiveIntensity = THREE.MathUtils.lerp(rollerGlow, 0.2, settle);
      });
      const readyNow = outputReady();
      if (readyNow && !outputWasReady) sealStartedAt = t;
      outputWasReady = readyNow;
      outputSeals.forEach((seal, i) => {
        const local = sealStartedAt === null ? -1 : t - sealStartedAt - i * 0.055;
        const duration = reducedMotion ? 0.24 : 0.5;
        const enter = THREE.MathUtils.smoothstep(local, 0, Math.min(0.12, duration * 0.45));
        const leave = 1 - THREE.MathUtils.smoothstep(local, duration * 0.45, duration);
        const strength = THREE.MathUtils.clamp(enter * leave, 0, 1);
        seal.visible = strength > 0.002;
        seal.material.opacity = 0.92 * strength;
        seal.scale.setScalar(reducedMotion ? 1 : 0.96 + 0.08 * Math.sin(Math.PI *
          THREE.MathUtils.clamp(local / duration, 0, 1)));
      });
    },
    get processState() {
      const isOutputReady = outputReady();
      return {
        runId: processRunId,
        ready: true, completed: isOutputReady, outputReady: isOutputReady,
        loadState: texturePairsFailed ? "unavailable"
          : texturePairsReady === cols.length ? "ready" : "loading",
        progress: processProgress,
        outputVisible: isOutputReady && fades.every((f) => f.cutoutMat.opacity >= 0.999),
        texturePairsReady,
        age: activeSince === null ? 0 : Math.max(0, lastProcessT - activeSince)
      };
    }
  };
}

function buildReconstruct(scene, s, payload, reconSteps, stage2Density = null,
  stage2Blending = "normal", reducedMotion = false) {
  const g = new THREE.Group();
  faceCam(g, s);
  const p1 = plinth(2.25, 0.72, 1.55);
  p1.position.x = -1.7;
  const p2 = plinth(2.25, 0.72, 1.55, true);
  p2.position.x = 1.7;
  /* Two workcell hoops make the true traces read as active SAM3D machinery,
     not free-floating visualisations. They never replace or fake the trace. */
  const chamberMat = new THREE.MeshStandardMaterial({
    color: 0x1f3941, emissive: ICE, emissiveIntensity: 0.5,
    transparent: true, opacity: 0.78, roughness: 0.4
  });
  const chamberRings = [-1.7, 1.7].map((x, i) => {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1.05, 0.045, 8, 56), chamberMat.clone()
    );
    ring.position.set(x, 1.75, 0);
    ring.rotation.y = Math.PI / 2;
    ring.rotation.x = i ? 0.5 : -0.5;
    g.add(ring);
    return ring;
  });
  const completion = completionLock(chamberRings[1], reducedMotion);
  const tag = boardLabel("SINGLE-VIEW SAM-3D · TRUE DIFFUSION TRAJECTORY", 5.2);
  tag.position.set(0, 4.1, 0);
  const groundProgress = reconstructionGroundProgress("SINGLE-VIEW RECONSTRUCTION · 75 STEPS");

  /* ---- exported reconstruction process, looping once installed ----
     assets/recon/ carries the true per-step Stage-1 voxels and Stage-2
     Gaussian centers. Before that payload is verified, both mounts stay empty. */
  const readout = canvasPlane(4.6, 0.32, 1150, 80, () => {});
  readout.position.set(0, 3.5, 0);
  const roCtx = readout.userData.canvas.getContext("2d");
  let player = null;
  const drawPlayerStep = ({ stage, step, steps }) => {
    const W = 1150, H = 80;
    roCtx.fillStyle = "#0c0f13";
    roCtx.fillRect(0, 0, W, H);
    roCtx.textBaseline = "middle";
    roCtx.font = `500 30px ${MONO}`;
    roCtx.textAlign = "left";
    if (!player?.isReal) {
      const state = player?.loadState || "idle";
      const status = state === "loading"
        ? "LOADING EXPORTED SINGLE-VIEW TRACE"
        : state === "unavailable"
          ? "REAL TRACE UNAVAILABLE · REVISIT TO RETRY"
          : "EXPORTED TRACE LOADS ON ARRIVAL";
      roCtx.fillStyle = state === "unavailable" ? "#e4574b" : "#e39b2d";
      roCtx.fillText(status, 24, H / 2 + 1);
      roCtx.fillStyle = "#5c6873";
      roCtx.textAlign = "right";
      roCtx.fillText("NO SYNTHETIC SUBSTITUTE", W - 24, H / 2 + 1);
      readout.userData.tex.needsUpdate = true;
      return;
    }
    roCtx.fillStyle = stage === 1 ? "#e39b2d" : "#86d7ea";
    const name = stage === 1
      ? "STAGE-1 · SPARSE STRUCTURE"
      : "S1 FROZEN · STAGE-2 · LATENT REFINEMENT";
    roCtx.fillText(`${name} · STEP ${String(step + 1).padStart(2, "0")}/${steps}`, 24, H / 2 + 1);
    roCtx.fillStyle = "#5c6873";
    roCtx.textAlign = "right";
    roCtx.fillText(
      `REAL TRACE · DRAW ${player.stage2Keep}/${player.stage2PerVoxel} GAUSSIANS/VOXEL`,
      W - 24, H / 2 + 1);
    readout.userData.tex.needsUpdate = true;
  };
  player = createDeferredReconPlayer({
    stepsPayload: reconSteps,
    realOnly: true,
    stageSteps: [50, 25],
    period: 6.5,
    s1Frac: 0.42,
    s2Frac: 0.34,
    dissolveFrac: 0.08,
    noiseRadius: 0.8,   // keep the noise shell clear of the readout board
    pointSize: 0.50,
    stage2PointSize: SINGLE_STAGE2_POINT_SIZE,
    stage1Opacity: 0.54,
    stage2Opacity: 1.0,   // soft-disc falloff halves integrated alpha; restore weight
    stage2Density,
    stage2Blending,
    onStep: drawPlayerStep
  });
  /* The empty real-only constructor calls onStep before facade assignment. */
  drawPlayerStep(player.state);
  /* Each stage owns its own transform and spin pivot. Stage 2 therefore
     refines beside the frozen Stage-1 result instead of replacing it or
     orbiting around a shared center. */
  player.group.remove(player.stage1Root, player.stage2Root);
  const mountStage = (root, x, scale) => {
    const cloud = new THREE.Group();
    cloud.add(root);
    /* Single-view exports store body length on raw X; multi-view/agreement
       store it on raw Y. Using the multi-view rotation here turned the animal
       into screen depth and made the carried result look backwards. */
    cloud.rotation.set(-Math.PI / 2, 0, Math.PI);
    const inner = new THREE.Group();
    inner.add(cloud);
    inner.scale.setScalar(scale);
    const spin = new THREE.Group();
    spin.position.set(x, 1.75, 0);
    spin.add(inner);
    g.add(spin);
    return spin;
  };
  const spin1 = mountStage(player.stage1Root, -1.7, RECON_MOUNT_SINGLE);
  const spin2 = mountStage(player.stage2Root, 1.7, RECON_MOUNT_SINGLE);
  const s1Label = boardLabel("STAGE 1 · SPARSE VOXELS", 2.35);
  s1Label.position.set(-1.7, 0.78, 0.9);
  s1Label.rotation.x = -0.35;
  const s2Label = boardLabel("STAGE 2 · MODEL RGB GAUSSIAN CENTERS", 2.7);
  s2Label.position.set(1.7, 0.78, 0.9);
  s2Label.rotation.x = -0.35;

  /* the exact tracked RGB frame used for this reconstruction trace */
  const sourceImage = reconSteps?.source?.image || `${VIEWS}rgb_left.png`;
  const inputBoard = maskedPhotoBoard(sourceImage, `${VIEWS}mask_left.png`, 1.9, 1.25);
  inputBoard.position.set(-4.5, 2.15, 0.75);
  inputBoard.rotation.y = 0.22;
  const inputLabel = boardLabel("INPUT · ONE MASKED LEFT RGB VIEW", 2.5);
  inputLabel.position.set(-4.5, 1.38, 0.8);
  inputLabel.rotation.y = 0.22;
  const inputRay = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-3.56, 2.0, 0.55),
      new THREE.Vector3(-2.6, 1.82, 0.1)
    ]),
    new THREE.LineBasicMaterial({ color: AMBER, transparent: true, opacity: 0.72 })
  );

  const proposalAnchors = {};
  const proposalShimmers = {};
  /* DISABLED (2026-07-11, user request): the mask boards and per-view 3D
     proposals crowded the exhibit — station 3 now shows only the two-stage
     reconstruction process. Masks already live at station 2, and the
     single-view story is told by the side panel. Re-enable by uncommenting.
  const views = [
    { label: "LEFT MASK", file: "mask_left.png", color: AMBER },
    { label: "RIGHT MASK", file: "mask_right.png", color: ICE },
    { label: "TOP MASK", file: "mask_top_aligned.png", color: 0xe8e4da }
  ];
  views.forEach((v, i) => {
    const x = -4.15 + i * 1.28;
    const board = photoBoard(VIEWS + v.file, 1.15, 0.82);
    board.position.set(x, 2.05, 1.1);
    board.rotation.y = 0.12;
    const lab = boardLabel(v.label, 1.15);
    lab.position.set(x, 1.48, 1.13);
    lab.rotation.y = 0.12;
    const ray = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(x + 0.36, 1.9, 0.66),
        new THREE.Vector3(-0.18 + i * 0.18, 1.78, 0.05)
      ]),
      new THREE.LineBasicMaterial({ color: v.color, transparent: true, opacity: 0.82 })
    );
    ray.renderOrder = 2;

    const px = -1.7 + i * 1.7;
    const base = plinth(1.25, 0.34, 0.86, i === 0);
    base.position.set(px, 0, 1.35);
    const propAnchor = new THREE.Group();
    propAnchor.position.set(px, 0.42, 1.35);
    const propShimmer = shimmerBlock(`VIEW ${i + 1}`);
    propShimmer.scale.setScalar(0.55);
    propShimmer.position.copy(propAnchor.position);
    const propLabel = boardLabel(`${v.label.replace(" MASK", "")} 3D PROPOSAL`, 1.38);
    propLabel.position.set(px, 0.88, 2.0);
    propLabel.rotation.x = -0.42;

    proposalAnchors[`proposal${i}`] = propAnchor;
    proposalShimmers[`proposal${i}`] = propShimmer;
    g.add(board, lab, ray, base, propAnchor, propShimmer, propLabel);
  });

  END DISABLED */

  /* two-stage explainer where the note board used to sit */
  const note = canvasPlane(3.8, 0.86, 820, 184, (ctx, W, H) => {
    ctx.fillStyle = "#0c0f13";
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "#2a323c";
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, W - 4, H - 4);
    ctx.textAlign = "center";
    ctx.fillStyle = "#e39b2d";
    ctx.font = `500 28px ${MONO}`;
    ctx.fillText("STAGE 1 · 50 STEPS → SPARSE VOXEL STRUCTURE", W / 2, 56);
    ctx.fillStyle = "#86d7ea";
    ctx.font = `500 28px ${MONO}`;
    ctx.fillText("STAGE 2 · 25 STEPS → MODEL-PREDICTED COLOR", W / 2, 122);
  });
  note.position.set(4.45, 2.05, 0.75);
  note.rotation.y = -0.22;

  g.add(p1, p2, readout, tag, note, inputBoard, inputLabel, inputRay,
    s1Label, s2Label, groundProgress.mesh);
  scene.add(g);
  stationSpot(scene, s, 90);
  let processRunId = null;
  let activeSince = null;
  function restartProcess(t, runId = processRunId) {
    processRunId = runId;
    activeSince = t;
    player.resetClock();
    player.update(0);
    completion.reset();
    groundProgress.setPlayback(player.phases);
    groundProgress.update(player.state, false);
  }
  return {
    anchors: proposalAnchors,
    shimmers: proposalShimmers,
    pipelineTargets: { input: inputBoard, output: spin2 },
    player,
    get reconState() {
      return {
        ...player.state,
        runId: processRunId,
        real: player.isReal,
        loadState: player.loadState,
        ready: player.ready,
        completed: player.completed,
        version: player.version,
        stage1Count: player.stage1Points.geometry.drawRange.count,
        stage2Count: player.stage2Points.visible
          ? player.stage2Points.geometry.drawRange.count : 0,
        stage1Visible: player.stage1Points.visible,
        stage2Visible: player.stage2Points.visible,
        stage2RealColor: player.stage2Points.material.uniforms.uHasRealColor.value === 1,
        pointSizes: [
          player.stage1Points.material.uniforms.uSize.value,
          player.stage2Points.material.uniforms.uSize.value
        ],
        opacities: [
          player.stage1Points.material.uniforms.uOpacity.value,
          player.stage2Points.material.uniforms.uOpacity.value
        ],
        groundProgress: groundProgress.state
      };
    },
    onActive(t) {
      if (processRunId === null) restartProcess(t, null);
    },
    beginProcess({ runId, t }) { restartProcess(t, runId); },
    markTraceLoading() {
      player.markLoading();
      drawPlayerStep(player.state);
    },
    installTrace(stepsPayload, t) {
      if (!player.install(stepsPayload)) return false;
      restartProcess(t, processRunId);
      drawPlayerStep(player.state);
      return true;
    },
    markTraceUnavailable() {
      player.markUnavailable();
      drawPlayerStep(player.state);
    },
    update(t, isActive) {
      if (!isActive) return;
      const local = Math.max(0, t - (activeSince ?? t));
      player.update(local);
      groundProgress.setPlayback(player.phases);
      groundProgress.update(player.state, player.completed);
      spin1.rotation.y = local * 0.16;
      spin2.rotation.y = local * 0.16;
      chamberRings[0].rotation.z = local * 0.9;
      chamberRings[1].rotation.z = -local * 1.15;
      chamberRings.forEach((ring, i) => {
        if (i === 0) {
          ring.material.emissiveIntensity = 0.38 + 0.72 * Math.sin(local * 3.4 + i) ** 2;
        }
      });
      /* The real trace owns this boundary; a loading/failed zero-point facade
         must never produce a completion accent. The player's completion latch
         prevents its later display loop from retriggering the lock. */
      completion.update(t, player.isReal && player.completed,
        0.38 + 0.72 * Math.sin(local * 3.4 + 1) ** 2);
    }
  };
}

function buildFusion(scene, s, payload, multiviewReconSteps, stage2Density = null,
  stage2Blending = "normal", reducedMotion = false) {
  const g = new THREE.Group();
  faceCam(g, s);
  const groundProgress = reconstructionGroundProgress("MULTI-VIEW RECONSTRUCTION · 75 STEPS");
  /* The fusion dais is 3.5u in radius; park the strip just beyond its rim so
     the cylinder cannot occlude a floor plane only 4.5cm above grade. */
  groundProgress.mesh.position.z = 4.15;
  const mainTag = boardLabel("AGREEMENT-DRIVEN MULTI-VIEW SAM3D RECONSTRUCTION", 6.3);
  mainTag.position.set(0, 5.42, 0);
  g.add(groundProgress.mesh, mainTag);

  /* Step 04 receives the reunited masked triptych from Step 03, never its
     single-view 3D result. Keep the physical input slots beside the machine so
     the thrown cards have an unambiguous destination. */
  const mvInputs = [
    ["rgb_left.png", "mask_left.png", "LEFT", 3.45],
    ["rgb_top.png", "mask_top_aligned.png", "TOP", 4.65],
    ["rgb_right.png", "mask_right.png", "RIGHT", 5.85]
  ].map(([rgb, mask, label, x]) => {
    const board = maskedPhotoBoard(`${VIEWS}${rgb}`, `${VIEWS}${mask}`, 1.02, 0.68);
    board.position.set(x, 1.55, 0.85);
    board.rotation.y = -0.18;
    const caption = boardLabel(`${label} · MASKED RGB`, 1.16);
    caption.position.set(x, 1.05, 0.9);
    caption.rotation.y = -0.18;
    g.add(board, caption);
    return board;
  });
  const inputTag = boardLabel("INPUT · 3 MASKED RGB VIEWS", 3.35);
  inputTag.position.set(4.65, 2.25, 0.82);
  inputTag.rotation.y = -0.18;
  g.add(inputTag);

  const dais = new THREE.Mesh(
    new THREE.CylinderGeometry(3.1, 3.5, 0.5, 28),
    new THREE.MeshStandardMaterial({ color: 0x11151a, roughness: 0.85 })
  );
  dais.position.y = 0.25;
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(3.15, 0.045, 8, 60),
    new THREE.MeshStandardMaterial({ color: 0x1a1408, emissive: AMBER, emissiveIntensity: 1.0 })
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.52;
  g.add(dais, ring);
  const completion = completionLock(ring, reducedMotion);

  /* the 5941-pt agreement cloud, recolored per step through a GPU LUT */
  const { meta, positions, scalars } = payload;
  const N = meta.count, STEPS = meta.steps;
  const current = new Uint8Array(N);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const scalarAttr = new THREE.BufferAttribute(current, 1, true);
  scalarAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("aScalar", scalarAttr);

  const lut = buildNightbarnLUT();
  /* two layers over one geometry: a dense normal-blended core so the body
     reads solid, plus a soft additive halo kept faint so the amber center
     cannot blow out to white. */
  const cloudMat = (size, alpha, blending, tint = 1.0) => new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending, fog: false,
    uniforms: {
      uSize: { value: size },
      uAlpha: { value: alpha },
      uTint: { value: tint },
      uDom: { value: new THREE.Vector2(0.3, 1.0) },
      uLUT: { value: lut }
    },
    vertexShader: /* glsl */ `
      attribute float aScalar;
      uniform float uSize;
      varying float vS;
      void main() {
        vS = aScalar;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = uSize * (60.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uLUT;
      uniform vec2 uDom;
      uniform float uAlpha;
      uniform float uTint;
      varying float vS;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float d = dot(c, c);
        if (d > 0.25) discard;
        float x = clamp((vS - uDom.x) / (uDom.y - uDom.x), 0.0, 1.0);
        vec3 col = texture2D(uLUT, vec2(x, 0.5)).rgb * uTint;
        gl_FragColor = vec4(col, uAlpha * (1.0 - d * 3.2));
      }
    `
  });

  const core = new THREE.Points(geo, cloudMat(1.1, 0.5, THREE.NormalBlending, 0.68));
  const halo = new THREE.Points(geo, cloudMat(1.5, 0.015, THREE.AdditiveBlending, 0.9));
  halo.renderOrder = 2;
  const cloud = new THREE.Group();
  cloud.add(core, halo);
  /* long axis stored along Y (see agreement.js) — lay it down, legs down */
  cloud.rotation.set(-Math.PI / 2, 0, -Math.PI / 2);
  const inner = new THREE.Group();
  inner.add(cloud);
  const bb = new THREE.Box3().setFromObject(inner);
  const size = bb.getSize(new THREE.Vector3());
  inner.scale.setScalar(3.6 / Math.max(size.x, size.z, 1e-6));
  bb.setFromObject(inner);
  const c = bb.getCenter(new THREE.Vector3());
  inner.position.sub(c);              // center the cow on the spin pivot
  const spin = new THREE.Group();
  spin.position.set(0, 2.4, 0);
  spin.add(inner);
  g.add(spin);

  /* A second, independently recorded exhibit flanks the existing agreement
     evolution: real three-view SAM-3D Stage 1 on the left, Stage 2 on the
  right. The center Fusion cloud and its LUT animation remain unchanged. */
  const mvPlayer = createDeferredReconPlayer({
    stepsPayload: multiviewReconSteps,
    realOnly: true,
    stageSteps: [50, 25],
    period: 9.2,
    s1Frac: 0.43,
    s2Frac: 0.35,
    dissolveFrac: 0.07,
    pointSize: 0.44,
    stage2PointSize: MV_STAGE2_POINT_SIZE,
    stage1Opacity: 0.48,
    stage2Opacity: 0.95,  // soft-disc falloff compensation, matches station 03
    stage2Density,
    stage2Blending
  });
  mvPlayer.group.remove(mvPlayer.stage1Root, mvPlayer.stage2Root);
  const MV_X1 = -5.1, MV_X2 = -3.35;
  const mvMount = (root, x) => {
    const rawCloud = new THREE.Group();
    rawCloud.add(root);
    rawCloud.rotation.set(-Math.PI / 2, 0, -Math.PI / 2);
    const model = new THREE.Group();
    model.add(rawCloud);
    model.scale.setScalar(RECON_MOUNT_MULTIVIEW);
    const pivot = new THREE.Group();
    pivot.position.set(x, 1.62, 0.35);
    pivot.add(model);
    g.add(pivot);
    return pivot;
  };
  const mvSpin1 = mvMount(mvPlayer.stage1Root, MV_X1);
  const mvSpin2 = mvMount(mvPlayer.stage2Root, MV_X2);
  for (const [x, hot] of [[MV_X1, false], [MV_X2, true]]) {
    const base = plinth(1.5, 0.5, 1.12, hot);
    base.position.set(x, 0, 0.35);
    g.add(base);
  }
  const mvLabel1 = boardLabel("3-VIEW · STAGE 1", 1.9);
  mvLabel1.position.set(MV_X1, 0.65, 1.05);
  mvLabel1.rotation.x = -0.4;
  const mvLabel2 = boardLabel("3-VIEW · STAGE 2 · RGB", 1.9);
  mvLabel2.position.set(MV_X2, 0.65, 1.05);
  mvLabel2.rotation.x = -0.4;
  const mvTraceLabel = canvasPlane(5.8, 0.26, 1160, 52, () => {});
  mvTraceLabel.position.set(0, 3.82, 0.55);
  g.add(mvLabel1, mvLabel2, mvTraceLabel);
  const mvStatusCtx = mvTraceLabel.userData.canvas.getContext("2d");
  function drawMvTraceStatus() {
    const W = 1160, H = 52;
    const state = mvPlayer.loadState;
    const text = mvPlayer.isReal
      ? `REAL MULTI-VIEW RECONSTRUCTION TRACE · DRAW ${mvPlayer.stage2Keep}/${mvPlayer.stage2PerVoxel} · S1 → S2`
      : state === "loading"
        ? "LOADING EXPORTED MULTI-VIEW RECONSTRUCTION TRACE · EVIDENCE MOUNTS EMPTY"
        : state === "unavailable"
          ? "REAL MULTI-VIEW TRACE UNAVAILABLE · REVISIT TO RETRY"
          : "EXPORTED MULTI-VIEW TRACE LOADS ON ARRIVAL";
    mvStatusCtx.fillStyle = "#0c0f13";
    mvStatusCtx.fillRect(0, 0, W, H);
    mvStatusCtx.fillStyle = mvPlayer.isReal ? "#86d7ea" : "#e39b2d";
    let size = 26;
    mvStatusCtx.font = `500 ${size}px ${MONO}`;
    while (size > 12 && mvStatusCtx.measureText(text).width > W - 28) {
      mvStatusCtx.font = `500 ${--size}px ${MONO}`;
    }
    mvStatusCtx.textAlign = "center";
    mvStatusCtx.textBaseline = "middle";
    mvStatusCtx.fillText(text, W / 2, H / 2 + 1);
    mvTraceLabel.userData.tex.needsUpdate = true;
  }
  drawMvTraceStatus();

  /* step readout, redrawn on step change */
  const readout = canvasPlane(4.6, 0.35, 1152, 88, () => {});
  readout.position.set(0, 4.7, 0);
  g.add(readout);
  const roCtx = readout.userData.canvas.getContext("2d");
  function drawReadout(step) {
    const W = 1152, H = 88;
    roCtx.fillStyle = "#0c0f13";
    roCtx.fillRect(0, 0, W, H);
    roCtx.fillStyle = "#86d7ea";
    roCtx.font = `500 30px ${MONO}`;
    roCtx.textAlign = "left";
    roCtx.textBaseline = "middle";
    const label = meta.stepLabels[step] === "last" ? "FINAL" : String(step).padStart(2, "0");
    roCtx.fillText(`DIFFUSION STEP ${label}/50`, 26, H / 2);
    roCtx.fillStyle = "#e39b2d";
    roCtx.textAlign = "right";
    roCtx.fillText(`MEAN AGREEMENT ${meta.meanAgreement[step].toFixed(2)}`, W - 26, H / 2);
  }

  scene.add(g);
  stationSpot(scene, s, 30);

  let lastStep = -1;
  function setStep(step) {
    current.set(scalars.subarray(step * N, (step + 1) * N));
    scalarAttr.needsUpdate = true;
    drawReadout(step);
    readout.userData.tex.needsUpdate = true;
  }
  setStep(0);

  let processRunId = null;
  let activeSince = null;
  function restartProcess(t, runId = processRunId) {
    processRunId = runId;
    activeSince = t;
    lastStep = 0;
    setStep(0);
    mvPlayer.resetClock();
    mvPlayer.update(0);
    completion.reset();
    groundProgress.setPlayback(mvPlayer.phases);
    groundProgress.update(mvPlayer.state, false);
  }

  return {
    player: mvPlayer,
    pipelineTargets: { input: mvInputs[1], output: mvSpin2 },
    get reconState() {
      return {
        ...mvPlayer.state,
        runId: processRunId,
        real: mvPlayer.isReal,
        loadState: mvPlayer.loadState,
        ready: mvPlayer.ready,
        completed: mvPlayer.completed,
        version: mvPlayer.version,
        stage1Count: mvPlayer.stage1Points.geometry.drawRange.count,
        stage2Count: mvPlayer.stage2Points.visible
          ? mvPlayer.stage2Points.geometry.drawRange.count : 0,
        stage1Visible: mvPlayer.stage1Points.visible,
        stage2Visible: mvPlayer.stage2Points.visible,
        stage2RealColor: mvPlayer.stage2Points.material.uniforms.uHasRealColor.value === 1,
        pointSizes: [
          mvPlayer.stage1Points.material.uniforms.uSize.value,
          mvPlayer.stage2Points.material.uniforms.uSize.value
        ],
        opacities: [
          mvPlayer.stage1Points.material.uniforms.uOpacity.value,
          mvPlayer.stage2Points.material.uniforms.uOpacity.value
        ],
        groundProgress: groundProgress.state
      };
    },
    onActive(t) {
      if (processRunId === null) restartProcess(t, null);
    },
    beginProcess({ runId, t }) { restartProcess(t, runId); },
    markTraceLoading() {
      mvPlayer.markLoading();
      drawMvTraceStatus();
    },
    installTrace(stepsPayload, t) {
      if (!mvPlayer.install(stepsPayload)) return false;
      restartProcess(t, processRunId);
      drawMvTraceStatus();
      return true;
    },
    markTraceUnavailable() {
      mvPlayer.markUnavailable();
      drawMvTraceStatus();
    },
    update(t, isActive) {
      if (!isActive) return;
      const local = Math.max(0, t - (activeSince ?? t));
      const step = Math.floor(local * 8) % STEPS;
      if (step !== lastStep) {
        lastStep = step;
        setStep(step);
      }
      spin.rotation.y = local * 0.14;
      mvPlayer.update(local);
      groundProgress.setPlayback(mvPlayer.phases);
      groundProgress.update(mvPlayer.state, mvPlayer.completed);
      mvSpin1.rotation.y = local * 0.17;
      mvSpin2.rotation.y = local * 0.17;
      completion.update(t, mvPlayer.isReal && mvPlayer.completed, 0.52);
    }
  };
}

/* ---------- FEATURES station: Eq. 8 handcrafted features, computed live ----------
   All values are computed in the payload's normalized model space (unit "u")
   from the same 5941-pt positions the fusion station renders. Payload axes:
   x = width, y = body length, z = height; the display transform maps payload
   (x,y,z) → display (y,z,x), so payload y lies along ground X and payload z
   points up. Overlays are built in raw payload space inside the same rotated
   group as the cloud, so geometry and values always agree. */

/* eigen-decomposition of a symmetric 3×3 via cyclic Jacobi rotations */
function jacobiEigen3(cov) {
  const a = cov.map((r) => r.slice());
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 32; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-16) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-18) continue;
      const th = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]);
      const c = Math.cos(th), s = Math.sin(th);
      for (let k = 0; k < 3; k++) {           // A ← A·J
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq;
        a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {           // A ← Jᵀ·A
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk;
        a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {           // V ← V·J
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq;
        v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[j][j] - a[i][i]);
  return {
    vals: order.map((i) => a[i][i]),
    vecs: order.map((i) => new THREE.Vector3(v[0][i], v[1][i], v[2][i]).normalize())
  };
}

function computeFeatureValues(pos, N) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const mean = [0, 0, 0];
  for (let i = 0; i < N; i++) {
    for (let a = 0; a < 3; a++) {
      const w = pos[i * 3 + a];
      if (w < min[a]) min[a] = w;
      if (w > max[a]) max[a] = w;
      mean[a] += w;
    }
  }
  for (let a = 0; a < 3; a++) mean[a] /= N;
  const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < N; i++) {
    const dx = pos[i * 3] - mean[0], dy = pos[i * 3 + 1] - mean[1], dz = pos[i * 3 + 2] - mean[2];
    cov[0][0] += dx * dx; cov[0][1] += dx * dy; cov[0][2] += dx * dz;
    cov[1][1] += dy * dy; cov[1][2] += dy * dz; cov[2][2] += dz * dz;
  }
  for (let r = 0; r < 3; r++) for (let c = r; c < 3; c++) {
    cov[r][c] /= N;
    cov[c][r] = cov[r][c];
  }
  const std = [Math.sqrt(cov[0][0]), Math.sqrt(cov[1][1]), Math.sqrt(cov[2][2])];
  const eig = jacobiEigen3(cov);
  /* coordinate percentiles P = {10,25,50,75,90} per axis */
  const PCTS = [10, 25, 50, 75, 90];
  const pct = [[], [], []];
  const tmp = new Float32Array(N);
  for (let a = 0; a < 3; a++) {
    for (let i = 0; i < N; i++) tmp[i] = pos[i * 3 + a];
    tmp.sort();
    for (const p of PCTS) pct[a].push(tmp[Math.min(N - 1, Math.round((p / 100) * (N - 1)))]);
  }
  /* vertical-section densities: thirds along the body axis (payload y) */
  const y0 = min[1], span = Math.max(max[1] - min[1], 1e-9);
  const rho = [0, 0, 0];
  for (let i = 0; i < N; i++) {
    rho[Math.min(2, Math.floor(((pos[i * 3 + 1] - y0) / span) * 3))]++;
  }
  for (let k = 0; k < 3; k++) rho[k] /= N;
  const ext = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  return { min, max, ext, mean, std, cov, eig, PCTS, pct, rho, vBBox: ext[0] * ext[1] * ext[2] };
}

/* hull area (triangle areas) + volume (divergence theorem) from the
   ConvexGeometry triangle soup */
function hullMetrics(geo) {
  const p = geo.getAttribute("position");
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), bc = new THREE.Vector3();
  let volume = 0, area = 0;
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i);
    b.fromBufferAttribute(p, i + 1);
    c.fromBufferAttribute(p, i + 2);
    area += ab.subVectors(b, a).cross(ac.subVectors(c, a)).length() * 0.5;
    volume += a.dot(bc.crossVectors(b, c)) / 6;
  }
  return { volume: Math.abs(volume), area };
}

/* canvas-baked text tag as a Sprite (billboards for free, recorder-safe) */
function tagSprite(lines, h, opts = {}) {
  const px = 30, pad = 16, lh = px * 1.45;
  const c = document.createElement("canvas");
  let ctx = c.getContext("2d");
  ctx.font = `500 ${px}px ${MONO}`;
  const wpx = Math.max(...lines.map((l) => ctx.measureText(l.text || l).width)) + pad * 2;
  c.width = Math.ceil(wpx);
  c.height = Math.ceil(lh * lines.length + pad);
  ctx = c.getContext("2d");
  ctx.fillStyle = opts.bg || "rgba(12,15,19,0.82)";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.font = `500 ${px}px ${MONO}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  lines.forEach((l, i) => {
    ctx.fillStyle = l.color || opts.color || "#e8e4da";
    ctx.fillText(l.text || l, c.width / 2, pad / 2 + lh * (i + 0.5));
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sp.scale.set(h * c.width / c.height, h, 1);
  sp.renderOrder = 3;
  return sp;
}

function buildFeatures(scene, s, payload) {
  const g = new THREE.Group();
  faceCam(g, s);

  /* dais — calmer, ice-ringed cousin of the fusion dais */
  const dais = new THREE.Mesh(
    new THREE.CylinderGeometry(2.9, 3.3, 0.5, 28),
    new THREE.MeshStandardMaterial({ color: 0x11151a, roughness: 0.85 })
  );
  dais.position.y = 0.25;
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(2.95, 0.04, 8, 60),
    new THREE.MeshStandardMaterial({ color: 0x0d161a, emissive: ICE, emissiveIntensity: 0.7 })
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.52;
  g.add(dais, ring);

  const { meta, positions, scalars } = payload;
  const N = meta.count, STEPS = meta.steps;

  /* ---- feature values, live from the shared payload positions ---- */
  const F = computeFeatureValues(positions, N);
  const hullPts = [];
  const hullStep = Math.max(1, Math.ceil(N / 1200));
  for (let i = 0; i < N; i += hullStep) {
    hullPts.push(new THREE.Vector3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]));
  }
  const hullGeo = new ConvexGeometry(hullPts);
  const hm = hullMetrics(hullGeo);
  /* l = body length (payload y), w = payload x, h = payload z (display up) */
  const values = {
    l: F.ext[1], w: F.ext[0], h: F.ext[2],
    vBBox: F.vBBox, vHull: hm.volume, aSurface: hm.area,
    lambda: F.eig.vals.slice(),
    lambdaRatios: {
      l12: F.eig.vals[0] / F.eig.vals[1],
      l23: F.eig.vals[1] / F.eig.vals[2],
      l31: F.eig.vals[2] / F.eig.vals[0]
    },
    percentiles: { x: F.pct[0].slice(), y: F.pct[1].slice(), z: F.pct[2].slice() },
    rho: F.rho.slice(), mean: F.mean.slice(), std: F.std.slice()
  };

  /* ---- the cloud: static, final-step colors dimmed toward ice ---- */
  const finalScalars = new Uint8Array(scalars.subarray((STEPS - 1) * N, STEPS * N));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("aScalar", new THREE.BufferAttribute(finalScalars, 1, true));
  const lut = buildNightbarnLUT();
  const cloudMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.NormalBlending, fog: false,
    uniforms: {
      uSize: { value: 1.05 },
      uDom: { value: new THREE.Vector2(0.3, 1.0) },
      uLUT: { value: lut }
    },
    vertexShader: /* glsl */ `
      attribute float aScalar;
      uniform float uSize;
      varying float vS;
      void main() {
        vS = aScalar;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = uSize * (60.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uLUT;
      uniform vec2 uDom;
      varying float vS;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float d = dot(c, c);
        if (d > 0.25) discard;
        float x = clamp((vS - uDom.x) / (uDom.y - uDom.x), 0.0, 1.0);
          vec3 col = mix(vec3(0.05, 0.14, 0.18), vec3(0.82, 0.38, 0.04), x);
          col = mix(col, texture2D(uLUT, vec2(x, 0.5)).rgb * 0.72, 0.22);
          gl_FragColor = vec4(col, 0.52 * (1.0 - d * 2.65));
      }
    `
  });
  const pts = new THREE.Points(geo, cloudMat);
  pts.renderOrder = 1;

  /* raw payload space, rotated/scaled to display exactly like the fusion cloud */
  const cloud = new THREE.Group();
  cloud.add(pts);
  cloud.rotation.set(-Math.PI / 2, 0, -Math.PI / 2);
  const inner = new THREE.Group();
  inner.add(cloud);
  /* analytic framing (Box3 over sprites would mis-center the cloud):
     display extents = (payload y, payload z, payload x) */
  const sc = 3.4 / Math.max(F.ext[1], F.ext[0], 1e-6);
  inner.scale.setScalar(sc);
  const ctr = [(F.min[0] + F.max[0]) / 2, (F.min[1] + F.max[1]) / 2, (F.min[2] + F.max[2]) / 2];
  inner.position.set(-ctr[1] * sc, -ctr[2] * sc, -ctr[0] * sc);
  const holder = new THREE.Group();
  holder.position.set(0, 2.15, 0);
  holder.add(inner);
  g.add(holder);

  /* The feature values and overlays stay in payload space, but the visible
     body upgrades to the final agreement GLB once it arrives. The point cloud
     remains as a zero-network fallback if that model fails to load. */
  const finalSurface = new THREE.Group();
  cloud.add(finalSurface);
  let finalModelReady = false;
  function attachFinalModel(srcScene) {
    const obj = srcScene.clone(true);
    /* GLB axes (width, height, length) → payload axes (width, length, height). */
    obj.rotation.x = Math.PI / 2;
    obj.updateMatrixWorld(true);
    let bb = new THREE.Box3().setFromObject(obj);
    const size = bb.getSize(new THREE.Vector3());
    const ratios = [F.ext[0] / size.x, F.ext[1] / size.y, F.ext[2] / size.z]
      .filter(Number.isFinite);
    const fit = ratios.reduce((sum, value) => sum + value, 0) / ratios.length;
    obj.scale.setScalar(fit);
    obj.updateMatrixWorld(true);
    bb = new THREE.Box3().setFromObject(obj);
    const modelCenter = bb.getCenter(new THREE.Vector3());
    obj.position.add(new THREE.Vector3(...ctr).sub(modelCenter));
    finalSurface.clear();
    finalSurface.add(obj);
    pts.visible = false;
    finalModelReady = true;
    /* Handed back so buildStations can put it under the screen-size gate:
       measured at 292k triangles, the second-biggest thing in the ranch. */
    return obj;
  }

  /* ---- six overlay families, built in raw payload space ---- */
  const raw = new THREE.Group();
  cloud.add(raw);
  const fams = [];
  const famGroup = () => { const gr = new THREE.Group(); raw.add(gr); fams.push(gr); return gr; };
  const maxExt = Math.max(...F.ext);
  const pad = 0.07 * maxExt;
  const tagH = 0.32 / sc;                 // ≈0.32 world units after parent scale
  const fmt = (v, d = 3) => v.toFixed(d);

  /* 1 — F(g): bbox wireframe + l/w/h dimension lines + volume/surface tags */
  {
    const gr = famGroup();
    const box = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(F.ext[0], F.ext[1], F.ext[2])),
      new THREE.LineBasicMaterial({ color: AMBER, transparent: true, opacity: 0.9 })
    );
    box.position.set(ctr[0], ctr[1], ctr[2]);
    box.renderOrder = 2;
    gr.add(box);
    /* dimension lines just outside the box, parallel to their axis */
    const dims = [
      { axis: 1, label: "l", off: { 0: F.max[0] + pad, 2: F.min[2] - pad } },
      { axis: 0, label: "w", off: { 1: F.min[1] - pad, 2: F.min[2] - pad } },
      { axis: 2, label: "h", off: { 0: F.max[0] + pad, 1: F.max[1] + pad } }
    ];
    const linePts = [];
    for (const d of dims) {
      const p0 = [0, 0, 0], p1 = [0, 0, 0];
      for (const a of [0, 1, 2]) {
        if (a === d.axis) { p0[a] = F.min[a]; p1[a] = F.max[a]; }
        else { p0[a] = p1[a] = d.off[a]; }
      }
      const v0 = new THREE.Vector3(...p0), v1 = new THREE.Vector3(...p1);
      linePts.push(v0, v1);
      const tag = tagSprite([`${d.label} = ${fmt(F.ext[d.axis])} u`], tagH, { color: "#e39b2d" });
      tag.position.lerpVectors(v0, v1, 0.5);
      /* nudge the tag outward, away from the box center */
      for (const a of [0, 1, 2]) {
        if (a !== d.axis) tag.position.setComponent(a, tag.position.getComponent(a) + Math.sign(d.off[a] - ctr[a]) * pad * 0.8);
      }
      gr.add(tag);
    }
    const lgeo = new THREE.BufferGeometry().setFromPoints(linePts);
    const dimLines = new THREE.LineSegments(lgeo,
      new THREE.LineBasicMaterial({ color: AMBER, transparent: true, opacity: 0.7 }));
    dimLines.renderOrder = 2;
    gr.add(dimLines);
    const vtag = tagSprite([
      { text: `V_bbox = ${fmt(F.vBBox)} u³`, color: "#e39b2d" },
      { text: `V_hull = ${fmt(hm.volume)} u³`, color: "#86d7ea" },
      { text: `A_surface = ${fmt(hm.area)} u²`, color: "#86d7ea" }
    ], tagH * 2.6);
    vtag.position.set(ctr[0], ctr[1], F.max[2] + pad * 3.2);
    gr.add(vtag);
  }

  /* 2 — F(a): PCA arrows from the centroid, lengths ∝ √λ, + ratio chips */
  {
    const gr = famGroup();
    const centroid = new THREE.Vector3(...F.mean);
    const cols = [AMBER, ICE, 0xe8e4da];
    F.eig.vals.forEach((lam, i) => {
      const len = Math.sqrt(Math.max(lam, 0)) * 2.2;
      const ar = new THREE.ArrowHelper(F.eig.vecs[i], centroid, len, cols[i], len * 0.22, len * 0.12);
      ar.line.material.transparent = true;
      ar.cone.material.transparent = true;
      ar.line.renderOrder = 2;
      ar.cone.renderOrder = 2;
      gr.add(ar);
    });
    const r = values.lambdaRatios;
    const chip = tagSprite([
      { text: `λ1/λ2 = ${fmt(r.l12, 2)}`, color: "#e39b2d" },
      { text: `λ2/λ3 = ${fmt(r.l23, 2)}`, color: "#86d7ea" },
      { text: `λ3/λ1 = ${fmt(r.l31, 2)}`, color: "#e8e4da" }
    ], tagH * 2.6);
    chip.position.set(ctr[0], ctr[1], F.max[2] + pad * 3.2);
    gr.add(chip);
  }

  /* 3 — F(q): translucent percentile slice planes; active axis cycles x→y→z */
  let updateSlices = null;
  {
    const gr = famGroup();
    const axisQ = [
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0)),   // normal +x
      new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)),  // normal +y
      new THREE.Quaternion()                                                     // normal +z
    ];
    const axisSize = [
      [F.ext[2], F.ext[1]],
      [F.ext[0], F.ext[2]],
      [F.ext[0], F.ext[1]]
    ];
    /* plane centers per axis/percentile, precomputed */
    const pctPos = [0, 1, 2].map((a) => F.pct[a].map((v) => {
      const p = new THREE.Vector3(ctr[0], ctr[1], ctr[2]);
      p.setComponent(a, v);
      return p;
    }));
    const slices = [];
    for (let j = 0; j < 5; j++) {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({
          color: ICE, transparent: true, opacity: 0.22,
          side: THREE.DoubleSide, depthWrite: false
        })
      );
      m.renderOrder = 2;
      const tag = tagSprite([`P${F.PCTS[j]}`], tagH * 0.8, { color: "#86d7ea" });
      gr.add(m, tag);
      slices.push({ m, tag });
    }
    const _q = new THREE.Quaternion(), _dx = new THREE.Vector3();
    const AXIS_P = 3.6, TR = 0.75 / 3.6;
    updateSlices = (t) => {
      const ph = (t / AXIS_P) % 3;
      const i0 = Math.floor(ph), i1 = (i0 + 1) % 3, f = ph - i0;
      let u = f < 1 - TR ? 0 : (f - (1 - TR)) / TR;
      u = u * u * (3 - 2 * u);
      _q.slerpQuaternions(axisQ[i0], axisQ[i1], u);
      const sx = axisSize[i0][0] + (axisSize[i1][0] - axisSize[i0][0]) * u;
      const sy = axisSize[i0][1] + (axisSize[i1][1] - axisSize[i0][1]) * u;
      for (let j = 0; j < 5; j++) {
        const { m, tag } = slices[j];
        m.quaternion.copy(_q);
        m.scale.set(sx * 1.06, sy * 1.06, 1);
        m.position.lerpVectors(pctPos[i0][j], pctPos[i1][j], u);
        _dx.set(1, 0, 0).applyQuaternion(_q);
        tag.position.copy(m.position).addScaledVector(_dx, sx * 0.53 + pad * 0.5);
      }
    };
    updateSlices(0);
  }

  /* 4 — F(ρ): three body-axis sections; slab height + opacity encode density */
  {
    const gr = famGroup();
    const secLen = F.ext[1] / 3;
    for (let k = 0; k < 3; k++) {
      const frac = F.rho[k];
      const slabH = F.ext[2] * Math.min(1, frac * 3) * 0.95;
      const slab = new THREE.Mesh(
        new THREE.BoxGeometry(F.ext[0] * 1.06, secLen * 0.86, slabH),
        new THREE.MeshBasicMaterial({
          color: ICE, transparent: true, opacity: 0.06 + frac * 0.7, depthWrite: false
        })
      );
      slab.position.set(ctr[0], F.min[1] + secLen * (k + 0.5), F.min[2] + slabH / 2);
      slab.renderOrder = 2;
      const tag = tagSprite([`ρ_Z${k + 1} = ${(frac * 100).toFixed(1)}%`], tagH * 0.85, { color: "#86d7ea" });
      tag.position.set(ctr[0], F.min[1] + secLen * (k + 0.5), F.max[2] + pad * 1.6);
      gr.add(slab, tag);
    }
  }

  /* 5 — F(μ): centroid marker + wireframe 1σ ellipsoid */
  {
    const gr = famGroup();
    const mu = new THREE.Mesh(
      new THREE.SphereGeometry(0.022 * maxExt, 14, 10),
      new THREE.MeshBasicMaterial({ color: AMBER, transparent: true, opacity: 1 })
    );
    mu.position.set(...F.mean);
    mu.renderOrder = 2;
    const ell = new THREE.Mesh(
      new THREE.SphereGeometry(1, 20, 14),
      new THREE.MeshBasicMaterial({ color: ICE, wireframe: true, transparent: true, opacity: 0.35 })
    );
    ell.scale.set(F.std[0], F.std[1], F.std[2]);
    ell.position.set(...F.mean);
    ell.renderOrder = 2;
    const tag = tagSprite([
      { text: `μ = (${F.mean.map((v) => fmt(v, 2)).join(", ")}) u`, color: "#e39b2d" },
      { text: `σ = (${F.std.map((v) => fmt(v, 3)).join(", ")}) u`, color: "#86d7ea" }
    ], tagH * 1.8);
    tag.position.set(ctr[0], ctr[1], F.max[2] + pad * 3.2);
    gr.add(mu, ell, tag);
  }

  /* 6 — CONVEX HULL: translucent ice shell with a cheap fresnel edge */
  {
    const gr = famGroup();
    const hullMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
      uniforms: { uFade: { value: 1 } },
      vertexShader: /* glsl */ `
        varying vec3 vN;
        varying vec3 vV;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalMatrix * normal;
          vV = -mv.xyz;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uFade;
        varying vec3 vN;
        varying vec3 vV;
        void main() {
          float fr = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.0);
          gl_FragColor = vec4(vec3(0.53, 0.84, 0.92), uFade * (0.07 + 0.5 * fr));
        }
      `
    });
    const hull = new THREE.Mesh(hullGeo, hullMat);
    hull.renderOrder = 2;
    const tag = tagSprite([`CONVEX HULL · ${hullPts.length} pts`], tagH * 0.85, { color: "#86d7ea" });
    tag.position.set(ctr[0], ctr[1], F.max[2] + pad * 2.2);
    gr.add(hull, tag);
  }

  /* station title plane */
  const title = boardLabel("FINAL AGREEMENT SURFACE · FEATURES LIVE FROM 5941 pts (u)", 5.7);
  title.position.set(0, 4.85, 0);
  g.add(title);

  const drawEnsembleBridge = (ctx, W, H, t = 0) => {
    const active = Math.floor(t * 2.6) % 11;
    ctx.fillStyle = "#0b0e12";
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "#2a323c";
    ctx.lineWidth = 5;
    ctx.strokeRect(2.5, 2.5, W - 5, H - 5);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#86d7ea";
    ctx.font = `500 28px ${MONO}`;
    ctx.fillText("FEATURE VECTOR → ENSEMBLE ML", W / 2, 42);

    const box = (x, y, w, h, label, hot = false, pulse = 0) => {
      ctx.fillStyle = hot ? "#2a1f0d" : "#141a21";
      ctx.fillRect(x - w / 2, y - h / 2, w, h);
      ctx.strokeStyle = hot ? "#e39b2d" : pulse > 0 ? `rgba(134,215,234,${0.25 + pulse * 0.65})` : "#39434e";
      ctx.lineWidth = hot || pulse > 0 ? 4 : 3;
      ctx.strokeRect(x - w / 2, y - h / 2, w, h);
      ctx.fillStyle = hot ? "#e39b2d" : "#c8ccd2";
      ctx.font = `500 24px ${MONO}`;
      ctx.fillText(label, x, y + 1);
    };
    const arrow = (x0, y0, x1, y1, alpha = 1) => {
      ctx.strokeStyle = `rgba(227,155,45,${alpha})`;
      ctx.fillStyle = `rgba(227,155,45,${alpha})`;
      ctx.lineWidth = 4 + alpha * 2;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1 - 14, y1);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x1 - 16, y1 - 9); ctx.lineTo(x1 - 16, y1 + 9); ctx.lineTo(x1, y1);
      ctx.fill();
    };

    const toks = ["F(g)", "F(a)", "F(q)", "F(ρ)", "F(μ)", "HULL VIEW"];
    toks.forEach((t, i) => box(92 + i * 82, 116, 68, 44, t, i === 0));
    arrow(585, 116, 655, 116);
    box(745, 116, 170, 56, "FIXED VECTOR", true);

    ctx.fillStyle = "#8b95a0";
    ctx.font = `500 24px ${MONO}`;
    ctx.fillText("TOP-11 BASE REGRESSORS", W / 2, 196);
    const regs = ["RID", "LAS", "EN", "SVR", "RF", "ET", "GB", "ADA", "CAT", "LGB", "XGB"];
    const regPos = [];
    regs.forEach((r, i) => {
      const row = i < 6 ? 0 : 1;
      const count = row === 0 ? 6 : 5;
      const j = row === 0 ? i : i - 6;
      const x = W / 2 + (j - (count - 1) / 2) * 108;
      const y = 254 + row * 66;
      const pulse = Math.max(0, 1 - Math.abs(((i - active + 11) % 11)) / 2);
      box(x, y, 88, 46, r, false, pulse);
      regPos.push([x, y]);
      ctx.fillStyle = `rgba(134,215,234,${0.18 + pulse * 0.75})`;
      ctx.font = `500 18px ${MONO}`;
      /* The paper reports fold-level aggregate metrics, not Case 001 base
         predictions. Keep the bridge kinetic without inventing kg values. */
      ctx.fillText(`ŷ${i + 1}`, x, y + 38);
    });
    const metaX = W / 2, metaY = 454;
    regPos.forEach(([x, y], i) => {
      const pulse = i === active ? 1 : 0.16;
      arrow(x, y + 28, metaX, metaY - 44, pulse);
    });
    ctx.strokeStyle = "#e39b2d";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(W / 2, 356); ctx.lineTo(W / 2, 412);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(W / 2 - 9, 410); ctx.lineTo(W / 2 + 9, 410); ctx.lineTo(W / 2, 426);
    ctx.fillStyle = "#e39b2d";
    ctx.fill();
    box(W / 2, 454, 300, 58, "RIDGE META · kg", true, 1);
    const outPulse = 0.5 + 0.5 * Math.sin(t * 4.2);
    ctx.fillStyle = `rgba(227,155,45,${0.55 + outPulse * 0.4})`;
    ctx.font = `500 26px ${MONO}`;
    ctx.fillText("ŷk = g(ŷbase)", W / 2, 510);
    ctx.fillStyle = "#8b95a0";
    ctx.font = `500 18px ${MONO}`;
    ctx.fillText("SCHEMATIC FLOW · DATASET METRICS AT S7", W / 2, 548);
  };
  const bridge = canvasPlane(4.25, 2.46, 980, 568, (ctx, W, H) => drawEnsembleBridge(ctx, W, H, 0));
  const bridgeCtx = bridge.userData.canvas.getContext("2d");
  /* the animated bridge is a full-canvas redraw + GPU texture re-upload:
     cap at 8 Hz and freeze it entirely unless this station is the active one */
  const bridgeGate = new PanelThrottle(8);
  bridge.position.set(5.15, 1.75, 2.25);
  bridge.rotation.y = -0.42;
  bridge.scale.setScalar(0.92);
  g.add(bridge);

  scene.add(g);
  stationSpot(scene, s, 34);

  /* ---- per-family fade: auto-cycle, chip pinning, seek-stable in tour ---- */
  const famEntries = fams.map((gr) => {
    const ents = [];
    gr.traverse((o) => {
      const m = o.material;
      if (!m) return;
      const materials = Array.isArray(m) ? m : [m];
      for (const material of materials) {
        /* The opaque final surface must not hide measurement overlays. */
        material.depthTest = false;
        if (material.isShaderMaterial && material.uniforms && material.uniforms.uFade) {
          ents.push({ sh: material });
        } else if (material.opacity !== undefined) {
          material.transparent = true;
          ents.push({ m: material, base: material.opacity });
        }
      }
    });
    return ents;
  });
  function applyFade(i, f) {
    fams[i].visible = f > 0.004;
    for (const e of famEntries[i]) {
      if (e.sh) e.sh.uniforms.uFade.value = f;
      else e.m.opacity = e.base * f;
    }
  }

  const FAM_N = 6, FAM_PERIOD = 4.2, EDGE = 0.5 / FAM_PERIOD;
  let lastT = 0;
  let pin = null;    // { idx, t0 } — chip click pins a family
  let blend = null;  // { t0, fades } — smooths pin/unpin transitions
  let onUnpin = null; // notifies the panel so the chip highlight clears
  const curFades = [1, 0, 0, 0, 0, 0];
  const _target = [0, 0, 0, 0, 0, 0];
  function computeFades(t) {
    if (pin && t - pin.t0 > 15) {            // resume the auto-cycle after idle
      blend = { t0: t, fades: curFades.slice() };
      pin = null;
      if (onUnpin) onUnpin();
    }
    if (pin) { _target.fill(0); _target[pin.idx] = 1; }
    else {
      /* pure function of t: deterministic under tour seeking */
      const ph = (t / FAM_PERIOD) % FAM_N;
      for (let f = 0; f < FAM_N; f++) {
        const d = Math.min(ph - f, f + 1 - ph);
        _target[f] = Math.min(1, Math.max(0, d / EDGE));
      }
    }
    let k = 1;
    if (blend) {
      k = Math.min(1, (t - blend.t0) / 0.6);
      k = k * k * (3 - 2 * k);
      if (k >= 1) blend = null;
    }
    for (let f = 0; f < FAM_N; f++) {
      curFades[f] = blend ? blend.fades[f] + (_target[f] - blend.fades[f]) * k : _target[f];
    }
  }

  return {
    values,
    attachFinalModel,
    pipelineTargets: { input: holder, output: holder },
    get finalModelReady() { return finalModelReady; },
    setFamily(idx) {
      blend = { t0: lastT, fades: curFades.slice() };
      pin = { idx: Math.min(FAM_N - 1, Math.max(0, idx | 0)), t0: lastT };
    },
    set unpinCallback(cb) { onUnpin = cb; },
    get featureState() {
      let fi = 0;
      for (let f = 1; f < FAM_N; f++) if (curFades[f] > curFades[fi]) fi = f;
      return { family: pin ? pin.idx : fi, pinned: !!pin, fades: curFades.slice() };
    },
    update(t, isActive) {
      lastT = t;
      computeFades(t);
      for (let f = 0; f < FAM_N; f++) applyFade(f, curFades[f]);
      if (curFades[2] > 0.004) updateSlices(t);
      if (bridgeGate.due(t, isActive)) {
        drawEnsembleBridge(bridgeCtx, 980, 568, t);
        bridge.userData.tex.needsUpdate = true;
      }
    }
  };
}

const METHODS = [
  { key: "rgbd",      label: "RGB+D",      mape: "6.77%", r2: "0.65", hot: false },
  { key: "average",   label: "AVERAGE",   mape: "2.82%", r2: "0.44", hot: false },
  { key: "entropy",   label: "ENTROPY",   mape: "2.73%", r2: "0.47", hot: false },
  { key: "trellis2",  label: "TRELLIS2",  mape: "2.64%", r2: "0.53", hot: false },
  { key: "agreement", label: "AGREEMENT", mape: "2.22%", r2: "0.69", hot: true }
];

const COMPARE_SPACING = 2.8;
/* All five sources use canonical (width, height, length) axes. Present them at
   the same left-facing three-quarter yaw so geometry, rather than an accidental
   asset-local camera angle, is what changes across the comparison. */
const COMPARE_MODEL_YAW = -0.9;
const RGBD_MODEL_YAW = COMPARE_MODEL_YAW + Math.PI;
const compareX = (i) => (i - (METHODS.length - 1) / 2) * COMPARE_SPACING;

function methodPlaque(m) {
  return canvasPlane(2.4, 0.72, 512, 154, (ctx, W, H) => {
    ctx.fillStyle = m.hot ? "#2a1f0d" : "#0c0f13";
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = m.hot ? "#e39b2d" : "#2a323c";
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, W - 4, H - 4);
    ctx.fillStyle = m.hot ? "#e39b2d" : "#e8e4da";
    ctx.font = `38px ${BLACK}`;
    ctx.textAlign = "center";
    ctx.fillText(m.label, W / 2, 58);
    ctx.fillStyle = m.hot ? "#f5d9a8" : "#8b95a0";
    ctx.font = `500 30px ${MONO}`;
    ctx.fillText(`MAPE ${m.mape} · R² ${m.r2}`, W / 2, 116);
  });
}

/* Low-tier Step-05 stand-in: preserve each source GLB untouched, but represent
   one unfocused surface method with a deterministic sample of its real
   vertices. The native RGB+D POINTS primitive is already the measured dataset
   geometry, so it is never replaced by a proxy or presented as a mesh. */
function pointProxyForModel(obj, color, budget = 18000) {
  obj.updateMatrixWorld(true);
  const meshes = [];
  let total = 0;
  obj.traverse((o) => {
    const pos = o.isMesh && o.geometry?.getAttribute("position");
    if (!pos) return;
    meshes.push({ mesh: o, pos, col: o.geometry.getAttribute("color") });
    total += pos.count;
  });
  const stride = Math.max(1, Math.ceil(total / budget));
  const proxy = new THREE.Group();
  const rootInverse = new THREE.Matrix4().copy(obj.matrixWorld).invert();
  let proxyPoints = 0;
  for (const { mesh, pos, col } of meshes) {
    const count = Math.ceil(pos.count / stride);
    const xyz = new Float32Array(count * 3);
    const rgb = col ? new Float32Array(count * 3) : null;
    let j = 0;
    for (let i = 0; i < pos.count; i += stride) {
      xyz[j * 3] = pos.getX(i);
      xyz[j * 3 + 1] = pos.getY(i);
      xyz[j * 3 + 2] = pos.getZ(i);
      if (rgb) {
        rgb[j * 3] = col.getX(i);
        rgb[j * 3 + 1] = col.getY(i);
        rgb[j * 3 + 2] = col.getZ(i);
      }
      j++;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(xyz, 3));
    if (rgb) geo.setAttribute("color", new THREE.BufferAttribute(rgb, 3));
    const points = new THREE.Points(geo, new THREE.PointsMaterial({
      color: rgb ? 0xffffff : color,
      vertexColors: !!rgb,
      size: 0.028,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
      sizeAttenuation: true
    }));
    rootInverse.clone().multiply(mesh.matrixWorld)
      .decompose(points.position, points.quaternion, points.scale);
    proxy.add(points);
    proxyPoints += count;
  }
  proxy.visible = false;
  obj.add(proxy);
  return { proxy, meshes: meshes.map(({ mesh }) => mesh), points: proxyPoints };
}

function buildCompare(scene, s, qualityTier = "high") {
  const g = new THREE.Group();
  faceCam(g, s);
  const anchors = {}, shimmers = {};
  const mounted = new Map();
  const materialDefaults = new WeakMap();
  let agreementGhosted = false;
  let agreementLoadState = "loading";
  let processRunId = null;
  const lowTier = qualityTier === "low";
  METHODS.forEach((m, i) => {
    const x = compareX(i);
    const plinthHeight = m.hot ? 1.1 : 0.9;
    const p = plinth(2.3, plinthHeight, 1.7, m.hot);
    p.position.x = x;
    const anchor = new THREE.Group();
    /* The rim is 0.05 u thick and centred at plinthHeight, so its physical top
       is exactly +0.025 u. Mount every comparison on that surface. */
    anchor.position.set(x, plinthHeight + 0.025, 0);
    const sh = shimmerBlock(
      m.key === "rgbd" ? "LOADING · 99K POINTS"
        : m.key === "trellis2" ? "LOADING · 16 MB" : null
    );
    sh.position.copy(anchor.position);
    const plq = methodPlaque(m);
    plq.position.set(x, m.hot ? 3.4 : 3.1, 0.2);
    g.add(p, anchor, sh, plq);
    anchors[m.key] = anchor;
    shimmers[m.key] = sh;
  });
  const focusRing = new THREE.Mesh(
    new THREE.TorusGeometry(1.28, 0.045, 8, 48),
    new THREE.MeshBasicMaterial({
      color: AMBER, transparent: true, opacity: lowTier ? 0.8 : 0,
      depthWrite: false, blending: THREE.AdditiveBlending
    })
  );
  focusRing.rotation.x = Math.PI / 2;
  focusRing.position.set(compareX(0), 0.08, 0);
  focusRing.visible = lowTier;
  g.add(focusRing);
  scene.add(g);
  stationSpot(scene, s, 64);
  /* hotter pool over the agreement plinth */
  const agreementX = anchors.agreement.position.x;
  stationSpot(scene, s, 100, new THREE.Vector3(
    Math.sin(g.rotation.y + Math.PI / 2) * agreementX,
    0,
    Math.cos(g.rotation.y + Math.PI / 2) * agreementX));
  function ghostModel(entry, on) {
    if (!entry) return;
    entry.obj.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const materials = Array.isArray(o.material) ? o.material : [o.material];
      for (const mat of materials) {
        if (!materialDefaults.has(mat)) {
          materialDefaults.set(mat, {
            opacity: mat.opacity, transparent: mat.transparent, depthWrite: mat.depthWrite
          });
        }
        const base = materialDefaults.get(mat);
        mat.opacity = on ? Math.min(base.opacity, 0.08) : base.opacity;
        mat.transparent = on ? true : base.transparent;
        mat.depthWrite = on ? false : base.depthWrite;
        mat.needsUpdate = true;
      }
    });
    if (entry.proxy) {
      entry.proxy.traverse((o) => {
        if (o.material?.opacity !== undefined) o.material.opacity = on ? 0.05 : 0.88;
      });
    }
  }
  return {
    anchors, shimmers,
    beginProcess({ runId }) { processRunId = runId; },
    pipelineTargets: { input: anchors.agreement, output: anchors.agreement },
    get processState() {
      const outputReady = mounted.has("agreement");
      return {
        runId: processRunId,
        ready: true, completed: outputReady, outputReady,
        loadState: outputReady ? "ready" : agreementLoadState,
        progress: outputReady ? 1 : 0,
        outputVisible: outputReady
      };
    },
    registerMounted(key, obj) {
      if (!obj) return;
      const method = METHODS.find((m) => m.key === key);
      let nativePoints = 0;
      obj.traverse((o) => {
        if (o.isPoints) nativePoints += o.geometry?.getAttribute("position")?.count || 0;
      });
      const sampled = nativePoints > 0
        ? { proxy: null, meshes: [], points: nativePoints, kind: "point-cloud" }
        : lowTier
          ? { ...pointProxyForModel(obj, method?.hot ? AMBER : ICE), kind: "surface-model" }
          : { proxy: null, meshes: [], points: 0, kind: "surface-model" };
      mounted.set(key, { obj, ...sampled });
      if (key === "agreement") {
        agreementLoadState = "ready";
        ghostModel(mounted.get(key), agreementGhosted);
      }
    },
    markModelLoading(key) {
      if (key === "agreement" && !mounted.has(key)) agreementLoadState = "loading";
    },
    markModelUnavailable(key) {
      if (key === "agreement" && !mounted.has(key)) agreementLoadState = "unavailable";
    },
    setAgreementGhosted(on) {
      agreementGhosted = !!on;
      ghostModel(mounted.get("agreement"), agreementGhosted);
    },
    get lodState() {
      return {
        mode: lowTier ? "adaptive-surfaces-plus-native-rgbd-points" : "full-models-plus-native-rgbd-points",
        entries: [...mounted].map(([key, entry]) => ({
          key, kind: entry.kind, points: entry.points,
          mountBounds: entry.obj.userData.mountBounds || null
        }))
      };
    },
    update(t) {
      /* Keep every reconstruction at the same canonical yaw. Continuous
         turntable motion made shape differences harder to compare and could
         leave nominally aligned assets reading as unrelated poses. */
      if (!lowTier) return;
      const focus = Math.floor(t / 3.2) % METHODS.length;
      const focusKey = METHODS[focus].key;
      /* Put the method opposite the amber focus into point mode. This keeps
         the selected object and two neighbours as complete meshes while each
         source takes a turn shedding its raster cost. */
      let proxyKey = null;
      for (let offset = 2; offset < METHODS.length + 2; offset++) {
        const candidate = METHODS[(focus + offset) % METHODS.length].key;
        if (mounted.get(candidate)?.proxy) { proxyKey = candidate; break; }
      }
      for (const [key, entry] of mounted) {
        if (!entry.proxy) continue;
        if (key === "agreement" && agreementGhosted) {
          entry.meshes.forEach((mesh) => { mesh.visible = true; });
          entry.proxy.visible = false;
          continue;
        }
        const pointMode = key === proxyKey;
        entry.meshes.forEach((mesh) => { mesh.visible = !pointMode; });
        entry.proxy.visible = pointMode;
      }
      focusRing.position.x += (anchors[focusKey].position.x - focusRing.position.x) * 0.12;
      focusRing.material.opacity = 0.55 + 0.3 * Math.sin(t * 4.1) ** 2;
    }
  };
}

function buildWeigh(scene, s) {
  const g = new THREE.Group();
  faceCam(g, s);

  const board = canvasPlane(7.4, 4.2, 1280, 726, (ctx, W, H) => {
    ctx.fillStyle = "#0b0e12";
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "#2a323c";
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, W - 6, H - 6);
    ctx.textAlign = "center";
    ctx.fillStyle = "#8b95a0";
    ctx.font = `500 30px ${MONO}`;
    ctx.fillText("MV-SAM3D · LIVE WEIGHT FROM RGB ALONE", W / 2, 66);
    ctx.fillStyle = "#e39b2d";
    ctx.font = `120px ${BLACK}`;
    ctx.fillText("MAPE 2.22%", W / 2, 210);
    ctx.fillStyle = "#f5d9a8";
    ctx.font = `500 40px ${MONO}`;
    ctx.fillText("± 0.56 · 5-FOLD CV", W / 2, 268);
    ctx.fillStyle = "#e8e4da";
    ctx.font = `64px ${BLACK}`;
    ctx.fillText("R² 0.69      MAE 9.16 kg", W / 2, 380);
    ctx.fillStyle = "#86d7ea";
    ctx.font = `500 36px ${MONO}`;
    ctx.fillText("103 ANIMALS · 3 VIEWS · STACKED ENSEMBLE", W / 2, 452);
    ctx.strokeStyle = "#2a323c";
    ctx.beginPath();
    ctx.moveTo(90, 500); ctx.lineTo(W - 90, 500);
    ctx.stroke();
    ctx.fillStyle = "#8b95a0";
    ctx.font = `500 32px ${MONO}`;
    ctx.fillText("BASELINES · MAPE · LOWER IS BETTER", W / 2, 552);
    ctx.fillStyle = "#c8ccd2";
    ctx.font = `500 30px ${MONO}`;
    ctx.fillText("RGB-D 6.77% (R² 0.65) · AGREEMENT 2.22% (R² 0.69)", W / 2, 612);
    ctx.fillStyle = "#e39b2d";
    ctx.font = `500 34px ${MONO}`;
    ctx.fillText("arXiv : 2601.17791", W / 2, 678);
  });
  board.position.set(0, 3.0, -1.2);

  /* posts */
  for (const x of [-3.5, 3.5]) {
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.09, 0.11, 5.0, 8),
      new THREE.MeshStandardMaterial({ color: 0x2a323c, roughness: 0.7 })
    );
    post.position.set(x, 2.5, -1.25);
    g.add(post);
  }
  g.add(board);

  const kiosk = boardLabel("PAPER + LINKS · SEE SIDE PANEL", 3.2);
  kiosk.position.set(0, 0.75, 0.6);
  kiosk.rotation.x = -0.25;
  g.add(kiosk);

  /* ---- animated 3D bar chart: MAPE by method (bars grow on dwell) ---- */
  const BARS = [
    { name: "RGB-D",      v: 6.77, hot: false },
    { name: "SAM3D 1-VW", v: 2.84, hot: false },
    { name: "AVERAGE",    v: 2.82, hot: false },
    { name: "ENTROPY",    v: 2.73, hot: false },
    { name: "TRELLIS2",   v: 2.64, hot: false },
    { name: "AGREEMENT",  v: 2.22, hot: true }
  ];
  /* Wing offset and toe-in are shared by the MAPE and R² charts so the exhibit
     stays symmetric. At ±6.15 this was the widest exhibit in the world (half-
     width 8.45) shot from its furthest dwell (14.2 u), which pushed the far R²
     bar — and on 1280-wide screens its title too — under the 330 px side panel.
     ±4.9 with a shallower toe-in keeps both charts inboard of the panel down to
     1280x800 while staying legibly angled. */
  const WING_X = 4.9, WING_TOE = 0.4;
  const chart = new THREE.Group();
  chart.name = "weighMapeChart";   // QA measures its screen rect by name
  chart.position.set(-WING_X, 0, 0.85);
  chart.rotation.y = WING_TOE;
  chart.scale.setScalar(0.86);
  const SPACING = 0.78, H_MAX = 3.1;
  const chartW = (BARS.length - 1) * SPACING + 1.3;
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(chartW, 0.18, 1.9),
    new THREE.MeshStandardMaterial({ color: 0x11151a, roughness: 0.85 })
  );
  base.position.y = 0.09;
  chart.add(base);
  const title = canvasPlane(6.0, 0.62, 1200, 124, (ctx, W, H) => {
    ctx.fillStyle = "#0c0f13";
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = "center";
    ctx.fillStyle = "#e8e4da";
    ctx.font = `44px ${BLACK}`;
    ctx.fillText("WEIGHT MAPE % — LOWER IS BETTER", W / 2, 56);
    ctx.fillStyle = "#8b95a0";
    ctx.font = `500 28px ${MONO}`;
    ctx.fillText("5-FOLD CV · 103 ANIMALS", W / 2, 100);
  });
  title.position.set(0, H_MAX + 1.15, -0.7);
  chart.add(title);
  const bars = [];
  /* honest encoding: bar height DIRECTLY ∝ MAPE — RGB-D is tallest,
     agreement 2.22 is the shortest bar. Lower is better. */
  const VMAX = Math.max(...BARS.map((b) => b.v));
  let bestTag = null;
  BARS.forEach((b, i) => {
    const x = (i - (BARS.length - 1) / 2) * SPACING;
    const h = H_MAX * (b.v / VMAX);
    const geoB = new THREE.BoxGeometry(0.52, 1, 0.52);
    geoB.translate(0, 0.5, 0);
    const bar = new THREE.Mesh(geoB, new THREE.MeshStandardMaterial(
      b.hot
        ? { color: 0x8a5c14, emissive: AMBER, emissiveIntensity: 0.65, roughness: 0.5 }
        : { color: 0x3a444f, emissive: 0x86d7ea, emissiveIntensity: 0.10, roughness: 0.6 }
    ));
    bar.position.set(x, 0.18, 0);
    bar.scale.y = 0.02;
    /* canvas-baked value + name labels (recorder-safe) */
    const val = canvasPlane(0.72, 0.3, 160, 66, (ctx, W, H) => {
      ctx.fillStyle = "#0c0f13";
      ctx.fillRect(0, 0, W, H);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = b.hot ? "#e39b2d" : "#c8ccd2";
      ctx.font = `500 34px ${MONO}`;
      ctx.fillText(b.v.toFixed(2), W / 2, H / 2 + 1);
    });
    val.position.set(x, 0.55, 0);
    const name = canvasPlane(0.78, 0.24, 200, 60, (ctx, W, H) => {
      ctx.fillStyle = "#0c0f13";
      ctx.fillRect(0, 0, W, H);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = b.hot ? "#e39b2d" : "#8b95a0";
      let size = 22;
      ctx.font = `500 ${size}px ${MONO}`;
      while (size > 11 && ctx.measureText(b.name).width > W - 10) {
        ctx.font = `500 ${--size}px ${MONO}`;
      }
      ctx.fillText(b.name, W / 2, H / 2 + 1);
    });
    name.position.set(x, 0.28, 1.02);
    name.rotation.x = -0.85;
    chart.add(bar, val, name);
    bars.push({ bar, val, h, delay: i * 0.09 });
    /* floating "BEST" tag bobbing above the (short) agreement bar */
    if (b.hot) {
      bestTag = tagSprite([{ text: "BEST · 2.22%", color: "#e39b2d" }], 0.42,
        { bg: "rgba(32,23,8,0.92)" });
      bestTag.position.set(x, 0.18 + h + 1.05, 0);
      bestTag.userData.baseY = 0.18 + h + 1.05;
      bestTag.visible = false;
      chart.add(bestTag);
    }
  });
  g.add(chart);

  /* ---- paired 3D bar chart: R² by the same reconstruction methods ---- */
  const R2_BARS = [
    { name: "RGB-D",      v: 0.65, hot: false },
    { name: "SAM3D 1-VW", v: 0.41, hot: false },
    { name: "AVERAGE",    v: 0.44, hot: false },
    { name: "ENTROPY",    v: 0.47, hot: false },
    { name: "TRELLIS2",   v: 0.53, hot: false },
    { name: "AGREEMENT",  v: 0.69, hot: true }
  ];
  const r2Chart = new THREE.Group();
  r2Chart.name = "weighR2Chart";   // QA measures its screen rect by name
  r2Chart.position.set(WING_X, 0, 0.85);
  r2Chart.rotation.y = -WING_TOE;
  r2Chart.scale.setScalar(0.86);
  const R2_SPACING = SPACING, R2_H_MAX = H_MAX;
  const r2ChartW = chartW;
  const r2Base = new THREE.Mesh(
    new THREE.BoxGeometry(r2ChartW, 0.18, 1.9),
    new THREE.MeshStandardMaterial({ color: 0x11151a, roughness: 0.85 })
  );
  r2Base.position.y = 0.09;
  r2Chart.add(r2Base);
  const r2Title = canvasPlane(6.0, 0.62, 1200, 124, (ctx, W, H) => {
    ctx.fillStyle = "#0c0f13";
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = "center";
    ctx.fillStyle = "#e8e4da";
    ctx.font = `44px ${BLACK}`;
    ctx.fillText("WEIGHT R² — HIGHER IS BETTER", W / 2, 56);
    ctx.fillStyle = "#8b95a0";
    ctx.font = `500 28px ${MONO}`;
    ctx.fillText("TABLE 2 · STACKED ENSEMBLE ML", W / 2, 100);
  });
  r2Title.position.set(0, R2_H_MAX + 1.15, -0.7);
  r2Chart.add(r2Title);
  const r2Bars = [];
  let r2BestTag = null;
  R2_BARS.forEach((b, i) => {
    const x = (i - (R2_BARS.length - 1) / 2) * R2_SPACING;
    const h = R2_H_MAX * (b.v / 0.70);
    const geoB = new THREE.BoxGeometry(0.52, 1, 0.52);
    geoB.translate(0, 0.5, 0);
    const bar = new THREE.Mesh(geoB, new THREE.MeshStandardMaterial(
      b.hot
        ? { color: 0x8a5c14, emissive: AMBER, emissiveIntensity: 0.68, roughness: 0.5 }
        : { color: 0x253f4b, emissive: 0x86d7ea, emissiveIntensity: 0.18, roughness: 0.6 }
    ));
    bar.position.set(x, 0.18, 0);
    bar.scale.y = 0.02;
    const val = canvasPlane(0.72, 0.3, 160, 66, (ctx, W, H) => {
      ctx.fillStyle = "#0c0f13";
      ctx.fillRect(0, 0, W, H);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = b.hot ? "#e39b2d" : "#c8ccd2";
      ctx.font = `500 34px ${MONO}`;
      ctx.fillText(b.v.toFixed(2), W / 2, H / 2 + 1);
    });
    val.position.set(x, 0.55, 0);
    const name = canvasPlane(0.78, 0.24, 200, 60, (ctx, W, H) => {
      ctx.fillStyle = "#0c0f13";
      ctx.fillRect(0, 0, W, H);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = b.hot ? "#e39b2d" : "#8b95a0";
      let size = 22;
      ctx.font = `500 ${size}px ${MONO}`;
      while (size > 11 && ctx.measureText(b.name).width > W - 10) {
        ctx.font = `500 ${--size}px ${MONO}`;
      }
      ctx.fillText(b.name, W / 2, H / 2 + 1);
    });
    name.position.set(x, 0.28, 1.02);
    name.rotation.x = -0.85;
    r2Chart.add(bar, val, name);
    r2Bars.push({ bar, val, h, delay: i * 0.1 });
    if (b.hot) {
      r2BestTag = tagSprite([{ text: "BEST · R² 0.69", color: "#e39b2d" }], 0.42,
        { bg: "rgba(32,23,8,0.92)" });
      r2BestTag.position.set(x, 0.18 + h + 0.72, 0);
      r2BestTag.userData.baseY = 0.18 + h + 0.72;
      r2BestTag.visible = false;
      r2Chart.add(r2BestTag);
    }
  });
  g.add(r2Chart);

  scene.add(g);
  stationSpot(scene, s, 80);

  /* grow-on-dwell clock: armed the first time the station becomes active */
  let growStart = null;
  let growth = 0;
  const sm = (k) => { const c = Math.min(1, Math.max(0, k)); return c * c * (3 - 2 * c); };
  return {
    onActive(t) { if (growStart === null) growStart = t; },
    get barGrowth() { return growth; },
    /* QA hook: heights must rise with MAPE, agreement shortest, BEST tag on */
    get barInfo() {
      return {
        bars: BARS.map((b, i) => ({ name: b.name, mape: b.v, h: bars[i].h, hot: b.hot })),
        r2: R2_BARS.map((b, i) => ({ name: b.name, r2: b.v, h: r2Bars[i].h, hot: b.hot })),
        bestTag: !!bestTag && bestTag.visible
      };
    },
    update(t) {
      const t0 = growStart === null ? Infinity : growStart;
      for (const b of bars) {
        const k = sm((t - t0 - b.delay) / 1.1);
        b.bar.scale.y = Math.max(0.02, b.h * k);
        b.val.position.y = 0.18 + b.h * k + 0.36;
        b.val.visible = k > 0.05;
      }
      for (const b of r2Bars) {
        const k = sm((t - t0 - b.delay - 0.18) / 1.1);
        b.bar.scale.y = Math.max(0.02, b.h * k);
        b.val.position.y = 0.18 + b.h * k + 0.36;
        b.val.visible = k > 0.05;
      }
      growth = sm((t - t0 - bars[bars.length - 1].delay) / 1.1);
      if (bestTag) {
        bestTag.visible = growth > 0.6;
        /* slight deterministic bob */
        bestTag.position.y = bestTag.userData.baseY + 0.07 * Math.sin(t * 2.1);
      }
      if (r2BestTag) {
        r2BestTag.visible = growth > 0.6;
        r2BestTag.position.y = r2BestTag.userData.baseY + 0.07 * Math.sin(t * 2.0 + 0.6);
      }
    }
  };
}

function buildFuture(scene, s, payload, reducedMotion = false) {
  const g = new THREE.Group();
  /* The line sits beyond the paddock's NORTH fence (z=9.5). Its authored +X
     axis is rotated onto world -Z, so material travelling from local +X to -X
     moves SOUTH -> NORTH. Children sit around local z=-3; offsetting the group
     +3 in world X centres the machinery on the paddock at x=-40. */
  g.position.set(s.look.x + 3.0, 0, s.look.z);
  g.rotation.y = Math.PI / 2;
  g.updateMatrixWorld(true);

  /* The physical cattle lane and camera gantry already live in environment.js.
     This external northbound demonstrator receives their output: an actual 3D
     conveyor, ordered Case 001 RGB carrier, reconstruction cell, and kg terminal.
     Only the trigger and kg UI are simulated; the images and points are recorded. */
  const steel = new THREE.MeshStandardMaterial({
    color: 0x202832, roughness: 0.62, metalness: 0.38
  });
  const darkSteel = new THREE.MeshStandardMaterial({
    color: 0x0d1217, roughness: 0.78, metalness: 0.22
  });
  const beltMat = new THREE.MeshStandardMaterial({
    color: 0x151b21, roughness: 0.92, metalness: 0.06
  });
  const railMat = new THREE.MeshStandardMaterial({
    color: 0x24313a, emissive: ICE, emissiveIntensity: 0.12,
    roughness: 0.58, metalness: 0.32
  });
  const amberMat = new THREE.MeshStandardMaterial({
    color: 0x6c4610, emissive: AMBER, emissiveIntensity: 0.78,
    roughness: 0.48, metalness: 0.22
  });
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0x355867, emissive: ICE, emissiveIntensity: 0.08,
    transparent: true, opacity: 0.16, depthWrite: false,
    roughness: 0.18, metalness: 0.05, side: THREE.DoubleSide
  });

  const belt = new THREE.Mesh(new THREE.BoxGeometry(7.65, 0.12, 1.14), beltMat);
  belt.position.set(0, 0.9, -3.0);
  belt.name = "futureConveyorBelt";
  const undercarriage = new THREE.Mesh(
    new THREE.BoxGeometry(7.75, 0.34, 1.26), darkSteel);
  undercarriage.position.set(0, 0.66, -3.0);
  g.add(belt, undercarriage);

  for (const z of [-3.62, -2.38]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(7.85, 0.1, 0.1), railMat);
    rail.position.set(0, 1.02, z);
    g.add(rail);
  }
  for (const x of [-3.65, -1.25, 1.25, 3.65]) {
    for (const z of [-3.48, -2.52]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.65, 0.14), steel);
      leg.position.set(x, 0.33, z);
      g.add(leg);
    }
  }

  /* Visible rollers and moving amber slats make this read as equipment, not as
     a horizontal plinth. Slat motion is view-only and follows the deterministic
     station clock; reduced-motion keeps the belt parked. */
  const rollerGeo = new THREE.CylinderGeometry(0.11, 0.11, 1.06, 10);
  const rollerMat = new THREE.MeshStandardMaterial({
    color: 0x3a4650, roughness: 0.48, metalness: 0.55
  });
  const rollers = new THREE.InstancedMesh(rollerGeo, rollerMat, 12);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < 12; i++) {
    dummy.position.set(-3.55 + i * 0.65, 0.93, -3.0);
    dummy.rotation.set(Math.PI / 2, 0, 0);
    dummy.updateMatrix();
    rollers.setMatrixAt(i, dummy.matrix);
  }
  rollers.instanceMatrix.needsUpdate = true;
  g.add(rollers);

  const slatGeo = new THREE.BoxGeometry(0.3, 0.025, 0.86);
  const slats = new THREE.InstancedMesh(slatGeo, amberMat, 10);
  slats.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  g.add(slats);

  /* Scanner portal: the simulated gate event becomes a physical input station.
     Three beacons echo left/right/top capture without duplicating the real rig. */
  const scanner = new THREE.Group();
  /* The south input end is closest to the paddock; material then travels north. */
  scanner.position.set(3.25, 0, -3.0);
  scanner.name = "futureCaptureScanner";
  for (const z of [-0.72, 0.72]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, 2.25, 0.18), steel);
    post.position.set(0, 1.87, z);
    scanner.add(post);
  }
  const scanTop = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.18, 1.62), steel);
  scanTop.position.set(0, 3.0, 0);
  scanner.add(scanTop);
  const lensMat = new THREE.MeshStandardMaterial({
    color: 0x11151a, emissive: AMBER, emissiveIntensity: 0.35,
    roughness: 0.3, metalness: 0.25
  });
  for (const z of [-0.46, 0, 0.46]) {
    const lens = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 8), lensMat);
    lens.position.set(0.14, 3.0, z);
    scanner.add(lens);
  }
  const scanMat = new THREE.MeshBasicMaterial({
    color: ICE, transparent: true, opacity: 0.22,
    depthWrite: false, side: THREE.DoubleSide
  });
  const scanCurtain = new THREE.Mesh(new THREE.BoxGeometry(0.045, 1.65, 1.18), scanMat);
  scanCurtain.position.set(0, 1.82, 0);
  scanner.add(scanCurtain);
  g.add(scanner);

  /* The workpiece is a real three-image Case 001 cartridge riding the belt.
     Thumbnail derivatives keep this station cheap and preserve source PNGs. */
  const carrier = new THREE.Group();
  const tray = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.14, 0.94), steel);
  tray.position.y = 0.02;
  carrier.add(tray);
  const photoCards = [];
  /* Keep the recorded multi-view source order explicit and visible. The trace
     metadata lists left, right, top; numbering prevents spatial ambiguity. */
  const captureOrder = [
    { file: GATE_THUMB_FILES.rgb[0], id: "left", label: "1 · LEFT" },
    { file: GATE_THUMB_FILES.rgb[1], id: "right", label: "2 · RIGHT" },
    { file: GATE_THUMB_FILES.rgb[2], id: "top", label: "3 · TOP" }
  ];
  captureOrder.forEach(({ file, label }, i) => {
    const card = new THREE.Group();
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(0.58, 0.62, 0.055), darkSteel);
    const imageMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, map: gateThumbTex(file)
    });
    const image = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.48), imageMat);
    image.position.z = 0.031;
    const tag = boardLabel(label, 0.62);
    tag.position.set(0, -0.43, 0.04);
    card.add(frame, image, tag);
    card.position.set((i - 1) * 0.61, 0.48, 0.18);
    card.rotation.y = (i - 1) * -0.12;
    carrier.add(card);
    photoCards.push(card);
  });
  carrier.position.set(3.25, 1.0, -3.0);
  g.add(carrier);

  /* A visible data handoff bridges the physical gantry and the external line.
     Starts come from environment.js's camera-housing origins; ends coincide with
     the matching slot on the carrier, so each flying card hands over without a
     pop. LEFT, RIGHT, TOP use separate progress clocks from deployment-sim.js. */
  const photoFlights = photoCards.map((sourceCard, i) => {
    const flight = sourceCard.clone(true);
    flight.name = `futurePhotoFlight-${captureOrder[i].id}`;
    const spec = FUTURE_RIG_CAPTURE_POINTS[i];
    const start = g.worldToLocal(new THREE.Vector3(spec.x, spec.y, spec.z));
    const end = new THREE.Vector3(
      3.25 + (i - 1) * 0.61, 1.48, -2.82);
    flight.position.copy(start);
    flight.scale.setScalar(0.82);
    flight.visible = false;
    g.add(flight);
    return { flight, start, end };
  });

  /* Reconstruction cell. The payload positions are mounted directly inside a
     transparent industrial cage; drawRange reveals the recorded cloud as the
     RGB cartridge is consumed. */
  const chamber = new THREE.Group();
  chamber.position.set(-0.35, 0, -3.0);
  chamber.name = "futureReconstructionCell";
  const chamberBase = new THREE.Mesh(
    new THREE.CylinderGeometry(0.94, 1.04, 0.2, 24), darkSteel);
  chamberBase.position.y = 1.02;
  chamber.add(chamberBase);
  const chamberTop = chamberBase.clone();
  chamberTop.position.y = 2.85;
  chamber.add(chamberTop);
  for (const x of [-0.83, 0.83]) {
    for (const z of [-0.48, 0.48]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1.72, 0.07), railMat);
      post.position.set(x, 1.94, z);
      chamber.add(post);
    }
  }
  const glass = new THREE.Mesh(
    new THREE.CylinderGeometry(0.86, 0.86, 1.72, 24, 1, true), glassMat);
  glass.position.y = 1.94;
  chamber.add(glass);
  const scanRings = [];
  for (const y of [1.18, 2.7]) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.87, 0.035, 8, 40), amberMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = y;
    chamber.add(ring);
    scanRings.push(ring);
  }

  const pointGeo = new THREE.BufferGeometry();
  pointGeo.setAttribute("position", new THREE.BufferAttribute(payload.positions, 3));
  pointGeo.setDrawRange(0, 0);
  const pointMat = new THREE.PointsMaterial({
    color: ICE, size: 0.047, transparent: true, opacity: 0.94,
    depthWrite: false, depthTest: true, sizeAttenuation: true
  });
  const points = new THREE.Points(pointGeo, pointMat);
  points.renderOrder = 3;
  const cloud = new THREE.Group();
  cloud.add(points);
  cloud.rotation.set(-Math.PI / 2, 0, -Math.PI / 2);
  cloud.updateMatrixWorld(true);
  let bb = new THREE.Box3().setFromObject(cloud);
  const cloudSize = bb.getSize(new THREE.Vector3());
  cloud.scale.setScalar(Math.min(
    1.42 / Math.max(cloudSize.x, 1e-6),
    1.25 / Math.max(cloudSize.y, 1e-6)));
  cloud.updateMatrixWorld(true);
  bb = new THREE.Box3().setFromObject(cloud);
  const cloudCenter = bb.getCenter(new THREE.Vector3());
  cloud.position.sub(cloudCenter);
  const cloudPivot = new THREE.Group();
  cloudPivot.position.set(0, 1.95, 0.02);
  cloudPivot.add(cloud);
  chamber.add(cloudPivot);
  g.add(chamber);

  /* Once reconstruction completes, move the ACTUAL completed 5,941-point cow
     to the estimation dock. A second render object shares the recorded geometry
     and material; the chamber copy is hidden during transfer, so this reads as
     one 3D result moving forward rather than a fabricated feature token. */
  const transferPointModel = new THREE.Group();
  transferPointModel.name = "futureTransferred3DModel";
  const transferCloud = cloud.clone(true);
  let transferPoints = null;
  transferCloud.traverse((o) => {
    if (o.isPoints) {
      transferPoints = o;
      o.renderOrder = 3;
    }
  });
  transferPointModel.add(transferCloud);
  transferPointModel.position.set(-0.35, 1.95, -3.0);
  g.add(transferPointModel);

  const estimationDock = new THREE.Group();
  estimationDock.name = "future3DEstimationDock";
  const dockBase = new THREE.Mesh(
    new THREE.CylinderGeometry(0.72, 0.78, 0.15, 20), darkSteel);
  dockBase.position.y = 1.06;
  const dockRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.58, 0.035, 8, 32), amberMat);
  dockRing.rotation.x = Math.PI / 2;
  dockRing.position.y = 1.15;
  estimationDock.add(dockBase, dockRing);
  estimationDock.position.set(-3.05, 0, -3.0);
  g.add(estimationDock);

  /* Industrial output terminal. This small machine screen is the only result
     surface; it is not a pipeline board, and the simulated-value warning lives
     beside the number so it survives screenshots. */
  const terminal = new THREE.Group();
  /* Offset the cabinet to the viewer-facing side of the conveyor, leaving the
     completed 3D cow visible on its estimation dock instead of inside a box. */
  terminal.position.set(-3.25, 0, -1.75);
  terminal.name = "futureWeightTerminal";
  const terminalBase = new THREE.Mesh(
    new THREE.BoxGeometry(1.7, 0.38, 1.15), darkSteel);
  terminalBase.position.y = 0.69;
  const column = new THREE.Mesh(new THREE.BoxGeometry(1.32, 1.5, 0.72), steel);
  column.position.set(0, 1.55, -0.08);
  const screenFrame = new THREE.Mesh(
    new THREE.BoxGeometry(1.68, 1.28, 0.16), darkSteel);
  screenFrame.position.set(0, 2.25, 0.24);
  terminal.add(terminalBase, column, screenFrame);
  const terminalScreen = canvasPlane(1.48, 1.08, 740, 540, () => {});
  terminalScreen.position.set(0, 2.25, 0.33);
  terminal.add(terminalScreen);
  const terminalCtx = terminalScreen.userData.canvas.getContext("2d");
  const terminalLampMat = new THREE.MeshStandardMaterial({
    color: 0x1b2229, emissive: AMBER, emissiveIntensity: 0.16
  });
  const terminalLamp = new THREE.Mesh(
    new THREE.SphereGeometry(0.11, 12, 8), terminalLampMat);
  terminalLamp.position.set(0, 3.0, 0.08);
  terminal.add(terminalLamp);
  g.add(terminal);

  /* Compact equipment labels and one overhead provenance nameplate. They name
     machines; they do not flatten the exhibit back into a four-card diagram. */
  const stageLabels = [
    ["01 · VIRTUAL CAPTURE", 3.25],
    ["02 · CASE 001 RGB", 1.65],
    ["03 · REAL 3D REPLAY", -0.35],
    ["04 · 3D → KG", -3.25]
  ];
  for (const [text, x] of stageLabels) {
    const label = boardLabel(text, 1.55);
    label.position.set(x, x === -0.35 ? 3.22 : 3.32, -3.0);
    g.add(label);
  }
  const nameplate = canvasPlane(5.1, 0.52, 1120, 114, (ctx, W, H) => {
    ctx.fillStyle = "#0b0e12";
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "#e39b2d";
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, W - 4, H - 4);
    ctx.textAlign = "center";
    ctx.fillStyle = "#e39b2d";
    ctx.font = "500 32px " + MONO;
    ctx.fillText("SIMULATED DEPLOYMENT LINE", W / 2, 45);
    ctx.fillStyle = "#8b95a0";
    ctx.font = "500 20px " + MONO;
    ctx.fillText("RECORDED CASE 001 RGB + 5,941-POINT 3D REPLAY", W / 2, 84);
  });
  nameplate.position.set(0, 4.22, -3.55);
  g.add(nameplate);

  const lampMats = [];
  const stageX = [3.25, 1.65, -0.35, -3.25];
  for (const x of stageX) {
    const mat = new THREE.MeshStandardMaterial({
      color: 0x1b2229, emissive: 0x1b2229, emissiveIntensity: 0.15
    });
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.095, 10, 7), mat);
    lamp.position.set(x, 1.14, -2.28);
    g.add(lamp);
    lampMats.push(mat);
  }

  scene.add(g);
  /* Station anchor is east of the line. Scanner is south, terminal is north. */
  stationSpot(scene, s, 86, new THREE.Vector3(-12.0, 0, -3.2));
  stationSpot(scene, s, 48, new THREE.Vector3(-12.0, 0, 3.2));

  let currentState = deploymentStateAt(0, { reducedMotion });
  let runSince = null;
  let proximityInside = false;
  let proximityDistance = Infinity;
  let proximityZone = null;
  let triggerSource = "idle";
  let visiblePoints = 0;
  let terminalSignature = "";

  function drawTerminal(state, force = false) {
    const signature = state.phase + ":" + state.weightReady;
    if (!force && signature === terminalSignature) return;
    terminalSignature = signature;
    const W = 740, H = 540;
    terminalCtx.fillStyle = "#071015";
    terminalCtx.fillRect(0, 0, W, H);
    terminalCtx.strokeStyle = state.weightReady ? "#e39b2d" : "#365260";
    terminalCtx.lineWidth = 8;
    terminalCtx.strokeRect(5, 5, W - 10, H - 10);
    terminalCtx.textAlign = "center";
    terminalCtx.fillStyle = "#86d7ea";
    terminalCtx.font = "500 28px " + MONO;
    terminalCtx.fillText("AUTOMATED WEIGHT TERMINAL", W / 2, 68);
    terminalCtx.fillStyle = state.weightReady ? "#e39b2d" : "#657580";
    terminalCtx.font = "92px " + BLACK;
    terminalCtx.fillText(state.weightReady ? String(state.demoKg) + " kg" : "ANALYZING", W / 2, 220);
    terminalCtx.fillStyle = state.weightReady ? "#f5d9a8" : "#71808b";
    terminalCtx.font = "500 26px " + MONO;
    terminalCtx.fillText(
      state.weightReady ? "SIMULATED UI VALUE" : "3D MODEL → STACKED ENSEMBLE",
      W / 2, 294);
    terminalCtx.fillStyle = "#8b95a0";
    terminalCtx.font = "500 22px " + MONO;
    terminalCtx.fillText("NOT MODEL INFERENCE · NOT CASE 001", W / 2, 355);
    terminalCtx.strokeStyle = "#26343d";
    terminalCtx.beginPath();
    terminalCtx.moveTo(52, 394);
    terminalCtx.lineTo(W - 52, 394);
    terminalCtx.stroke();
    terminalCtx.fillStyle = "#86d7ea";
    terminalCtx.font = "500 21px " + MONO;
    terminalCtx.fillText("PAPER VALIDATION · MAPE 2.22%", W / 2, 446);
    terminalCtx.fillStyle = "#6f7a84";
    terminalCtx.font = "500 18px " + MONO;
    terminalCtx.fillText("103 CATTLE · 5-FOLD CV", W / 2, 488);
    terminalScreen.userData.tex.needsUpdate = true;
  }

  function updateStageLamps(state) {
    lampMats.forEach((mat, i) => {
      const active = i === state.phaseIndex;
      const done = i < state.phaseIndex;
      const color = active ? AMBER : done ? ICE : 0x27313a;
      mat.color.setHex(active ? 0x6c4610 : done ? 0x244653 : 0x1b2229);
      mat.emissive.setHex(color);
      mat.emissiveIntensity = active ? 1.0 : done ? 0.52 : 0.12;
    });
  }

  function updateBelt(local) {
    for (let i = 0; i < 10; i++) {
      const move = reducedMotion ? 0 : (local * 0.62) % 7.2;
      /* Local -X maps to world +Z after the group rotation: northbound. */
      const x = 3.55 - ((i * 0.78 + move) % 7.2);
      dummy.position.set(x, 0.98, -3.0);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      slats.setMatrixAt(i, dummy.matrix);
    }
    slats.instanceMatrix.needsUpdate = true;
  }

  function applyState(state, local) {
    currentState = state;
    updateStageLamps(state);
    drawTerminal(state);

    /* Empty tray at capture; real L/R/T cards appear and travel during images,
       then feed into the reconstruction cage. */
    const imageTravel = state.phaseIndex < 1 ? 0
      : state.phaseIndex === 1 ? state.phaseProgress : 1;
    let carrierX = THREE.MathUtils.lerp(3.25, 0.65, imageTravel);
    let consume = 0;
    if (state.phase === "reconstruct") {
      consume = state.pointFraction;
      carrierX = THREE.MathUtils.lerp(0.65, 0.12, consume);
    } else if (state.phaseIndex > 2) {
      consume = 1;
    }
    /* Reduced motion is a static cutaway of the whole line: leave one RGB
       cartridge parked at its station instead of showing only final output. */
    if (reducedMotion) {
      carrierX = 1.65;
      consume = 0;
    }
    carrier.position.x = carrierX;
    carrier.position.y = 1.0 - consume * 0.26;
    carrier.scale.setScalar(1 - consume * 0.42);
    carrier.visible = consume < 0.985;
    photoCards.forEach((card, i) => {
      card.visible = i < state.photoCount;
    });
    const flightProgress = state.photoFlightProgress || [1, 1, 1];
    photoFlights.forEach(({ flight, start, end }, i) => {
      const p = flightProgress[i] || 0;
      flight.visible = !reducedMotion && p > 0 && p < 1;
      flight.position.lerpVectors(start, end, p);
      flight.position.y += Math.sin(Math.PI * p) * (0.8 + i * 0.14);
      flight.scale.setScalar(0.82 + p * 0.18);
      flight.rotation.z = (1 - p) * (i - 1) * 0.12;
    });

    visiblePoints = Math.min(payload.meta.count,
      Math.round(payload.meta.count * state.pointFraction));
    pointGeo.setDrawRange(0, visiblePoints);
    const transferring3D = state.phase === "estimate";
    /* In motion there is only one visible result: it leaves the chamber and
       travels north. Reduced motion keeps a static chamber copy as a cutaway. */
    points.visible = visiblePoints > 0 && (!transferring3D || reducedMotion);
    cloudPivot.visible = points.visible;
    transferPointModel.visible = transferring3D && visiblePoints > 0;
    if (transferPoints) transferPoints.visible = transferPointModel.visible;
    transferPointModel.position.x = THREE.MathUtils.lerp(
      -0.35, -3.05, state.outputProgress || 0);
    transferPointModel.position.y = 1.95
      + (reducedMotion ? 0 : 0.12 * Math.sin(Math.PI * (state.outputProgress || 0)));
    transferPointModel.rotation.y = reducedMotion ? 0 : local * 0.16;
    scanCurtain.visible = !reducedMotion && state.phase === "capture";
    scanMat.opacity = scanCurtain.visible
      ? 0.12 + 0.28 * Math.sin(local * 10) ** 2 : 0;
    lensMat.emissiveIntensity = state.phase === "capture"
      ? 0.7 + 1.1 * Math.sin(local * 12) ** 2 : 0.22;

    if (!reducedMotion && visiblePoints > 0) {
      cloudPivot.rotation.y = local * 0.16;
      scanRings[0].rotation.z = local * 0.28;
      scanRings[1].rotation.z = -local * 0.24;
    }

    terminalLampMat.emissiveIntensity = state.weightReady ? 1.3 : 0.18;
    terminalLampMat.emissive.setHex(state.weightReady ? AMBER : 0x29434f);
  }

  updateBelt(0);
  drawTerminal(currentState, true);
  applyState(currentState, 0);

  return {
    /* Station entry, the physical gantry and the visible factory all drive the
       same one-shot clock. It keeps advancing after station focus clears and
       parks at the final kg state instead of silently looping. */
    tickRuntime(t, subject, isActive = false) {
      updateBelt(t);
      const gantry = deploymentProximity(subject, FUTURE_RIG_PROXIMITY);
      const factory = deploymentProximity(subject, FUTURE_FACTORY_PROXIMITY);
      const proximity = gantry.distance <= factory.distance
        ? { ...gantry, zone: "gantry" }
        : { ...factory, zone: "factory" };
      const inside = gantry.inside || factory.inside;
      proximityDistance = proximity.distance;
      proximityZone = inside ? (gantry.inside ? "gantry" : "factory") : null;
      const elapsed = runSince === null ? Infinity : Math.max(0, t - runSince);
      if (!isActive && inside && !proximityInside &&
          (runSince === null || elapsed >= DEPLOYMENT_PERIOD)) {
        runSince = t;
        triggerSource = `${proximityZone}-proximity`;
        applyState(deploymentStateAt(0, { reducedMotion }), 0);
      }
      proximityInside = inside;
      if (runSince !== null) {
        const local = Math.max(0, t - runSince);
        applyState(deploymentOneShotStateAt(local, { reducedMotion }),
          Math.min(local, DEPLOYMENT_PERIOD - 1e-3));
      }
    },
    onActive(t) {
      runSince = t;
      triggerSource = "station-navigation";
      applyState(deploymentStateAt(0, { reducedMotion }), 0);
    },
    update() {},
    get deploymentState() {
      return {
        ...currentState,
        layout: "spatial-conveyor",
        placement: "north-outside-paddock-northbound",
        triggerMode: "gantry-factory-proximity-or-station-entry",
        triggerSource,
        proximityInside,
        proximityZone,
        proximityDistance: Number.isFinite(proximityDistance) ? proximityDistance : null,
        proximityRadius: proximityZone === "factory"
          ? FUTURE_FACTORY_PROXIMITY.radius : FUTURE_RIG_PROXIMITY.radius,
        realPointCount: payload.meta.count,
        visiblePointCount: visiblePoints,
        carrierX: carrier.position.x,
        outputX: transferPointModel.position.x,
        captureOrder: captureOrder.map(({ id }) => id),
        transferredObject: "recorded-5941-point-3d-cow",
        sources: {
          capture: "simulated",
          images: "recorded-case-001-thumbnails",
          reconstruction: "recorded-case-001-agreement-payload",
          weight: "simulated-ui-not-model-inference"
        }
      };
    }
  };
}

/* ---------- assembly ---------- */

export function updateActiveExhibit(exhibits, activeIndex, t) {
  const exhibit = exhibits?.[activeIndex];
  if (typeof exhibit?.update === "function") exhibit.update(t, true);
}

export function buildStations(
  scene, payload, reconSteps = null, multiviewReconSteps = null, quality = null
) {
  /* Point-cloud density is a device decision, so it arrives from the host
     rather than being sniffed here — that keeps ?tour=1's forced full quality
     in one place and lets the station builders stay pure. */
  const stage2Density = quality?.stage2Density ?? null;
  const stage2Blending = quality?.stage2Blending ?? "normal";
  const reducedMotion = !!quality?.reducedMotion;
  const builders = [buildGate, buildCapture,
    (sc, st) => buildSegment(sc, st, reducedMotion),
    (sc, st) => buildReconstruct(sc, st, payload, reconSteps, stage2Density,
      stage2Blending, reducedMotion),
    (sc, st) => buildFusion(sc, st, payload, multiviewReconSteps, stage2Density,
      stage2Blending, reducedMotion),
    (sc, st) => buildCompare(sc, st, quality?.tier),
    (sc, st) => buildFeatures(sc, st, payload), buildWeigh,
    (sc, st) => buildFuture(sc, st, payload, reducedMotion)];
  /* Builders add their own groups straight to the scene and return only their
     interaction surface, so the roots are recovered by diffing scene.children
     around each call. That keeps nine builders untouched and, more usefully,
     cannot drift: anything a builder adds is captured whether or not someone
     remembers to return it. Lights are excluded — LightRig already owns their
     visibility by station, and two owners would fight. */
  const exhibits = [];
  const stationRoots = STATIONS.map((s, i) => {
    const before = scene.children.length;
    exhibits.push(builders[i](scene, s) || {});
    const added = scene.children.slice(before).filter((o) => !o.isLight);
    added.forEach((o, n) => {
      o.name = o.name || `station${String(i).padStart(2, "0")}${added.length > 1 ? `.${n}` : ""}`;
    });
    return added;
  });
  /* the world must load plaqueless rather than not at all */
  try { addHandoffPlaques(scene); } catch (err) { console.warn("handoff plaques disabled:", err); }
  const CAPTURE_I = 1, FEATURES_I = 6, WEIGH_I = 7, FUTURE_I = 8;

  const anchors = {}, shimmers = {};
  for (const ex of exhibits) {
    Object.assign(anchors, ex.anchors || {});
    Object.assign(shimmers, ex.shimmers || {});
  }

  /* The reconstruction GLBs dominate the frame: measured from station 00 after
     a visit to 05, station 05's models alone drew 1.39M of 1.78M triangles
     while covering roughly 24 pixels. They are gated on projected size, and
     the station in focus is always exempt. */
  const modelLod = new ScreenSizeLod({ minFraction: 0.04 });
  const rootStation = new Map();
  stationRoots.forEach((objects, i) => objects.forEach((o) => rootStation.set(o, i)));
  function registerModelLod(obj) {
    let top = obj;
    while (top.parent && top.parent !== scene) top = top.parent;
    modelLod.add(rootStation.has(top) ? rootStation.get(top) : null, obj);
  }

  function attachModel(key, gltfScene) {
    if (key === "agreement") {
      ["proposal0", "proposal1", "proposal2"].forEach((pkey, i) => {
        if (!anchors[pkey]) return;
        const obj = mountModel(anchors[pkey], gltfScene, 1.25, [-0.32, 0.04, 0.28][i]);
        tintModel(obj, [AMBER, ICE, 0xe8e4da][i], [0.58, 0.44, 0.34][i]);
        shimmers[pkey].visible = false;
        registerModelLod(obj);
      });
      const agreementModel = mountModel(anchors.agreement, gltfScene, 3.1, COMPARE_MODEL_YAW);
      registerModelLod(agreementModel);
      exhibits[5].registerMounted?.("agreement", agreementModel);
      shimmers.agreement.visible = false;
      const featuresModel = exhibits[FEATURES_I].attachFinalModel(gltfScene);
      if (featuresModel) registerModelLod(featuresModel);
    } else if (anchors[key]) {
      /* AutoAligned Subject 001 stores head↔tail opposite to the reconstruction
         exports despite sharing the same canonical axes. Flip only this source. */
      const yaw = key === "rgbd" ? RGBD_MODEL_YAW : COMPARE_MODEL_YAW;
      const model = mountModel(anchors[key], gltfScene, 3.1, yaw);
      registerModelLod(model);
      exhibits[5].registerMounted?.(key, model);
      shimmers[key].visible = false;
    }
  }

  let activeI = -1;   // station in focus (-1 = overview/travel/intro)
  /* `subject` is the driven calf's world position (null outside roam). The
     capture rig has to watch it EVERY frame, not only while station 01 is the
     active exhibit — walking under the gantry is a roam-mode reward, and roam
     usually leaves activeI at whatever station was last visited. */
  function update(t, subject = null) {
    exhibits[FUTURE_I].tickRuntime?.(t, subject, activeI === FUTURE_I);
    updateActiveExhibit(exhibits, activeI, t);
    exhibits[CAPTURE_I].tickCameras?.(t, subject);
    const activeShimmers = exhibits[activeI]?.shimmers;
    if (activeShimmers) {
      for (const key in activeShimmers) {
        const shimmer = activeShimmers[key];
        if (shimmer.visible) {
          shimmer.userData.shimmerMat.opacity = 0.22 + 0.16 * Math.sin(t * 3.1 + 1);
        }
      }
    }
  }

  /* Compile every station-light configuration while the loading screen is
     still up. Without this the first station a visitor reaches pays 10 shader
     compiles in one frame, because focusing a station changes how many spots
     are lit and three.js caches programs per light count. */
  function prewarmLights(renderer, scene, camera) {
    return lightRig.prewarm(renderer, scene, camera);
  }

  /* a station became active (dwell / tour dwell) — arms grow-on-dwell exhibits */
  function setActive(i, t) {
    activeI = i;
    lightRig.setFocus(i);
    /* never let the size gate blank the exhibit the visitor came to see, no
       matter where the camera ends up */
    modelLod.keep(i);
    const ex = exhibits[i];
    if (ex && ex.onActive) ex.onActive(t);
  }

  /* overview / intro: no focused station, relight the whole ranch */
  function clearActive() {
    activeI = -1;
    lightRig.setFocus(-1);
    modelLod.keep();
  }

  function pipelineTarget(station, kind = "input") {
    const target = exhibits[station]?.pipelineTargets?.[kind] || null;
    if (!target) return null;
    scene.updateMatrixWorld(true);
    return target.getWorldPosition(new THREE.Vector3());
  }

  return {
    attachModel, update, setActive, clearActive, prewarmLights,
    pipelineTarget,
    setAgreementGhosted(on) { exhibits[5].setAgreementGhosted?.(on); },
    markModelLoading(key) { exhibits[5].markModelLoading?.(key); },
    markModelUnavailable(key) { exhibits[5].markModelUnavailable?.(key); },
    /* the render loop owns the camera, so it drives the size gate */
    updateModelLod: (camera) => modelLod.update(camera),
    setModelLodEnabled: (on) => modelLod.setEnabled(on),
    get modelLodStats() { return modelLod.stats; },
    get compareLodState() { return exhibits[5].lodState || null; },
    /* [{station, pos, objects}] — scene-graph handles for QA and future LOD */
    get roots() {
      return STATIONS.map((s, i) => ({ station: i, pos: s.pos, objects: stationRoots[i] }));
    },
    get captureFlash() { return exhibits[CAPTURE_I].flashState || null; },
    get reconState() { return exhibits[3].reconState; },
    get fusionReconState() { return exhibits[4].reconState; },
    pipelineProcessState(i) {
      if (i === 3) return exhibits[3].reconState;
      if (i === 4) return exhibits[4].reconState;
      return exhibits[i]?.processState || null;
    },
    beginPipelineProcess(i, request) {
      exhibits[i]?.beginProcess?.(request);
    },
    markReconLoading(i) { exhibits[i]?.markTraceLoading?.(); },
    installReconTrace(i, stepsPayload, worldTime) {
      return exhibits[i]?.installTrace?.(stepsPayload, worldTime) || false;
    },
    markReconUnavailable(i) { exhibits[i]?.markTraceUnavailable?.(); },
    /* live player handles for the step scrubber (3 = single-view, 4 = fusion) */
    get reconPlayers() {
      return { 3: exhibits[3].player || null, 4: exhibits[4].player || null };
    },
    get barGrowth() { return exhibits[WEIGH_I].barGrowth; },
    get weighBars() { return exhibits[WEIGH_I].barInfo; },
    get deploymentState() { return exhibits[8].deploymentState; },
    /* FEATURES station (index 6): chip pinning + QA/report hooks */
    setFeatureFamily(i) { exhibits[FEATURES_I].setFamily(i); },
    set featureUnpinCallback(cb) { exhibits[FEATURES_I].unpinCallback = cb; },
    get featureState() { return exhibits[FEATURES_I].featureState; },
    get featureValues() { return exhibits[FEATURES_I].values; },
    get featureFinalModelReady() { return exhibits[FEATURES_I].finalModelReady; }
  };
}
