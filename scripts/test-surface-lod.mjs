import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const names = ["agreement", "average", "entropy", "trellis2"];
const expectedSourceTriangles = { agreement: 291056, average: 315732, entropy: 296590, trellis2: 491030 };
const componentType = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const itemSize = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function readGlb(file) {
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.toString("utf8", 0, 4), "glTF", `${file} must be a GLB`);
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8").trim());
  const binOffset = 20 + jsonLength + 8;
  const primitive = json.meshes[0].primitives[0];
  const getAccessor = (attributeName, accessorIndex = null) => {
    const accessor = json.accessors[accessorIndex ?? primitive.attributes[attributeName]];
    const view = json.bufferViews[accessor.bufferView];
    const Type = componentType[accessor.componentType];
    const tightStride = itemSize[accessor.type] * Type.BYTES_PER_ELEMENT;
    const stride = view.byteStride || tightStride;
    const values = [];
    for (let i = 0; i < accessor.count; i++) {
      const base = binOffset + (view.byteOffset || 0) + (accessor.byteOffset || 0) + i * stride;
      const row = [];
      for (let c = 0; c < itemSize[accessor.type]; c++) {
        row.push(new Type(bytes.buffer, bytes.byteOffset + base + c * Type.BYTES_PER_ELEMENT, 1)[0]);
      }
      values.push(row);
    }
    return { accessor, values };
  };
  return {
    primitive,
    position: getAccessor("POSITION"),
    index: getAccessor(null, primitive.indices),
    color: primitive.attributes.COLOR_0 === undefined ? null : getAccessor("COLOR_0"),
    normal: primitive.attributes.NORMAL === undefined ? null : getAccessor("NORMAL")
  };
}

function bounds(position) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const row of position.values) for (let axis = 0; axis < 3; axis++) {
    min[axis] = Math.min(min[axis], row[axis]);
    max[axis] = Math.max(max[axis], row[axis]);
  }
  return { min, max };
}

function boundaryEdgeCount(model) {
  const edgeUse = new Map();
  for (let i = 0; i < model.index.values.length; i += 3) {
    const triangle = model.index.values.slice(i, i + 3).map(([value]) => value);
    for (const [u, v] of [[triangle[0], triangle[1]], [triangle[1], triangle[2]], [triangle[2], triangle[0]]]) {
      const edge = [u, v].sort((x, y) => x - y).join(":");
      edgeUse.set(edge, (edgeUse.get(edge) || 0) + 1);
    }
  }
  return [...edgeUse.values()].filter((uses) => uses === 1).length;
}

for (const name of names) {
  const source = readGlb(path.join(root, "assets/cases/case_001/models", `${name}.glb`));
  const display = readGlb(path.join(root, "assets/cases/case_001/models/display", `${name}.glb`));
  assert.equal(source.index.values.length / 3, expectedSourceTriangles[name], `${name} source asset changed`);
  const displayTriangles = display.index.values.length / 3;
  assert.ok(displayTriangles >= 40000 && displayTriangles <= 60000,
    `${name} display surface must stay in the 40–60k triangle budget`);
  assert.ok(display.color && display.normal, `${name} display surface needs color and normal attributes`);

  const sourceBounds = bounds(source.position), displayBounds = bounds(display.position);
  for (let axis = 0; axis < 3; axis++) {
    const sourceExtent = sourceBounds.max[axis] - sourceBounds.min[axis];
    const displayExtent = displayBounds.max[axis] - displayBounds.min[axis];
    assert.ok(displayExtent >= sourceExtent * 0.95, `${name} bounds collapsed on axis ${axis}`);
  }

  const edgeUse = new Map(), coverage = new Set();
  for (let i = 0; i < display.index.values.length; i += 3) {
    const triangle = display.index.values.slice(i, i + 3).map(([value]) => value);
    for (const vertex of triangle) assert.ok(vertex >= 0 && vertex < display.position.values.length,
      `${name} display index is out of range`);
    const rows = triangle.map((vertex) => display.position.values[vertex]);
    const ab = rows[1].map((value, axis) => value - rows[0][axis]);
    const ac = rows[2].map((value, axis) => value - rows[0][axis]);
    assert.ok(Math.hypot(ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]) > 1e-10,
      `${name} display contains a degenerate face`);
    const centroid = [0, 0, 0];
    for (const row of rows) for (let axis = 0; axis < 3; axis++) centroid[axis] += row[axis] / 3;
    const cell = centroid.map((value, axis) => Math.min(3, Math.max(0,
      Math.floor((value - sourceBounds.min[axis]) / Math.max(sourceBounds.max[axis] - sourceBounds.min[axis], 1e-8) * 4))));
    coverage.add(cell.join(":"));
    for (const [u, v] of [[triangle[0], triangle[1]], [triangle[1], triangle[2]], [triangle[2], triangle[0]]]) {
      const edge = [u, v].sort((x, y) => x - y).join(":");
      edgeUse.set(edge, (edgeUse.get(edge) || 0) + 1);
    }
  }
  assert.ok([...edgeUse.values()].every((uses) => uses <= 2), `${name} display has non-manifold interior edges`);
  assert.ok(boundaryEdgeCount(display) <= boundaryEdgeCount(source) + 8,
    `${name} display introduced interior boundary holes`);
  if (name === "trellis2") assert.ok(boundaryEdgeCount(display) < 200,
    "Trellis2 texture seams must be welded before decimation, not reduced as isolated islands");
  assert.ok(coverage.size >= 40, `${name} display surface lost coarse spatial coverage`);

  for (const row of display.normal.values) {
    const length = Math.hypot(...row);
    assert.ok(Number.isFinite(length) && Math.abs(length - 1) < 1e-3, `${name} normals must be normalized`);
  }
  const colors = display.color.values.flat();
  assert.ok(colors.every(Number.isFinite), `${name} display colors must be finite`);
  const normalizedColors = display.color.accessor.normalized ? colors.map((value) => value / 255) : colors;
  assert.ok(normalizedColors.every((value) => value >= 0 && value <= 1), `${name} display colors must be normalized`);
}

console.log("Display surface GLBs verified: connected 40–60k triangle meshes, bounds, colors, normals, indices, and coverage.");
