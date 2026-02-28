import { describe, expect, it } from 'vitest';
import { PromptProcessor } from './promptProcessor';

function makeEnvelope(prompt) {
  return {
    id: `prompt_${Math.random().toString(36).slice(2, 8)}`,
    inputMode: 'text',
    rawPrompt: prompt,
    classifiedTypes: ['actions'],
    estimatedGoldCost: 50,
    riskLevel: 'low',
    requiresReview: false,
  };
}

describe('PromptProcessor', () => {
  it('commits reserved gold on successful apply', async () => {
    let committed = 0;
    let refunded = 0;

    const processor = new PromptProcessor(
      {
        reserveGold: () => 'res_1',
        commitReservedGold: () => {
          committed += 1;
          return true;
        },
        refundReservedGold: () => {
          refunded += 1;
          return true;
        },
      },
      {},
      {
        executePrompt: async () => {
          return;
        },
      }
    );

    processor.enqueue(makeEnvelope('cast meteor now'), 'fast');
    await processor.waitForIdle();

    expect(committed).toBe(1);
    expect(refunded).toBe(0);
    expect(processor.getHistory()).toHaveLength(1);
  });

  it('refunds reserved gold after terminal failure and retries', async () => {
    let committed = 0;
    let refunded = 0;
    let attempts = 0;

    const processor = new PromptProcessor(
      {
        reserveGold: () => 'res_1',
        commitReservedGold: () => {
          committed += 1;
          return true;
        },
        refundReservedGold: () => {
          refunded += 1;
          return true;
        },
      },
      {},
      {
        maxRetries: 3,
        retryDelayMs: 1,
        executePrompt: async () => {
          attempts += 1;
          throw new Error('boom');
        },
      }
    );

    processor.enqueue(makeEnvelope('force fail prompt'), 'fast');
    await processor.waitForIdle();

    expect(attempts).toBe(3);
    expect(committed).toBe(0);
    expect(refunded).toBe(1);
    expect(processor.getHistory()).toHaveLength(0);
  });

  it('includes resolved mechanics in replay script observability', async () => {
    const processor = new PromptProcessor(
      {
        reserveGold: () => 'res_1',
        commitReservedGold: () => true,
        refundReservedGold: () => true,
      },
      {
        onArtifactApplied: async () => ({
          activatedMechanics: 1,
        }),
      },
      {
        executePrompt: async () => ({
          templateVersion: 'sandbox-v1',
          artifact: {
            sandboxPatch: {
              ui: [],
              units: [],
              actions: [],
              mechanics: [
                {
                  id: 'wall_of_fire',
                  name: 'Wall of Fire',
                  description: 'Creates a burning lane barrier.',
                  rules: ['Deals 8 DPS for 4s', 'Applies ignite to nearby enemies'],
                },
              ],
            },
          },
        }),
      }
    );

    processor.enqueue(makeEnvelope('wall of fire'), 'fast');
    await processor.waitForIdle();

    const replay = processor.getReplayScript();
    expect(replay).toContain('mechanic: Wall of Fire');
    expect(replay).toContain('Deals 8 DPS for 4s');
    expect(replay).toContain('template=sandbox-v1');
  });

  it('refunds and fails apply when mechanics were requested but none activated', async () => {
    let committed = 0;
    let refunded = 0;

    const processor = new PromptProcessor(
      {
        reserveGold: () => 'res_1',
        commitReservedGold: () => {
          committed += 1;
          return true;
        },
        refundReservedGold: () => {
          refunded += 1;
          return true;
        },
      },
      {
        onArtifactApplied: async () => ({
          activatedMechanics: 0,
        }),
      },
      {
        executePrompt: async () => ({
          templateVersion: 'sandbox-v1',
          artifact: {
            sandboxPatch: {
              resetToBaselineFirst: false,
              ui: [],
              units: [],
              actions: [],
              mechanics: [
                {
                  id: 'bad_mech',
                  name: 'Bad Mech',
                  description: 'Will not activate',
                  hooks: [],
                },
              ],
            },
          },
        }),
      }
    );

    processor.enqueue(makeEnvelope('apply but no active mechanics'), 'fast');
    await processor.waitForIdle();

    expect(committed).toBe(0);
    expect(refunded).toBe(1);
    expect(processor.getHistory()).toHaveLength(0);
  });

  it('can clear queued jobs and replay history for sandbox reset', async () => {
    let resolveApply;
    const firstApplyDone = new Promise((resolve) => {
      resolveApply = resolve;
    });

    const processor = new PromptProcessor(
      {
        reserveGold: () => 'res_1',
        commitReservedGold: () => true,
        refundReservedGold: () => true,
      },
      {},
      {
        executePrompt: async () => {
          await firstApplyDone;
        },
      }
    );

    processor.enqueue(makeEnvelope('first prompt'), 'fast');
    processor.enqueue(makeEnvelope('second prompt should be dropped'), 'fast');

    const dropped = processor.clearQueuedJobs();
    expect(dropped).toBe(1);

    resolveApply();
    await processor.waitForIdle();
    expect(processor.getHistory()).toHaveLength(1);

    processor.clearHistory();
    expect(processor.getHistory()).toHaveLength(0);
  });

  it('refunds gold and skips history if sandbox apply routes fail', async () => {
    let committed = 0;
    let refunded = 0;

    const processor = new PromptProcessor(
      {
        reserveGold: () => 'res_1',
        commitReservedGold: () => {
          committed += 1;
          return true;
        },
        refundReservedGold: () => {
          refunded += 1;
          return true;
        },
      },
      {
        onArtifactApplied: async () => {
          throw new Error('route failure');
        },
      },
      {
        executePrompt: async () => ({
          templateVersion: 'sandbox-v1',
          artifact: {
            sandboxPatch: {
              resetToBaselineFirst: false,
              ui: [],
              mechanics: [],
              units: [],
              actions: [],
            },
          },
        }),
      }
    );

    processor.enqueue(makeEnvelope('apply route failure'), 'fast');
    await processor.waitForIdle();

    expect(committed).toBe(0);
    expect(refunded).toBe(1);
    expect(processor.getHistory()).toHaveLength(0);
  });
});
