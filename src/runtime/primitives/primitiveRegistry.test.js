import { describe, expect, it } from 'vitest';

import { createDefaultPrimitiveRegistry } from './primitiveRegistry.js';

describe('PrimitiveRegistry', () => {
  it('validates and executes known primitive invocations', () => {
    const registry = createDefaultPrimitiveRegistry();
    const commands = registry.executeInvocation(
      {
        primitiveId: 'economy.add_gold',
        args: { amount: 25, reason: 'combo' },
      },
      { eventName: 'onKillCombo' }
    );

    expect(commands).toEqual([
      {
        type: 'economy.addGold',
        payload: {
          amount: 25,
          reason: 'combo',
        },
      },
    ]);
  });

  it('emits action cast command from actions.cast_spell primitive', () => {
    const registry = createDefaultPrimitiveRegistry();
    const commands = registry.executeInvocation(
      {
        primitiveId: 'actions.cast_spell',
        args: { spellName: 'fireball' },
      },
      { eventName: 'onKillCombo' }
    );

    expect(commands).toEqual([
      {
        type: 'actions.castSpell',
        payload: {
          spellName: 'fireball',
        },
      },
    ]);
  });

  it('rejects invocation with unknown primitive', () => {
    const registry = createDefaultPrimitiveRegistry();
    const result = registry.validateInvocation(
      {
        primitiveId: 'unknown.primitive',
        args: {},
      },
      'onTick'
    );
    expect(result.ok).toBe(false);
  });

  it('rejects invocation when hook is not allowed', () => {
    const registry = createDefaultPrimitiveRegistry();
    const result = registry.validateInvocation(
      {
        primitiveId: 'units.spawn',
        args: { unitKind: 'car' },
      },
      'onEnemyDeath'
    );
    expect(result.ok).toBe(false);
  });

  it('resolves dynamic context references in args', () => {
    const registry = createDefaultPrimitiveRegistry();
    const commands = registry.executeInvocation(
      {
        primitiveId: 'combat.apply_dot',
        args: {
          targetId: '$enemy.id',
          dps: '$dot.dps',
          durationSeconds: '$dot.duration',
        },
      },
      {
        eventName: 'onEnemyDeath',
        enemy: { id: 'enemy_9' },
        dot: { dps: 7, duration: 3 },
      }
    );

    expect(commands).toEqual([
      {
        type: 'combat.applyDot',
        payload: {
          targetId: 'enemy_9',
          dps: 7,
          durationSeconds: 3,
        },
      },
    ]);
  });

  it('fails when dynamic context references are unresolved', () => {
    const registry = createDefaultPrimitiveRegistry();
    expect(() =>
      registry.executeInvocation(
        {
          primitiveId: 'combat.apply_dot',
          args: {
            targetId: '$enemy.id',
            dps: 5,
            durationSeconds: 3,
          },
        },
        {
          eventName: 'onEnemyDeath',
        }
      )
    ).toThrow('unresolved refs');
  });
});
