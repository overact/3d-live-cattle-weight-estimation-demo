import assert from "node:assert/strict";
import { createAutoNavigator } from "../js/world/auto-nav.js?v=20260907-ranch-drive-v6";

const clearNav = createAutoNavigator({ probe: () => false });
const clear = clearNav.update({
  dt: 0.1,
  position: { x: 0, z: 0 },
  desired: { x: 4, z: 0 },
  grounded: true
});
assert.equal(clear.decision, "direct");
assert.deepEqual(clear.dir, { x: 1, z: 0 });

const lowFence = (x, z, clearance) =>
  x > 1.3 && x < 3.3 && Math.abs(z) < 1.0 && clearance <= 1.1;
const jumpNav = createAutoNavigator({ probe: lowFence });
const jump = jumpNav.update({
  dt: 0.1,
  position: { x: 0, z: 0 },
  desired: { x: 1, z: 0 },
  grounded: true
});
assert.equal(jump.action, "jump", "a fence below jump clearance must trigger a jump");
assert.equal(jump.decision, "jump");
assert.equal(jumpNav.qaState.jumpCount, 1);
const airborne = jumpNav.update({
  dt: 0.1,
  position: { x: 0.2, z: 0 },
  desired: { x: 1, z: 0 },
  grounded: false
});
assert.equal(airborne.action, null, "the same fence must not trigger a double jump");
assert.equal(airborne.decision, "clear-jump");

const tallObstacle = (x, z) => x > 1.3 && x < 3.3 && Math.abs(z) < 1.15;
const avoidNav = createAutoNavigator({ probe: tallObstacle });
const avoid = avoidNav.update({
  dt: 0.1,
  position: { x: 0, z: 0 },
  desired: { x: 1, z: 0 },
  grounded: true
});
assert.match(avoid.decision, /^avoid-/);
assert.notEqual(avoid.dir.z, 0, "a tall obstacle must produce lateral steering");
assert.equal(avoid.action, null);
assert.equal(avoidNav.qaState.avoidCount, 1);
const sideBefore = avoidNav.qaState.avoidSide;
avoidNav.replan({ x: 0, z: 0 }, { x: 1, z: 0 });
assert.equal(avoidNav.qaState.avoidSide, -sideBefore, "replan must try the opposite side");
assert.equal(avoidNav.qaState.replanCount, 1);

console.log("Auto navigation verified: direct steering, low-obstacle jump, tall-obstacle avoidance.");
