/* chibi-body-core.js — pure-math builder for the one-piece calf body.
   No three.js import and no DOM access, so the exact same code runs on the
   main thread (sync fallback) or inside a Web Worker (the normal path —
   ~100 ms of SDF sampling + surface nets never touches the load path).

   Output is plain transferable typed arrays; the avatar module wraps them
   in a BufferGeometry. Normals are accumulated here too, so the main-thread
   assembly cost is a few milliseconds. */

/* Hereford-type markings, copied off the study animal in
   assets/cases/case_001/views/rgb_left.png: red-brown hide, white face,
   white underline/socks, dark hooves and muzzle. The earlier "brown head on a
   cream body" was that pattern inverted, which reads lamb, not calf. */
export const CALF_PALETTE = {
  coat: 0x6e3b28,     // Hereford red-brown
  cream: 0xf0e7d6,    // face / underline / socks (warm off-white, never pure)
  dark: 0x2b211b,     // hooves, nostrils, tail switch
  muzzle: 0xc9928c    // bare nose skin — pink, not cream
};
export const HIP_Y = 0.52;
export const LEG_XZ = [
  { x: -0.3, z: 0.38, phase: 0, front: true },       // FL
  { x: 0.3, z: 0.38, phase: Math.PI, front: true },  // FR
  { x: -0.3, z: -0.4, phase: Math.PI, front: false },// BL
  { x: 0.3, z: -0.4, phase: 0, front: false }        // BR
];

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const sstep = (a, b, x) => {
  const k = clamp((x - a) / (b - a), 0, 1);
  return k * k * (3 - 2 * k);
};

/* ---------- deterministic value noise (no Math.random: the worker and the
     sync fallback must paint byte-identical hides) ---------- */

function hash01(i, j, k) {
  let h = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(j | 0, 0x165667b1) ^ Math.imul(k | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}
function vnoise(x, y, z) {
  const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z);
  const fx = x - i, fy = y - j, fz = z - k;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  const lerp = (a, b, t) => a + (b - a) * t;
  const c00 = lerp(hash01(i, j, k), hash01(i + 1, j, k), ux);
  const c10 = lerp(hash01(i, j + 1, k), hash01(i + 1, j + 1, k), ux);
  const c01 = lerp(hash01(i, j, k + 1), hash01(i + 1, j, k + 1), ux);
  const c11 = lerp(hash01(i, j + 1, k + 1), hash01(i + 1, j + 1, k + 1), ux);
  return lerp(lerp(c00, c10, uy), lerp(c01, c11, uy), uz);
}
/* two octaves are enough: one to make the patch outline wander, one to fray it */
const fbm2 = (x, y, z) =>
  vnoise(x, y, z) * 0.72 + vnoise(x * 2.7 + 11.3, y * 2.7 + 5.1, z * 2.7 + 3.7) * 0.28;

/* ---------- SDF: torso + legs as one smooth union ---------- */

function smin(a, b, k) {
  const h = clamp(0.5 + 0.5 * (b - a) / k, 0, 1);
  return b + (a - b) * h - k * h * (1 - h);
}
function sdEllipsoid(px, py, pz, cx, cy, cz, rx, ry, rz) {
  const qx = (px - cx) / rx, qy = (py - cy) / ry, qz = (pz - cz) / rz;
  const k0 = Math.sqrt(qx * qx + qy * qy + qz * qz);
  const k1 = Math.sqrt((qx / rx) ** 2 + (qy / ry) ** 2 + (qz / rz) ** 2);
  return k1 > 1e-9 ? (k0 * (k0 - 1)) / k1 : -Math.min(rx, ry, rz);
}
function sdSphere(px, py, pz, cx, cy, cz, r) {
  return Math.hypot(px - cx, py - cy, pz - cz) - r;
}
function sdVCapsule(px, py, pz, cx, cz, y0, y1, r) {
  const y = clamp(py, y0, y1);
  return Math.hypot(px - cx, py - y, pz - cz) - r;
}

function calfSDF(x, y, z) {
  /* torso: main barrel + chest fill toward the (separate) big head */
  let d = sdEllipsoid(x, y, z, 0, 0.75, -0.02, 0.5, 0.4, 0.64);
  d = smin(d, sdEllipsoid(x, y, z, 0, 0.76, 0.3, 0.42, 0.35, 0.38), 0.1);
  for (const L of LEG_XZ) {
    /* leg column (round foot doubles as the hoof) + haunch bulge at the hip */
    d = smin(d, sdVCapsule(x, y, z, L.x, L.z, 0.1, HIP_Y, 0.1), 0.1);
    d = smin(d, sdSphere(x, y, z, L.x, HIP_Y + 0.02, L.z + (L.front ? 0.01 : -0.02),
      L.front ? 0.145 : 0.18), 0.11);
  }
  return d;
}

/* ---------- surface nets: one vertex per sign-change cell ---------- */

function extractSurface(sdf, min, max, cell) {
  const nx = Math.ceil((max[0] - min[0]) / cell) + 1;
  const ny = Math.ceil((max[1] - min[1]) / cell) + 1;
  const nz = Math.ceil((max[2] - min[2]) / cell) + 1;
  const val = new Float32Array(nx * ny * nz);
  const vid = (i, j, k) => (i * ny + j) * nz + k;
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++)
      for (let k = 0; k < nz; k++)
        val[vid(i, j, k)] = sdf(min[0] + i * cell, min[1] + j * cell, min[2] + k * cell);

  const cellVert = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const cid = (i, j, k) => (i * (ny - 1) + j) * (nz - 1) + k;
  const positions = [];
  const CORNERS = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  for (let i = 0; i < nx - 1; i++)
    for (let j = 0; j < ny - 1; j++)
      for (let k = 0; k < nz - 1; k++) {
        const v = CORNERS.map(([a, b, c]) => val[vid(i + a, j + b, k + c)]);
        let inside = 0;
        for (const s of v) if (s < 0) inside++;
        if (inside === 0 || inside === 8) continue;
        let px = 0, py = 0, pz = 0, n = 0;
        for (const [a, b] of EDGES) {
          if ((v[a] < 0) === (v[b] < 0)) continue;
          const t = v[a] / (v[a] - v[b]);
          px += CORNERS[a][0] + (CORNERS[b][0] - CORNERS[a][0]) * t;
          py += CORNERS[a][1] + (CORNERS[b][1] - CORNERS[a][1]) * t;
          pz += CORNERS[a][2] + (CORNERS[b][2] - CORNERS[a][2]) * t;
          n++;
        }
        cellVert[cid(i, j, k)] = positions.length / 3;
        positions.push(min[0] + (i + px / n) * cell, min[1] + (j + py / n) * cell, min[2] + (k + pz / n) * cell);
      }

  const index = [];
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) index.push(a, b, c, a, c, d);
    else index.push(a, c, b, a, d, c);
  };
  for (let i = 0; i < nx - 1; i++)
    for (let j = 0; j < ny - 1; j++)
      for (let k = 0; k < nz - 1; k++) {
        const s0 = val[vid(i, j, k)] < 0;
        if (i < nx - 2 && j > 0 && k > 0 && (val[vid(i + 1, j, k)] < 0) !== s0) {
          quad(cellVert[cid(i, j - 1, k - 1)], cellVert[cid(i, j, k - 1)],
            cellVert[cid(i, j, k)], cellVert[cid(i, j - 1, k)], s0);
        }
        if (j < ny - 2 && i > 0 && k > 0 && (val[vid(i, j + 1, k)] < 0) !== s0) {
          quad(cellVert[cid(i - 1, j, k - 1)], cellVert[cid(i - 1, j, k)],
            cellVert[cid(i, j, k)], cellVert[cid(i, j, k - 1)], s0);
        }
        if (k < nz - 2 && i > 0 && j > 0 && (val[vid(i, j, k + 1)] < 0) !== s0) {
          quad(cellVert[cid(i - 1, j - 1, k)], cellVert[cid(i, j - 1, k)],
            cellVert[cid(i, j, k)], cellVert[cid(i - 1, j, k)], s0);
        }
      }
  return { positions: new Float32Array(positions), index };
}

/* ---------- paint + auto-skin + normals ---------- */

/* sRGB hex → LINEAR floats. three's ColorManagement converts material .color
   for us but leaves vertex-color attributes alone (they are assumed to be in
   the working space already) — feeding raw sRGB in is what washed the old hide
   out to pale beige while the same hex on a material rendered rich brown. */
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const hexRGB = (h) => [
  srgbToLinear(((h >> 16) & 255) / 255),
  srgbToLinear(((h >> 8) & 255) / 255),
  srgbToLinear((h & 255) / 255)
];

/* Coat painter in RIG space (y = 0 at the hooves, +z forward), shared by the
   SDF hide and by the separate head sphere in chibi-cattle.js — so the white
   face runs down the throat and meets the brisket across the neck seam
   instead of stopping at a mesh boundary.

   Every boundary is a NARROW smoothstep (~0.06) offset by noise: hide markings
   have hard, ragged edges, and a wide falloff on a clean ellipsoid is what made
   the old patches look airbrushed. */
export function createCoatPainter(palette) {
  const pal = { ...CALF_PALETTE, ...(palette || {}) };
  const coat = hexRGB(pal.coat), cream = hexRGB(pal.cream), dark = hexRGB(pal.dark);
  const field = (x, y, z, cx, cy, cz, rx, ry, rz) =>
    ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 + ((z - cz) / rz) ** 2;

  return function paintCoat(x, y, z, out) {
    /* one warp drives every edge, so patches on the body and on the head fray
       with the same grain (big lobes + a fine fringe) */
    const warp = (fbm2(x * 2.6, y * 2.6, z * 2.6) - 0.5) * 0.6
      + (fbm2(x * 8.1 + 5.3, y * 8.1, z * 8.1 + 2.9) - 0.5) * 0.18;

    /* 1. underline: the belly and lower flank, cut by a wavy line. The ±0.02
          band is about two SDF cells — as hard as vertex colours can go before
          the edge starts showing triangles instead of hair. */
    const yLine = 0.5 + warp * 0.34;
    let white = 1 - sstep(yLine - 0.02, yLine + 0.02, y);
    /* 2. brisket tongue climbing the chest between the front legs */
    white = Math.max(white, 1 - sstep(0.95, 1.02,
      field(x, y, z, 0, 0.64, 0.5, 0.32, 0.3, 0.36) + warp));
    /* 3. white face — reaches past the head sphere down the throat, leaving
          the poll and cheeks red the way a Hereford's does */
    white = Math.max(white, 1 - sstep(0.95, 1.02,
      field(x, y, z, 0, 1.16, 0.8, 0.52, 0.42, 0.5) + warp * 0.8));
    /* 4. socks, below the knee */
    white = Math.max(white, 1 - sstep(0.31, 0.35, y + warp * 0.2));

    /* hide is never flat — a slow mottle keeps the red from reading as plastic */
    const shade = 0.93 + 0.13 * fbm2(x * 5.5 + 9.1, y * 5.5, z * 5.5);
    let r = coat[0] * shade, g = coat[1] * shade, b = coat[2] * shade;
    r += (cream[0] - r) * white; g += (cream[1] - g) * white; b += (cream[2] - b) * white;

    /* hooves last: they overwrite whatever the socks painted */
    const kHoof = 1 - sstep(0.11, 0.16, y + warp * 0.06);
    r += (dark[0] - r) * kHoof; g += (dark[1] - g) * kHoof; b += (dark[2] - b) * kHoof;

    out[0] = r; out[1] = g; out[2] = b;
    return out;
  };
}

export function buildCalfBodyData(palette) {
  const t0 = typeof performance !== "undefined" ? performance.now() : 0;
  const { positions, index } = extractSurface(calfSDF, [-0.66, -0.05, -0.86], [0.66, 1.3, 0.86], 0.022);
  const count = positions.length / 3;
  const color = new Float32Array(count * 3);
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  const paintCoat = createCoatPainter(palette);
  const rgb = [0, 0, 0];

  for (let v = 0; v < count; v++) {
    const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];

    paintCoat(x, y, z, rgb);
    color[v * 3] = rgb[0]; color[v * 3 + 1] = rgb[1]; color[v * 3 + 2] = rgb[2];

    /* skin: nearest leg's weight band below the hip, torso above */
    let wLeg = 0, boneIdx = 0;
    for (let li = 0; li < 4; li++) {
      const L = LEG_XZ[li];
      const w = (1 - sstep(0.14, 0.4, Math.hypot(x - L.x, z - L.z))) *
                (1 - sstep(HIP_Y - 0.04, HIP_Y + 0.18, y));
      if (w > wLeg) { wLeg = w; boneIdx = li + 1; }
    }
    wLeg = Math.min(1, wLeg * 1.2);
    skinIndex[v * 4] = boneIdx;
    skinWeight[v * 4] = wLeg;
    skinIndex[v * 4 + 1] = 0;
    skinWeight[v * 4 + 1] = 1 - wLeg;
  }

  /* smooth normals: accumulate face normals, then normalize */
  const normal = new Float32Array(count * 3);
  for (let f = 0; f < index.length; f += 3) {
    const a = index[f] * 3, b2 = index[f + 1] * 3, c = index[f + 2] * 3;
    const abx = positions[b2] - positions[a], aby = positions[b2 + 1] - positions[a + 1], abz = positions[b2 + 2] - positions[a + 2];
    const acx = positions[c] - positions[a], acy = positions[c + 1] - positions[a + 1], acz = positions[c + 2] - positions[a + 2];
    const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
    for (const vi of [a, b2, c]) {
      normal[vi] += nx; normal[vi + 1] += ny; normal[vi + 2] += nz;
    }
  }
  for (let v = 0; v < count; v++) {
    const l = Math.hypot(normal[v * 3], normal[v * 3 + 1], normal[v * 3 + 2]) || 1;
    normal[v * 3] /= l; normal[v * 3 + 1] /= l; normal[v * 3 + 2] /= l;
  }

  return {
    positions,
    normal,
    color,
    skinIndex,
    skinWeight,
    index: new Uint32Array(index),
    buildMs: (typeof performance !== "undefined" ? performance.now() : 0) - t0
  };
}
