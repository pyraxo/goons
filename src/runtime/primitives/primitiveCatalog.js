export const MECHANIC_HOOK_EVENTS = [
  'onTick',
  'onEnemySpawn',
  'onEnemyDeath',
  'onKillCombo',
  'onWaveStart',
];

function numericArg({ min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = {}) {
  return {
    type: 'number',
    min,
    max,
  };
}

function stringArg({ minLength = 1 } = {}) {
  return {
    type: 'string',
    minLength,
  };
}

function integerArg({ min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = {}) {
  return {
    type: 'integer',
    min,
    max,
  };
}

export const BUILTIN_PRIMITIVE_CATALOG = [
  {
    id: 'economy.add_gold',
    version: 1,
    description: 'Adds gold immediately.',
    allowedEvents: ['onTick', 'onEnemyDeath', 'onKillCombo', 'onWaveStart'],
    args: {
      amount: numericArg({ min: 0.01, max: 1_000_000_000 }),
      reason: stringArg({ minLength: 1 }),
    },
    requiredArgs: ['amount'],
    emitCommands: ({ args }) => [
      {
        type: 'economy.addGold',
        payload: {
          amount: args.amount,
          reason: args.reason ?? 'mechanic',
        },
      },
    ],
  },
  {
    id: 'economy.add_multiplier',
    version: 1,
    description: 'Adds a named multiplier with optional duration.',
    allowedEvents: ['onTick', 'onEnemyDeath', 'onKillCombo', 'onWaveStart'],
    args: {
      key: stringArg({ minLength: 1 }),
      multiplier: numericArg({ min: 0.01, max: 100 }),
      durationSeconds: numericArg({ min: 0.01, max: 3600 }),
    },
    requiredArgs: ['key', 'multiplier'],
    emitCommands: ({ args }) => [
      {
        type: 'economy.addMultiplier',
        payload: {
          key: args.key,
          multiplier: args.multiplier,
          durationSeconds: args.durationSeconds,
        },
      },
    ],
  },
  {
    id: 'combat.apply_dot',
    version: 1,
    description: 'Applies damage-over-time to a known target.',
    allowedEvents: ['onTick', 'onEnemySpawn', 'onEnemyDeath', 'onKillCombo'],
    args: {
      targetId: stringArg({ minLength: 1 }),
      dps: numericArg({ min: 0.01, max: 10_000 }),
      durationSeconds: numericArg({ min: 0.01, max: 120 }),
    },
    requiredArgs: ['targetId', 'dps', 'durationSeconds'],
    emitCommands: ({ args }) => [
      {
        type: 'combat.applyDot',
        payload: {
          targetId: args.targetId,
          dps: args.dps,
          durationSeconds: args.durationSeconds,
        },
      },
    ],
  },
  {
    id: 'combat.deal_damage',
    version: 1,
    description: 'Deals direct damage to a known target.',
    allowedEvents: ['onTick', 'onEnemySpawn', 'onEnemyDeath', 'onKillCombo'],
    args: {
      targetId: stringArg({ minLength: 1 }),
      amount: numericArg({ min: 0.01, max: 1_000_000 }),
    },
    requiredArgs: ['targetId', 'amount'],
    emitCommands: ({ args }) => [
      {
        type: 'combat.dealDamage',
        payload: {
          targetId: args.targetId,
          amount: args.amount,
        },
      },
    ],
  },
  {
    id: 'combat.chain_spread',
    version: 1,
    description: 'Triggers a spread operation from a source entity.',
    allowedEvents: ['onTick', 'onEnemyDeath', 'onKillCombo'],
    args: {
      sourceId: stringArg({ minLength: 1 }),
      radius: numericArg({ min: 0.1, max: 200 }),
      maxTargets: integerArg({ min: 1, max: 1024 }),
    },
    requiredArgs: ['sourceId', 'radius', 'maxTargets'],
    emitCommands: ({ args }) => [
      {
        type: 'combat.chainSpread',
        payload: {
          sourceId: args.sourceId,
          radius: args.radius,
          maxTargets: args.maxTargets,
        },
      },
    ],
  },
  {
    id: 'units.spawn',
    version: 1,
    description: 'Spawns a unit by kind.',
    allowedEvents: ['onTick', 'onWaveStart'],
    args: {
      unitKind: stringArg({ minLength: 1 }),
      lane: integerArg({ min: 0, max: 32 }),
    },
    requiredArgs: ['unitKind'],
    emitCommands: ({ args }) => [
      {
        type: 'units.spawn',
        payload: {
          unitKind: args.unitKind,
          lane: args.lane,
        },
      },
    ],
  },
  {
    id: 'ui.mount_widget',
    version: 1,
    description: 'Mounts a UI widget with props.',
    allowedEvents: ['onTick', 'onWaveStart'],
    args: {
      widgetId: stringArg({ minLength: 1 }),
      props: {
        type: 'object',
      },
    },
    requiredArgs: ['widgetId', 'props'],
    emitCommands: ({ args }) => [
      {
        type: 'ui.mountWidget',
        payload: {
          widgetId: args.widgetId,
          props: args.props,
        },
      },
    ],
  },
];
