import { assertRuntimeCommand } from './commandSchema.js';

const DEFAULT_MAX_COMMANDS_PER_TICK = 32;
const DEFAULT_MAX_MECHANIC_MS = 3;
const HANDLER_NAMES = ['onTick', 'onEnemySpawn', 'onEnemyDeath', 'onKillCombo', 'onWaveStart'];

function normalizeMechanic(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('Mechanic must be an object');
  }

  const id = String(input.id ?? '').trim();
  const name = String(input.name ?? '').trim() || id;
  if (!id) {
    throw new Error('Mechanic requires non-empty id');
  }

  const handlers = {};
  if (input.handlers && typeof input.handlers === 'object') {
    for (const handlerName of HANDLER_NAMES) {
      if (typeof input.handlers[handlerName] === 'function') {
        handlers[handlerName] = input.handlers[handlerName];
      }
    }
  }

  if (typeof input.onTick === 'function') {
    handlers.onTick = input.onTick;
  }

  if (Object.keys(handlers).length === 0) {
    throw new Error(`Mechanic "${id}" requires at least one handler`);
  }

  return {
    id,
    name,
    handlers,
    maxRuntimeMs:
      typeof input.maxRuntimeMs === 'number' && Number.isFinite(input.maxRuntimeMs) && input.maxRuntimeMs > 0
        ? input.maxRuntimeMs
        : null,
    maxCommandsPerTick:
      Number.isInteger(input.maxCommandsPerTick) && input.maxCommandsPerTick > 0
        ? input.maxCommandsPerTick
        : null,
    enabled: input.enabled !== false,
  };
}

export class MechanicRuntime {
  constructor(options = {}) {
    this.maxCommandsPerTick = options.maxCommandsPerTick ?? DEFAULT_MAX_COMMANDS_PER_TICK;
    this.maxMechanicMs = options.maxMechanicMs ?? DEFAULT_MAX_MECHANIC_MS;
    this.mechanics = new Map();
    this.telemetry = new Map();
  }

  clear() {
    this.mechanics.clear();
    this.telemetry.clear();
  }

  registerMechanic(rawMechanic) {
    const mechanic = normalizeMechanic(rawMechanic);
    this.mechanics.set(mechanic.id, mechanic);
    this.telemetry.set(mechanic.id, {
      name: mechanic.name,
      ticks: 0,
      commands: 0,
      errors: 0,
      lastError: null,
    });
  }

  disableMechanic(id, reason) {
    const mechanic = this.mechanics.get(id);
    if (!mechanic) return false;
    mechanic.enabled = false;
    const telemetry = this.telemetry.get(id);
    if (telemetry) {
      telemetry.errors += 1;
      telemetry.lastError = reason || 'disabled';
    }
    return true;
  }

  getSnapshot() {
    const mechanics = Array.from(this.mechanics.values()).map((mechanic) => ({
      id: mechanic.id,
      name: mechanic.name,
      enabled: mechanic.enabled,
      telemetry: this.telemetry.get(mechanic.id) || null,
    }));
    mechanics.sort((a, b) => a.id.localeCompare(b.id));
    return mechanics;
  }

  runHandler(eventName, context = {}, applyCommand = () => {}) {
    let remainingCommandBudget = this.maxCommandsPerTick;
    let totalCommands = 0;
    const disabledThisTick = [];
    const now = typeof performance !== 'undefined' ? performance.now.bind(performance) : Date.now;

    const mechanics = Array.from(this.mechanics.values()).sort((a, b) => a.id.localeCompare(b.id));
    for (const mechanic of mechanics) {
      if (!mechanic.enabled || remainingCommandBudget <= 0) {
        continue;
      }

      const handler = mechanic.handlers[eventName];
      if (typeof handler !== 'function') {
        continue;
      }

      const telemetry = this.telemetry.get(mechanic.id);
      const startedAt = now();
      try {
        const commands = handler(context);
        const list = Array.isArray(commands) ? commands : [];
        const commandCap = mechanic.maxCommandsPerTick ?? this.maxCommandsPerTick;
        let emittedByMechanic = 0;

        for (const command of list) {
          if (remainingCommandBudget <= 0 || emittedByMechanic >= commandCap) {
            break;
          }
          assertRuntimeCommand(command);
          applyCommand(command, mechanic);
          remainingCommandBudget -= 1;
          totalCommands += 1;
          emittedByMechanic += 1;
          if (telemetry) telemetry.commands += 1;
        }

        const elapsedMs = now() - startedAt;
        const runtimeBudgetMs = mechanic.maxRuntimeMs ?? this.maxMechanicMs;
        if (telemetry) telemetry.ticks += 1;
        if (elapsedMs > runtimeBudgetMs) {
          this.disableMechanic(mechanic.id, `Exceeded runtime budget ${elapsedMs.toFixed(2)}ms`);
          disabledThisTick.push(mechanic.id);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown mechanic error';
        this.disableMechanic(mechanic.id, message);
        disabledThisTick.push(mechanic.id);
      }
    }

    return {
      commandsApplied: totalCommands,
      disabledMechanics: disabledThisTick,
      remainingCommandBudget,
    };
  }

  tick(dt, context = {}, applyCommand = () => {}) {
    return this.runHandler('onTick', { dt, ...context }, applyCommand);
  }

  dispatchEvent(eventName, eventPayload = {}, applyCommand = () => {}) {
    return this.runHandler(eventName, eventPayload, applyCommand);
  }
}
