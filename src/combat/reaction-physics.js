/**
 * @typedef {Object} ReactionProfile
 * @property {number} mass
 * @property {number} drag
 * @property {number} maxSpeedX
 * @property {number} maxSpeedZ
 * @property {number} poiseThreshold
 * @property {number} poiseRecoverPerSec
 * @property {number} poisePerImpulse
 * @property {number} staggerSec
 * @property {number} maxImpulse
 */

/**
 * @typedef {Object} HitReactionInput
 * @property {'projectile'|'chain'|'zone_tick'} source
 * @property {number} damage
 * @property {number} intensity
 * @property {string[]} effects
 * @property {{x:number, z:number}} impactPoint
 * @property {{x:number, z:number}} enemyPosition
 * @property {number} laneMinX
 * @property {number} laneMaxX
 * @property {number} [maxImpulse]
 */

const EPSILON = 0.0001;
const REACTION_UNIT_SCALE = 0.2;

export const SOURCE_IMPULSE_MULTIPLIERS = Object.freeze({
  projectile: 1.8,
  chain: 1.5,
  zone_tick: 0.7,
});

export const EFFECT_IMPULSE_MULTIPLIERS = Object.freeze({
  knockback: 2.8,
  stun: 1.8,
  freeze: 1.3,
  slow: 1.2,
  burn: 1.1,
  shield_break: 1.4,
});

export const ZONE_IMPULSE_COOLDOWN_SEC = 0.08;

/** @type {Record<string, ReactionProfile>} */
export const REACTION_PROFILES = Object.freeze({
  melee: Object.freeze({
    mass: 0.6,
    drag: 4.0,
    maxSpeedX: 14.0,
    maxSpeedZ: 18.0,
    poiseThreshold: 5.0,
    poiseRecoverPerSec: 3.0,
    poisePerImpulse: 1.8,
    staggerSec: 0.4,
    maxImpulse: 22.0,
  }),
  ranged: Object.freeze({
    mass: 0.4,
    drag: 3.2,
    maxSpeedX: 18.0,
    maxSpeedZ: 22.0,
    poiseThreshold: 3.5,
    poiseRecoverPerSec: 2.5,
    poisePerImpulse: 2.2,
    staggerSec: 0.5,
    maxImpulse: 26.0,
  }),
  tank: Object.freeze({
    mass: 1.0,
    drag: 5.0,
    maxSpeedX: 10.0,
    maxSpeedZ: 14.0,
    poiseThreshold: 8.0,
    poiseRecoverPerSec: 4.0,
    poisePerImpulse: 1.4,
    staggerSec: 0.3,
    maxImpulse: 18.0,
  }),
});

const DEFAULT_PROFILE = REACTION_PROFILES.melee;

export function profileForEnemyKind(kind) {
  return REACTION_PROFILES[kind] || DEFAULT_PROFILE;
}

/**
 * @param {HitReactionInput} input
 */
export function computeImpulseVector(input) {
  const source = SOURCE_IMPULSE_MULTIPLIERS[input?.source] || 1;
  const intensity = clamp(Number(input?.intensity) || 1.2, 0.2, 4);
  const damage = Math.max(0, Number(input?.damage) || 0);
  const maxImpulse = Math.max(0.4, Number(input?.maxImpulse) || 20);
  const effects = Array.isArray(input?.effects) ? input.effects : [];

  const enemyX = Number(input?.enemyPosition?.x) || 0;
  const enemyZ = Number(input?.enemyPosition?.z) || 0;
  const impactX = Number(input?.impactPoint?.x) || enemyX;
  const impactZ = Number(input?.impactPoint?.z) || enemyZ;

  let dirX = enemyX - impactX;
  let dirZ = enemyZ - impactZ;
  const len = Math.hypot(dirX, dirZ);
  if (len < EPSILON) {
    dirX = 0;
    dirZ = -1;
  } else {
    dirX /= len;
    dirZ /= len;
  }

  let effectMultiplier = 1;
  for (const effect of effects) {
    effectMultiplier *= EFFECT_IMPULSE_MULTIPLIERS[effect] || 1;
  }
  effectMultiplier = clamp(effectMultiplier, 0.55, 5.0);

  const strength = clamp(damage * REACTION_UNIT_SCALE * intensity * source * effectMultiplier, 0, maxImpulse);
  let impulseX = dirX * strength;
  const impulseZ = dirZ * strength;

  const laneMinX = Number(input?.laneMinX);
  const laneMaxX = Number(input?.laneMaxX);
  if (Number.isFinite(laneMinX) && Number.isFinite(laneMaxX)) {
    const projectedX = enemyX + impulseX;
    if (projectedX < laneMinX) {
      impulseX = laneMinX - enemyX;
    } else if (projectedX > laneMaxX) {
      impulseX = laneMaxX - enemyX;
    }
  }

  return {
    x: impulseX,
    z: impulseZ,
    magnitude: Math.hypot(impulseX, impulseZ),
  };
}

export function applyImpulseToVelocity(state, impulse, profile) {
  const cfg = profile || DEFAULT_PROFILE;
  const mass = Math.max(0.25, Number(cfg.mass) || 1);
  const maxSpeedX = Math.max(0.2, Number(cfg.maxSpeedX) || DEFAULT_PROFILE.maxSpeedX);
  const maxSpeedZ = Math.max(0.2, Number(cfg.maxSpeedZ) || DEFAULT_PROFILE.maxSpeedZ);

  const velX = clamp((Number(state?.velX) || 0) + (Number(impulse?.x) || 0) / mass, -maxSpeedX, maxSpeedX);
  const velZ = clamp((Number(state?.velZ) || 0) + (Number(impulse?.z) || 0) / mass, -maxSpeedZ, maxSpeedZ);
  return { velX, velZ };
}

export function updatePoiseAndStagger(state, impulseMagnitude, profile, dt = 0) {
  const cfg = profile || DEFAULT_PROFILE;
  const recoverPerSec = Math.max(0, Number(cfg.poiseRecoverPerSec) || 0);
  const poisePerImpulse = Math.max(0, Number(cfg.poisePerImpulse) || 1);
  const poiseThreshold = Math.max(0.1, Number(cfg.poiseThreshold) || 1);
  const staggerSec = Math.max(0.01, Number(cfg.staggerSec) || 0.1);
  const elapsed = Math.max(0, Number(dt) || 0);

  let poiseDamage = Math.max(0, Number(state?.poiseDamage) || 0);
  let staggerFor = Math.max(0, Number(state?.staggerFor) || 0);
  poiseDamage = Math.max(0, poiseDamage - recoverPerSec * elapsed);
  staggerFor = Math.max(0, staggerFor - elapsed);

  const impulse = Math.max(0, Number(impulseMagnitude) || 0);
  poiseDamage += impulse * poisePerImpulse;

  let didStagger = false;
  if (poiseDamage >= poiseThreshold) {
    didStagger = true;
    staggerFor = Math.max(staggerFor, staggerSec);
    poiseDamage *= 0.35;
  }

  return { poiseDamage, staggerFor, didStagger };
}

export function integrateVelocity(state, dt, bounds) {
  const elapsed = Math.max(0, Number(dt) || 0);
  const minX = Number.isFinite(bounds?.minX) ? Number(bounds.minX) : -Infinity;
  const maxX = Number.isFinite(bounds?.maxX) ? Number(bounds.maxX) : Infinity;
  const minZ = Number.isFinite(bounds?.minZ) ? Number(bounds.minZ) : -Infinity;
  const maxZ = Number.isFinite(bounds?.maxZ) ? Number(bounds.maxZ) : Infinity;
  const drag = Math.max(0, Number(bounds?.drag) || 0);
  const maxSpeedX = Math.max(0.2, Number(bounds?.maxSpeedX) || 1000);
  const maxSpeedZ = Math.max(0.2, Number(bounds?.maxSpeedZ) || 1000);

  let velX = clamp(Number(state?.velX) || 0, -maxSpeedX, maxSpeedX);
  let velZ = clamp(Number(state?.velZ) || 0, -maxSpeedZ, maxSpeedZ);
  const dragFactor = Math.exp(-drag * elapsed);
  velX *= dragFactor;
  velZ *= dragFactor;

  let positionX = (Number(state?.positionX) || 0) + velX * elapsed;
  let positionZ = (Number(state?.positionZ) || 0) + velZ * elapsed;

  if (positionX <= minX || positionX >= maxX) {
    positionX = clamp(positionX, minX, maxX);
    velX = 0;
  }

  if (positionZ <= minZ || positionZ >= maxZ) {
    positionZ = clamp(positionZ, minZ, maxZ);
    velZ = 0;
  }

  if (Math.abs(velX) < 0.0001) {
    velX = 0;
  }
  if (Math.abs(velZ) < 0.0001) {
    velZ = 0;
  }

  return { positionX, positionZ, velX, velZ };
}

export function canApplyZoneImpulse(now, lastZoneImpulseAt, cooldownSec = ZONE_IMPULSE_COOLDOWN_SEC) {
  if (!Number.isFinite(lastZoneImpulseAt)) {
    return true;
  }

  return Number(now) - Number(lastZoneImpulseAt) >= Math.max(0, Number(cooldownSec) || 0);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
