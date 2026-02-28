const ARCHETYPES = ['projectile', 'aoe_burst', 'zone_control', 'chain', 'strike', 'beam'];
const ELEMENTS = ['fire', 'ice', 'arcane', 'earth', 'storm'];
const TARGET_MODES = ['nearest', 'nearest_enemy', 'lane', 'lane_cluster', 'ground_point', 'front_cluster', 'commander_facing'];
const TARGET_PATTERNS = ['single_enemy', 'lane_circle', 'lane_sweep', 'ground_strike', 'line_from_caster'];
const EFFECTS = ['burn', 'freeze', 'stun', 'knockback', 'slow', 'shield_break'];
const VFX_SHAPES = ['orb', 'ring', 'wall', 'arc', 'wave', 'pillar', 'beam'];
const TRAIL_EFFECTS = ['spark', 'smoke', 'frost_mist', 'lightning_arc', 'ember_trail', 'shadow_wisp', 'holy_motes', 'none'];
const IMPACT_EFFECTS = ['explosion', 'shatter', 'ripple', 'flash', 'vortex', 'pillar', 'none'];
const CAST_STYLES = ['launch', 'slam', 'channel', 'sweep', 'pulse', 'smite', 'focus'];

const EFFECT_WEIGHTS = {
  burn: 10,
  freeze: 16,
  stun: 15,
  knockback: 11,
  slow: 9,
  shield_break: 8,
};

const ANCHOR_PROFILE_ALIASES = {
  tsunami: 'tidal surge',
  'tidal wave': 'tidal surge',
};

const ANCHOR_PROFILES = {
  fireball: {
    element: 'fire',
    allowedArchetypes: ['aoe_burst', 'projectile'],
    preferredPattern: 'single_enemy',
    preferredShape: 'orb',
    preferredTargetMode: 'nearest_enemy',
    requiredEffects: ['burn'],
    castStyle: 'launch',
  },
  wall: {
    element: 'earth',
    allowedArchetypes: ['zone_control'],
    preferredPattern: 'lane_circle',
    preferredShape: 'wall',
    preferredTargetMode: 'lane_cluster',
    requiredEffects: ['slow'],
    castStyle: 'slam',
  },
  frost: {
    element: 'ice',
    allowedArchetypes: ['zone_control'],
    preferredPattern: 'lane_circle',
    preferredShape: 'ring',
    preferredTargetMode: 'front_cluster',
    requiredEffects: ['freeze', 'slow'],
    castStyle: 'pulse',
  },
  bolt: {
    element: 'storm',
    allowedArchetypes: ['chain', 'projectile'],
    preferredPattern: 'single_enemy',
    preferredShape: 'arc',
    preferredTargetMode: 'front_cluster',
    requiredEffects: ['stun'],
    castStyle: 'pulse',
  },
  'tidal surge': {
    element: 'ice',
    allowedArchetypes: ['zone_control'],
    preferredPattern: 'lane_sweep',
    preferredShape: 'wave',
    preferredTargetMode: 'front_cluster',
    requiredEffects: ['knockback', 'slow'],
    castStyle: 'sweep',
    minLaneSpan: 2,
    minLength: 16,
  },
  meteor: {
    element: 'fire',
    allowedArchetypes: ['strike'],
    preferredPattern: 'ground_strike',
    preferredShape: 'pillar',
    preferredTargetMode: 'front_cluster',
    requiredEffects: ['burn', 'stun'],
    castStyle: 'smite',
  },
  quake: {
    element: 'earth',
    allowedArchetypes: ['strike'],
    preferredPattern: 'ground_strike',
    preferredShape: 'pillar',
    preferredTargetMode: 'front_cluster',
    requiredEffects: ['stun', 'knockback'],
    castStyle: 'smite',
  },
  sunlance: {
    element: 'fire',
    allowedArchetypes: ['beam'],
    preferredPattern: 'line_from_caster',
    preferredShape: 'beam',
    preferredTargetMode: 'commander_facing',
    requiredEffects: ['burn'],
    castStyle: 'focus',
    minLength: 20,
  },
  'dragon breath': {
    element: 'fire',
    allowedArchetypes: ['beam'],
    preferredPattern: 'line_from_caster',
    preferredShape: 'beam',
    preferredTargetMode: 'commander_facing',
    requiredEffects: ['burn', 'knockback'],
    castStyle: 'focus',
    minLength: 16,
  },
};

const TOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['archetype', 'element', 'targeting', 'numbers', 'effects', 'vfx', 'sfx'],
  properties: {
    name: {
      type: 'string',
      minLength: 2,
      maxLength: 40,
      description: 'A vivid, evocative spell name (e.g. "Cinderstorm Salvo", "Glacial Requiem", "Voltaic Cascade").',
    },
    description: {
      type: 'string',
      minLength: 8,
      maxLength: 120,
      description: 'One-sentence flavor text describing what the spell looks and feels like in combat.',
    },
    archetype: { type: 'string', enum: ARCHETYPES },
    element: { type: 'string', enum: ELEMENTS },
    targeting: {
      type: 'object',
      additionalProperties: false,
      required: ['mode'],
      properties: {
        mode: { type: 'string', enum: TARGET_MODES },
        lane: { type: 'integer', minimum: 0, maximum: 4 },
        pattern: { type: 'string', enum: TARGET_PATTERNS },
        singleTarget: { type: 'boolean' },
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
        laneSpan: { type: 'integer', minimum: 1, maximum: 5 },
        width: { type: 'number', minimum: 1, maximum: 44 },
        length: { type: 'number', minimum: 1, maximum: 120 },
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
        size: { type: 'number', minimum: 0.4, maximum: 2.2 },
        ringColor: { type: 'string', minLength: 3, maxLength: 16 },
        visibility: { type: 'number', minimum: 0.4, maximum: 2.2 },
        primaryColor: {
          type: 'string',
          pattern: '^#[0-9a-fA-F]{6}$',
          description: 'Hex color for the main body of the spell (e.g. "#ff6622" for molten orange).',
        },
        secondaryColor: {
          type: 'string',
          pattern: '^#[0-9a-fA-F]{6}$',
          description: 'Hex accent color for glow, particles, and edges (e.g. "#ffcc00" for golden highlights).',
        },
        trailEffect: {
          type: 'string',
          enum: TRAIL_EFFECTS,
          description: 'Particle trail left behind the spell as it travels.',
        },
        impactEffect: {
          type: 'string',
          enum: IMPACT_EFFECTS,
          description: 'Visual burst when the spell hits or detonates.',
        },
        particleDensity: {
          type: 'number',
          minimum: 0.2,
          maximum: 2.0,
          description: 'How dense the particle effects are. 0.5=subtle, 1.0=normal, 2.0=spectacular.',
        },
        screenShake: {
          type: 'number',
          minimum: 0,
          maximum: 1.0,
          description: 'Camera shake on impact. 0=none, 0.3=light rumble, 0.7=heavy, 1.0=devastating.',
        },
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
    castStyle: {
      type: 'string',
      enum: CAST_STYLES,
      description: 'How the spell launches: launch=thrown forward, slam=ground impact, channel=sustained beam, sweep=wide arc, pulse=radial burst.',
    },
  },
};

export function getToolDefinition() {
  return {
    type: 'function',
    name: 'craft_spell',
    description:
      'Craft one balanced spell config for real-time combat. Use targeting.pattern/singleTarget plus numbers.length and numbers.width to describe single-hit, lane-circle, or lane-sweep spells.',
    strict: false,
    parameters: TOOL_SCHEMA,
  };
}

function normalizeUnlocks(unlocks) {
  const value = Array.isArray(unlocks) ? unlocks.filter((item) => typeof item === 'string') : [];
  return new Set(value);
}

function allowedArchetypes() {
  return new Set(ARCHETYPES);
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

function inferTargetPattern(archetype, shape, explicitSingleTarget) {
  if (archetype === 'strike') {
    return 'ground_strike';
  }
  if (archetype === 'beam') {
    return 'line_from_caster';
  }
  if (explicitSingleTarget === true) {
    return 'single_enemy';
  }
  if (archetype === 'zone_control' && shape === 'wave') {
    return 'lane_sweep';
  }
  if (archetype === 'zone_control') {
    return 'lane_circle';
  }
  return 'single_enemy';
}

function widthToLaneSpan(width) {
  return Math.round(clampNumber((Number(width) || 8) / 8, 1, 5));
}

function computePowerScore(spell) {
  const numbers = spell.numbers;
  const damageCost = numbers.damage * 0.46;
  const radiusCost = Math.pow(Math.max(0.7, numbers.radius), 1.42) * 5.6;
  const durationCost = numbers.durationSec * 4.8;
  const tickCost = spell.archetype === 'zone_control' ? (1 / Math.max(0.2, numbers.tickRate || 1.0)) * 7.2 : 0;
  const chainCost = spell.archetype === 'chain' ? Math.max(0, (numbers.chainCount || 2) - 1) * 8.2 : 0;
  const strikeCost = spell.archetype === 'strike' ? 12 : 0;
  const beamCost = spell.archetype === 'beam' ? (numbers.durationSec || 2) * 3.5 + Math.max(0, (numbers.length || 20) - 12) * 0.5 : 0;
  const speedCost =
    spell.archetype === 'projectile' || spell.archetype === 'aoe_burst' || spell.targeting.pattern === 'lane_sweep'
      ? Math.max(0, (numbers.speed || 24) - 16) * 0.3
      : 0;
  const widthCost = spell.archetype === 'zone_control' ? Math.max(0, (numbers.width || 6) - 4) * 0.95 : 0;
  const lengthCost = spell.archetype === 'zone_control' ? Math.max(0, (numbers.length || 6) - 4) * 0.38 : 0;
  const laneSpanCost = spell.archetype === 'zone_control' ? Math.max(0, (numbers.laneSpan || 1) - 1) * 5.8 : 0;
  const effectsCost = spell.effects.reduce((sum, effect) => sum + (EFFECT_WEIGHTS[effect] || 0), 0);
  const controlSurcharge = spell.effects.some((effect) => effect === 'freeze' || effect === 'stun') ? 6 : 0;
  return (
    damageCost +
    radiusCost +
    durationCost +
    tickCost +
    chainCost +
    strikeCost +
    beamCost +
    speedCost +
    widthCost +
    lengthCost +
    laneSpanCost +
    effectsCost +
    controlSurcharge
  );
}

function deriveCost(powerScore) {
  const mana = Math.round(clampNumber(8 + powerScore * 0.42, 8, 65));
  return { mana };
}

function sanitizeDraft(draft, context, warnings) {
  const archetypeSet = allowedArchetypes();
  const unlocks = normalizeUnlocks(context?.unlocks);

  let archetype = typeof draft?.archetype === 'string' ? draft.archetype : 'projectile';
  if (!archetypeSet.has(archetype)) {
    warnings.push(`archetype ${archetype} unavailable, downgraded`);
    archetype = unlocks.has('fireball') ? 'aoe_burst' : 'projectile';
  }

  const element = ELEMENTS.includes(draft?.element) ? draft.element : 'arcane';
  const requestedPattern = TARGET_PATTERNS.includes(draft?.targeting?.pattern)
    ? draft.targeting.pattern
    : inferTargetPattern(archetype, draft?.vfx?.shape, draft?.targeting?.singleTarget);

  const targetingMode = TARGET_MODES.includes(draft?.targeting?.mode) ? draft.targeting.mode : 'nearest';
  const defaultSingleTarget = requestedPattern === 'single_enemy' && archetype !== 'aoe_burst' && archetype !== 'chain';
  const singleTarget =
    typeof draft?.targeting?.singleTarget === 'boolean' ? draft.targeting.singleTarget : defaultSingleTarget;
  let pattern = singleTarget ? 'single_enemy' : requestedPattern;
  const targeting = {
    mode: targetingMode,
    pattern,
    singleTarget: singleTarget || pattern === 'single_enemy',
  };
  if (targetingMode === 'lane' || targetingMode === 'lane_cluster') {
    const lane = clampNumber(draft?.targeting?.lane ?? 2, 0, 4);
    targeting.lane = Math.round(lane);
  }

  const defaultRadius = archetype === 'zone_control' ? 2.4 : archetype === 'strike' ? 3.0 : 2.1;
  const radius = clampNumber(draft?.numbers?.radius ?? defaultRadius, 0.8, 8);
  const widthDefault = pattern === 'lane_sweep' ? 22 : pattern === 'lane_circle' ? 8 : radius * 2;
  const width = clampNumber(draft?.numbers?.width ?? widthDefault, 1, 44);
  const lengthDefault = pattern === 'lane_sweep' ? 34 : Math.max(3.2, radius * 2);
  const length = clampNumber(draft?.numbers?.length ?? lengthDefault, 1, 120);
  const laneSpanDefault = widthToLaneSpan(width);

  const numbers = {
    damage: clampNumber(draft?.numbers?.damage ?? 24, 8, 120),
    radius,
    durationSec: clampNumber(draft?.numbers?.durationSec ?? (archetype === 'zone_control' ? 4 : archetype === 'beam' ? 2.5 : 0), 0, 10),
    tickRate: clampNumber(draft?.numbers?.tickRate ?? 0.9, 0.2, 2),
    chainCount: Math.round(clampNumber(draft?.numbers?.chainCount ?? 3, 1, 7)),
    laneSpan: Math.round(clampNumber(draft?.numbers?.laneSpan ?? laneSpanDefault, 1, 5)),
    width,
    length,
    speed: clampNumber(draft?.numbers?.speed ?? (pattern === 'lane_sweep' ? 14 : 30), 8, 44),
  };

  let effects = uniqueEffects(draft?.effects).slice(0, 3);

  if (archetype !== 'zone_control' && archetype !== 'strike' && archetype !== 'beam' && (targeting.pattern === 'lane_circle' || targeting.pattern === 'lane_sweep')) {
    targeting.pattern = 'single_enemy';
    targeting.singleTarget = true;
    warnings.push('lane-targeted pattern downgraded to single_enemy');
  }

  const intensity = clampNumber(draft?.vfx?.intensity ?? 0.8, 0.2, 1.4);
  const vfxShape = VFX_SHAPES.includes(draft?.vfx?.shape) ? draft.vfx.shape : shapeForArchetype(archetype);
  const vfxSize = clampNumber(draft?.vfx?.size ?? defaultSizeForArchetype(archetype), 0.4, 2.2);
  const visibility = clampNumber(draft?.vfx?.visibility ?? 1.0, 0.4, 2.2);
  const ringColor = sanitizeColorToken(draft?.vfx?.ringColor);

  const primaryColor = sanitizeHexColor(draft?.vfx?.primaryColor) || defaultPrimaryColor(element);
  const secondaryColor = sanitizeHexColor(draft?.vfx?.secondaryColor) || defaultSecondaryColor(element);
  const trailEffect = TRAIL_EFFECTS.includes(draft?.vfx?.trailEffect)
    ? draft.vfx.trailEffect
    : defaultTrailForElement(element);
  const impactEffect = IMPACT_EFFECTS.includes(draft?.vfx?.impactEffect)
    ? draft.vfx.impactEffect
    : defaultImpactForArchetype(archetype);
  const particleDensity = clampNumber(draft?.vfx?.particleDensity ?? 1.0, 0.2, 2.0);
  const screenShake = clampNumber(draft?.vfx?.screenShake ?? defaultScreenShake(archetype), 0, 1.0);
  const castStyle = CAST_STYLES.includes(draft?.castStyle)
    ? draft.castStyle
    : defaultCastStyle(archetype);

  const spellName = sanitizeFlavorText(draft?.name, defaultSpellName(archetype, element), 40);
  const spellDescription = sanitizeFlavorText(
    draft?.description,
    `A ${element} ${archetype.replace('_', ' ')} spell.`,
    120
  );

  const spell = {
    name: spellName,
    description: spellDescription,
    archetype,
    element,
    targeting,
    numbers,
    effects,
    vfx: {
      palette: sanitizeText(draft?.vfx?.palette, `${element}-sigil`, 24),
      intensity,
      shape: vfxShape,
      size: vfxSize,
      visibility,
      primaryColor,
      secondaryColor,
      trailEffect,
      impactEffect,
      particleDensity,
      screenShake,
      ...(ringColor ? { ringColor } : {}),
    },
    sfx: {
      cue: sanitizeText(draft?.sfx?.cue, `${element}-cast`, 32),
    },
    castStyle,
  };

  applyCompatibilityRules(spell, warnings);
  return spell;
}

function applyCompatibilityRules(spell, warnings) {
  if (!TARGET_PATTERNS.includes(spell.targeting.pattern)) {
    spell.targeting.pattern = inferTargetPattern(spell.archetype, spell.vfx.shape, spell.targeting.singleTarget);
  }

  if (spell.targeting.pattern === 'lane_sweep' || (spell.vfx.shape === 'wave' && spell.archetype === 'zone_control' && !spell.targeting.singleTarget)) {
    spell.targeting.pattern = 'lane_sweep';
    spell.targeting.singleTarget = false;
    if (spell.archetype !== 'zone_control') {
      warnings.push('lane_sweep requires zone_control archetype');
      spell.archetype = 'zone_control';
    }
    spell.vfx.shape = 'wave';
    if (!['nearest', 'nearest_enemy', 'lane', 'lane_cluster', 'front_cluster'].includes(spell.targeting.mode)) {
      spell.targeting.mode = 'front_cluster';
    }
  } else if (spell.targeting.pattern === 'lane_circle') {
    spell.targeting.singleTarget = false;
    if (spell.archetype !== 'zone_control') {
      warnings.push('lane_circle requires zone_control archetype');
      spell.archetype = 'zone_control';
    }
    if (!['ring', 'wall'].includes(spell.vfx.shape)) {
      spell.vfx.shape = 'ring';
    }
    if (!['nearest', 'nearest_enemy', 'lane', 'lane_cluster', 'front_cluster'].includes(spell.targeting.mode)) {
      spell.targeting.mode = 'lane_cluster';
    }
  }

  if (spell.targeting.singleTarget) {
    spell.targeting.pattern = 'single_enemy';
    if (spell.archetype === 'chain' || spell.archetype === 'zone_control') {
      warnings.push('singleTarget converted to projectile archetype');
      spell.archetype = 'projectile';
    }
    spell.numbers.radius = clampNumber(spell.numbers.radius, 0.8, 1.6);
    if (spell.vfx.shape === 'wave' || spell.vfx.shape === 'wall') {
      spell.vfx.shape = 'orb';
    }
  }

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
    spell.numbers.width = clampNumber(spell.numbers.width, 1, 44);
    spell.numbers.length = clampNumber(spell.numbers.length, 1, 120);
    spell.numbers.laneSpan = Math.round(clampNumber(spell.numbers.laneSpan || widthToLaneSpan(spell.numbers.width), 1, 5));
    if (spell.targeting.pattern === 'lane_sweep') {
      if (spell.numbers.laneSpan < 2) {
        spell.numbers.laneSpan = 2;
        warnings.push('lane_sweep laneSpan corrected to minimum 2');
      }
      if (spell.numbers.length < 10) {
        spell.numbers.length = 10;
        warnings.push('lane_sweep length corrected');
      }
    }
  }

  if (spell.archetype !== 'chain') {
    delete spell.numbers.chainCount;
  }

  if (spell.archetype !== 'zone_control' && spell.archetype !== 'beam') {
    spell.numbers.durationSec = clampNumber(spell.numbers.durationSec, 0, 6);
    if (spell.numbers.durationSec > 0 && spell.archetype !== 'aoe_burst') {
      spell.numbers.durationSec = 0;
    }
    spell.numbers.laneSpan = 1;
  }

  if (spell.archetype === 'chain') {
    spell.targeting.mode = 'front_cluster';
    spell.targeting.singleTarget = false;
  }

  if (spell.archetype === 'strike') {
    spell.targeting.pattern = 'ground_strike';
    spell.targeting.singleTarget = false;
    spell.vfx.shape = 'pillar';
    spell.castStyle = 'smite';
    spell.numbers.durationSec = 0;
    spell.numbers.radius = clampNumber(spell.numbers.radius, 1.5, 6);
    if (!['nearest', 'nearest_enemy', 'front_cluster', 'lane', 'lane_cluster', 'ground_point'].includes(spell.targeting.mode)) {
      spell.targeting.mode = 'front_cluster';
    }
    delete spell.numbers.chainCount;
  }

  if (spell.archetype === 'beam') {
    spell.targeting.pattern = 'line_from_caster';
    spell.targeting.singleTarget = false;
    spell.targeting.mode = 'commander_facing';
    spell.vfx.shape = 'beam';
    spell.castStyle = 'focus';
    spell.numbers.durationSec = clampNumber(spell.numbers.durationSec || 2.5, 1, 6);
    spell.numbers.length = clampNumber(spell.numbers.length || 30, 10, 80);
    spell.numbers.width = clampNumber(spell.numbers.width || 3, 1.5, 8);
    spell.numbers.tickRate = clampNumber(spell.numbers.tickRate || 0.3, 0.15, 0.8);
    spell.numbers.laneSpan = 1;
    delete spell.numbers.chainCount;
  }

  if (spell.targeting.mode !== 'lane' && spell.targeting.mode !== 'lane_cluster') {
    delete spell.targeting.lane;
  }
}

export function validateAndFinalizeSpell(draft, context) {
  const warnings = [];
  const spell = sanitizeDraft(draft, context, warnings);
  const anchorProfile = resolveAnchorProfile(context);
  if (anchorProfile) {
    applyAnchorProfile(spell, anchorProfile, warnings);
  }
  applyContextualVariance(spell, context, warnings);
  applySoftNoRepeat(spell, context, warnings);
  applyCompatibilityRules(spell, warnings);
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
      name: 'Cinderstorm Salvo',
      description: 'A roaring sphere of molten flame that erupts on impact, scorching everything nearby.',
      archetype: 'aoe_burst',
      element: 'fire',
      targeting: { mode: 'nearest', pattern: 'single_enemy', singleTarget: false },
      numbers: { damage: 60, radius: 3.4, durationSec: 0, speed: 32, width: 3, length: 4, laneSpan: 1 },
      effects: ['burn'],
      vfx: { palette: 'ember', intensity: 1.0, shape: 'orb', primaryColor: '#ff4400', secondaryColor: '#ffaa00', trailEffect: 'ember_trail', impactEffect: 'explosion', particleDensity: 1.4, screenShake: 0.5 },
      sfx: { cue: 'fireburst' },
      castStyle: 'launch',
    };
  }

  if (name === 'wall') {
    return {
      name: 'Bulwark of Ruin',
      description: 'A towering slab of enchanted stone erupts from the earth, halting all who approach.',
      archetype: 'zone_control',
      element: 'earth',
      targeting: { mode: 'lane', pattern: 'lane_circle', singleTarget: false },
      numbers: { damage: 10, radius: 2.0, durationSec: 8, tickRate: 0.8, width: 8, length: 5, laneSpan: 1 },
      effects: ['slow', 'knockback'],
      vfx: { palette: 'stone', intensity: 0.7, shape: 'wall', primaryColor: '#8a7d6b', secondaryColor: '#c8a96e', trailEffect: 'smoke', impactEffect: 'ripple', particleDensity: 0.6, screenShake: 0.35 },
      sfx: { cue: 'bulwark' },
      castStyle: 'slam',
    };
  }

  if (name === 'frost') {
    return {
      name: 'Glacial Requiem',
      description: 'A crystalline ring of absolute zero blooms outward, flash-freezing the battlefield.',
      archetype: 'zone_control',
      element: 'ice',
      targeting: { mode: 'front_cluster', pattern: 'lane_circle', singleTarget: false },
      numbers: { damage: 16, radius: 4.5, durationSec: 2.2, tickRate: 0.7, width: 10, length: 9, laneSpan: 2 },
      effects: ['freeze', 'slow'],
      vfx: { palette: 'glacier', intensity: 0.9, shape: 'ring', primaryColor: '#66ccff', secondaryColor: '#e0f0ff', trailEffect: 'frost_mist', impactEffect: 'shatter', particleDensity: 1.2, screenShake: 0.3 },
      sfx: { cue: 'frostwave' },
      castStyle: 'pulse',
    };
  }

  if (name === 'bolt') {
    return {
      name: 'Voltaic Cascade',
      description: 'Crackling arcs of raw lightning leap between enemies in a blinding chain.',
      archetype: 'chain',
      element: 'storm',
      targeting: { mode: 'front_cluster', pattern: 'single_enemy', singleTarget: false },
      numbers: { damage: 42, radius: 2.3, durationSec: 0, chainCount: 4, width: 4, length: 6, laneSpan: 1 },
      effects: ['stun'],
      vfx: { palette: 'ion', intensity: 1.1, shape: 'arc', primaryColor: '#88ddff', secondaryColor: '#ffffff', trailEffect: 'lightning_arc', impactEffect: 'flash', particleDensity: 1.6, screenShake: 0.25 },
      sfx: { cue: 'chainbolt' },
      castStyle: 'pulse',
    };
  }

  if (name === 'tidal surge' || name === 'tsunami') {
    return {
      name: 'Abyssal Undertow',
      description: 'A towering enchanted wave crashes through the lane, dragging enemies backward in its wake.',
      archetype: 'zone_control',
      element: 'ice',
      targeting: { mode: 'front_cluster', pattern: 'lane_sweep', singleTarget: false },
      numbers: { damage: 24, radius: 2.8, durationSec: 4.2, tickRate: 0.8, width: 18, length: 22, laneSpan: 2, speed: 14 },
      effects: ['knockback', 'slow'],
      vfx: {
        palette: 'abyssal-tide',
        intensity: 1.0,
        shape: 'wave',
        primaryColor: '#2a9dff',
        secondaryColor: '#c7f1ff',
        trailEffect: 'frost_mist',
        impactEffect: 'ripple',
        particleDensity: 1.4,
        screenShake: 0.45,
      },
      sfx: { cue: 'tidal-crash' },
      castStyle: 'sweep',
    };
  }

  if (name === 'meteor' || name === 'strike') {
    return {
      name: 'Cataclysm Bolt',
      description: 'A devastating pillar of fire tears from the sky, slamming into the ground with explosive force.',
      archetype: 'strike',
      element: 'fire',
      targeting: { mode: 'front_cluster', pattern: 'ground_strike', singleTarget: false },
      numbers: { damage: 75, radius: 3.5, durationSec: 0, speed: 28, width: 7, length: 7, laneSpan: 1 },
      effects: ['burn', 'stun'],
      vfx: { palette: 'cataclysm', intensity: 1.2, shape: 'pillar', primaryColor: '#ff4400', secondaryColor: '#ffcc00', trailEffect: 'ember_trail', impactEffect: 'explosion', particleDensity: 1.6, screenShake: 0.7 },
      sfx: { cue: 'sky-smite' },
      castStyle: 'smite',
    };
  }

  if (name === 'sunlance' || name === 'beam' || name === 'dragon breath') {
    return {
      name: 'Solar Convergence',
      description: 'A searing beam of concentrated light channels from the commander, burning everything in its path.',
      archetype: 'beam',
      element: 'fire',
      targeting: { mode: 'commander_facing', pattern: 'line_from_caster', singleTarget: false },
      numbers: { damage: 18, radius: 2.0, durationSec: 2.5, tickRate: 0.3, width: 3, length: 35, laneSpan: 1, speed: 28 },
      effects: ['burn'],
      vfx: { palette: 'solar', intensity: 1.0, shape: 'beam', primaryColor: '#ffaa22', secondaryColor: '#ffffff', trailEffect: 'ember_trail', impactEffect: 'pillar', particleDensity: 1.4, screenShake: 0.2 },
      sfx: { cue: 'beam-channel' },
      castStyle: 'focus',
    };
  }

  return {
    name: 'Arcane Missile',
    description: 'A shimmering bolt of raw arcane energy that homes in on the nearest foe.',
    archetype: 'projectile',
    element: 'arcane',
    targeting: { mode: 'nearest', pattern: 'single_enemy', singleTarget: true },
    numbers: { damage: 32, radius: 2.0, durationSec: 0, speed: 28, width: 2, length: 3, laneSpan: 1 },
    effects: ['slow'],
    vfx: { palette: 'astral', intensity: 0.8, shape: 'orb', primaryColor: '#b366ff', secondaryColor: '#e0b3ff', trailEffect: 'holy_motes', impactEffect: 'flash', particleDensity: 0.8, screenShake: 0.15 },
    sfx: { cue: 'arcane-shot' },
    castStyle: 'launch',
  };
}

export function deterministicFallback(prompt, context) {
  const raw = String(prompt || '').toLowerCase();
  const anchorKey = normalizeAnchorKey(context?.spellIdentity?.curatedKey || context?.spellIdentity?.anchorKey);
  const canonicalAnchor = ANCHOR_PROFILE_ALIASES[anchorKey] || anchorKey;

  let presetName = 'default';
  if (canonicalAnchor && ANCHOR_PROFILES[canonicalAnchor]) {
    presetName = canonicalAnchor;
  } else if (/(tsunami|tidal|wave|surge|deluge|undertow)/.test(raw)) {
    presetName = 'tidal surge';
  } else if (/(meteor|smite|strike|sky.*bolt|divine|cataclysm|quake|earthquake|seismic)/.test(raw)) {
    presetName = 'meteor';
  } else if (/(beam|laser|ray|lance|sun.*lance|dragon.*breath|channel|convergence)/.test(raw)) {
    presetName = 'beam';
  } else if (/(volcano|lava|magma|eruption|fire)/.test(raw)) {
    presetName = 'fireball';
  } else if (/(wall|barrier|block|fortify|stone)/.test(raw)) {
    presetName = 'wall';
  } else if (/(frost|freeze|ice|blizzard|glacier)/.test(raw)) {
    presetName = 'frost';
  } else if (/(bolt|lightning|chain|thunder)/.test(raw)) {
    presetName = 'bolt';
  }

  const draft = createPreset(presetName);
  const finalized = validateAndFinalizeSpell(draft, context);
  if (finalized.ok) {
    return finalized;
  }

  return validateAndFinalizeSpell(createPreset('default'), context);
}

function resolveAnchorProfile(context) {
  const rawAnchor = normalizeAnchorKey(context?.spellIdentity?.curatedKey || context?.spellIdentity?.anchorKey);
  if (!rawAnchor) {
    return null;
  }
  const canonicalAnchor = ANCHOR_PROFILE_ALIASES[rawAnchor] || rawAnchor;
  const profile = ANCHOR_PROFILES[canonicalAnchor];
  if (!profile) {
    return null;
  }
  return {
    key: canonicalAnchor,
    ...profile,
  };
}

function applyAnchorProfile(spell, profile, warnings) {
  if (!profile || !spell) {
    return;
  }

  if (profile.element && spell.element !== profile.element) {
    spell.element = profile.element;
    warnings.push(`anchor(${profile.key}) forced element=${profile.element}`);
  }

  if (Array.isArray(profile.allowedArchetypes) && profile.allowedArchetypes.length > 0) {
    if (!profile.allowedArchetypes.includes(spell.archetype)) {
      spell.archetype = profile.allowedArchetypes[0];
      warnings.push(`anchor(${profile.key}) forced archetype=${spell.archetype}`);
    }
  }

  if (profile.preferredPattern && TARGET_PATTERNS.includes(profile.preferredPattern)) {
    spell.targeting.pattern = profile.preferredPattern;
    spell.targeting.singleTarget = profile.preferredPattern === 'single_enemy';
  }

  if (profile.preferredTargetMode && TARGET_MODES.includes(profile.preferredTargetMode)) {
    spell.targeting.mode = profile.preferredTargetMode;
  }

  if (profile.preferredShape && VFX_SHAPES.includes(profile.preferredShape)) {
    spell.vfx.shape = profile.preferredShape;
  }

  if (profile.castStyle && CAST_STYLES.includes(profile.castStyle)) {
    spell.castStyle = profile.castStyle;
  }

  if (Number.isFinite(profile.minLaneSpan)) {
    spell.numbers.laneSpan = Math.max(Math.round(profile.minLaneSpan), Math.round(Number(spell.numbers.laneSpan || 1)));
  }

  if (Number.isFinite(profile.minLength)) {
    spell.numbers.length = Math.max(Number(profile.minLength), Number(spell.numbers.length || 1));
  }

  if (Array.isArray(profile.requiredEffects) && profile.requiredEffects.length > 0) {
    spell.effects = uniqueEffects([...profile.requiredEffects, ...(spell.effects || [])]).slice(0, 3);
  }
}

function applyContextualVariance(spell, context, warnings) {
  if (!spell || typeof spell !== 'object') {
    return;
  }
  if (!context?.variantContext || typeof context.variantContext !== 'object') {
    return;
  }

  const enemies = Array.isArray(context?.nearbyEnemies) ? context.nearbyEnemies : [];
  const castIndex = Math.max(1, Math.round(Number(context?.variantContext?.castIndex || 1)));
  const wave = clampNumber(context?.wave ?? 1, 1, 60);
  const mana = clampNumber(context?.mana ?? 0, 0, 999);
  const enemyCount = enemies.length;
  const nearBaseCount = enemies.filter((enemy) => Number(enemy?.z ?? 0) >= 12).length;
  const spread = laneSpread(enemies);
  const avgHp = enemyCount > 0 ? enemies.reduce((sum, enemy) => sum + Number(enemy?.hp ?? 0), 0) / enemyCount : 0;

  const enemyPressure = clamp01(enemyCount / 10);
  const nearBasePressure = clamp01(nearBaseCount / 6);
  const lanePressure = clamp01(spread / 4);
  const durabilityPressure = clamp01(avgHp / 110);
  const wavePressure = clamp01(wave / 40);
  const manaPressure = clamp01(mana / 120);

  const seedBase = [
    context?.spellIdentity?.anchorKey || '',
    context?.spellIdentity?.curatedKey || '',
    castIndex,
    wave,
    mana,
    enemyCount,
    spread,
  ].join('|');
  const signedA = pseudoRandomSigned(`${seedBase}:a`);
  const signedB = pseudoRandomSigned(`${seedBase}:b`);

  const aggression = enemyPressure * 0.05 + nearBasePressure * 0.05 + durabilityPressure * 0.04 + wavePressure * 0.03;
  const economy = (1 - manaPressure) * 0.06;
  const damageScale = clampNumber(1 + aggression - economy + signedA * 0.05, 0.9, 1.12);
  const areaScale = clampNumber(1 + enemyPressure * 0.06 + lanePressure * 0.05 + signedB * 0.05, 0.9, 1.12);
  const speedScale = clampNumber(1 + signedA * 0.08 + nearBasePressure * 0.04, 0.9, 1.12);

  spell.numbers.damage = clampNumber(spell.numbers.damage * damageScale, 8, 120);
  spell.numbers.radius = clampNumber(spell.numbers.radius * areaScale, 0.8, 8);
  const cycle = ((castIndex - 1) % 3) + 1;
  if (cycle === 1) {
    spell.numbers.damage = clampNumber(spell.numbers.damage + 2.2, 8, 120);
  } else if (cycle === 2) {
    spell.numbers.radius = clampNumber(spell.numbers.radius + 0.28, 0.8, 8);
  } else {
    spell.numbers.speed = clampNumber((spell.numbers.speed || 24) + 1.8, 8, 44);
  }

  if (spell.archetype === 'zone_control') {
    spell.numbers.durationSec = clampNumber(spell.numbers.durationSec * clampNumber(1 + signedB * 0.06 + enemyPressure * 0.04, 0.9, 1.14), 1, 10);
    spell.numbers.length = clampNumber(spell.numbers.length * clampNumber(1 + lanePressure * 0.08 + signedA * 0.05, 0.9, 1.15), 1, 120);
    spell.numbers.width = clampNumber(spell.numbers.width * clampNumber(1 + lanePressure * 0.07 + signedB * 0.05, 0.9, 1.15), 1, 44);
    spell.numbers.laneSpan = Math.round(clampNumber(spell.numbers.laneSpan + (lanePressure > 0.5 ? 1 : 0), 1, 5));
  } else if (spell.archetype === 'beam') {
    spell.numbers.durationSec = clampNumber(spell.numbers.durationSec * clampNumber(1 + signedB * 0.05 + enemyPressure * 0.03, 0.92, 1.1), 1, 6);
    spell.numbers.length = clampNumber(spell.numbers.length * clampNumber(1 + lanePressure * 0.06 + signedA * 0.04, 0.92, 1.12), 10, 80);
    spell.numbers.width = clampNumber(spell.numbers.width * clampNumber(1 + enemyPressure * 0.05, 0.95, 1.1), 1.5, 8);
  } else {
    spell.numbers.speed = clampNumber(spell.numbers.speed * speedScale, 8, 44);
  }

  spell.vfx.intensity = clampNumber(spell.vfx.intensity + signedB * 0.08, 0.2, 1.4);
  spell.vfx.particleDensity = clampNumber(spell.vfx.particleDensity + signedA * 0.15 + enemyPressure * 0.15, 0.2, 2.0);
  spell.vfx.screenShake = clampNumber(spell.vfx.screenShake + signedB * 0.08 + aggression * 0.35, 0, 1.0);

  if (mana < 24 && spell.effects.length > 2) {
    spell.effects = spell.effects.slice(0, 2);
    warnings.push('mana_low_effect_budget_reduced');
  }
}

function applySoftNoRepeat(spell, context, warnings) {
  const recentSignatures = Array.isArray(context?.variantContext?.recentSignatures)
    ? context.variantContext.recentSignatures.filter((item) => typeof item === 'string')
    : [];
  if (recentSignatures.length === 0) {
    return;
  }

  let signature = buildSpellVariantSignature(spell);
  if (!recentSignatures.includes(signature)) {
    return;
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    mutateSpellForNoRepeat(spell, context, attempt);
    applyCompatibilityRules(spell, warnings);
    signature = buildSpellVariantSignature(spell);
    if (!recentSignatures.includes(signature)) {
      warnings.push('soft_no_repeat_guard_adjusted_variant');
      return;
    }
  }

  warnings.push('soft_no_repeat_guard_unresolved');
}

function mutateSpellForNoRepeat(spell, context, attempt) {
  const seed = [
    context?.spellIdentity?.anchorKey || 'spell',
    context?.variantContext?.castIndex || 1,
    attempt,
  ].join('|');
  const signed = pseudoRandomSigned(seed);
  const flip = pseudoRandomUnit(`${seed}:flip`) > 0.5;

  spell.numbers.damage = clampNumber(spell.numbers.damage * (flip ? 1.06 : 0.94), 8, 120);
  spell.numbers.radius = clampNumber(spell.numbers.radius * (flip ? 0.94 : 1.06), 0.8, 8);
  spell.numbers.speed = clampNumber((spell.numbers.speed || 24) * (flip ? 1.04 : 0.96), 8, 44);
  spell.vfx.particleDensity = clampNumber((spell.vfx.particleDensity || 1.0) + signed * 0.18, 0.2, 2.0);
  spell.vfx.screenShake = clampNumber((spell.vfx.screenShake || 0.2) + signed * 0.1, 0, 1.0);
  spell.castStyle = rotateCastStyle(spell.castStyle, attempt + 1);

  spell.vfx.primaryColor = tintHexColor(spell.vfx.primaryColor, '#ffffff', flip ? 0.06 : 0.03);
  spell.vfx.secondaryColor = tintHexColor(spell.vfx.secondaryColor, '#000000', flip ? 0.04 : 0.02);
}

export function buildSpellVariantSignature(spell) {
  if (!spell || typeof spell !== 'object') {
    return 'invalid';
  }
  const effects = Array.isArray(spell.effects) ? [...spell.effects].sort() : [];
  const numbers = spell.numbers || {};
  const targeting = spell.targeting || {};
  const vfx = spell.vfx || {};
  return [
    String(spell.archetype || ''),
    String(spell.element || ''),
    String(targeting.pattern || ''),
    String(targeting.mode || ''),
    String(vfx.shape || ''),
    String(spell.castStyle || ''),
    effects.join(','),
    Math.round(Number(numbers.damage || 0) / 4),
    Math.round(Number(numbers.radius || 0) * 2),
    Math.round(Number(numbers.durationSec || 0) * 2),
    Math.round(Number(numbers.speed || 0) / 3),
    Math.round(Number(numbers.laneSpan || 1)),
    Math.round(Number(numbers.width || 0) / 3),
    Math.round(Number(numbers.length || 0) / 4),
  ].join('|');
}

function rotateCastStyle(current, offset) {
  const index = CAST_STYLES.indexOf(current);
  if (index < 0) {
    return CAST_STYLES[0];
  }
  return CAST_STYLES[(index + offset) % CAST_STYLES.length];
}

function laneSpread(enemies) {
  const lanes = new Set();
  for (const enemy of enemies) {
    lanes.add(clampNumber(enemy?.lane ?? 2, 0, 4));
  }
  return lanes.size;
}

function pseudoRandomSigned(seed) {
  return pseudoRandomUnit(seed) * 2 - 1;
}

function pseudoRandomUnit(seed) {
  const text = String(seed || '');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

function tintHexColor(hex, target, amount) {
  const sourceHex = sanitizeHexColor(hex) || '#999999';
  const targetHex = sanitizeHexColor(target) || sourceHex;
  const blend = clampNumber(amount, 0, 1);
  const sourceRgb = hexToRgb(sourceHex);
  const targetRgb = hexToRgb(targetHex);
  const mixed = {
    r: Math.round(sourceRgb.r + (targetRgb.r - sourceRgb.r) * blend),
    g: Math.round(sourceRgb.g + (targetRgb.g - sourceRgb.g) * blend),
    b: Math.round(sourceRgb.b + (targetRgb.b - sourceRgb.b) * blend),
  };
  return rgbToHex(mixed);
}

function hexToRgb(hex) {
  const value = sanitizeHexColor(hex) || '#000000';
  return {
    r: Number.parseInt(value.slice(1, 3), 16),
    g: Number.parseInt(value.slice(3, 5), 16),
    b: Number.parseInt(value.slice(5, 7), 16),
  };
}

function rgbToHex(rgb) {
  const r = clampNumber(Math.round(rgb?.r ?? 0), 0, 255).toString(16).padStart(2, '0');
  const g = clampNumber(Math.round(rgb?.g ?? 0), 0, 255).toString(16).padStart(2, '0');
  const b = clampNumber(Math.round(rgb?.b ?? 0), 0, 255).toString(16).padStart(2, '0');
  return `#${r}${g}${b}`;
}

function normalizeAnchorKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function shapeForArchetype(archetype) {
  if (archetype === 'zone_control') return 'ring';
  if (archetype === 'chain') return 'arc';
  if (archetype === 'strike') return 'pillar';
  if (archetype === 'beam') return 'beam';
  return 'orb';
}

function defaultSizeForArchetype(archetype) {
  if (archetype === 'aoe_burst') return 1.15;
  if (archetype === 'zone_control') return 1.0;
  if (archetype === 'chain') return 0.85;
  if (archetype === 'strike') return 1.3;
  if (archetype === 'beam') return 0.9;
  return 1.0;
}

function defaultPrimaryColor(element) {
  const map = { fire: '#ff6622', ice: '#66ccff', arcane: '#b366ff', earth: '#8ca85c', storm: '#88ddff' };
  return map[element] || '#b366ff';
}

function defaultSecondaryColor(element) {
  const map = { fire: '#ffcc00', ice: '#ffffff', arcane: '#e0b3ff', earth: '#c8a96e', storm: '#ffffff' };
  return map[element] || '#e0b3ff';
}

function defaultTrailForElement(element) {
  const map = { fire: 'ember_trail', ice: 'frost_mist', arcane: 'holy_motes', earth: 'smoke', storm: 'lightning_arc' };
  return map[element] || 'spark';
}

function defaultImpactForArchetype(archetype) {
  const map = { projectile: 'flash', aoe_burst: 'explosion', zone_control: 'ripple', chain: 'flash', strike: 'explosion', beam: 'pillar' };
  return map[archetype] || 'flash';
}

function defaultScreenShake(archetype) {
  const map = { projectile: 0.15, aoe_burst: 0.45, zone_control: 0.25, chain: 0.2, strike: 0.65, beam: 0.15 };
  return map[archetype] || 0.15;
}

function defaultCastStyle(archetype) {
  const map = { projectile: 'launch', aoe_burst: 'launch', zone_control: 'slam', chain: 'pulse', strike: 'smite', beam: 'focus' };
  return map[archetype] || 'launch';
}

function defaultSpellName(archetype, element) {
  const elementNames = { fire: 'Flame', ice: 'Frost', arcane: 'Arcane', earth: 'Stone', storm: 'Storm' };
  const archetypeNames = { projectile: 'Bolt', aoe_burst: 'Blast', zone_control: 'Ward', chain: 'Arc', strike: 'Smite', beam: 'Ray' };
  return `${elementNames[element] || 'Arcane'} ${archetypeNames[archetype] || 'Spell'}`;
}

function sanitizeFlavorText(value, fallback, maxLength) {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(/[^\w\s.,!?'-]/g, '').trim().slice(0, maxLength);
  return cleaned || fallback;
}

function sanitizeHexColor(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(cleaned)) return cleaned;
  if (/^[0-9a-f]{6}$/.test(cleaned)) return `#${cleaned}`;
  if (/^0x[0-9a-f]{6}$/.test(cleaned)) return `#${cleaned.slice(2)}`;
  return null;
}

function sanitizeText(value, fallback, maxLength) {
  if (typeof value !== 'string') {
    return fallback;
  }
  const cleaned = value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-').slice(0, maxLength);
  return cleaned || fallback;
}

function sanitizeColorToken(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const cleaned = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(cleaned)) {
    return cleaned;
  }
  if (/^(0x)?[0-9a-f]{6}$/.test(cleaned)) {
    return `#${cleaned.replace(/^0x/, '')}`;
  }
  return null;
}

function clampNumber(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return min;
  }
  return Math.max(min, Math.min(max, numeric));
}

function clamp01(value) {
  return clampNumber(value, 0, 1);
}

function round2(value) {
  return Math.round(value * 100) / 100;
}
