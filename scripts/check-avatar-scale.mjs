import assert from "node:assert/strict";
import * as THREE from "../vendor/three.module.js";
import { createGlbCattle } from "../js/lib/glb-cattle.js?v=20260907-ranch-drive-v6";

const source = new THREE.Group();
source.add(new THREE.Mesh(new THREE.BoxGeometry(2, 4, 6), new THREE.MeshStandardMaterial()));
source.scale.setScalar(.3);
createGlbCattle({ scene: source, animations: [] }, { height: 1.5 });
let bounds = new THREE.Box3().setFromObject(source);
assert.ok(Math.abs(bounds.max.y - bounds.min.y - 1.5) < 1e-6, "authored scale must be preserved while fitting height");
const clone = source.clone(true);
createGlbCattle({ scene: clone, animations: [] }, { height: 1.5 });
bounds = new THREE.Box3().setFromObject(clone);
assert.ok(Math.abs(bounds.max.y - bounds.min.y - 1.5) < 1e-6, "adapting an already scaled clone must not create a giant ghost");
console.log("Avatar scale verified: authored scales and pre-fitted clones retain the requested height.");
