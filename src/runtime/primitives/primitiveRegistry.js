import { validateRuntimeCommandList } from '../commandSchema.js';
import { BUILTIN_PRIMITIVE_CATALOG } from './primitiveCatalog.js';

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isDynamicRef(value) {
  return typeof value === 'string' && value.startsWith('$') && value.length > 1;
}

function resolvePath(path, context) {
  const parts = path.split('.').filter(Boolean);
  let current = context;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || !(part in current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function resolveDynamicArgs(value, context, unresolvedRefs) {
  if (Array.isArray(value)) {
    return value.map((item) => resolveDynamicArgs(item, context, unresolvedRefs));
  }

  if (isDynamicRef(value)) {
    const resolved = resolvePath(value.slice(1), context);
    if (resolved === undefined) {
      unresolvedRefs.push(value);
      return value;
    }
    return resolved;
  }

  if (value && typeof value === 'object') {
    const resolved = {};
    for (const [key, item] of Object.entries(value)) {
      resolved[key] = resolveDynamicArgs(item, context, unresolvedRefs);
    }
    return resolved;
  }

  return value;
}

function validateArgValue(definition, value, key, allowDynamicRefs) {
  if (allowDynamicRefs && isDynamicRef(value)) {
    return;
  }

  if (definition.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`Primitive arg "${key}" must be a number`);
    }
    if (definition.min !== undefined && value < definition.min) {
      throw new Error(`Primitive arg "${key}" must be >= ${definition.min}`);
    }
    if (definition.max !== undefined && value > definition.max) {
      throw new Error(`Primitive arg "${key}" must be <= ${definition.max}`);
    }
    return;
  }

  if (definition.type === 'integer') {
    if (!Number.isInteger(value)) {
      throw new Error(`Primitive arg "${key}" must be an integer`);
    }
    if (definition.min !== undefined && value < definition.min) {
      throw new Error(`Primitive arg "${key}" must be >= ${definition.min}`);
    }
    if (definition.max !== undefined && value > definition.max) {
      throw new Error(`Primitive arg "${key}" must be <= ${definition.max}`);
    }
    return;
  }

  if (definition.type === 'string') {
    if (typeof value !== 'string') {
      throw new Error(`Primitive arg "${key}" must be a string`);
    }
    if (definition.minLength !== undefined && value.trim().length < definition.minLength) {
      throw new Error(`Primitive arg "${key}" must have minimum length ${definition.minLength}`);
    }
    return;
  }

  if (definition.type === 'object') {
    if (!isObject(value)) {
      throw new Error(`Primitive arg "${key}" must be an object`);
    }
    return;
  }

  throw new Error(`Unsupported primitive arg type "${definition.type}" for "${key}"`);
}

function normalizePrimitiveDefinition(definition) {
  if (!isObject(definition)) {
    throw new Error('Primitive definition must be an object');
  }

  const id = String(definition.id ?? '').trim();
  if (!id) {
    throw new Error('Primitive definition requires non-empty id');
  }

  if (!Array.isArray(definition.allowedEvents) || definition.allowedEvents.length === 0) {
    throw new Error(`Primitive "${id}" requires non-empty allowedEvents`);
  }

  if (typeof definition.emitCommands !== 'function') {
    throw new Error(`Primitive "${id}" requires emitCommands function`);
  }

  const args = isObject(definition.args) ? clone(definition.args) : {};
  const requiredArgs = Array.isArray(definition.requiredArgs)
    ? definition.requiredArgs.map((value) => String(value))
    : [];

  return {
    id,
    version: Number.isInteger(definition.version) ? definition.version : 1,
    description: String(definition.description ?? '').trim(),
    allowedEvents: definition.allowedEvents.map((value) => String(value)),
    args,
    requiredArgs,
    emitCommands: definition.emitCommands,
  };
}

export class PrimitiveRegistry {
  constructor(definitions = []) {
    this.definitions = new Map();
    for (const definition of definitions) {
      this.register(definition);
    }
  }

  register(definition) {
    const normalized = normalizePrimitiveDefinition(definition);
    this.definitions.set(normalized.id, normalized);
    return normalized;
  }

  has(id) {
    return this.definitions.has(id);
  }

  get(id) {
    return this.definitions.get(id) ?? null;
  }

  list() {
    return Array.from(this.definitions.values()).map((definition) => ({
      id: definition.id,
      version: definition.version,
      description: definition.description,
      allowedEvents: [...definition.allowedEvents],
      requiredArgs: [...definition.requiredArgs],
      args: clone(definition.args),
    }));
  }

  validateInvocation(invocation, eventName, options = {}) {
    const allowDynamicRefs = options.allowDynamicRefs !== false;
    if (!isObject(invocation)) {
      return { ok: false, error: 'Primitive invocation must be an object' };
    }

    const primitiveId = String(invocation.primitiveId ?? '').trim();
    if (!primitiveId) {
      return { ok: false, error: 'Primitive invocation missing primitiveId' };
    }

    const primitive = this.definitions.get(primitiveId);
    if (!primitive) {
      return { ok: false, error: `Unknown primitive "${primitiveId}"` };
    }

    if (eventName && !primitive.allowedEvents.includes(eventName)) {
      return { ok: false, error: `Primitive "${primitiveId}" is not allowed on hook "${eventName}"` };
    }

    const args = isObject(invocation.args) ? invocation.args : {};
    for (const key of primitive.requiredArgs) {
      if (args[key] === undefined) {
        return { ok: false, error: `Primitive "${primitiveId}" missing required arg "${key}"` };
      }
    }

    for (const [key, value] of Object.entries(args)) {
      const definition = primitive.args[key];
      if (!definition) {
        return { ok: false, error: `Primitive "${primitiveId}" received unknown arg "${key}"` };
      }
      try {
        validateArgValue(definition, value, key, allowDynamicRefs);
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : `Invalid arg "${key}"`,
        };
      }
    }

    return { ok: true };
  }

  executeInvocation(invocation, context = {}) {
    const eventName = String(context.eventName ?? '').trim() || undefined;
    const validation = this.validateInvocation(invocation, eventName, { allowDynamicRefs: true });
    if (!validation.ok) {
      throw new Error(validation.error);
    }

    const primitive = this.get(invocation.primitiveId);
    if (!primitive) {
      throw new Error(`Unknown primitive "${invocation.primitiveId}"`);
    }

    const unresolvedRefs = [];
    const resolvedArgs = resolveDynamicArgs(invocation.args ?? {}, context, unresolvedRefs);
    if (unresolvedRefs.length > 0) {
      throw new Error(
        `Primitive "${primitive.id}" args could not be resolved: unresolved refs ${unresolvedRefs.join(', ')}`
      );
    }
    const resolvedValidation = this.validateInvocation(
      {
        primitiveId: invocation.primitiveId,
        args: resolvedArgs,
      },
      eventName,
      { allowDynamicRefs: false }
    );
    if (!resolvedValidation.ok) {
      throw new Error(`Primitive "${primitive.id}" args could not be resolved: ${resolvedValidation.error}`);
    }

    const commands = primitive.emitCommands({
      args: resolvedArgs,
      context,
    });

    const normalizedCommands = Array.isArray(commands) ? commands : [];
    const commandValidation = validateRuntimeCommandList(normalizedCommands);
    if (!commandValidation.ok) {
      throw new Error(`Primitive "${primitive.id}" emitted invalid commands: ${commandValidation.error}`);
    }

    return normalizedCommands;
  }
}

export function createDefaultPrimitiveRegistry() {
  return new PrimitiveRegistry(BUILTIN_PRIMITIVE_CATALOG);
}
