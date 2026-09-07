/* Panels: DOM side-panel content per station, progress dots,
   and CSS2D in-world station markers (interactive chrome only —
   anything the recorder must capture lives in-scene as canvas planes). */

import * as THREE from "../../vendor/three.module.js";
import { CSS2DObject } from "../../vendor/CSS2DRenderer.js";
import { STATIONS } from "./rail.js?v=20260907-ranch-drive-v6";
import { IO, pad2 } from "./handoff-content.js?v=20260907-ranch-drive-v6";

/* All numbers are the paper's real results — do not edit casually. */
export const CONTENT = [
  {
    kicker: "STATION 00 · WELCOME",
    title: "Walk the pipeline.",
    body: "Agreement-Driven Multi-View 3D Reconstruction for Live Cattle Weight Estimation — by Rabin Dulal, Wenfeng Jia, Lihong Zheng, and Jane Quinn. This research preprint becomes an evidence trail from three RGB photos to a weight-estimation method evaluated on 103 cattle with 5-fold cross-validation.",
    chips: [],
    figures: []
  },
  {
    kicker: "STATION 01 · CAPTURE",
    title: "Three cameras, no scale.",
    body: "For each animal, the dataset provides matched left, right, and top RGB views. No scale, crush, contact, or depth sensor is required at inference.",
    chips: ["103 ANIMALS", "3 MATCHED VIEWS", "RGB ONLY"],
    figures: []
  },
  {
    kicker: "STATION 02 · SEGMENT",
    title: "One animal, zero background.",
    body: "SAM 3 isolates the animal in every view with the prompt “cattle or cow”. The boards cross-fade between the raw frame and its mask — everything that is not cow is discarded before 3D generation.",
    chips: ["SAM 3", "PROMPT “CATTLE OR COW”"],
    figures: []
  },
  {
    kicker: "STATION 03 · SINGLE-VIEW RECONSTRUCTION",
    title: "Watch one view become a 3D reconstruction.",
    body: "Only the masked left RGB view is submitted here; the right and top views remain beside the calf. The frame drives a real SAM-3D trajectory, replayed from sampler hooks rather than a synthetic morph. Stage 1 uses 50 denoising steps for sparse structure, then Stage 2 uses 25 structured-latent steps for model-predicted color. The completed single-view 3D result stays on this workcell. Once processing finishes, only the left view returns and rejoins the held pair, forming the three-view input for Station 04.",
    chips: ["REAL SINGLE-VIEW TRACE", "S1 FROZEN BESIDE S2", "MODEL-PREDICTED SH RGB"],
    figures: []
  },
  {
    kicker: "STATION 04 · MULTI-VIEW RECONSTRUCTION",
    title: "Reconstruct three views by agreement.",
    body: "Three masked views build one shared 3D animal. At each step, we compare each view's proposed update with their shared average. Closer updates get more weight. The method uses this fusion in both stages; the colored cloud here shows the recorded Stage-1 agreement field. Station 03 is a separate single-view baseline.",
    chips: ["ON-DEMAND 3-VIEW TRACE", "S1 SHARED AGREEMENT", "S2 MULTI-VIEW REFINEMENT"],
    figures: [{ src: "assets/figures/global_agreement.png", alt: "Global agreement over diffusion steps" }]
  },
  {
    kicker: "STATION 05 · COMPARE",
    title: "Same protocol, different geometry.",
    body: "Compare five reconstruction sources for the same animal: RGB+D, average fusion, entropy fusion, TRELLIS2, and agreement fusion. They share the paper's downstream feature extraction and evaluation protocol. The labels report results across 103 cattle. This is a comparison exhibit, separate from the image-to-weight inference pipeline.",
    chips: ["RGB+D · 99,082 POINTS · MAPE 6.77% · R² 0.65", "AVERAGE · MAPE 2.82% · R² 0.44", "ENTROPY · MAPE 2.73% · R² 0.47", "TRELLIS2 · MAPE 2.64% · R² 0.53", "AGREEMENT · MAPE 2.22% · R² 0.69"],
    figures: [{ src: "assets/figures/results/regression_MAPE.png", alt: "Dataset-level MAPE across weight-estimation models" }]
  },
  {
    kicker: "STATION 06 · FEATURES",
    title: "Body shape becomes a feature vector.",
    body: "The dais is an illustrative overlay computed from the 5941-point agreement payload in normalized model space (unit u). It mirrors the paper's five feature groups: global geometry (including box and hull), shape, coordinate percentiles, vertical density, and per-axis statistics. The paper's regression uses features extracted from each reconstructed point cloud; this world overlay is for inspection, not a Case 001 regression row.",
    chips: ["ILLUSTRATIVE OVERLAY", "5 PAPER FEATURE GROUPS", "FEATURES → ENSEMBLE"],
    families: ["GEOMETRY", "SHAPE", "PERCENTILES", "DENSITY", "STATISTICS", "HULL VIEW"],
    figures: []
  },
  {
    kicker: "STATION 07 · WEIGH",
    title: "From geometry to kilograms.",
    body: "The final exhibit reports 5-fold cross-validation on 103 animals: MAPE 2.22% ± 0.56, R² 0.69, MAE 9.16 kg. The paired bars compare MAPE on the left and sourced R² values on the right, so the last step focuses on evidence rather than repeating the ensemble mechanics.",
    chips: ["11 BASE REGRESSORS", "RIDGE META · α = 1.0", "5-FOLD CV"],
    figures: [{ src: "assets/figures/results/regression_R2.png", alt: "Dataset-level R squared comparison across weight-estimation models" }],
    links: [
      { href: "https://arxiv.org/abs/2601.17791", label: "PAPER · ARXIV 2601.17791", ext: true },
      { href: "agreement.html", label: "AGREEMENT 3D" },
      { href: "paper.html", label: "READ THE PAPER" }
    ]
  },
  {
    kicker: "STATION 08 · FUTURE",
    title: "Follow the automated factory line.",
    body: "Arriving beside either the camera gantry or the conveyor automatically starts the same factory sequence—no precise calf positioning is required. Three visible shutter bursts issue the recorded Case 001 cards in left → right → top order; they ride the northbound line into reconstruction and become the real 5,941-point 3D cow. That completed 3D result moves into estimation before the terminal shows 480 kg—an illustrative UI value, not model inference or a Case 001 result. Once capture starts, that pass always finishes; the 15-second line repeats while you remain anywhere in the Station 08 workcell.",
    chips: ["15S AUTO LOOP", "LEFT → RIGHT → TOP FLASH", "REAL 3D MOVES TO KG"],
    figures: []
  }
];

/* Pipeline intro rows — the method end-to-end, one row per station (0–8). */
const PIPELINE = [
  "WELCOME — RANCH GATE",
  "3×RGB CAPTURE — left · right · top",
  "SAM3 SEGMENTATION",
  "BASELINE · SINGLE-VIEW SAM3D",
  "AGREEMENT-DRIVEN MULTI-VIEW RECONSTRUCTION",
  "COMPARISON · FIVE RECONSTRUCTION SOURCES",
  "GEOMETRIC FEATURE EXTRACTION",
  "STACKED-ENSEMBLE WEIGHT REGRESSION",
  "SPATIAL RGB-TO-KG FACTORY LINE"
];

/* Evidence scope and one decisive interaction per stop. The world answers the
   question spatially; these short lines keep the reader from mistaking an
   illustrative Case 001 exhibit for the paper's dataset-level evaluation. */
const SCOPE = [
  "PAPER MAP",
  "CASE 001 · MATCHED RGB VIEWS",
  "CASE 001 · RGB / MASK",
  "CASE 001 · SINGLE-VIEW TRACE",
  "CASE 001 · MULTI-VIEW TRACE",
  "CASE 001 MODELS + DATASET METRICS",
  "ILLUSTRATIVE WORLD OVERLAY",
  "DATASET-LEVEL · 103 CATTLE · 5-FOLD CV",
  "SIMULATED DEPLOYMENT · CASE 001 REPLAY"
];

const TRY = [
  "Choose Begin or jump to the evidence you care about.",
  "Watch the three cameras fire and inspect the matched views.",
  "Compare each RGB view with the SAM 3 cutout.",
  "Scrub Stage 1 and Stage 2, then orbit the single-view reconstruction.",
  "Scrub both stages of the multi-view reconstruction and inspect the agreement evidence.",
  "Watch the synchronized turntable, then compare reconstruction sources under the same downstream protocol.",
  "Select a feature group to pin its normalized-space overlay.",
  "Orbit the paired bars and compare Agreement with RGB-D; these are cross-validation aggregates.",
  "Watch the repeating 1 LEFT → 2 RIGHT → 3 TOP shutter handoff, then follow the completed 3D cow into weight estimation."
];

export function initPanels({ panelEl, dotsEl, chipEl, onGoto, onFamily }) {
  function setPanelOpen(on, { returnFocus = false } = {}) {
    const focusWasInside = panelEl.contains(document.activeElement);
    panelEl.classList.toggle("open", on);
    panelEl.toggleAttribute("inert", !on);
    panelEl.setAttribute("aria-hidden", String(!on));
    chipEl.setAttribute("aria-expanded", String(on));
    if (!on && returnFocus && focusWasInside) chipEl.focus();
  }

  const closeButtonHTML = () =>
    `<button class="panel-close hud-mono" type="button" aria-label="Close station details">×</button>`;

  function wirePanelChrome() {
    panelEl.querySelector(".panel-close")?.addEventListener("click", () =>
      setPanelOpen(false, { returnFocus: true }));
  }

  chipEl.addEventListener("click", () => setPanelOpen(!panelEl.classList.contains("open")));

  /* progress dots, with a thin connector per pipeline leg between them */
  const legLinks = [];
  const dots = STATIONS.map((s, i) => {
    const b = document.createElement("button");
    b.className = "dot hud-mono";
    b.type = "button";
    b.textContent = s.num;
    b.title = `${s.num} · ${s.name}`;
    b.setAttribute("aria-label", `Go to station ${s.num} ${s.name}`);
    b.addEventListener("click", () => onGoto(i));
    dotsEl.appendChild(b);
    if (i < STATIONS.length - 1) {
      const link = document.createElement("span");
      link.className = "dot-link";
      link.setAttribute("aria-hidden", "true");   // decorative — dots carry the labels
      dotsEl.appendChild(link);
      legLinks.push(link);
    }
    return b;
  });

  function setDots(i) {
    dots.forEach((d, j) => d.classList.toggle("active", j === i));
  }

  /* stations seen this page load: filled dots + solid connectors answer
     "how much of the pipeline have I walked" at a glance */
  const visited = new Set();
  function refreshVisited() {
    dots.forEach((d, j) => d.classList.toggle("visited", visited.has(j)));
    legLinks.forEach((l, j) =>
      l.classList.toggle("solid", visited.has(j) && visited.has(j + 1)));
  }

  /* highlight the leg being traveled / dwelled, mirroring the ground chevrons */
  function setLeg(i) {
    legLinks.forEach((l, j) => l.classList.toggle("active", j === i));
  }

  const TOTAL = String(STATIONS.length - 1).padStart(2, "0");

  /* pipeline rows, shared by the overview panel and the gate panel */
  function pipelineRowsHTML() {
    return PIPELINE.map((label, i) =>
      `<button class="pipe-row hud-mono" type="button" data-station="${i}">` +
      `<span class="pipe-num">${i}</span><span>${label}</span></button>`).join("");
  }
  function wireRows() {
    panelEl.querySelectorAll(".pipe-row").forEach((b) =>
      b.addEventListener("click", () => onGoto(parseInt(b.dataset.station, 10))));
  }

  /* the three source RGB views, pinned across every station panel: the
     constant reminder that stations 1–8 are one animal's data moving through
     the pipeline. Brighter where the views are actively consumed (01–04). */
  function crumbStripHTML(i) {
    const views = ["left", "right", "top"];
    return `<button class="crumb-strip${i <= 4 ? " crumb-strip--hot" : ""}" ` +
      `type="button" title="The three source views — go to station 01">` +
      `<span class="crumb-label">SUBJECT · 3 VIEWS</span>` +
      views.map((v) =>
        /* thumbs, never case views: the full 1920×1080 sources are 10 MB for
           the trio and belong to stations 1–3 only (source-texture-policy) */
        `<img src="assets/world/thumbs/rgb_${v}.webp" alt="${v} camera view" ` +
        `width="44" height="30" decoding="async" loading="lazy">`
      ).join("") +
      `</button>`;
  }

  function showStation(i, { open = false } = {}) {
    if (i === 0) {
      showGate();
      if (!open) hidePanel();
      return;
    }
    visited.add(i);
    refreshVisited();
    const c = CONTENT[i];
    const figs = c.figures.map((f) =>
      `<img class="panel-fig" src="${f.src}" alt="${f.alt}" loading="lazy">`).join("");
    const chips = c.chips.map((t) => `<span class="chip hud-mono">${t}</span>`).join("");
    /* clickable feature-family chips (FEATURES station): pin an overlay family */
    const fam = (c.families || []).map((t, j) =>
      `<button class="chip chip-btn hud-mono" type="button" data-family="${j}">${t}</button>`).join("");
    const links = (c.links || []).map((l) =>
      `<a class="panel-link hud-mono" href="${l.href}"${l.ext ? ' target="_blank" rel="noopener"' : ""}>${l.label}</a>`).join("");
    /* IN/OUT footer: this station's place in the dataflow, both ends clickable */
    const io = IO[i];
    const ioRow = (tag, arrow, station, label) => station === null
      ? `<span class="io-row io-row--end"><span class="io-tag">${tag}</span>` +
        `<span class="io-arrow">${arrow}</span>${label}</span>`
      : `<button class="io-row" type="button" data-goto="${station}">` +
        `<span class="io-tag">${tag}</span><span class="io-arrow">${arrow}</span>` +
        `${pad2(station)} · ${label}</button>`;
    const ioHTML = io
      ? `<div class="io-footer">` +
        ioRow("IN", "←", io.in.from, io.in.label) +
        ioRow("OUT", "→", io.out.to, io.out.label) +
        `</div>`
      : "";
    panelEl.innerHTML = closeButtonHTML() +
      crumbStripHTML(i) +
      `<p class="panel-kicker hud-mono">${c.kicker}</p>` +
      `<p class="panel-scope hud-mono">${SCOPE[i]}</p>` +
      `<h2>${c.title}</h2>` +
      `<p class="panel-try"><span class="hud-mono">TRY</span> ${TRY[i]}</p>` +
      `<p class="panel-body">${c.body}</p>` +
      `<div class="chip-row">${chips}</div>` +
      (fam ? `<div class="chip-row chip-row--families">${fam}</div>` : "") +
      figs +
      (links ? `<div class="panel-links">${links}</div>` : "") +
      ioHTML;
    wirePanelChrome();
    panelEl.querySelector(".crumb-strip")
      .addEventListener("click", () => onGoto(1));
    panelEl.querySelectorAll(".io-row[data-goto]").forEach((b) =>
      b.addEventListener("click", () => onGoto(parseInt(b.dataset.goto, 10))));
    if (fam && onFamily) {
      panelEl.querySelectorAll(".chip-btn").forEach((b) =>
        b.addEventListener("click", () => {
          panelEl.querySelectorAll(".chip-btn").forEach((x) =>
            x.classList.toggle("active", x === b));
          onFamily(parseInt(b.dataset.family, 10));
        }));
    }
    setPanelOpen(open);
    chipEl.textContent = `${STATIONS[i].num} / ${TOTAL} — ${STATIONS[i].name} · DETAILS`;
    setDots(i);
    setLeg(i);   // every arrival path (rail, roam, tour) funnels through here
  }

  function hidePanel() {
    setPanelOpen(false);
  }

  /* station 0 — the ranch gate dwell reuses the pipeline rows panel */
  function showGate() {
    visited.add(0);
    refreshVisited();
    const c = CONTENT[0];
    panelEl.innerHTML = closeButtonHTML() +
      `<p class="panel-kicker hud-mono">${c.kicker}</p>` +
      `<p class="panel-scope hud-mono">${SCOPE[0]}</p>` +
      `<h2>${c.title}</h2>` +
      `<p class="panel-try"><span class="hud-mono">START</span> ${TRY[0]}</p>` +
      `<p class="panel-body">${c.body}</p>` +
      `<div class="pipe-rows">${pipelineRowsHTML()}</div>` +
      `<button id="btnStartTour" class="hud-mono" type="button">BEGIN → 01 CAPTURE</button>`;
    wirePanelChrome();
    wireRows();
    panelEl.querySelector("#btnStartTour").addEventListener("click", () => onGoto(1));
    setPanelOpen(true);
    chipEl.textContent = `00 / ${TOTAL} — ${STATIONS[0].name}`;
    setDots(0);
    setLeg(0);
  }

  /* overview "PIPELINE" panel: the method end-to-end, rows rail-travel */
  function showPipeline() {
    panelEl.innerHTML = closeButtonHTML() +
      `<p class="panel-kicker hud-mono">MV-SAM3D · PIPELINE</p>` +
      `<p class="panel-scope hud-mono">INTERACTIVE PAPER MAP</p>` +
      `<h2>Three cameras to kilograms.</h2>` +
      `<p class="panel-body">Follow three views through masks, agreement fusion, features and weight estimation. Steps 03 and 05 are comparison stops. Choose any station to inspect it; open DETAILS when you want to read more.</p>` +
      `<div class="pipe-rows">${pipelineRowsHTML()}</div>` +
      `<button id="btnStartTour" class="hud-mono" type="button">START AT THE GATE →</button>`;
    wirePanelChrome();
    wireRows();
    panelEl.querySelector("#btnStartTour").addEventListener("click", () => onGoto(0));
    setPanelOpen(true);
    setDots(-1);
    setLeg(-1);
  }

  /* FEATURES chips: drop the pinned highlight when the auto-cycle resumes */
  function clearFamilyActive() {
    panelEl.querySelectorAll(".chip-btn.active").forEach((b) => b.classList.remove("active"));
  }

  return { showStation, hidePanel, showPipeline, setDots, setLeg, clearFamilyActive };
}

/* floating numbered markers above each exhibit — clickable, rail-travel */
export function makeStationMarkers(scene, onGoto) {
  const markers = [];
  STATIONS.forEach((s, i) => {
    const el = document.createElement("button");
    el.className = "station-marker hud-mono";
    el.type = "button";
    el.dataset.station = i;
    el.setAttribute("aria-label", `Go to station ${s.num} ${s.name}`);
    el.innerHTML =
      `<span class="marker-num">${i}</span><span class="marker-name">${s.name}</span>`;
    el.addEventListener("click", () => onGoto(i));
    const obj = new CSS2DObject(el);
    /* Station 08's deployment console has a taller provenance header, so its
       marker is lifted clear of the in-scene truth labels. It also has to sit
       over the CONVEYOR rather than over `pos`: 08's dwell camera parks 1.4 u
       from pos and looks past it down the line, so a badge anchored at pos
       lands ~70 deg above the view axis and never appears during its own
       dwell. `look` is the thing the camera is actually aimed at, and sitting
       over the conveyor pushes the badge far enough down the view axis to
       clear the global nav bar as well. */
    const anchor = i === 8
      ? { x: s.look.x + 3, y: 6.35, z: s.pos.z }
      : { x: s.pos.x, y: 5.6, z: s.pos.z };
    obj.position.set(anchor.x, anchor.y, anchor.z);
    scene.add(obj);
    markers.push(el);
  });
  return markers;
}
