/* obb-collider.js — ground-plane collision for a walking character against a
   static set of oriented boxes and circles. No three.js import and no scene
   knowledge: the host registers shapes in world XZ and asks for a corrected
   position, so the same set can serve a controller, a camera, or a QA probe.

     const world = createColliderSet();
     world.addSegment(x0, z0, x1, z1, 0.16, 1.1);   // a fence run
     world.addCircle(x, z, 0.9, 1.3);               // a hay bale
     const p = world.resolve(nextX, nextZ, 0.45, clearance);

   `top` and `clearance` are heights ABOVE LOCAL GROUND, not world Y: props sit
   on rolling terrain, so an absolute top would be wrong by the hill it stands
   on.

   Two deliberate properties:

   - Resolution is along the axis of LEAST penetration, which makes a character
     slide along a wall instead of stopping dead against it. Straight-line
     auto-run steering then finds gate openings on its own most of the time.
   - Every shape carries a `top` height and is skipped once the character's
     feet clear it, so a 1.1 u fence stays jumpable by a calf with a 1.5 u
     apex. Solid props just declare a top nobody can reach. */

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

export function createColliderSet() {
  const boxes = [];
  const circles = [];

  const set = {
    /* box centred at (x,z), half-extents along its own axes, yaw ry using the
       same convention as the scene's instance placements (local +X rotated by
       ry lands on (cos ry, −sin ry) in world XZ) */
    addBox(x, z, hx, hz, ry = 0, top = Infinity) {
      boxes.push({ x, z, hx, hz, top, cos: Math.cos(ry), sin: Math.sin(ry) });
      return set;
    },
    /* a wall run from (x0,z0) to (x1,z1) — the common case, and the reason
       fences register one box per LINE instead of one per rendered instance */
    addSegment(x0, z0, x1, z1, halfThickness = 0.16, top = Infinity) {
      const dx = x1 - x0, dz = z1 - z0;
      const len = Math.hypot(dx, dz);
      if (len < 1e-6) return set;
      return set.addBox((x0 + x1) / 2, (z0 + z1) / 2, len / 2, halfThickness,
        Math.atan2(-dz, dx), top);
    },
    addCircle(x, z, r, top = Infinity) {
      circles.push({ x, z, r, top });
      return set;
    },
    get count() { return boxes.length + circles.length; },

    /* Correct one ground position. `out` is reused by the caller's hot loop;
       `hit` reports whether anything pushed, which the host uses to notice a
       jammed auto-run. */
    resolve(x, z, radius, clearance = 0, out = { x: 0, z: 0, hit: false }) {
      out.x = x; out.z = z; out.hit = false;
      /* two passes: one push can shove the character into a neighbouring shape
         (fence corners, bale clusters) and a second pass settles it */
      for (let pass = 0; pass < 2; pass++) {
        let moved = false;
        for (const c of circles) {
          if (clearance > c.top) continue;
          const dx = out.x - c.x, dz = out.z - c.z;
          const d = Math.hypot(dx, dz);
          const reach = c.r + radius;
          if (d >= reach) continue;
          if (d < 1e-6) { out.x = c.x + reach; moved = true; continue; }
          out.x = c.x + (dx / d) * reach;
          out.z = c.z + (dz / d) * reach;
          moved = true;
        }
        for (const b of boxes) {
          if (clearance > b.top) continue;
          const dx = out.x - b.x, dz = out.z - b.z;
          const lx = dx * b.cos - dz * b.sin;
          const lz = dx * b.sin + dz * b.cos;
          if (Math.abs(lx) >= b.hx + radius || Math.abs(lz) >= b.hz + radius) continue;
          let nx = lx, nz = lz;
          if (Math.abs(lx) <= b.hx && Math.abs(lz) <= b.hz) {
            /* centre is inside: leave by the nearest face */
            if (b.hx + radius - Math.abs(lx) < b.hz + radius - Math.abs(lz)) {
              nx = Math.sign(lx || 1) * (b.hx + radius);
            } else {
              nz = Math.sign(lz || 1) * (b.hz + radius);
            }
          } else {
            const px = clamp(lx, -b.hx, b.hx), pz = clamp(lz, -b.hz, b.hz);
            const ox = lx - px, oz = lz - pz;
            const d = Math.hypot(ox, oz);
            if (d >= radius) continue;
            if (d < 1e-6) { nx = px + (b.hx + radius) * Math.sign(lx || 1); }
            else { nx = px + (ox / d) * radius; nz = pz + (oz / d) * radius; }
          }
          out.x = b.x + nx * b.cos + nz * b.sin;
          out.z = b.z - nx * b.sin + nz * b.cos;
          moved = true;
        }
        out.hit = out.hit || moved;
        if (!moved) break;
      }
      return out;
    }
  };
  return set;
}
