/* Handoff content: what flows OUT of station i and INTO station i+1.
   Single source of truth for three surfaces — the travel caption
   (travel-caption.js), the panel IN/OUT footers (panels.js) and the in-world
   plaques (stations.js) — so they can never disagree about the pipeline. */

export const pad2 = (i) => String(i).padStart(2, "0");

/* LEGS[i] narrates the handoff on the leg between station i and i+1. Shown
   for travel in EITHER direction: the camera may ride backwards, the data
   does not. */
export const LEGS = [
  "00 → 01 · through the gate — three cameras wait in the pen",
  "01 → 02 · three RGB views head off to SAM-3 masking",
  "02 → 03 · left enters single-view SAM3D; right + top stay with the calf",
  "03 → 04 · left rejoins the held pair; three masked views continue",
  "04 → 05 · the multi-view result lines up against three reconstruction rivals",
  "05 → 06 · winning geometry gives up girth, area, volume",
  "06 → 07 · measurements step onto the scale — kilograms out",
  "07 → 08 · evaluated regression result enters a simulated ranch workflow"
];

/* A hop across several stations is a seek, not a single handoff. */
export const hopCaption = (a, b) =>
  `${pad2(a)} → ${pad2(b)} · ${b > a ? "fast-forwarding" : "rewinding"} the pipeline`;

/* IO[i]: what station i consumes and what it hands on. `to: null` marks a
   terminal output with no station to travel to. Station 00 is null — the
   gate panel's BEGIN CTA already is its OUT affordance. */
export const IO = [
  null,
  { in: { from: 0, label: "a visitor" },               out: { to: 2, label: "three RGB frames" } },
  { in: { from: 1, label: "RGB triptych" },            out: { to: 3, label: "masked cattle RGB views" } },
  { in: { from: 2, label: "left masked view · right + top held" }, out: { to: 4, label: "reunited masked RGB triptych" } },
  { in: { from: 3, label: "three masked RGB views" },  out: { to: 5, label: "multi-view 3D result" } },
  { in: { from: 4, label: "multi-view result + three rivals" }, out: { to: 6, label: "chosen agreement model" } },
  { in: { from: 5, label: "winning cloud" },           out: { to: 7, label: "feature vector" } },
  { in: { from: 6, label: "features" },                out: { to: 8, label: "evaluated regression result" } },
  { in: { from: 7, label: "evaluated regression result" }, out: { to: null, label: "simulated future workflow" } }
];
