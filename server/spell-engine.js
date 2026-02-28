const ARCHETYPES = ['projectile', 'aoe_burst', 'zone_control', 'chain'];
const ELEMENTS = ['fire', 'ice', 'arcane', 'earth', 'storm'];
const TARGET_MODES = ['nearest', 'lane', 'ground_point', 'front_cluster'];
const EFFECTS = ['burn', 'freeze', 'stun', 'knockback', 'slow', 'shield_break'];
const VFX_SHAPES = ['orb', 'ring', 'wall', 'arc'];

const EFFECT_WEIGHTS = {
  burn: 10,
  freeze: 16,
  stun: 15,
  knockback: 11,
  slow: 9,
  shield_break: 8,
};

const TOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['archetype', 'element', 'targeting', 'numbers', 'effects', 'vfx', 'sfx'],
  properties: {
    archetype: { type: 'string', enum: ARCHETYPES },
    element: { type: 'string', enum: ELEMENTS },
    targeting: {
      type: 'object',
      additionalProperties: false,
      required: ['mode'],
      properties: {
        mode: { type: 'string', enum: TARGET_MODES },
        lane: { type: 'integer', minimum: 0, maximum: 4 },
      },
    },
    numbers: {
      type: 'object',
      additionalProperties: false,
      required: ['damage', 'radius', 'durationSec'],
      properties: {
        damage: { type: 'number', minimum: 1, maximum: 200 },
        radius: { type: 'number', minimum: 0.4, maximum: 12 },
        durationSec: { type: 'number', minimum: 0, maximum: 20 },
        tickRate: { type: 'number', minimum: 0.1, maximum: 4 },
        chainCount: { type: 'integer', minimum: 1, maximum: 10 },
        speed: { type: 'number', minimum: 6, maximum: 60 },
      },
    },
    effects: {
      type: 'array',
      items: { type: 'string', enum: EFFECTS },
      maxItems: 3,
      uniqueItems: true,
    },
    vfx: {
      type: 'object',
      additionalProperties: false,
      required: ['palette', 'intensity', 'shape'],
      properties: {
        palette: { type: 'string', minLength: 2, maxLength: 24 },
        intensity: { type: 'number', minimum: 0.2, maximum: 1.4 },
        shape: { type: 'string', enum: VFX_SHAPES },
      },
    },
    sfx: {
      type: 'object',
      additionalProperties: false,
      required: ['cue'],
      properties: {
        cue: { type: 'string', minLength: 2, maxLength: 32 },
      },
    },
  },
};

export function getToolDefinition() {
  return {
    type: 'function',
    name: 'craft_spell',
    description:
      'Craft a single balanced spell config for the current combat context using only supported archetypes/effects.',
    strict: false,
    parameters: TOOL_SCHEMA,
  };
}

function normalizeUnlocks(unlocks) {
  const value = Array.isArray(unlocks) ? unlocks.filter((item) => typeof item === 'string') : [];
  return new Set(value);
}

function allowedArchetypes(unlocks) {
  const set = new Set(['projectile']);
  if (unlocks.has('fireball')) set.add('aoe_burst');
  if (unlocks.has('wall')) set.add('zone_control');
  if (unlocks.has('bolt')) set.add('chain');
  return set;
}

function uniqueEffects(effects) {
  if (!Array.isArray(effects)) {
    return [];
  }

  const seen = new Set();
  const output = [];
  for (const effect of effects) {
    if (!EFFECTS.includes(effect) || seen.has(effect)) {
      continue;
    }
    seen.add(effect);
    output.push(effect);
  }
  return output;
}

function computePowerScore(spell) {
  const numbers = spell.numbers;
  const damageCost = numbers.damage * 0.46;
  const radiusCost = Math.pow(Math.max(0.7, numbers.radius), 1.42) * 5.6;
  const durationCost = numbers.durationSec * 4.8;
  const tickCost = spell.archetype === 'zone_control' ? (1 / Math.max(0.2, numbers.tickRate || 1.0)) * 7.2 : 0;
  const chainCost = spell.archetype === 'chain' ? Math.max(0, (numbers.chainCount || 2) - 1) * 8.2 : 0;
  const speedCost = spell.archetype === 'projectile' || spell.archetype === 'aoe_burst' ? Math.max(0, (numbers.speed || 24) - 16) * 0.3 : 0;
  const effectsCost = spell.effects.reduce((sum, effect) => sum + (EFFECT_WEIGHTS[effect] || 0), 0);
  const controlSurcharge = spell.effects.some((effect) => effect === 'freeze' || effect === 'stun') ? 6 : 0;
  return damageCost + radiusCost + durationCost + tickCost + chainCost + speedCost + effectsCost + controlSurcharge;
}

function deriveCost(powerScore) {
  const mana = Math.round(clampNumber(8 + powerScore * 0.42, 8, 65));
  const cooldownSec = round2(clampNumber(0.25 + powerScore * 0.052, 0.25, 10));
  return { mana, cooldownSec };
}

function sanitizeDraft(draft, context, warnings) {
  const unlocks = normalizeUnlocks(context.unlocks);
  const archetypeSet = allowedArchetypes(unlocks);

  let archetype = typeof draft?.archetype === 'string' ? draft.archetype : 'projectile';
  if (!archetypeSet.has(archetype)) {
    warnings.push(`archetype ${archetype} unavailable, downgraded`);
    archetype = unlocks.has('fireball') ? 'aoe_burst' : 'projectile';
  }

  const element = ELEMENTS.includes(draft?.element) ? draft.element : 'arcane';

  const targetingMode = TARGET_MODES.includes(draft?.targeting?.mode) ? draft.targeting.mode : 'nearest';
  const targeting = {
    mode: targetingMode,
  };
  if (targetingMode === 'lane') {
    const lane = clampNumber(draft?.targeting?.lane ?? 2, 0, 4);
    targeting.lane = Math.round(lane);
  }

  const numbers = {
    damage: clampNumber(draft?.numbers?.damage ?? 24, 8, 120),
    radius: clampNumber(draft?.numbers?.radius ?? (archetype === 'zone_control' ? 2.4 : 2.1), 0.8, 8),
    durationSec: clampNumber(draft?.numbers?.durationSec ?? (archetype === 'zone_control' ? 4 : 0), 0, 10),
    tickRate: clampNumber(draft?.numbers?.tickRate ?? 0.9, 0.2, 2),
    chainCount: Math.round(clampNumber(draft?.numbers?.chainCount ?? 3, 1, 7)),
    speed: clampNumber(draft?.numbers?.speed ?? 30, 8, 44),
  };

  let effects = uniqueEffects(draft?.effects).slice(0, 3);

  if (effects.includes('freeze') && !unlocks.has('frost')) {
    effects = effects.filter((effect) => effect !== 'freeze');
    warnings.push('freeze removed because frost is locked');
  }

  if (archetype === 'chain' && !unlocks.has('bolt')) {
    warnings.push('chain unavailable before bolt unlock; using aoe_burst');
    archetype = 'aoe_burst';
  }

  if (archetype === 'zone_control' && !unlocks.has('wall')) {
    warnings.push('zone_control unavailable before wall unlock; using projectile');
    archetype = 'projectile';
  }

  const intensity = clampNumber(draft?.vfx?.intensity ?? 0.8, 0.2, 1.4);
  const vfxShape = VFX_SHAPES.includes(draft?.vfx?.shape) ? draft.vfx.shape : shapeForArchetype(archetype);

  const spell = {
    archetype,
    element,
    targeting,
    numbers,
    effects,
    vfx: {
      palette: sanitizeText(draft?.vfx?.palette, `${element}-sigil`, 24),
      intensity,
      shape: vfxShape,
    },
    sfx: {
      cue: sanitizeText(draft?.sfx?.cue, `${element}-cast`, 32),
    },
  };

  applyCompatibilityRules(spell, warnings);
  return spell;
}

function applyCompatibilityRules(spell, warnings) {
  if (spell.effects.includes('freeze') && spell.effects.includes('burn') && spell.vfx.intensity > 1.0) {
    spell.vfx.intensity = 1.0;
    warnings.push('freeze+burn full intensity reduced for compatibility');
  }

  if (spell.archetype === 'chain' && spell.numbers.chainCount < 2) {
    spell.numbers.chainCount = 2;
    warnings.push('chainCount raised to minimum 2');
  }

  if (spell.archetype === 'zone_control') {
    if (spell.numbers.durationSec <= 0) {
      spell.numbers.durationSec = 2.5;
      warnings.push('zone_control duration corrected');
    }
    if (spell.numbers.radius < 1.6) {
      spell.numbers.radius = 1.6;
      warnings.push('zone_control radius corrected');
    }
  }

  if (spell.archetype !== 'chain') {
    delete spell.numbers.chainCount;
  }

  if (spell.archetype !== 'zone_control') {
    spell.numbers.durationSec = clampNumber(spell.numbers.durationSec, 0, 6);
    if (spell.numbers.durationSec > 0 && spell.archetype !== 'aoe_burst') {
      spell.numbers.durationSec = 0;
    }
  }

  if (spell.archetype === 'chain') {
    spell.targeting.mode = 'front_cluster';
  }
}

export function validateAndFinalizeSpell(draft, context) {
  const warnings = [];
  const spell = sanitizeDraft(draft, context, warnings);
  const powerScore = computePowerScore(spell);
  spell.cost = deriveCost(powerScore);

  return {
    ok: true,
    spell,
    warnings,
    powerScore: round2(powerScore),
  };
}

function createPreset(name) {
  if (name === 'fireball') {
    return {
      archetype: 'aoe_burst',
      element: 'fire',
      targeting: { mode: 'nearest' },
      numbers: { damage: 60, radius: 3.4, durationSec: 0, speed: 32 },
      effects: ['burn'],
      vfx: { palette: 'ember', intensity: 1.0, shape: 'orb' },
      sfx: { cue: 'fireburst' },
    };
  }

  if (name === 'wall') {
    return {
      archetype: 'zone_control',
      element: 'earth',
      targeting: { mode: 'lane' },
      numbers: { damage: 10, radius: 2.0, durationSec: 8, tickRate: 0.8 },
      effects: ['slow', 'knockback'],
      vfx: { palette: 'stone', intensity: 0.7, shape: 'wall' },
      sfx: { cue: 'bulwark' },
    };
  }

  if (name === 'frost') {
    return {
      archetype: 'zone_control',
      element: 'ice',
      targeting: { mode: 'front_cluster' },
      numbers: { damage: 16, radius: 4.5, durationSec: 2.2, tickRate: 0.7 },
      effects: ['freeze', 'slow'],
      vfx: { palette: 'glacier', intensity: 0.9, shape: 'ring' },
      sfx: { cue: 'frostwave' },
    };
  }

  if (name === 'bolt') {
    return {
      archetype: 'chain',
      element: 'storm',
      targeting: { mode: 'front_cluster' },
      numbers: { damage: 42, radius: 2.3, durationSec: 0, chainCount: 4 },
      effects: ['stun'],
      vfx: { palette: 'ion', intensity: 1.1, shape: 'arc' },
      sfx: { cue: 'chainbolt' },
    };
  }

  return {
    archetype: 'projectile',
    element: 'arcane',
    targeting: { mode: 'nearest' },
    numbers: { damage: 32, radius: 2.0, durationSec: 0, speed: 28 },
    effects: ['slow'],
    vfx: { palette: 'astral', intensity: 0.8, shape: 'orb' },
    sfx: { cue: 'arcane-shot' },
  };
}

export function deterministicFallback(prompt, context) {
  const raw = String(prompt || '').toLowerCase();
  const unlocks = normalizeUnlocks(context.unlocks);

  let presetName = 'default';
  if (/(volcano|lava|magma|meteor|eruption|fire)/.test(raw) && unlocks.has('fireball')) {
    presetName = 'fireball';
  } else if (/(wall|barrier|block|fortify|stone)/.test(raw) && unlocks.has('wall')) {
    presetName = 'wall';
  } else if (/(frost|freeze|ice|blizzard|glacier)/.test(raw) && unlocks.has('frost')) {
    presetName = 'frost';
  } else if (/(bolt|lightning|chain|storm|thunder)/.test(raw) && unlocks.has('bolt')) {
    presetName = 'bolt';
  }

  const draft = createPreset(presetName);
  const finalized = validateAndFinalizeSpell(draft, context);
  if (finalized.ok) {
    return finalized;
  }

  return validateAndFinalizeSpell(createPreset('default'), context);
}

function shapeForArchetype(archetype) {
  if (archetype === 'zone_control') return 'ring';
  if (archetype === 'chain') return 'arc';
  return 'orb';
}

function sanitizeText(value, fallback, maxLength) {
  if (typeof value !== 'string') {
    return fallback;
  }
  const cleaned = value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-').slice(0, maxLength);
  return cleaned || fallback;
}

function clampNumber(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return min;
  }
  return Math.max(min, Math.min(max, numeric));
}

function round2(value) {
  return Math.round(value * 100) / 100;
}
