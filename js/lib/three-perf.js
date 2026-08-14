/* three-perf.js — reusable three.js performance utilities (no app coupling).
   Drop into any project; only the THREE import path below is project-specific.

   - LightRig:        budget punctual lights — only the ones near the active
                      "slot" stay visible, so forward-rendered materials are
                      compiled/evaluated against a handful of lights, not all.
   - PanelThrottle:   redraw gate for dynamic CanvasTexture panels. needsUpdate
                      re-uploads the WHOLE texture, so cap the rate and freeze
                      the panel entirely while its exhibit is not in focus.
   - instanceTemplate: bake a (possibly multi-mesh) GLB template into one
                      InstancedMesh per source mesh — N placements collapse
                      from N draw calls per mesh to 1. */

import * as THREE from "../../vendor/three.module.js";

/* Punctual-light budget keyed by an integer slot (e.g. station index).
   setFocus(i): slots within `span` of i stay visible; setFocus(-1|null):
   everything visible (overview / intro). Toggling visibility changes the
   compiled light count — three.js caches one program per count, so after
   the first few transitions every variant is warm. */
export class LightRig {
  constructor(span = 1) {
    this.span = span;
    this.slots = new Map();   // slot -> Light[]
  }
  add(slot, ...lights) {
    if (!this.slots.has(slot)) this.slots.set(slot, []);
    this.slots.get(slot).push(...lights);
  }
  setFocus(i) {
    this._focus = i;
    const all = i == null || i < 0;
    for (const [slot, lights] of this.slots) {
      const on = all || Math.abs(slot - i) <= this.span;
      for (const l of lights) l.visible = on;
    }
  }

  /* Compile one program set per distinct lit-spot COUNT, up front.

     three.js keys its program cache on the number of lights of each type in
     the scene, so every time setFocus changes how many spots are visible, the
     next frame recompiles every lit material in view. Measured on the first
     walk into station 01's gantry: overview lights all 12 spots, the station
     dwell lights 3, and that transition compiled 10 new programs inside a
     single 532 ms frame — the stall a visitor feels exactly once per session,
     at the worst possible moment.

     Distinct COUNTS are what matters, not distinct focus values: focus 2 and
     focus 3 both light three slots and share a program set. There are only a
     handful, so this is a few compiles paid behind the loading screen. */
  prewarm(renderer, scene, camera) {
    const previous = this._focus ?? null;
    const seen = new Set();
    let compiled = 0;
    for (const focus of [null, ...this.slots.keys()]) {
      this.setFocus(focus);
      let lit = 0;
      for (const lights of this.slots.values()) {
        for (const l of lights) if (l.visible) lit++;
      }
      if (seen.has(lit)) continue;
      seen.add(lit);
      renderer.compile(scene, camera);
      compiled++;
    }
    this.setFocus(previous);
    return { configurations: compiled };
  }
}

/* Redraw gate for dynamic canvas-textured panels.
   const gate = new PanelThrottle(8);          // max 8 redraws/second
   if (gate.due(t, isActive)) { redraw(); }    // false while inactive
   Frozen panels keep their last texture, which is what a far-away or
   out-of-focus board should look like anyway. */
export class PanelThrottle {
  constructor(hz = 8) {
    this.interval = 1 / hz;
    this.last = -Infinity;
  }
  due(t, active = true) {
    if (!active) return false;
    /* seeking backwards (tour scrub) must not freeze the panel */
    if (t < this.last || t - this.last >= this.interval) {
      this.last = t;
      return true;
    }
    return false;
  }
}

/* Bake a template Object3D (e.g. a loaded GLB scene) into InstancedMeshes.
   placements: [{ x, z, ry?, scale?, y? }]. When `y` is omitted the instance
   rests on groundFn(x, z) exactly like a per-clone bbox settle would:
   yOffset = -template_bbox.min.y * scale (yaw does not change min.y).
   Returns a Group holding one InstancedMesh per mesh found in the template. */
export function instanceTemplate(template, placements, groundFn = () => 0) {
  template.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(template);
  const minY = bb.min.y;

  const sources = [];
  template.traverse((o) => {
    if (o.isMesh) sources.push({ geo: o.geometry, mat: o.material, local: o.matrixWorld.clone() });
  });

  const group = new THREE.Group();
  const place = new THREE.Matrix4();
  const compose = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const posV = new THREE.Vector3();
  const sclV = new THREE.Vector3();

  for (const src of sources) {
    const im = new THREE.InstancedMesh(src.geo, src.mat, placements.length);
    placements.forEach((p, i) => {
      const s = p.scale ?? 1;
      const y = p.y ?? (groundFn(p.x, p.z) - minY * s);
      q.setFromAxisAngle(up, p.ry ?? 0);
      posV.set(p.x, y, p.z);
      sclV.setScalar(s);
      place.compose(posV, q, sclV);
      compose.multiplyMatrices(place, src.local);
      im.setMatrixAt(i, compose);
    });
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    group.add(im);
  }
  return group;
}

/* Screen-size LOD gate for heavy imported models.

   The failure this exists for: a 1.4M-triangle reconstruction GLB, parked at
   a station 96 units from the camera, covering about 24 pixels of a 800px
   viewport — full cost, no detail delivered. Distance alone is the wrong
   metric (a big object at 90 units still deserves to be drawn, a small one at
   40 may not), so the gate is the fraction of viewport HEIGHT the object's
   bounding sphere would cover:

       fraction = radius / (distance * tan(vfov / 2))

   which is FOV-aware and self-tuning per object size. Hysteresis keeps an
   object hovering at the threshold from flickering: it must grow noticeably
   past the show point before coming back.

   Objects are hidden, not swapped for a stand-in, because at the sizes this
   triggers at the object is a few dozen pixels deep in fog. Anything kept
   with keep() is exempt — use it for whatever the visitor is looking at, so
   this can never blank the exhibit in front of them. */
export class ScreenSizeLod {
  constructor({ minFraction = 0.04, hysteresis = 1.4 } = {}) {
    this.minFraction = minFraction;
    this.hysteresis = hysteresis;
    this.entries = [];          // {object, key, centre, radius, shown}
    this.kept = new Set();
    this.enabled = true;
    this._box = new THREE.Box3();
    this._sphere = new THREE.Sphere();
    this._centre = new THREE.Vector3();
  }

  /* Measure now, in world space: these models are mounted once and do not
     move afterwards, so re-deriving a bounding sphere every frame would be
     pure waste. Call again if a model is ever re-parented or re-scaled. */
  add(key, object) {
    this._box.setFromObject(object);
    if (this._box.isEmpty()) return null;
    this._box.getBoundingSphere(this._sphere);
    const entry = {
      key, object,
      centre: this._sphere.center.clone(),
      radius: this._sphere.radius,
      shown: object.visible
    };
    this.entries.push(entry);
    return entry;
  }

  /* Exempt a set of keys from the gate (e.g. the station in focus). */
  keep(...keys) {
    this.kept = new Set(keys.filter((k) => k !== null && k !== undefined));
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!on) {
      for (const e of this.entries) { e.object.visible = true; e.shown = true; }
    }
  }

  update(camera) {
    if (!this.enabled) return 0;
    const halfFov = (camera.fov * Math.PI) / 360;
    const tan = Math.tan(halfFov);
    let hidden = 0;
    for (const e of this.entries) {
      if (this.kept.has(e.key)) {
        e.object.visible = true;
        e.shown = true;
        continue;
      }
      const d = camera.position.distanceTo(e.centre);
      const fraction = e.radius / Math.max(d * tan, 1e-6);
      /* asymmetric thresholds: cheap to keep hiding, dearer to come back */
      const limit = e.shown ? this.minFraction : this.minFraction * this.hysteresis;
      e.shown = fraction >= limit;
      e.object.visible = e.shown;
      if (!e.shown) hidden++;
    }
    return hidden;
  }

  get stats() {
    return {
      total: this.entries.length,
      hidden: this.entries.filter((e) => !e.shown).length,
      kept: [...this.kept]
    };
  }
}
