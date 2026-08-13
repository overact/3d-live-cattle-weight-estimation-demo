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
  "assets/world/barn_big_quaternius.glb", "assets/world/fence_quaternius.glb",
  "assets/world/hay_quaternius.glb", "assets/world/pinetree_quaternius.glb",
  "assets/world/cow_quaternius.glb", "assets/world/thumbs/rgb_left.webp",
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
if (rgbdBytes.subarray(0, 4).toString("utf8") !== "glTF" ||
    rgbdBytes.readUInt32LE(16) !== 0x4e4f534a || rgbdPrimitive?.mode !== 0 ||
    rgbdPrimitive?.attributes?.COLOR_0 !== undefined || rgbdAccessor?.count !== 99082 ||
    rgbdGltf.asset?.extras?.sourceSha256 !==
      "b6a7286bb6d229441060c399f047744b8f19dca704d8e8eb9e5a7d6d543d950f" ||
    rgbdBytes.length > 1_300_000) {
  throw new Error("RGB+D GLB does not match the 99,082-point Subject 001 evidence contract");
}

const worldMain = fs.readFileSync(path.join(root, "js/world/main.js"), "utf8");
const worldCarry = fs.readFileSync(path.join(root, "js/world/pipeline-carry.js"), "utf8");
const mainStationsVersion = worldMain.match(/from "\.\/stations\.js\?v=([^"]+)"/)?.[1];
const carryStationsVersion = worldCarry.match(/from "\.\/stations\.js\?v=([^"]+)"/)?.[1];
if (!mainStationsVersion || mainStationsVersion !== carryStationsVersion) {
  throw new Error("World modules do not share one versioned stations.js instance");
}

const bytes = fs.readdirSync(root).reduce((sum, name) => sum + sizeOf(path.join(root, name)), 0);
function sizeOf(full) {
  const stat = fs.statSync(full);
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory() || path.basename(full) === ".git") return 0;
  return fs.readdirSync(full).reduce((sum, name) => sum + sizeOf(path.join(full, name)), 0);
}

console.log(`Public boundary verified: ${requiredPages.join(", ")}; ${(bytes / 1024 / 1024).toFixed(2)} MiB.`);
