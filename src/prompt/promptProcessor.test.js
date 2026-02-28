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
      {},
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
});
