import { describe, expect, it } from 'vitest';
import { MechanicRuntime } from './mechanicRuntime.js';

describe('MechanicRuntime', () => {
  it('applies valid commands from onTick', () => {
    const runtime = new MechanicRuntime();
    runtime.registerMechanic({
      id: 'bonus_gold',
      name: 'Bonus Gold',
      onTick: () => [
        {
          type: 'economy.addGold',
          payload: { amount: 5, reason: 'test' },
        },
      ],
    });

    let applied = 0;
    const result = runtime.tick(0.016, {}, () => {
      applied += 1;
    });

    expect(result.commandsApplied).toBe(1);
    expect(applied).toBe(1);
  });

  it('disables mechanic after invalid command', () => {
    const runtime = new MechanicRuntime();
    runtime.registerMechanic({
      id: 'bad_mechanic',
      name: 'Bad Mechanic',
      onTick: () => [{ type: 'engine.eval', payload: {} }],
    });

    const result = runtime.tick(0.016, {}, () => {});
    expect(result.disabledMechanics).toContain('bad_mechanic');

    const snapshot = runtime.getSnapshot();
    expect(snapshot.find((entry) => entry.id === 'bad_mechanic')?.enabled).toBe(false);
  });
});
