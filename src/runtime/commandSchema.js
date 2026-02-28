const ALLOWED_COMMAND_TYPES = new Set([
  'combat.applyDot',
  'combat.chainSpread',
  'combat.dealDamage',
  'economy.addGold',
  'economy.addMultiplier',
  'units.spawn',
  'ui.mountWidget',
]);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validatePositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function validatePayload(type, payload) {
  if (!isObject(payload)) {
    return { ok: false, error: `Runtime command "${type}" requires object payload` };
  }

  if (type === 'economy.addGold') {
    if (!validatePositiveNumber(payload.amount)) {
      return { ok: false, error: 'economy.addGold.amount must be a positive number' };
    }
    return { ok: true };
  }

  if (type === 'economy.addMultiplier') {
    if (!validateString(payload.key)) {
      return { ok: false, error: 'economy.addMultiplier.key must be a non-empty string' };
    }
    if (!validatePositiveNumber(payload.multiplier)) {
      return { ok: false, error: 'economy.addMultiplier.multiplier must be a positive number' };
    }
    if (payload.durationSeconds !== undefined && !validatePositiveNumber(payload.durationSeconds)) {
      return { ok: false, error: 'economy.addMultiplier.durationSeconds must be a positive number' };
    }
    return { ok: true };
  }

  if (type === 'combat.applyDot') {
    if (!validateString(payload.targetId)) {
      return { ok: false, error: 'combat.applyDot.targetId must be a non-empty string' };
    }
    if (!validatePositiveNumber(payload.dps) || !validatePositiveNumber(payload.durationSeconds)) {
      return { ok: false, error: 'combat.applyDot requires positive dps and durationSeconds' };
    }
    return { ok: true };
  }

  if (type === 'combat.dealDamage') {
    if (!validateString(payload.targetId) || !validatePositiveNumber(payload.amount)) {
      return { ok: false, error: 'combat.dealDamage requires targetId and positive amount' };
    }
    return { ok: true };
  }

  if (type === 'combat.chainSpread') {
    if (!validateString(payload.sourceId)) {
      return { ok: false, error: 'combat.chainSpread.sourceId must be a non-empty string' };
    }
    if (!validatePositiveNumber(payload.radius) || !validatePositiveNumber(payload.maxTargets)) {
      return { ok: false, error: 'combat.chainSpread requires positive radius and maxTargets' };
    }
    return { ok: true };
  }

  if (type === 'units.spawn') {
    if (!validateString(payload.unitKind)) {
      return { ok: false, error: 'units.spawn.unitKind must be a non-empty string' };
    }
    if (payload.lane !== undefined && !Number.isInteger(payload.lane)) {
      return { ok: false, error: 'units.spawn.lane must be an integer when provided' };
    }
    return { ok: true };
  }

  if (type === 'ui.mountWidget') {
    if (!validateString(payload.widgetId)) {
      return { ok: false, error: 'ui.mountWidget.widgetId must be a non-empty string' };
    }
    if (!isObject(payload.props)) {
      return { ok: false, error: 'ui.mountWidget.props must be an object' };
    }
    return { ok: true };
  }

  return { ok: false, error: `Unsupported runtime command "${type}"` };
}

export function validateRuntimeCommand(command) {
  if (!isObject(command)) {
    return { ok: false, error: 'Runtime command must be an object' };
  }

  const type = command.type;
  if (!validateString(type)) {
    return { ok: false, error: 'Runtime command type must be a non-empty string' };
  }

  if (!ALLOWED_COMMAND_TYPES.has(type)) {
    return { ok: false, error: `Runtime command type "${type}" is not allowed` };
  }

  return validatePayload(type, command.payload);
}

export function assertRuntimeCommand(command) {
  const result = validateRuntimeCommand(command);
  if (!result.ok) {
    throw new Error(result.error);
  }
}

export function validateRuntimeCommandList(commands) {
  if (!Array.isArray(commands)) {
    return { ok: false, error: 'Runtime command list must be an array' };
  }

  for (let i = 0; i < commands.length; i += 1) {
    const result = validateRuntimeCommand(commands[i]);
    if (!result.ok) {
      return { ok: false, error: `Command ${i} invalid: ${result.error}` };
    }
  }

  return { ok: true };
}
