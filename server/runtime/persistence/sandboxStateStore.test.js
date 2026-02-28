import { describe, expect, it } from 'vitest';

import { InMemorySandboxStateStore } from './sandboxStateStore.js';

describe('InMemorySandboxStateStore', () => {
  it('saves and loads sandbox state', async () => {
    const store = new InMemorySandboxStateStore();
    const state = {
      templateVersion: 'sandbox-v1',
      baselineAppliedAt: '2026-02-28T00:00:00.000Z',
      mechanics: [{ id: 'combo_gold' }],
      units: [],
      actions: [],
      ui: [],
      assets: [],
    };

    await store.save(state);
    const loaded = await store.load();
    expect(loaded.mechanics).toHaveLength(1);
    expect(loaded.mechanics[0].id).toBe('combo_gold');
  });

  it('resets to baseline', async () => {
    const store = new InMemorySandboxStateStore({
      templateVersion: 'sandbox-v1',
      baselineAppliedAt: 'x',
      mechanics: [{ id: 'x' }],
      units: [],
      actions: [],
      ui: [],
      assets: [],
    });

    const reset = await store.reset();
    expect(reset.mechanics).toHaveLength(0);
    expect(reset.baselineAppliedAt).toBe(null);
    expect(reset.assets).toEqual([]);
  });
});
