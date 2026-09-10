# 3D Live Cattle Weight Estimation — Show Demo

**Live Pages:** [Open Agreement Ranch](https://overact.github.io/3d-live-cattle-weight-estimation-demo/)

Quick access: [Ranch](https://overact.github.io/3d-live-cattle-weight-estimation-demo/) · [Agreement 3D](https://overact.github.io/3d-live-cattle-weight-estimation-demo/agreement.html) · [Paper](https://overact.github.io/3d-live-cattle-weight-estimation-demo/paper.html)

**Agreement Ranch** is an interactive Three.js companion to *Agreement-Driven Multi-View 3D Reconstruction for Live Cattle Weight Estimation*. Follow matched left, right, and top views through segmentation, agreement-driven multi-view fusion, geometric feature extraction, and downstream live-weight evaluation. Single-view reconstruction (03) and method comparison (05) are optional evidence stops, not prerequisites for the main pipeline.

## Explore

- **Ranch** (`index.html`) — a guided walkthrough of the full evidence pipeline, including an optional voice-paced cattle-led auto tour.
- **Agreement 3D** (`agreement.html`) — an interactive explorer for the recorded Stage-1 cross-view agreement field.
- **Paper** (`paper.html`) — the companion manuscript, evidence scope, links, and current citation.

The earlier Overview and Film pages are intentionally not included in this public repository or its deployment.

### Fullscreen

The ranch carries a fullscreen toggle in the top-right corner, deliberately outside the dock: the dock is trimmed to **AUTO EN** during the narrated tour and hidden outright in Gaming mode, where the toggle re-anchors above the footer buttons instead. Clicking the icon presents the whole page — world, HUD and narration — fullscreen and flips the icon to its exit state; **Esc** leaves fullscreen again. **V** does the same from the keyboard in every ranch mode (roam keeps F for the calf, the tour keeps T, Gaming mode keeps P/Q/R) and is inert on the poster and while typing. The control never guesses: it reads state back from `fullscreenchange`, so a native Esc exit re-syncs the icon, and while fullscreen is active a capture-phase guard consumes any page-visible **Esc** so the map toggle, the free-roam exit and the Gaming-mode exit wait for the next press. It hides itself on browsers without element fullscreen (iPhone Safari), and `?tour=1` keeps it out of the recorder frame.

The toggle is also the one fail-soft edge in the world module graph: it is imported on demand, so a host that cannot serve that file costs the button rather than the whole ranch. Every other import stays static, because the world cannot run without it — and a module that fails to fetch now reports itself on the poster (`WORLD RUNTIME FAILED TO LOAD`, with a **RETRY LOAD** that reloads through a fresh document URL) instead of leaving the page reading `CHECKING WEBGL…` with the reason visible only in the console. A first visit that is merely slow gets a plain `STILL FETCHING THE WORLD RUNTIME` note after 15 seconds.

That module is called `present-mode.js`, not `fullscreen.js`, on purpose: content blockers match request URLs, and a path ending in `fullscreen.js` is caught by filters aimed at fullscreen-interstitial ads — one visitor got `net::ERR_BLOCKED_BY_CLIENT` and a hidden button that way. Do not rename it back.

## Interactive auto tour

All three exhibition entrances arrive at **Step 00 with a manually controlled calf**. The English-voice entrance prepares the same playable starting point; press **T** / **AUTO EN** in the world to begin a continuously looping English presentation through Steps 00–08. Physical arrival starts each Step; departure waits for narration, exhibit playback, and any artifact handoff to finish. The tour plays nine local Sulafat recordings generated with `gemini-3.1-flash-tts-preview`; no API key or speech service is needed during playback. Muted, unavailable, or stalled audio falls back to a word-count-based subtitle reading interval. The deployment Step also waits for its kg-result event. The HUD voice control can mute or replay the current Step narration.

Station details start collapsed and open on demand. Desktop framing leaves room for an open inspector, while mobile controls wrap to keep navigation accessible. During a focused presentation, neighboring exhibits are hidden to reduce visual clutter and rendering work.

Surface models use display-only quadric-decimated GLBs (about 60,000 triangles each); source GLBs are unchanged. Add `?detail=full` to inspect original surface geometry. RGB+D keeps its native point samples. Display geometry and normalized feature overlays are presentation assets, not replacements for research measurements. Rebuild display assets with `python scripts/build-display-models.py` in an environment containing NumPy, trimesh, and Open3D; run `npm run verify` for regression and asset checks.

TRELLIS2's texture-seam vertices are welded after texture-to-linear-color baking and before decimation. This prevents disconnected texture islands from becoming sparse fragments; source geometry remains available unchanged in full-detail mode.

Automatic travel probes the same physical colliders used by the cattle controller. It jumps fences that fit below the authored clearance, steers around taller obstacles, and replans rather than dropping the visitor into manual control when a route stalls.

During narration, **0–8** and mouse Step selection redirect the calf without leaving the presentation. The old speech stops, the chosen Step is explained on arrival, and the sequence continues from there. Reselecting a Step replays it. Movement, jump, dash, an intentional scene drag, wheel zoom, or **TAKE CONTROL** still hand control back explicitly. Press **T** to resume narration from the nearest Step.

The visitor-facing auto tour is independent of the deterministic `?tour=1` capture route, which remains available for recorder and fixed-step QA workflows.

## Gaming mode — Agreement Sprint

Choose **GAMING MODE** on the opening screen or ranch dock. Race a 282 m trail through the actual ranch layout, with station landmarks and an open-world minimap. Both rivals run at 85% of their previous speed: 26/0.85 ≈ 30.6s and 31/0.85 ≈ 36.5s. Collect seven gates in order: left view, right view, top view, SAM3 masks, agreement fusion, shape features, and the weight-ensemble finish. View thumbnails become masks as the lap progresses.

Use **WASD / arrows** to move, **Shift** to run, **Space** to jump and **E** to dash. Thirteen obstacles include rails, hay bales and moving noise blocks; a hit adds 2s and briefly slows the calf. Leaving the trail also slows movement. Collect one held item at a time; **Q** or the item button activates a 3.5s speed boost, a one-hit mask shield, or a −3s clock bonus. Fusion adds a separate −2s bonus. After collecting the first six checkpoints, enter the black-and-white finish area from any direction; a missed line can be recovered by returning to it. The limit is 100s. Live position is physical progress; final ranking compares adjusted times. **P** pauses, **R** restarts, and **Esc** restores the pre-race ranch position. Touch controls are available. Leaving the browser pauses the clock and sound; resume explicitly.

Press **Space or Enter** on the race briefing to start, or on the pause/results panel to resume/replay. Space remains jump during a live race; holding the start key through the countdown does not trigger a jump. Race steering is calf-relative, independent of camera follow: tap for a small correction, hold to ramp smoothly to full turning rate over 0.3s, and release to stop turning immediately. Reversing starts a fresh gentle correction. Free-roam and narrated-tour controls are unchanged.

The next ordinary checkpoint auto-collects within 6 m, including a fast pass through that radius. You do not need to pass precisely through its arch, and the calf is never pulled off course. The first six checkpoints still collect in order; the final checkerboard uses its separate finish-area rule.

Soft looping ranch music and synthesized countdown, hoofbeat, jump, pickup, hit and finish sounds start only after a user gesture. The persistent SOUND button mutes both music and effects; pause and exit silence them, and music stops scheduling at the results screen. No audio downloads are needed. The browser stores the best time for this course version and mute preference only. Rival method names, medals and item effects are playful analogies, not scientific rankings or inference. Pure rules are covered by `npm run verify`; track, rival and HUD objects are reused across replays.

The single- and multi-RGB trace displays retain the recorded Gaussian centres and predicted colors. Stage-2 splats now track framebuffer size and lens zoom, with area-preserving low-tier sampling and slightly fuller coverage. This fixes display-induced sparsity; it does not invent mesh surfaces or recover geometry absent from the source reconstruction.

## Research status

The associated work is available as the [arXiv preprint](https://arxiv.org/abs/2601.17791) *Agreement-Driven Multi-View 3D Reconstruction for Live Cattle Weight Estimation* (arXiv:2601.17791, v1 submitted 25 January 2026). This repository does not claim an IEEE proceedings publication or formal ICIP publication. Conference and DOI metadata should be added only after an official publication record is available.

## Evidence and scope

The interactive case views and reconstruction traces are recorded research artifacts used to make the method inspectable. Headline weight-estimation values are dataset-level 5-fold cross-validation results over 103 cattle, not predictions for the single animal shown in the demo. Feature overlays are illustrative measurements in normalized model space, and the Station 08 `480 kg` readout is a simulated deployment UI value.

Reconstruction comparisons should be interpreted through the paper's visual evidence and downstream weight-estimation protocol. The demo does not claim direct geometric accuracy without corresponding ground-truth geometry metrics.

Case 001 source views and the Station 05 RGB+D baseline originate from [CowDB](https://github.com/ruchaya/CowDB), the public cattle database described by Ruchay et al., “Accurate body measurement of live cattle using three depth cameras and non-rigid 3-D shape recovery,” *Computers and Electronics in Agriculture* 179 (2020), 105821, [doi:10.1016/j.compag.2020.105821](https://doi.org/10.1016/j.compag.2020.105821). The RGB+D exhibit preserves all 99,082 Subject 001 cattle-crop samples in a compact glTF POINTS primitive. Although the crop PLY stores XYZ only, all crop coordinates match the full 651,264-point Subject 001 AutoAligned RGB cloud at six decimal places, allowing an exact registered-color join. Geometry is converted to the same `(width, height, length)` display axes as the other comparison assets with the right-handed transform `(y, -z, -x)`. Research artifacts and source data remain subject to their original rights; project maintainers should confirm redistribution terms before mirroring them elsewhere.

## Acknowledgements

This demo builds on the research and open-source implementations provided by:

- [MV-SAM3D](https://github.com/devinli123/MV-SAM3D), a multi-view 3D reconstruction framework extending SAM 3D Objects to multiple viewpoints.
- [SAM 3D Objects](https://github.com/facebookresearch/sam-3d-objects), the foundational single-image 3D object reconstruction model and codebase.

We thank the authors and maintainers of both projects for making their work and code available. Please consult the original repositories for their citation and license terms.

## Citation

Until an official proceedings record is available, cite the arXiv version:

```bibtex
@misc{dulal2026agreementdriven,
  title         = {Agreement-Driven Multi-View 3D Reconstruction for Live Cattle Weight Estimation},
  author        = {Dulal, Rabin and Jia, Wenfeng and Zheng, Lihong and Quinn, Jane},
  year          = {2026},
  eprint        = {2601.17791},
  archivePrefix = {arXiv},
  primaryClass  = {cs.CV},
  url           = {https://arxiv.org/abs/2601.17791}
}
```

## Run locally

This is a static site, but ES modules and binary assets require an HTTP server:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000/> in a WebGL 2-capable desktop browser.

## Public repository boundary

This repository is a clean, deployment-only export. It contains no previous project history, private data, local service files, development handoffs, experiment logs, or source videos. GitHub Pages publishes the static site directly from the `main` branch.

Third-party software, fonts, datasets, and world-asset notices are collected in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and [`assets/world/LICENSES.md`](assets/world/LICENSES.md).
