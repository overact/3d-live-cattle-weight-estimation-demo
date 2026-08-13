/* Declarative content contract for the Station 0 ranch-gate method map.
   The renderer owns the Canvas2D marks; this module keeps the method order,
   concise labels, and icon vocabulary independently testable. */

export const PRIMARY_PIPELINE_IDS = [
  "capture",
  "segment",
  "reconstruct",
  "fusion",
  "features",
  "weigh"
];

export const PIPELINE_NODES = [
  { id: "capture", label: "RGB", token: "triptych" },
  { id: "segment", label: "SAM3 masks", token: "masks" },
  { id: "reconstruct", label: "single-view reconstruction", token: "point-cow" },
  { id: "fusion", label: "multi-view agreement reconstruction", token: "merge" },
  { id: "features", label: "geometric features", token: "measure" },
  { id: "weigh", label: "kg", token: "weight" }
];

export const PIPELINE_BRANCHES = [
  { id: "compare", from: "fusion", kind: "evidence" },
  { id: "future", from: "weigh", kind: "future" }
];
