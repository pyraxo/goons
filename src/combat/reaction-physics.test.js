import { describe, expect, it } from 'vitest';
import {
  REACTION_PROFILES,
  applyImpulseToVelocity,
  canApplyZoneImpulse,
  computeImpulseVector,
  integrateVelocity,
  updatePoiseAndStagger,
} from './reaction-physics.js';

describe('reaction-physics', () => {
  it('computes away-from-impact impulse and clamps lateral displacement within lane bounds', () => {
    const impulse = computeImpulseVector({
      source: 'projectile',
      damage: 120,
      intensity: 1.0,
      effects: ['knockback'],
      impactPoint: { x: -8, z: -10 },
      enemyPosition: { x: 2.9, z: -10 },
      laneMinX: -3,
      laneMaxX: 3,
      maxImpulse: 12,
    });

    expect(impulse.z).toBeCloseTo(0, 5);
    expect(impulse.x).toBeGreaterThan(0);
    expect(2.9 + impulse.x).toBeLessThanOrEqual(3);
  });

  it('applies stronger recoil to ranged than tank profile for same impulse', () => {
    const impulse = { x: 0, z: -7 };

    const ranged = applyImpulseToVelocity({ velX: 0, velZ: 0 }, impulse, REACTION_PROFILES.ranged);
    const tank = applyImpulseToVelocity({ velX: 0, velZ: 0 }, impulse, REACTION_PROFILES.tank);

    expect(Math.abs(ranged.velZ)).toBeGreaterThan(Math.abs(tank.velZ));
  });

  it('triggers stagger when poise threshold is exceeded', () => {
    let state = { poiseDamage: 0, staggerFor: 0 };
    let didStagger = false;

    for (let i = 0; i < 4; i += 1) {
      const next = updatePoiseAndStagger(state, 3.4, REACTION_PROFILES.ranged, 0.05);
      state = { poiseDamage: next.poiseDamage, staggerFor: next.staggerFor };
      didStagger = didStagger || next.didStagger;
    }

    expect(didStagger).toBe(true);
    expect(state.staggerFor).toBeGreaterThan(0);
  });

  it('enforces cooldown for zone micro-impulse', () => {
    expect(canApplyZoneImpulse(5.0, Number.NEGATIVE_INFINITY, 0.2)).toBe(true);
    expect(canApplyZoneImpulse(5.0, 4.92, 0.2)).toBe(false);
    expect(canApplyZoneImpulse(5.2, 4.92, 0.2)).toBe(true);
  });

  it('integrates velocity with drag, max speed, and world clamps', () => {
    const first = integrateVelocity(
      { positionX: 2.95, positionZ: -9, velX: 20, velZ: -10 },
      0.1,
      { minX: -3, maxX: 3, minZ: -12, maxZ: 8, drag: 5, maxSpeedX: 6, maxSpeedZ: 8 }
    );

    expect(first.positionX).toBeLessThanOrEqual(3);
    expect(Math.abs(first.velX)).toBeLessThan(6);
    expect(Math.abs(first.velZ)).toBeLessThan(8);

    const second = integrateVelocity(first, 0.25, {
      minX: -3,
      maxX: 3,
      minZ: -12,
      maxZ: 8,
      drag: 7,
      maxSpeedX: 6,
      maxSpeedZ: 8,
    });
    expect(Math.abs(second.velX)).toBeLessThanOrEqual(Math.abs(first.velX));
    expect(Math.abs(second.velZ)).toBeLessThanOrEqual(Math.abs(first.velZ));
  });
});
