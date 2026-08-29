/* Obstacle-aware steering for cattle auto-travel.

   The navigator is deliberately independent of Three.js and the DOM. The
   host supplies a read-only collision probe and applies the returned heading
   and optional jump action to the real third-person rig. Low obstacles are
   jumped; obstacles that remain solid at jump height are skirted with a
   sticky side choice so the animal does not oscillate at a fence corner. */

const DEFAULTS = Object.freeze({
  probeDistance: 2.3,
  jumpClearance: 1.2,
  avoidAngle: Math.PI * 0.36,
  avoidSeconds: 0.78,
  jumpCooldown: 1.05
});

const finiteDt = (value) => Number.isFinite(value) && value > 0
  ? Math.min(value, 0.25) : 0;

function normalise(direction) {
  const x = Number(direction?.x) || 0;
  const z = Number(direction?.z) || 0;
  const length = Math.hypot(x, z);
  return length > 1e-6 ? { x: x / length, z: z / length } : { x: 0, z: 0 };
}

function rotate(direction, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: direction.x * cos - direction.z * sin,
    z: direction.x * sin + direction.z * cos
  };
}

export function createAutoNavigator({ probe = () => false, options = {} } = {}) {
  const config = { ...DEFAULTS, ...options };
  let avoidSide = 0;
  let avoidLeft = 0;
  let jumpLeft = 0;
  let jumpCount = 0;
  let avoidCount = 0;
  let replanCount = 0;
  let lastDecision = "direct";

  const hit = (position, direction, distance, clearance) => {
    const result = probe(
      position.x + direction.x * distance,
      position.z + direction.z * distance,
      clearance
    );
    return typeof result === "boolean" ? result : !!result?.hit;
  };

  const sideScore = (position, desired, side) => {
    const direction = rotate(desired, side * config.avoidAngle);
    let score = 0;
    for (const [distance, weight] of [[1.25, 4], [2.3, 2], [3.6, 1]]) {
      if (hit(position, direction, distance, 0)) score += weight;
    }
    return score;
  };

  const chooseSide = (position, desired, forceFlip = false) => {
    if (forceFlip && avoidSide) {
      avoidSide *= -1;
    } else {
      const left = sideScore(position, desired, 1);
      const right = sideScore(position, desired, -1);
      if (left === right && avoidSide) avoidSide *= -1;
      else avoidSide = left <= right ? 1 : -1;
    }
    avoidLeft = config.avoidSeconds;
    avoidCount += 1;
  };

  const api = {
    reset() {
      avoidSide = 0;
      avoidLeft = 0;
      jumpLeft = 0;
      lastDecision = "direct";
    },

    replan(position, desired) {
      chooseSide(position, normalise(desired), true);
      avoidLeft = config.avoidSeconds * 1.5;
      replanCount += 1;
    },

    update({ dt, position, desired, grounded = true, blocked = false } = {}) {
      const elapsed = finiteDt(dt);
      jumpLeft = Math.max(0, jumpLeft - elapsed);
      avoidLeft = Math.max(0, avoidLeft - elapsed);
      const direct = normalise(desired);
      const at = { x: Number(position?.x) || 0, z: Number(position?.z) || 0 };
      if (direct.x === 0 && direct.z === 0) {
        lastDecision = "idle";
        return { dir: direct, action: null, decision: lastDecision };
      }

      const groundAhead = hit(at, direct, config.probeDistance, 0);
      const jumpHeightAhead = groundAhead
        ? hit(at, direct, config.probeDistance, config.jumpClearance)
        : false;

      /* If the obstacle disappears when the calf's feet are above 1.2 u, it
         is a fence or another deliberately jumpable prop. Keep steering
         straight during the arc instead of mistaking the same fence for a
         reason to detour while airborne. */
      if (groundAhead && !jumpHeightAhead) {
        avoidLeft = 0;
        if (grounded && jumpLeft <= 0) {
          jumpLeft = config.jumpCooldown;
          jumpCount += 1;
          lastDecision = "jump";
          return { dir: direct, action: "jump", decision: lastDecision };
        }
        lastDecision = "clear-jump";
        return { dir: direct, action: null, decision: lastDecision };
      }

      if ((groundAhead && jumpHeightAhead) || (blocked && avoidLeft <= 0)) {
        chooseSide(at, direct);
      }

      if (avoidLeft > 0 && avoidSide) {
        let direction = rotate(direct, avoidSide * config.avoidAngle);
        /* A newly encountered corner can invalidate the sticky side. Switch
           only when the opposite ray is strictly clearer, preventing
           left/right jitter from one render frame to the next. */
        if (hit(at, direction, 1.25, 0)) {
          const opposite = rotate(direct, -avoidSide * config.avoidAngle);
          if (!hit(at, opposite, 1.25, 0)) {
            avoidSide *= -1;
            direction = opposite;
          }
        }
        lastDecision = avoidSide > 0 ? "avoid-left" : "avoid-right";
        return { dir: direction, action: null, decision: lastDecision };
      }

      lastDecision = "direct";
      return { dir: direct, action: null, decision: lastDecision };
    },

    get qaState() {
      return {
        decision: lastDecision,
        avoidSide,
        avoidLeft,
        jumpCooldown: jumpLeft,
        jumpCount,
        avoidCount,
        replanCount
      };
    }
  };

  return api;
}
