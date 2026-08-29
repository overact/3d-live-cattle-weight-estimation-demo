import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const requiredPages = ["index.html", "agreement.html", "paper.html"];
const forbiddenPages = ["overview.html", "film.html"];

function requireFile(rel) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    throw new Error(`Missing public runtime file: ${rel}`);
  }
}

for (const page of requiredPages) requireFile(page);
for (const page of forbiddenPages) {
  if (fs.existsSync(path.join(root, page))) throw new Error(`Forbidden public page present: ${page}`);
}

for (const page of requiredPages) {
  const html = fs.readFileSync(path.join(root, page), "utf8");
  for (const destination of requiredPages) {
    if (!html.includes(`href="${destination}"`)) {
      throw new Error(`${page} navigation is missing ${destination}`);
    }
  }
  for (const forbidden of forbiddenPages) {
    if (html.includes(`href="${forbidden}"`)) {
      throw new Error(`${page} navigation leaks forbidden page ${forbidden}`);
    }
  }
}

const autoTourRanchHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");
const autoTourRanchMain = fs.readFileSync(path.join(root, "js/world/main.js"), "utf8");
for (const id of [
  "btnAutoTour", "btnAutoTourIntro", "autoTourHud", "autoTourStep", "autoTourTitle",
  "autoTourNarration", "autoTourProgress", "autoTourVoice", "autoTourTakeControl"
]) {
  if (!autoTourRanchHtml.includes(`id="${id}"`)) {
    throw new Error(`Interactive auto tour is missing #${id}`);
  }
}
for (const contract of [
  "createAutoTour", "createAutoTourVoice", "initAutoTourHud", "onManualIntent", "takeManualControl",
  'mode === "auto-tour"'
]) {
  if (!autoTourRanchMain.includes(contract)) {
    throw new Error(`Interactive auto tour wiring is missing ${contract}`);
  }
}

const textFiles = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === ".playwright-cli" || entry.name === "output") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(?:html|css|js|mjs|json|md|yml)$/.test(entry.name)) textFiles.push(full);
  }
}
walk(root);

const forbiddenPublicRefs = /(?:overview\.html|film\.html|ICIP PAPER|This ICIP paper|ICIP INTERACTIVE PAPER)/i;
for (const full of textFiles) {
  if (path.relative(root, full) === "scripts/check-public.mjs") continue;
  const source = fs.readFileSync(full, "utf8");
  if (forbiddenPublicRefs.test(source)) {
    throw new Error(`Forbidden page or publication claim in ${path.relative(root, full)}`);
  }
}

const localRefs = new Set();
for (const page of requiredPages) {
  const html = fs.readFileSync(path.join(root, page), "utf8");
  for (const match of html.matchAll(/\b(?:src|href|data)="([^"]+)"/g)) {
    const ref = match[1].split(/[?#]/, 1)[0];
    if (!ref || /^(?:https?:|mailto:|#)/.test(ref)) continue;
    localRefs.add(ref);
  }
}

for (const full of textFiles.filter((file) => file.endsWith(".css"))) {
  const css = fs.readFileSync(full, "utf8");
  for (const match of css.matchAll(/url\((?:"|')?([^)'"?#]+)(?:"|')?\)/g)) {
    const resolved = path.normalize(path.join(path.dirname(path.relative(root, full)), match[1]));
    localRefs.add(resolved);
  }
}

for (const full of textFiles.filter((file) => /\.(?:js|mjs)$/.test(file))) {
  const source = fs.readFileSync(full, "utf8");
  for (const match of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
    const specifier = match[1].split("?", 1)[0];
    if (!specifier.startsWith(".")) continue;
    const resolved = path.normalize(path.relative(root, path.resolve(path.dirname(full), specifier)));
    localRefs.add(resolved);
  }
}

/* A static browser treats `module.js` and `module.js?v=...` as different
   modules. Reject split query graphs so singleton caches and lifecycle state
   cannot be instantiated twice or revived from mismatched browser caches. */
const moduleQueries = new Map();
for (const full of textFiles.filter((file) => /\.(?:js|mjs)$/.test(file))) {
  const source = fs.readFileSync(full, "utf8");
  for (const match of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (!specifier.startsWith(".")) continue;
    const [bare, query = "<unversioned>"] = specifier.split("?", 2);
    const target = path.normalize(path.relative(root, path.resolve(path.dirname(full), bare)));
    const queries = moduleQueries.get(target) || new Set();
    queries.add(query);
    moduleQueries.set(target, queries);
  }
}
for (const [target, queries] of moduleQueries) {
  if (queries.size > 1) {
    throw new Error(`Module query split for ${target}: ${[...queries].join(", ")}`);
  }
}

for (const ref of localRefs) requireFile(ref);

const dynamicRuntime = [
  "assets/agreement/meta.json", "assets/agreement/points.bin", "assets/agreement/agree.bin",
  "assets/agreement/payload.json", "assets/recon/meta.json", "assets/recon/steps.bin",
  "assets/recon/stage2.rgba.bin", "assets/recon_multiview/meta.json",
  "assets/recon_multiview/steps.bin", "assets/recon_multiview/stage2.rgba.bin",
  "assets/cases/case_001/models/agreement.glb", "assets/cases/case_001/models/average.glb",
  "assets/cases/case_001/models/entropy.glb", "assets/cases/case_001/models/trellis2.glb",
  "assets/cases/case_001/models/rgbd.glb",
  "assets/cases/case_001/views/display/rgb_left.webp",
  "assets/cases/case_001/views/display/rgb_right.webp",
  "assets/cases/case_001/views/display/rgb_top.webp",
  "assets/cases/case_001/views/display/mask_left.png",
  "assets/cases/case_001/views/display/mask_right.png",
  "assets/cases/case_001/views/display/mask_top_aligned.png",
  /* Full-resolution views referenced from data (the recon meta.json `source`
     blocks), not from code — the static collectors never see them. */
  "assets/cases/case_001/views/rgb_left.png", "assets/cases/case_001/views/rgb_right.png",
  "assets/cases/case_001/views/rgb_top.png", "assets/cases/case_001/views/mask_left.png",
  "assets/cases/case_001/views/mask_right.png", "assets/cases/case_001/views/mask_top_aligned.png",
  "assets/world/barn_big_quaternius.glb", "assets/world/fence_quaternius.glb",
  "assets/world/hay_quaternius.glb", "assets/world/pinetree_quaternius.glb",
  "assets/world/cow_quaternius.glb", "assets/world/candidates/cow_cubepet_kenney.glb",
  "assets/world/thumbs/rgb_left.webp",
  "assets/world/thumbs/rgb_right.webp", "assets/world/thumbs/rgb_top.webp",
  "assets/world/thumbs/mask_left.webp", "assets/world/thumbs/mask_right.webp",
  "assets/world/thumbs/mask_top_aligned.webp", "assets/figures/global_agreement.png",
  "assets/figures/results/regression_MAPE.png", "assets/figures/results/regression_R2.png",
  "vendor/three.module.js", "vendor/OrbitControls.js", "vendor/GLTFLoader.js",
  "vendor/BufferGeometryUtils.js", "vendor/CSS2DRenderer.js", "vendor/SkeletonUtils.js",
  "vendor/ConvexGeometry.js", "vendor/ConvexHull.js", "js/lib/chibi-body.worker.js"
];
for (const rel of dynamicRuntime) requireFile(rel);

const rgbdBytes = fs.readFileSync(path.join(root, "assets/cases/case_001/models/rgbd.glb"));
const rgbdJsonBytes = rgbdBytes.readUInt32LE(12);
const rgbdGltf = JSON.parse(rgbdBytes.subarray(20, 20 + rgbdJsonBytes).toString("utf8").trim());
const rgbdPrimitive = rgbdGltf.meshes?.[0]?.primitives?.[0];
const rgbdAccessor = rgbdGltf.accessors?.[rgbdPrimitive?.attributes?.POSITION];
const rgbdColorAccessor = rgbdGltf.accessors?.[rgbdPrimitive?.attributes?.COLOR_0];
if (rgbdBytes.subarray(0, 4).toString("utf8") !== "glTF" ||
    rgbdBytes.readUInt32LE(16) !== 0x4e4f534a || rgbdPrimitive?.mode !== 0 ||
    rgbdAccessor?.count !== 99082 || rgbdColorAccessor?.count !== 99082 ||
    rgbdColorAccessor?.componentType !== 5121 || rgbdColorAccessor?.normalized !== true ||
    JSON.stringify(rgbdAccessor?.min) !==
      JSON.stringify([-0.6681762933731079, -2.9204978942871094, -1.5134373903274536]) ||
    JSON.stringify(rgbdAccessor?.max) !==
      JSON.stringify([0.05010315775871277, -1.7450001239776611, 0.6385984420776367]) ||
    rgbdGltf.asset?.extras?.geometrySha256 !==
      "b6a7286bb6d229441060c399f047744b8f19dca704d8e8eb9e5a7d6d543d950f" ||
    rgbdGltf.asset?.extras?.colorSourceSha256 !==
      "63de160ac463fa04768cd494c584d282ea25b130cf68f07c98999493d471b41e" ||
    rgbdGltf.asset?.extras?.axisTransform !== "source (x,y,z) -> Three.js (y,-z,-x)" ||
    rgbdGltf.asset?.extras?.colorJoin !==
      "rounded XYZ identity at 1e-6 · 99082/99082 exact crop matches" ||
    !rgbdGltf.asset?.extras?.colorEncoding?.includes("registered source RGB") ||
    rgbdBytes.length > 1_600_000) {
  throw new Error("RGB+D GLB does not match the 99,082-point Subject 001 evidence contract");
}
const rgbdBinaryAt = 28 + rgbdJsonBytes;
const rgbdColorView = rgbdGltf.bufferViews[rgbdColorAccessor.bufferView];
const rgbdColorAt = rgbdBinaryAt + (rgbdColorView.byteOffset || 0) +
  (rgbdColorAccessor.byteOffset || 0);
const rgbdUniqueColors = new Set();
let rgbdNonzeroColors = 0;
for (let i = 0; i < rgbdAccessor.count; i++) {
  const r = rgbdBytes[rgbdColorAt + i * 3];
  const g = rgbdBytes[rgbdColorAt + i * 3 + 1];
  const b = rgbdBytes[rgbdColorAt + i * 3 + 2];
  if (r || g || b) rgbdNonzeroColors++;
  if (i % 97 === 0) rgbdUniqueColors.add(`${r},${g},${b}`);
}
if (rgbdNonzeroColors < 90000 || rgbdUniqueColors.size < 100) {
  throw new Error("RGB+D registered colors are unexpectedly empty or nearly constant");
}

const worldMain = fs.readFileSync(path.join(root, "js/world/main.js"), "utf8");
if (!worldMain.includes('if (key === "rgbd" && o.isPoints)') ||
    !worldMain.includes('"registered-source-rgb"') ||
    !worldMain.includes("vertexColors: hasDisplayColors")) {
  throw new Error("RGB+D runtime must preserve and disclose its registered source colors");
}

const worldCarry = fs.readFileSync(path.join(root, "js/world/pipeline-carry.js"), "utf8");
const worldStations = fs.readFileSync(path.join(root, "js/world/stations.js"), "utf8");
const worldRail = fs.readFileSync(path.join(root, "js/world/rail.js"), "utf8");
const worldRoam = fs.readFileSync(path.join(root, "js/world/roam.js"), "utf8");
if (!worldRoam.includes("createAutoNavigator") ||
    !worldRoam.includes('steering.action === "jump"') ||
    !worldRoam.includes("autoNavigator.replan")) {
  throw new Error("Roam auto-travel must jump low obstacles and replan around tall ones");
}
const deploymentSim = fs.readFileSync(path.join(root, "js/world/deployment-sim.js"), "utf8");
const renderLifecycle = fs.readFileSync(path.join(root, "js/world/render-lifecycle.js"), "utf8");
const deviceTier = fs.readFileSync(path.join(root, "js/lib/device-tier.js"), "utf8");
const threePerf = fs.readFileSync(path.join(root, "js/lib/three-perf.js"), "utf8");
const mainStationsVersion = worldMain.match(/from "\.\/stations\.js\?v=([^"]+)"/)?.[1];
const carryStationsVersion = worldCarry.match(/from "\.\/stations\.js\?v=([^"]+)"/)?.[1];
if (!mainStationsVersion || mainStationsVersion !== carryStationsVersion) {
  throw new Error("World modules do not share one versioned stations.js instance");
}

/* Keep the public export on the verified open-world runtime rather than only
   checking that its files exist. These markers cover the device/performance
   policy, Station 05 turntable, and Station 08's low-FPS-safe lifecycle. */
const ranchHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");
if (!ranchHtml.includes('<button class="station-chip hud-mono ui"') ||
    !worldMain.includes("let stationRuntimeTime = 0") ||
    !worldMain.includes("frameMs - lastStationRuntimeFrameMs") ||
    !worldMain.includes("onResume: () =>") ||
    !worldMain.includes('render-lifecycle.js?v=20260823-step05-visible-spin-step08-continuous') ||
    !renderLifecycle.includes("onResume?.()") ||
    !deviceTier.includes("export class AdaptivePixelRatio") ||
    !threePerf.includes("export class ScreenSizeLod")) {
  throw new Error("Public ranch is missing the responsive, low-FPS-safe runtime contract");
}
if (!worldStations.includes("turntableSpeed = 0.35") ||
    !worldStations.includes("COMPARE_SAFE_FRAME_X = -2.6") ||
    !worldStations.includes("synchronized: true") ||
    !worldStations.includes("completingCycle = true") ||
    !worldStations.includes("isFinishing: !isActive && completingCycle") ||
    !deploymentSim.includes("deploymentReducedMotionStateAt") ||
    worldStations.includes("RESTART")) {
  throw new Error("Public Station 05/08 lifecycle contract is incomplete");
}
if (!worldRail.includes("activationPoints: [V(-40, 0, 2), V(-40, 0, 13)]") ||
    !worldRoam.includes("stationActivationPoints") ||
    !worldRoam.includes("for (const point of stationActivationPoints[i])") ||
    !worldRoam.includes("panels.showStation(i, { open: i !== 8 })") ||
    !worldRoam.includes("if (i === 8) faceExhibit(i)") ||
    !worldCarry.includes("if (nextStation === 8)") ||
    !worldCarry.includes("const deploymentActive = proximityStation === 8") ||
    !worldCarry.includes("const leavingDeployment = proximityStation === 8") ||
    !worldCarry.includes("DEPLOYMENT LOOP ACTIVE") ||
    worldCarry.includes("VIEW STEP 07 BEFORE DEPLOYMENT")) {
  throw new Error("Public Station 08 must activate beside both cameras and conveyor");
}

const deploymentRuntime = await import(
  `data:text/javascript;base64,${Buffer.from(deploymentSim).toString("base64")}`);
if (deploymentRuntime.deploymentStateAt(15).cycleIndex !== 1 ||
    deploymentRuntime.deploymentStateAt(8).phase !== "reconstruct" ||
    deploymentRuntime.deploymentStateAt(13.9).weightReady ||
    deploymentRuntime.deploymentStateAt(13.9).outputProgress >= 1 ||
    !deploymentRuntime.deploymentStateAt(14.2).weightReady ||
    deploymentRuntime.DEPLOYMENT_PERIOD - deploymentRuntime.DEPLOYMENT_RESULT_AT > 1 ||
    deploymentRuntime.deploymentReducedMotionStateAt(0).phase !== "capture" ||
    !deploymentRuntime.deploymentReducedMotionStateAt(30).weightReady ||
    deploymentRuntime.deploymentReducedMotionStateAt(1).activeFlash !== -1) {
  throw new Error("Public Station 08 deployment semantics failed executable checks");
}

const bytes = fs.readdirSync(root).reduce((sum, name) => sum + sizeOf(path.join(root, name)), 0);
function sizeOf(full) {
  const stat = fs.statSync(full);
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory() || path.basename(full) === ".git") return 0;
  return fs.readdirSync(full).reduce((sum, name) => sum + sizeOf(path.join(full, name)), 0);
}

console.log(`Public boundary verified: ${requiredPages.join(", ")}; ${(bytes / 1024 / 1024).toFixed(2)} MiB.`);
