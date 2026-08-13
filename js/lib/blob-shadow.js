/* blob-shadow.js — the one soft contact shadow the whole demo uses.

   The forward renderer casts no real shadows (light budget, see three-perf.js),
   so every grounded character fakes one with a flat disc. Two call sites need
   different ownership, hence two exports:

     softBlobTexture()      — bare ramp; the caller builds its own material
                              because it animates opacity (the player calf
                              fades/shrinks the blob mid-jump).
     createBlobShadow(r)    — ready ground-facing mesh for static shadows;
                              .clone() it to add more, since Mesh.clone()
                              shares geometry + material by reference.

   Both hand out FRESH textures, so ownership is always the caller's: whoever
   called dispose()s. Nothing here is module-level shared state. */

import * as THREE from "../../vendor/three.module.js";

/* 64² alpha ramp for the blob shadow. A flat disc reads as a sticker under a
   soft-lit toy; the falloff costs one tiny texture and no extra draw call. */
export function softBlobTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(0,0,0,1)");
  g.addColorStop(0.5, "rgba(0,0,0,0.86)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/* CircleGeometry's UVs put the rim exactly on the ramp's transparent edge, so
   the disc radius and the falloff stay in step whatever `radius` is. */
export function createBlobShadow(radius = 0.8, opacity = 0.34) {
  const mesh = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 20),
    new THREE.MeshBasicMaterial({
      color: 0x000000, map: softBlobTexture(), transparent: true,
      opacity, depthWrite: false
    })
  );
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}
