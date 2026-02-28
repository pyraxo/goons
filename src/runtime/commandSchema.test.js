import { describe, expect, it } from 'vitest';
import { validateRuntimeCommand, validateRuntimeCommandList } from './commandSchema.js';

describe('validateRuntimeCommand', () => {
  it('accepts valid economy command', () => {
    const result = validateRuntimeCommand({
      type: 'economy.addGold',
      payload: { amount: 25, reason: 'combo' },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects invalid command type', () => {
    const result = validateRuntimeCommand({
      type: 'engine.eval',
      payload: {},
    });
    expect(result.ok).toBe(false);
  });

  it('rejects malformed list', () => {
    const result = validateRuntimeCommandList([
      { type: 'economy.addGold', payload: { amount: 10 } },
      { type: 'combat.dealDamage', payload: { targetId: '', amount: 1 } },
    ]);
    expect(result.ok).toBe(false);
  });
});
