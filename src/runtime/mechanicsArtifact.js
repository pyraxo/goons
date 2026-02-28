import { MECHANIC_HOOK_EVENTS } from './primitives/primitiveCatalog.js';

const ALLOWED_LIFECYCLES = new Set(['persistent', 'timed', 'wave']);
const HOOK_EVENTS = new Set(MECHANIC_HOOK_EVENTS);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizePositiveInteger(value, fallback) {
  if (!Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function normalizePositiveNumber(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function parseArgsFromJson(rawArgsJson) {
  if (typeof rawArgsJson !== 'string' || rawArgsJson.trim().length === 0) {
    return { args: {}, parseError: null };
  }

  try {
    const parsed = JSON.parse(rawArgsJson);
    if (!isObject(parsed)) {
      return { args: {}, parseError: 'argsJson must decode to a JSON object' };
    }
    return { args: parsed, parseError: null };
  } catch (error) {
    return {
      args: {},
      parseError: error instanceof Error ? error.message : 'invalid argsJson',
    };
  }
}

function normalizeInvocation(invocation) {
  const parsed = parseArgsFromJson(invocation.argsJson);
  return {
    primitiveId: String(invocation.primitiveId ?? '').trim(),
    args: isObject(invocation.args) ? invocation.args : parsed.args,
    parseError: parsed.parseError,
  };
}

function normalizeHook(hook) {
  return {
    event: String(hook.event ?? '').trim(),
    intervalSeconds: hook.intervalSeconds,
    maxInvocationsPerTick: hook.maxInvocationsPerTick,
    invocations: Array.isArray(hook.invocations) ? hook.invocations.map(normalizeInvocation) : [],
  };
}

export function validateMechanicArtifact(artifact, primitiveRegistry) {
  if (!isObject(artifact)) {
    return { ok: false, error: 'Mechanic artifact must be an object' };
  }

  const id = String(artifact.id ?? '').trim();
  if (!id) {
    return { ok: false, error: 'Mechanic artifact missing non-empty id' };
  }

  const name = String(artifact.name ?? '').trim();
  if (!name) {
    return { ok: false, error: `Mechanic "${id}" missing non-empty name` };
  }

  const lifecycle = String(artifact.lifecycle ?? 'persistent').trim();
  if (!ALLOWED_LIFECYCLES.has(lifecycle)) {
    return { ok: false, error: `Mechanic "${id}" has unsupported lifecycle "${lifecycle}"` };
  }

  const hooks = Array.isArray(artifact.hooks) ? artifact.hooks.map(normalizeHook) : [];
  if (hooks.length === 0) {
    return { ok: false, error: `Mechanic "${id}" requires at least one hook` };
  }

  for (const hook of hooks) {
    if (!HOOK_EVENTS.has(hook.event)) {
      return { ok: false, error: `Mechanic "${id}" has unsupported hook "${hook.event}"` };
    }
    if (!Array.isArray(hook.invocations) || hook.invocations.length === 0) {
      return { ok: false, error: `Mechanic "${id}" hook "${hook.event}" requires invocations` };
    }

    for (const invocation of hook.invocations) {
      if (invocation.parseError) {
        return {
          ok: false,
          error: `Mechanic "${id}" hook "${hook.event}" has invalid argsJson: ${invocation.parseError}`,
        };
      }
      const result = primitiveRegistry.validateInvocation(invocation, hook.event);
      if (!result.ok) {
        return {
          ok: false,
          error: `Mechanic "${id}" hook "${hook.event}" invalid primitive invocation: ${result.error}`,
        };
      }
    }
  }

  return { ok: true };
}

export function compileMechanicArtifact(artifact, primitiveRegistry) {
  const validation = validateMechanicArtifact(artifact, primitiveRegistry);
  if (!validation.ok) {
    throw new Error(validation.error);
  }

  const hooks = artifact.hooks.map(normalizeHook);
  const onTickHooks = hooks.filter((hook) => hook.event === 'onTick');
  const onEnemySpawnHooks = hooks.filter((hook) => hook.event === 'onEnemySpawn');
  const onEnemyDeathHooks = hooks.filter((hook) => hook.event === 'onEnemyDeath');
  const onKillComboHooks = hooks.filter((hook) => hook.event === 'onKillCombo');
  const onWaveStartHooks = hooks.filter((hook) => hook.event === 'onWaveStart');
  const tickAccumulators = new Map();

  for (let i = 0; i < onTickHooks.length; i += 1) {
    tickAccumulators.set(i, 0);
  }

  const maxCommandsPerTick = normalizePositiveInteger(artifact?.limits?.maxCommandsPerTick, 16);
  const maxInvocationsPerTickDefault = normalizePositiveInteger(
    artifact?.limits?.maxInvocationsPerTick,
    8
  );
  const maxRuntimeMs = normalizePositiveNumber(artifact?.limits?.maxRuntimeMs, 2.5);

  function executeHook(hooksForEvent, context) {
    const commands = [];
    for (const hook of hooksForEvent) {
      const maxInvocations = normalizePositiveInteger(
        hook.maxInvocationsPerTick,
        maxInvocationsPerTickDefault
      );
      for (let i = 0; i < hook.invocations.length && i < maxInvocations; i += 1) {
        const invocation = hook.invocations[i];
        const emitted = primitiveRegistry.executeInvocation(invocation, {
          eventName: hook.event,
          mechanicId: artifact.id,
          mechanicName: artifact.name,
          ...context,
        });
        commands.push(...emitted);
        if (commands.length >= maxCommandsPerTick) {
          return commands.slice(0, maxCommandsPerTick);
        }
      }
    }
    return commands;
  }

  return {
    id: artifact.id,
    name: artifact.name,
    maxRuntimeMs,
    maxCommandsPerTick,
    handlers: {
      onTick: ({ dt, ...context }) => {
        const commands = [];
        for (let i = 0; i < onTickHooks.length; i += 1) {
          const hook = onTickHooks[i];
          const intervalSeconds = normalizePositiveNumber(hook.intervalSeconds, 0);
          let elapsed = tickAccumulators.get(i) ?? 0;
          elapsed += normalizePositiveNumber(dt, 0);

          if (intervalSeconds > 0 && elapsed < intervalSeconds) {
            tickAccumulators.set(i, elapsed);
            continue;
          }

          if (intervalSeconds > 0) {
            elapsed %= intervalSeconds;
          } else {
            elapsed = 0;
          }
          tickAccumulators.set(i, elapsed);

          const emitted = executeHook([hook], { dt, ...context });
          commands.push(...emitted);
          if (commands.length >= maxCommandsPerTick) {
            return commands.slice(0, maxCommandsPerTick);
          }
        }
        return commands;
      },
      onEnemySpawn: (context) => executeHook(onEnemySpawnHooks, context),
      onEnemyDeath: (context) => executeHook(onEnemyDeathHooks, context),
      onKillCombo: (context) => executeHook(onKillComboHooks, context),
      onWaveStart: (context) => executeHook(onWaveStartHooks, context),
    },
  };
}
