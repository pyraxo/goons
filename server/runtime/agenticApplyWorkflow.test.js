import { describe, expect, it, vi } from 'vitest';

import { runAgenticApplyWorkflow } from './agenticApplyWorkflow.js';
import { MechanicRuntime } from './mechanicRuntime.js';
import { InMemorySandboxStateStore } from './persistence/sandboxStateStore.js';
import { createDefaultPrimitiveRegistry } from './primitives/primitiveRegistry.js';

function makeMechanicArtifact() {
  return {
    id: 'wall_of_fire',
    name: 'Wall of Fire',
    description: 'Periodic lane burn with combo reward.',
    lifecycle: 'persistent',
    hooks: [
      {
        event: 'onKillCombo',
        intervalSeconds: 0,
        maxInvocationsPerTick: 1,
        invocations: [
          {
            primitiveId: 'economy.add_gold',
            argsJson: '{"amount":3,"reason":"combo ignite bonus"}',
          },
        ],
      },
    ],
    limits: {
      maxCommandsPerTick: 8,
      maxInvocationsPerTick: 4,
      maxRuntimeMs: 2,
    },
  };
}

describe('runAgenticApplyWorkflow', () => {
  it('runs asset+patch routes and activates compiled mechanics', async () => {
    const primitiveRegistry = createDefaultPrimitiveRegistry();
    const mechanicRuntime = new MechanicRuntime();
    const sandboxStateStore = new InMemorySandboxStateStore();
    const generateAssets = vi.fn(async () => ({
      jobs: [{ assetId: 'mechanic_wall_of_fire' }],
      assets: [{ id: 'mechanic_wall_of_fire', path: '/models/generated/wall.glb' }],
    }));

    const result = await runAgenticApplyWorkflow({
      artifact: {
        sandboxPatch: {
          resetToBaselineFirst: false,
          mechanics: [makeMechanicArtifact()],
          units: [],
          actions: [{ id: 'ignite_lane', name: 'Ignite Lane', trigger: 'manual', effect: 'burn lane' }],
          ui: [],
        },
      },
      envelope: { id: 'prompt_1', rawPrompt: 'wall of fire' },
      templateVersion: 'sandbox-v1',
      primitiveRegistry,
      mechanicRuntime,
      sandboxStateStore,
      generateAssets,
      resetToBaseline: async () => {},
    });

    expect(generateAssets).toHaveBeenCalledTimes(1);
    expect(result.activatedMechanics).toBe(1);
    expect(result.assets).toHaveLength(1);

    const snapshot = mechanicRuntime.getSnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].id).toBe('wall_of_fire');

    const saved = await sandboxStateStore.load();
    expect(saved.mechanics).toHaveLength(1);
    expect(saved.assets).toHaveLength(1);
  });

  it('runs reset route before patch/activation when requested', async () => {
    const resetToBaseline = vi.fn(async () => {});

    await runAgenticApplyWorkflow({
      artifact: {
        sandboxPatch: {
          resetToBaselineFirst: true,
          mechanics: [],
          units: [],
          actions: [],
          ui: [],
        },
      },
      envelope: { id: 'prompt_2', rawPrompt: 'reset test' },
      templateVersion: 'sandbox-v1',
      primitiveRegistry: createDefaultPrimitiveRegistry(),
      mechanicRuntime: new MechanicRuntime(),
      sandboxStateStore: new InMemorySandboxStateStore(),
      generateAssets: async () => ({ jobs: [], assets: [] }),
      resetToBaseline,
    });

    expect(resetToBaseline).toHaveBeenCalledWith('artifact-apply');
  });
});
