import test from 'node:test';
import assert from 'node:assert/strict';
import { deterministicFallback, validateAndFinalizeSpell } from './spell-engine.js';

const baseContext = {
  wave: 5,
  mana: 80,
  unlocks: ['fireball', 'wall', 'frost', 'bolt'],
  nearbyEnemies: [],
};

test('accepts a valid spell draft', () => {
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

  assert.equal(result.ok, true);
  assert.equal(result.spell.archetype, 'aoe_burst');
  assert.ok(result.spell.cost.mana >= 8);
});

test('accepts high-power spell and derives capped cost', () => {
  const result = validateAndFinalizeSpell(
    {
      archetype: 'chain',
      element: 'storm',
      targeting: { mode: 'front_cluster' },
      numbers: { damage: 200, radius: 12, durationSec: 10, chainCount: 10 },
      effects: ['freeze', 'stun', 'burn'],
      vfx: { palette: 'overload', intensity: 1.4, shape: 'arc' },
      sfx: { cue: 'cataclysm' },
    },
    baseContext
  );

  assert.equal(result.ok, true);
  assert.ok(result.powerScore > 0);
  assert.equal(result.spell.cost.mana, 65);
});

test('enforces compatibility rule for freeze + burn intensity', () => {
  const result = validateAndFinalizeSpell(
    {
      archetype: 'aoe_burst',
      element: 'arcane',
      targeting: { mode: 'nearest' },
      numbers: { damage: 30, radius: 2.2, durationSec: 0 },
      effects: ['freeze', 'burn'],
      vfx: { palette: 'mixed', intensity: 1.3, shape: 'orb' },
      sfx: { cue: 'hybrid' },
    },
    baseContext
  );

  assert.equal(result.ok, true);
  assert.equal(result.spell.vfx.intensity, 1.0);
});

test('deterministic fallback maps volcano to fireball-like archetype', () => {
  const result = deterministicFallback('volcano', baseContext);

  assert.equal(result.ok, true);
  assert.equal(result.spell.archetype, 'aoe_burst');
  assert.equal(result.spell.element, 'fire');
});

test('fallback remains deterministic with same prompt/context', () => {
  const first = deterministicFallback('mystery rune', baseContext);
  const second = deterministicFallback('mystery rune', baseContext);

  assert.deepEqual(first.spell, second.spell);
});
