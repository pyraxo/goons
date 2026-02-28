import { describe, expect, it } from 'vitest';
import { deterministicFallback, validateAndFinalizeSpell } from './spell-engine.js';

const baseContext = {
  wave: 5,
  mana: 80,
  unlocks: ['fireball', 'wall', 'frost', 'bolt'],
  nearbyEnemies: [],
};

describe('spell-engine', () => {
  it('accepts a valid spell draft', () => {
    const result = validateAndFinalizeSpell(
      {
        archetype: 'aoe_burst',
        element: 'fire',
        targeting: { mode: 'nearest' },
        numbers: { damage: 40, radius: 2.8, durationSec: 0, speed: 28 },
        effects: ['burn'],
        vfx: { palette: 'ember', intensity: 0.9, shape: 'orb' },
        sfx: { cue: 'fireburst' },
      },
      baseContext
    );

    expect(result.ok).toBe(true);
    expect(result.spell.archetype).toBe('aoe_burst');
    expect(result.spell.cost.mana).toBeGreaterThanOrEqual(8);
  });

  it('normalizes lane_sweep constraints', () => {
    const result = validateAndFinalizeSpell(
      {
        archetype: 'zone_control',
        element: 'storm',
        targeting: { mode: 'front_cluster', pattern: 'lane_sweep', singleTarget: false },
        numbers: {
          damage: 22,
          radius: 2.4,
          durationSec: 3,
          tickRate: 0.4,
          width: 18,
          length: 6,
          laneSpan: 1,
          speed: 14,
        },
        effects: ['slow', 'knockback'],
        vfx: { palette: 'tidal', intensity: 1.0, shape: 'wave' },
        sfx: { cue: 'surf' },
      },
      baseContext
    );

    expect(result.ok).toBe(true);
    expect(result.spell.targeting.pattern).toBe('lane_sweep');
    expect(result.spell.vfx.shape).toBe('wave');
    expect(result.spell.numbers.length).toBeGreaterThanOrEqual(10);
    expect(result.spell.numbers.laneSpan).toBeGreaterThanOrEqual(2);
  });

  it('deterministic fallback is stable', () => {
    const first = deterministicFallback('mystery rune', baseContext);
    const second = deterministicFallback('mystery rune', baseContext);
    expect(first.spell).toEqual(second.spell);
  });
});
