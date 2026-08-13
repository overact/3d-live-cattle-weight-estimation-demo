# 3D Live Cattle Weight Estimation — Show Demo

**Agreement Ranch** is an interactive Three.js companion to *Agreement-Driven Multi-View 3D Reconstruction for Live Cattle Weight Estimation*. It turns the paper's RGB-to-3D-to-weight pipeline into a spatial walkthrough: follow matched left, right, and top views through segmentation, single-view reconstruction, agreement-driven multi-view fusion, geometric feature extraction, and downstream live-weight evaluation.

## Explore

- **Ranch** (`index.html`) — a guided walkthrough of the full evidence pipeline.
- **Agreement 3D** (`agreement.html`) — an interactive explorer for the recorded Stage-1 cross-view agreement field.
- **Paper** (`paper.html`) — the companion manuscript, evidence scope, links, and current citation.

The earlier Overview and Film pages are intentionally not included in this public repository or its deployment.

## Research status

The associated work is available as the [arXiv preprint](https://arxiv.org/abs/2601.17791) *Agreement-Driven Multi-View 3D Reconstruction for Live Cattle Weight Estimation* (arXiv:2601.17791, v1 submitted 25 January 2026). This repository does not claim an IEEE proceedings publication or formal ICIP publication. Conference and DOI metadata should be added only after an official publication record is available.

## Evidence and scope

The interactive case views and reconstruction traces are recorded research artifacts used to make the method inspectable. Headline weight-estimation values are dataset-level 5-fold cross-validation results over 103 cattle, not predictions for the single animal shown in the demo. Feature overlays are illustrative measurements in normalized model space, and the Station 08 `480 kg` readout is a simulated deployment UI value.

Reconstruction comparisons should be interpreted through the paper's visual evidence and downstream weight-estimation protocol. The demo does not claim direct geometric accuracy without corresponding ground-truth geometry metrics.

Case 001 source views originate from [CowDB](https://github.com/ruchaya/CowDB), the public cattle image database described by Ruchay et al., *MethodsX* 7 (2020), [doi:10.1016/j.mex.2020.100870](https://doi.org/10.1016/j.mex.2020.100870). Research artifacts and source data remain subject to their original rights; project maintainers should confirm redistribution terms before mirroring them elsewhere.

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
