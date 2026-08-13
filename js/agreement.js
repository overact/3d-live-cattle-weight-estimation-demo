/* MV-SAM3D agreement point-cloud viewer.
   Loads one static coordinate buffer (5941 voxels) plus a per-step
   agreement scalar matrix [51 x 5941] (~370 KB total — no PLY files
   are fetched at runtime), and recolors the cloud on the GPU through
   a colormap LUT texture. All failures are reported on screen. */

import * as THREE from "../vendor/three.module.js";
import { OrbitControls } from "../vendor/OrbitControls.js";

const wrap = document.getElementById("canvasWrap");

/* ---------- on-screen status / diagnostics ---------- */

const statusEl = document.createElement("div");
statusEl.style.cssText =
  "position:absolute;inset:0;display:grid;place-content:center;text-align:center;" +
  "gap:0.8rem;padding:2rem;font-family:'IBM Plex Mono',monospace;font-size:0.72rem;" +
  "letter-spacing:0.12em;color:#8b95a0;background:rgba(13,18,24,0.92);z-index:10;" +
  "white-space:pre-line";
statusEl.textContent = "LOADING DATA · ~370 KB";
wrap.appendChild(statusEl);

const showStatus = (msg) => { statusEl.textContent = msg; statusEl.style.display = "grid"; };
const showFatal = (msg, err) => {
  console.error(err || msg);
  statusEl.innerHTML =
    `<span style="color:#e4574b">VIEWER ERROR</span>` +
    `<span>${msg}</span>` +
    (err ? `<span style="color:#5c6873">${String(err).slice(0, 220)}</span>` : "") +
    `<span style="color:#5c6873">TRY A HARD REFRESH (CTRL+SHIFT+R) · CHROME/EDGE/FIREFOX RECOMMENDED</span>`;
};
const hideStatus = () => { statusEl.style.display = "none"; };

async function fetchOrThrow(url, as) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return as === "json" ? r.json() : r.arrayBuffer();
}

async function main() {
  /* WebGL availability check with a readable message */
  const probe = document.createElement("canvas");
  const gl = probe.getContext("webgl2") || probe.getContext("webgl");
  if (!gl) {
    showFatal("WEBGL IS NOT AVAILABLE IN THIS BROWSER / REMOTE SESSION.\nENABLE HARDWARE ACCELERATION OR TRY ANOTHER BROWSER.");
    return;
  }

  const canvas = document.getElementById("gl");
  const stepSlider = document.getElementById("stepSlider");
  const stepLabel = document.getElementById("stepLabel");
  const btnPlay = document.getElementById("btnPlay");
  const thrSlider = document.getElementById("thrSlider");
  const thrLabel = document.getElementById("thrLabel");
  const sizeSlider = document.getElementById("sizeSlider");
  const sizeLabel = document.getElementById("sizeLabel");
  const btnSpin = document.getElementById("btnSpin");
  const cmapPaper = document.getElementById("cmapPaper");
  const cmapBarn = document.getElementById("cmapBarn");
  const legendBar = document.getElementById("legendBar");
  const roStep = document.getElementById("roStep");
  const roMean = document.getElementById("roMean");
  const roVis = document.getElementById("roVis");
  const sparkLine = document.getElementById("sparkLine");
  const sparkHead = document.getElementById("sparkHead");

  /* ---------- data ----------
     Primary: raw .bin fetches. Some remote proxies strip binary bodies
     (0-byte responses), so fall back to base64 inside payload.json. */

  const b64ToBuf = (s) => {
    const bin = atob(s);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  };

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
    showStatus("BINARY FETCH FAILED · LOADING JSON FALLBACK · ~500 KB");
    meta = await fetchOrThrow("assets/agreement/payload.json", "json");
    ptsBuf = b64ToBuf(meta.pointsB64);
    agrBuf = b64ToBuf(meta.agreeB64);
  }

  const N = meta.count;
  const STEPS = meta.steps;
  if (ptsBuf.byteLength !== N * 12 || agrBuf.byteLength !== N * STEPS) {
    throw new Error(`payload size mismatch: pts ${ptsBuf.byteLength}B, agree ${agrBuf.byteLength}B for N=${N}, S=${STEPS}`);
  }
  const positions = new Float32Array(ptsBuf);
  const scalars = new Uint8Array(agrBuf);
  const current = new Uint8Array(N);

  stepSlider.max = STEPS - 1;

  /* ---------- colormaps ---------- */

  const lerp = (a, b, k) => a + (b - a) * k;

  function buildLUT(stops) {
    const data = new Uint8Array(256 * 4);
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

  const COOLWARM = [
    [0.0, 59, 76, 192], [0.125, 98, 130, 234], [0.25, 141, 176, 254],
    [0.375, 184, 208, 249], [0.5, 221, 221, 221], [0.625, 245, 196, 173],
    [0.75, 244, 154, 123], [0.875, 222, 96, 77], [1.0, 180, 4, 38]
  ];

  const NIGHTBARN = [
    [0.0, 32, 58, 84], [0.35, 134, 215, 234], [0.65, 237, 231, 218], [1.0, 227, 155, 45]
  ];

  const LUTS = { paper: buildLUT(COOLWARM), barn: buildLUT(NIGHTBARN) };

  const legendCSS = {
    paper: "linear-gradient(90deg, #3b4cc0, #8db0fe, #dddddd, #f49a7b, #b40426)",
    barn: "linear-gradient(90deg, #203a54, #86d7ea, #ede7da, #e39b2d)"
  };

  /* ---------- scene ---------- */

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1218);
  scene.fog = new THREE.Fog(0x0d1218, 3.5, 7);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 40);
  camera.position.set(1.9, 1.1, 1.9);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 1.1;
  controls.minDistance = 0.8;
  controls.maxDistance = 6;

  const grid = new THREE.GridHelper(4, 20, 0x2a3b47, 0x1a2731);
  scene.add(grid);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const scalarAttr = new THREE.BufferAttribute(current, 1, true);
  scalarAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("aScalar", scalarAttr);

  /* scalars are absolute agreement values; the colormap is stretched over
     the bake range [0.3, 1.0] so spatial contrast stays readable */
  const DOM_LO = 0.3, DOM_HI = 1.0;

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uSize: { value: 1.0 },
      uMin: { value: 0.0 },
      uDom: { value: new THREE.Vector2(DOM_LO, DOM_HI) },
      uLUT: { value: LUTS.paper }
    },
    vertexShader: /* glsl */ `
      attribute float aScalar;
      uniform float uSize;
      varying float vS;
      void main() {
        vS = aScalar;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = uSize * (36.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uLUT;
      uniform float uMin;
      uniform vec2 uDom;
      varying float vS;
      void main() {
        if (vS < uMin) discard;
        vec2 c = gl_PointCoord - 0.5;
        if (dot(c, c) > 0.25) discard;
        float x = clamp((vS - uDom.x) / (uDom.y - uDom.x), 0.0, 1.0);
        vec3 col = texture2D(uLUT, vec2(x, 0.5)).rgb;
        gl_FragColor = vec4(col, 1.0);
      }
    `
  });

  const points = new THREE.Points(geometry, material);
  /* voxel grid axes: the cow's long axis is stored along Y — lay it down,
     then roll around the long axis so the legs point down */
  points.rotation.z = -Math.PI / 2;
  points.rotation.x = -Math.PI / 2;
  scene.add(points);

  /* rest the grid just under the rotated cloud */
  const bbox = new THREE.Box3().setFromObject(points);
  grid.position.y = bbox.min.y - 0.06;

  /* ---------- sparkline ---------- */

  const W = 260, H = 56, PAD = 3;
  sparkLine.setAttribute(
    "points",
    meta.meanAgreement
      .map((v, i) => `${PAD + (i / (STEPS - 1)) * (W - 2 * PAD)},${H - PAD - v * (H - 2 * PAD)}`)
      .join(" ")
  );

  /* ---------- state ---------- */

  let step = 0;
  let playing = false;
  let lastAdvance = 0;

  function setStep(s) {
    step = Math.max(0, Math.min(STEPS - 1, s));
    current.set(scalars.subarray(step * N, (step + 1) * N));
    scalarAttr.needsUpdate = true;

    const label = String(step).padStart(2, "0");
    stepSlider.value = step;
    stepSlider.style.setProperty("--p", `${(step / (STEPS - 1)) * 100}%`);
    stepLabel.textContent = meta.stepLabels[step] === "last" ? "FINAL" : label;
    roStep.textContent = label;
    roMean.textContent = meta.meanAgreement[step].toFixed(2);
    sparkHead.setAttribute("x1", PAD + (step / (STEPS - 1)) * (W - 2 * PAD));
    sparkHead.setAttribute("x2", PAD + (step / (STEPS - 1)) * (W - 2 * PAD));
    updateVisible();
  }

  function updateVisible() {
    const thr = material.uniforms.uMin.value * 255;
    let n = 0;
    for (let i = 0; i < N; i++) if (current[i] >= thr) n++;
    roVis.textContent = `${Math.round((n / N) * 100)}%`;
  }

  function setPlaying(p) {
    playing = p;
    btnPlay.textContent = p ? "❚❚" : "▶";
  }

  /* ---------- wiring ---------- */

  stepSlider.addEventListener("input", () => {
    setPlaying(false);
    setStep(parseInt(stepSlider.value, 10));
  });

  btnPlay.addEventListener("click", () => setPlaying(!playing));

  thrSlider.addEventListener("input", () => {
    material.uniforms.uMin.value = parseFloat(thrSlider.value);
    thrLabel.textContent = parseFloat(thrSlider.value).toFixed(2);
    thrSlider.style.setProperty("--p", `${(thrSlider.value / 0.98) * 100}%`);
    updateVisible();
  });

  sizeSlider.addEventListener("input", () => {
    material.uniforms.uSize.value = parseFloat(sizeSlider.value);
    sizeLabel.textContent = parseFloat(sizeSlider.value).toFixed(1);
    sizeSlider.style.setProperty("--p", `${((sizeSlider.value - 0.4) / 2) * 100}%`);
  });

  btnSpin.addEventListener("click", () => {
    controls.autoRotate = !controls.autoRotate;
    btnSpin.classList.toggle("active", controls.autoRotate);
    btnSpin.setAttribute("aria-pressed", String(controls.autoRotate));
  });

  function setCmap(name) {
    material.uniforms.uLUT.value = LUTS[name];
    legendBar.style.background = legendCSS[name];
    cmapPaper.classList.toggle("active", name === "paper");
    cmapBarn.classList.toggle("active", name === "barn");
    cmapPaper.setAttribute("aria-selected", String(name === "paper"));
    cmapBarn.setAttribute("aria-selected", String(name === "barn"));
  }

  cmapPaper.addEventListener("click", () => setCmap("paper"));
  cmapBarn.addEventListener("click", () => setCmap("barn"));

  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" && e.key !== " ") return;
    if (e.key === " ") { e.preventDefault(); setPlaying(!playing); }
    if (e.key === "ArrowRight") { setPlaying(false); setStep(step + 1); }
    if (e.key === "ArrowLeft") { setPlaying(false); setStep(step - 1); }
  });

  /* ---------- resize + loop ---------- */

  function resize() {
    const w = wrap.clientWidth, h = wrap.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  new ResizeObserver(resize).observe(wrap);
  resize();

  renderer.setAnimationLoop((time) => {
    if (playing && time - lastAdvance > 110) {
      lastAdvance = time;
      setStep(step === STEPS - 1 ? 0 : step + 1);
    }
    controls.update();
    renderer.render(scene, camera);
  });

  hideStatus();
  setStep(0);
  setPlaying(true);
}

main().catch((err) => showFatal("FAILED TO INITIALISE THE POINT-CLOUD VIEWER.", err));
