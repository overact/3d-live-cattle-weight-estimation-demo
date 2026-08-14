/* Rail: station geometry, the master camera curve, and the tour timeline.
   One t-parameterized clock drives both the interactive tour and (later)
   the deterministic video recorder. */

import * as THREE from "../../vendor/three.module.js";

const V = (x, y, z) => new THREE.Vector3(x, y, z);

/* Station layout — S-curve across a 160x160 dusk pasture.
   pos: exhibit anchor on the ground. look: camera aim point.
   cam: default dwell camera position. dwell: tour hold seconds. */
export const STATIONS = [
  { id: "gate",        num: "00", name: "WELCOME",     pos: V(-48, 0,  42), look: V(-51.0, 2.45, 39.2), cam: V(-57.2, 4.2, 47.0), dwell: 8  },
  /* Front-on through the west gate: the capture fence reads as a square pen
     instead of a skewed diamond, and the guided calf spawns on its real entry. */
  { id: "capture",     num: "01", name: "CAPTURE",     pos: V(-30, 0,  35), look: V(-30, 1.4,  35), cam: V(-39.5, 4.2, 35.0), dwell: 7  },
  { id: "segment",     num: "02", name: "SEGMENT",     pos: V(-10, 0,  18), look: V(-10, 1.9,  18), cam: V(-14.5, 3.5, 26.5), dwell: 7  },
  { id: "reconstruct", num: "03", name: "SINGLE-VIEW RECON", pos: V( 12, 0,  26), look: V( 12, 1.7,  26), cam: V(  6.0, 3.6, 32.5), dwell: 7  },
  { id: "fusion",      num: "04", name: "MULTI-VIEW RECON",  pos: V( 30, 0,   4), look: V( 30, 2.4,   4), cam: V( 22.0, 4.5, 10.5), dwell: 11 },
  { id: "compare",     num: "05", name: "COMPARE",     pos: V( 14, 0, -18), look: V( 14, 1.4, -18), cam: V( 14.0, 4.0, -7.0), dwell: 9  },
  /* The southern method loop stays spacious without forcing 07→08 into a
     long backtracking hook: 05→06 bends south-west, then 06→07 turns north-
     west and naturally feeds the future line. */
  { id: "features",    num: "06", name: "FEATURES",    pos: V( -4, 0, -38), look: V( -4, 2.2, -38), cam: V(  2.0, 4.0,-29.0), dwell: 11 },
  /* The exhibit faces whoever WALKS here, and they always arrive from 06 to
     the south-east. `cam` is what stations.js faceCam yaws the boards toward,
     so the dwell camera and the visitor have to stand on the same side; with
     cam to the north-east the walk-up came in 120° behind the results board
     and, since every board is a FrontSide plane, saw nothing at all. Facing
     south-east puts the walk-up at ~12° off-front and costs only a shorter
     06→07 rail leg. Also closer and higher than the old 14.2 u / 6.4° pose,
     which made the world's widest exhibit read small and flat next to 01-06:
     now 13.5 u at 10.9°, back in family.
     (The barn no longer stands behind this exhibit — see environment.js.) */
  { id: "weigh",       num: "07", name: "WEIGH",       pos: V(-18, 0, -22), look: V(-18, 2.6, -22), cam: V(-7.2, 5.2, -30.1), dwell: 11 },
  /* The walk target stays east of the paddock. The northbound deployment line
     sits beyond the north fence; look/cam frame it from its clear east side. */
  { id: "future",      num: "08", name: "FUTURE",      pos: V(-28, 0, 14), look: V(-40, 2.1, 14), cam: V(-27.5, 5.0, 14), dwell: 10 }
];

/* Keep the ranch readable behind the opening guide and give free-explore a
   clearer plan view. Higher and steeper than it was (44.5° above the ground
   vs 40.6°), and aimed at the station centroid (-9, 2) rather than the world
   origin, so all nine stations sit inside the frame with air around them.
   Height rather than distance does the widening on purpose: the fog reaches
   full strength at 165 u, so backing the camera off instead would have washed
   the whole ranch grey. */
export const OVERVIEW = { pos: V(2, 68, 62), target: V(-9, 0, 2) };

/* Curve through dwell cameras with lifted flyover waypoints between. */
const railPts = [];
for (let i = 0; i < STATIONS.length; i++) {
  railPts.push(STATIONS[i].cam);
  if (i < STATIONS.length - 1) {
    const mid = STATIONS[i].cam.clone().lerp(STATIONS[i + 1].cam, 0.5);
    mid.y += 2.4;
    railPts.push(mid);
  }
}
const curve = new THREE.CatmullRomCurve3(railPts, false, "centripetal", 0.5);
/* getPoint(t) passes through control point i exactly at t = i/(n-1) */
const stationT = (i) => (2 * i) / (railPts.length - 1);
const ARC_DIVS = 360;
const arcLengths = curve.getLengths(ARC_DIVS);
const totalArcLength = arcLengths[arcLengths.length - 1] || 1;
const tToArcU = (t) => {
  const x = clamp01(t) * ARC_DIVS;
  const i = Math.min(ARC_DIVS - 1, Math.max(0, Math.floor(x)));
  const f = x - i;
  return ((arcLengths[i] || 0) + ((arcLengths[i + 1] || arcLengths[i]) - (arcLengths[i] || 0)) * f) / totalArcLength;
};
const stationU = (i) => tToArcU(stationT(i));

export const clamp01 = (x) => Math.min(1, Math.max(0, x));
export const smoothstep = (a, b, x) => {
  const k = clamp01((x - a) / (b - a));
  return k * k * (3 - 2 * k);
};
const ease = (k) => smoothstep(0, 1, k);

/* Camera pose while parked at a station: slow deterministic azimuth
   drift around the look point, so dwells feel alive in the tour. */
export function dwellPose(i, u) {
  const s = STATIONS[i];
  const off = s.cam.clone().sub(s.look);
  const r = Math.hypot(off.x, off.z);
  const az = Math.atan2(off.z, off.x) - 0.22 + 0.44 * clamp01(u / s.dwell);
  return {
    pos: V(s.look.x + r * Math.cos(az), s.cam.y, s.look.z + r * Math.sin(az)),
    target: s.look.clone()
  };
}

function railPose(a, b, k) {
  const t = stationT(a) + (stationT(b) - stationT(a)) * k;
  return {
    pos: curve.getPoint(clamp01(t) === t ? t : clamp01(t)),
    target: STATIONS[a].look.clone().lerp(STATIONS[b].look, ease(k))
  };
}

/* Travel along the rail from station a to b, blending in/out of the
   given endpoint poses (camera may have been orbited off the rail). */
export function travelPose(a, b, k, fromPose, toPose) {
  const ke = ease(k);
  const base = railPose(a, b, ke);
  if (fromPose) {
    const d = fromPose.pos.clone().sub(railPose(a, b, 0).pos);
    base.pos.addScaledVector(d, 1 - smoothstep(0, 0.35, ke));
    const dt = fromPose.target.clone().sub(STATIONS[a].look);
    base.target.addScaledVector(dt, 1 - smoothstep(0, 0.35, ke));
  }
  if (toPose) {
    const d = toPose.pos.clone().sub(railPose(a, b, 1).pos);
    base.pos.addScaledVector(d, smoothstep(0.65, 1, ke));
    const dt = toPose.target.clone().sub(STATIONS[b].look);
    base.target.addScaledVector(dt, smoothstep(0.65, 1, ke));
  }
  return base;
}

/* Continuous long-hop travel across several stations. Easing is applied once
   over the whole hop, so the camera does not slow down at intermediate stops.
   The target looks ahead along the route and settles onto the destination only
   near arrival. */
export function pathTravelPose(a, b, k, fromPose, toPose) {
  const ke = clamp01(k);
  const dir = Math.sign(b - a) || 1;
  const t0 = stationT(a), t1 = stationT(b);
  const u0 = stationU(a), u1 = stationU(b);
  const ru = u0 + (u1 - u0) * ke;
  const pos = curve.getPointAt(clamp01(ru));

  const lookAtIndex = (x) => {
    const clamped = Math.min(STATIONS.length - 1, Math.max(0, x));
    const lo = Math.floor(clamped), hi = Math.ceil(clamped);
    return STATIONS[lo].look.clone().lerp(STATIONS[hi].look, clamped - lo);
  };
  const legs = Math.max(1, Math.abs(b - a));
  const lookAhead = dir * Math.min(0.72, 0.55 + 0.25 / legs);
  let target = lookAtIndex(a + (b - a) * ke + lookAhead);
  target.lerp(STATIONS[b].look, smoothstep(0.8, 1, ke));

  if (fromPose) {
    const start = curve.getPointAt(u0);
    pos.addScaledVector(fromPose.pos.clone().sub(start), 1 - smoothstep(0, 0.24, ke));
    target.addScaledVector(fromPose.target.clone().sub(STATIONS[a].look), 1 - smoothstep(0, 0.24, ke));
  }
  if (toPose) {
    const end = curve.getPointAt(u1);
    pos.addScaledVector(toPose.pos.clone().sub(end), smoothstep(0.78, 1, ke));
    target.addScaledVector(toPose.target.clone().sub(STATIONS[b].look), smoothstep(0.78, 1, ke));
  }
  return { pos, target };
}

/* Raised quadratic arc between two arbitrary poses (intro fly-in,
   overview shots, dot-teleports from off-rail states). */
export function arcPose(from, to, k, lift = 6) {
  const ke = ease(k);
  const mid = from.pos.clone().lerp(to.pos, 0.5);
  mid.y = Math.max(mid.y, Math.max(from.pos.y, to.pos.y)) + lift;
  const p1 = from.pos.clone().lerp(mid, ke);
  const p2 = mid.clone().lerp(to.pos, ke);
  return {
    pos: p1.lerp(p2, ke),
    target: from.target.clone().lerp(to.target, ease(ke))
  };
}

/* ---------- tour timeline (?tour=1, and the future recorder) ---------- */

const FLY_IN = 4, LEG = 3.5, HOLD = 2;

export function buildTimeline() {
  const segs = [];
  let t = 0;
  segs.push({ type: "flyin", t0: t, t1: (t += FLY_IN) });
  STATIONS.forEach((s, i) => {
    segs.push({ type: "dwell", i, t0: t, t1: (t += s.dwell) });
    if (i < STATIONS.length - 1) segs.push({ type: "travel", i, t0: t, t1: (t += LEG) });
  });
  segs.push({ type: "hold", t0: t, t1: (t += HOLD) });
  return { segs, duration: t };
}

export function poseAt(timeline, t) {
  const tt = Math.min(Math.max(t, 0), timeline.duration - 1e-4);
  const seg = timeline.segs.find((s) => tt >= s.t0 && tt < s.t1) ||
    timeline.segs[timeline.segs.length - 1];
  const k = (tt - seg.t0) / (seg.t1 - seg.t0);
  switch (seg.type) {
    case "flyin":
      return { ...arcPose(OVERVIEW, dwellPose(0, 0), k, 4), station: k > 0.85 ? 0 : null };
    case "dwell":
      return { ...dwellPose(seg.i, tt - seg.t0), station: seg.i };
    case "travel":
      return {
        ...travelPose(seg.i, seg.i + 1, k,
          dwellPose(seg.i, STATIONS[seg.i].dwell), dwellPose(seg.i + 1, 0)),
        station: null,
        leg: seg.i   // which handoff the tour is riding — drives the caption
      };
    default: /* hold */
      return { ...dwellPose(STATIONS.length - 1, STATIONS[STATIONS.length - 1].dwell), station: STATIONS.length - 1 };
  }
}
