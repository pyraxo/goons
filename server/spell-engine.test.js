import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSpellVariantSignature, deterministicFallback, validateAndFinalizeSpell } from './spell-engine.js';

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

test('includes name, description, and enriched vfx fields with defaults', () => {
  const result = validateAndFinalizeSpell(
    {
      archetype: 'projectile',
      element: 'storm',
      targeting: { mode: 'nearest' },
      numbers: { damage: 20, radius: 1.5, durationSec: 0 },
      effects: ['stun'],
      vfx: { palette: 'ion', intensity: 0.8, shape: 'orb' },
      sfx: { cue: 'zap' },
    },
    baseContext
  );

  assert.equal(result.ok, true);
  assert.equal(typeof result.spell.name, 'string');
  assert.ok(result.spell.name.length >= 2);
  assert.equal(typeof result.spell.description, 'string');
  assert.ok(result.spell.description.length >= 8);
  assert.match(result.spell.vfx.primaryColor, /^#[0-9a-f]{6}$/);
  assert.match(result.spell.vfx.secondaryColor, /^#[0-9a-f]{6}$/);
  assert.match(result.spell.vfx.colors.core, /^#[0-9a-f]{6}$/);
  assert.match(result.spell.vfx.colors.glow, /^#[0-9a-f]{6}$/);
  assert.equal(typeof result.spell.vfx.trailEffect, 'string');
  assert.equal(typeof result.spell.vfx.particleTheme, 'string');
  assert.equal(typeof result.spell.vfx.impactEffect, 'string');
  assert.equal(typeof result.spell.vfx.particleDensity, 'number');
  assert.equal(typeof result.spell.vfx.screenShake, 'number');
  assert.equal(typeof result.spell.castStyle, 'string');
  assert.equal(typeof result.spell.sfx.volume, 'number');
  assert.equal(typeof result.spell.sfx.impactVolume, 'number');
  assert.equal(typeof result.spell.sfx.pitch, 'number');
  assert.equal(typeof result.spell.sfx.impactCue, 'string');
  assert.equal(typeof result.spell.sfx.layer, 'string');
});

test('preserves LLM-provided creative fields', () => {
  const result = validateAndFinalizeSpell(
    {
      name: 'Pyroclastic Ruin',
      description: 'A molten boulder tears through the sky and obliterates everything on impact.',
      archetype: 'aoe_burst',
      element: 'fire',
      targeting: { mode: 'nearest' },
      numbers: { damage: 55, radius: 3.0, durationSec: 0, speed: 30 },
      effects: ['burn'],
      vfx: {
        palette: 'magma',
        intensity: 1.2,
        shape: 'orb',
        primaryColor: '#ff3300',
        secondaryColor: '#ffaa22',
        trailEffect: 'ember_trail',
        impactEffect: 'explosion',
        particleDensity: 1.6,
        screenShake: 0.7,
      },
      sfx: { cue: 'meteor-crash' },
      castStyle: 'slam',
    },
    baseContext
  );

  assert.equal(result.ok, true);
  assert.equal(result.spell.name, 'Pyroclastic Ruin');
  assert.ok(result.spell.description.includes('molten'));
  assert.equal(result.spell.vfx.primaryColor, '#ff3300');
  assert.equal(result.spell.vfx.secondaryColor, '#ffaa22');
  assert.equal(result.spell.vfx.trailEffect, 'ember_trail');
  assert.equal(result.spell.vfx.impactEffect, 'explosion');
  assert.equal(result.spell.vfx.particleDensity, 1.6);
  assert.equal(result.spell.vfx.screenShake, 0.7);
  assert.equal(result.spell.castStyle, 'slam');
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
  assert.equal(typeof result.spell.name, 'string');
  assert.ok(result.spell.name.length > 0);
  assert.equal(typeof result.spell.vfx.primaryColor, 'string');
  assert.equal(typeof result.spell.castStyle, 'string');
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

test('supports nearest_enemy targeting and ring visibility options', () => {
  const result = validateAndFinalizeSpell(
    {
      archetype: 'zone_control',
      element: 'ice',
      targeting: { mode: 'nearest_enemy', pattern: 'lane_circle', singleTarget: false },
      numbers: { damage: 12, radius: 2.6, durationSec: 5, tickRate: 0.7, width: 9, length: 9, laneSpan: 2 },
      effects: ['slow'],
      vfx: { palette: 'glacier', intensity: 0.9, shape: 'ring', ringColor: '0x66ccff', visibility: 1.8 },
      sfx: { cue: 'frost-ring' },
    },
    baseContext
  );

  assert.equal(result.ok, true);
  assert.equal(result.spell.targeting.mode, 'nearest_enemy');
  assert.equal(result.spell.vfx.ringColor, '#66ccff');
  assert.equal(result.spell.vfx.visibility, 1.8);
});

test('strong curated anchor keeps fireball identity even when draft drifts', () => {
  const result = validateAndFinalizeSpell(
    {
      archetype: 'zone_control',
      element: 'ice',
      targeting: { mode: 'lane_cluster', pattern: 'lane_sweep', singleTarget: false },
      numbers: { damage: 22, radius: 2.4, durationSec: 4, tickRate: 0.7, width: 16, length: 20, laneSpan: 2, speed: 14 },
      effects: ['slow'],
      vfx: { palette: 'tempest', intensity: 0.9, shape: 'wave' },
      sfx: { cue: 'drifted' },
      castStyle: 'sweep',
    },
    {
      ...baseContext,
      spellIdentity: {
        anchorKey: 'fireball',
        curatedKey: 'fireball',
        anchorPolicy: 'strong',
        source: 'curated_lexicon',
      },
      variantContext: {
        castIndex: 1,
        recentSignatures: [],
      },
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.spell.element, 'fire');
  assert.ok(['aoe_burst', 'projectile'].includes(result.spell.archetype));
  assert.ok(result.spell.effects.includes('burn'));
});

test('soft no-repeat guard adjusts duplicate variant signature', () => {
  const draft = {
    archetype: 'projectile',
    element: 'storm',
    targeting: { mode: 'nearest_enemy', pattern: 'single_enemy', singleTarget: true },
    numbers: { damage: 32, radius: 1.4, durationSec: 0, speed: 28 },
    effects: ['slow'],
    vfx: { palette: 'ion', intensity: 0.9, shape: 'orb' },
    sfx: { cue: 'arc' },
    castStyle: 'launch',
  };

  const first = validateAndFinalizeSpell(draft, {
    ...baseContext,
    spellIdentity: { anchorKey: 'spark', curatedKey: null, anchorPolicy: 'adaptive', source: 'freeform' },
    variantContext: { castIndex: 1, recentSignatures: [] },
  });
  const firstSignature = buildSpellVariantSignature(first.spell);

  const second = validateAndFinalizeSpell(draft, {
    ...baseContext,
    spellIdentity: { anchorKey: 'spark', curatedKey: null, anchorPolicy: 'adaptive', source: 'freeform' },
    variantContext: { castIndex: 1, recentSignatures: [firstSignature] },
  });
  const secondSignature = buildSpellVariantSignature(second.spell);

  assert.notEqual(secondSignature, firstSignature);
  assert.ok(second.warnings.includes('soft_no_repeat_guard_adjusted_variant'));
});

test('contextual fallback creates different variants across cast index', () => {
  const first = deterministicFallback('fireball', {
    ...baseContext,
    spellIdentity: { anchorKey: 'fireball', curatedKey: 'fireball', anchorPolicy: 'strong', source: 'curated_lexicon' },
    variantContext: { castIndex: 1, recentSignatures: [] },
  });
  const second = deterministicFallback('fireball', {
    ...baseContext,
    spellIdentity: { anchorKey: 'fireball', curatedKey: 'fireball', anchorPolicy: 'strong', source: 'curated_lexicon' },
    variantContext: { castIndex: 2, recentSignatures: [] },
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.notEqual(buildSpellVariantSignature(first.spell), buildSpellVariantSignature(second.spell));
});
