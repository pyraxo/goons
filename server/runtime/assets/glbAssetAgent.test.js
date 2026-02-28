import { afterEach, describe, expect, it, vi } from 'vitest';

import { deriveGlbAssetJobs, generateGlbAssetsForArtifact } from './glbAssetAgent.js';

describe('glbAssetAgent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('derives deterministic GLB jobs from sandbox patch collections', () => {
    const jobs = deriveGlbAssetJobs({
      sandboxPatch: {
        mechanics: [{ id: 'wall_of_fire', name: 'Wall of Fire' }],
        units: [{ id: 'car_unit', name: 'Car Unit' }],
        actions: [{ id: 'ignite_lane', name: 'Ignite Lane' }],
        ui: [{ id: 'hud_timer', title: 'HUD Timer' }],
      },
    });

    expect(jobs.map((job) => job.assetId)).toEqual([
      'mechanic_wall_of_fire',
      'unit_car_unit',
      'action_ignite_lane',
      'ui_hud_timer',
    ]);
  });

  it('generates assets through API endpoint and normalizes response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        assets: [
          {
            id: 'mechanic_wall_of_fire',
            name: 'Wall Flame Emitter',
            path: '/models/generated/prompt-a-mechanic_wall_of_fire.glb',
            sourceType: 'mechanic',
            sourceId: 'wall_of_fire',
            generatedAt: '2026-02-28T00:00:00.000Z',
            model: 'gpt-5.3-codex',
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateGlbAssetsForArtifact({
      envelope: {
        id: 'prompt_a',
        rawPrompt: 'wall of fire',
      },
      artifact: {
        sandboxPatch: {
          mechanics: [{ id: 'wall_of_fire', name: 'Wall of Fire' }],
          units: [],
          actions: [],
          ui: [],
        },
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.jobs).toHaveLength(1);
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0].kind).toBe('glb');
  });
});
