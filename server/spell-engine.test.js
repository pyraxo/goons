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
  assert.ok(result.spell.cost.mana <= 65);
  assert.ok(result.spell.cost.mana >= 40);
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

test('accepts lane_sweep pattern with width/length and normalizes sweep constraints', () => {
  const result = validateAndFinalizeSpell(
    {
      archetype: 'zone_control',
      element: 'storm',
      targeting: { mode: 'front_cluster', pattern: 'lane_sweep', singleTarget: false },
      numbers: { damage: 22, radius: 2.4, durationSec: 3, tickRate: 0.4, width: 18, length: 6, laneSpan: 1, speed: 14 },
      effects: ['slow', 'knockback'],
      vfx: { palette: 'tidal', intensity: 1.0, shape: 'wave' },
      sfx: { cue: 'surf' },
    },
    baseContext
  );

  assert.equal(result.ok, true);
  assert.equal(result.spell.targeting.pattern, 'lane_sweep');
  assert.equal(result.spell.vfx.shape, 'wave');
  assert.ok(result.spell.numbers.length >= 10);
  assert.ok(result.spell.numbers.laneSpan >= 2);
});

test('accepts lane_circle + lane_cluster targeting and clamps lane index', () => {
  const result = validateAndFinalizeSpell(
    {
      archetype: 'zone_control',
      element: 'earth',
      targeting: { mode: 'lane_cluster', lane: 9, pattern: 'lane_circle', singleTarget: false },
      numbers: { damage: 12, radius: 2.3, durationSec: 5, tickRate: 0.6, width: 10, length: 8, laneSpan: 1 },
      effects: ['slow'],
      vfx: { palette: 'sand', intensity: 0.8, shape: 'ring' },
      sfx: { cue: 'sand' },
    },
    baseContext
  );

  assert.equal(result.ok, true);
  assert.equal(result.spell.targeting.mode, 'lane_cluster');
  assert.equal(result.spell.targeting.pattern, 'lane_circle');
  assert.equal(result.spell.targeting.lane, 4);
  assert.equal(result.spell.targeting.singleTarget, false);
  assert.ok(result.spell.numbers.width >= 1);
  assert.ok(result.spell.numbers.length >= 1);
});

test('singleTarget converts zone draft into projectile-safe output', () => {
  const result = validateAndFinalizeSpell(
    {
      archetype: 'zone_control',
      element: 'arcane',
      targeting: { mode: 'lane', lane: 2, pattern: 'single_enemy', singleTarget: true },
      numbers: { damage: 20, radius: 3.4, durationSec: 4, tickRate: 0.8, width: 9, length: 9, laneSpan: 2 },
      effects: ['slow'],
      vfx: { palette: 'focus', intensity: 0.8, shape: 'ring' },
      sfx: { cue: 'focus' },
    },
    baseContext
  );

  assert.equal(result.ok, true);
  assert.equal(result.spell.archetype, 'projectile');
  assert.equal(result.spell.targeting.singleTarget, true);
  assert.equal(result.spell.targeting.pattern, 'single_enemy');
  assert.ok(result.spell.numbers.radius <= 1.6);
});
