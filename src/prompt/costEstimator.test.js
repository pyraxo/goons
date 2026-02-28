import { afterEach, describe, expect, it } from 'vitest';
import { estimatePrompt } from './costEstimator';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('estimatePrompt', () => {
  it('uses LLM estimate payload and normalizes envelope fields', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        estimate: {
          classifiedTypes: ['units', 'mechanics'],
          estimatedGoldCost: 141.2,
          riskLevel: 'high',
          requiresReview: false,
        },
      }),
    });

    const result = await estimatePrompt('spawn a poison priest unit with dot aura');

    expect(result.rawPrompt).toBe('spawn a poison priest unit with dot aura');
    expect(result.classifiedTypes).toContain('units');
    expect(result.classifiedTypes).toContain('mechanics');
    expect(result.estimatedGoldCost).toBe(142);
    expect(result.riskLevel).toBe('high');
    expect(result.requiresReview).toBe(false);
  });

  it('throws when endpoint fails', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 500,
      text: async () => '{"error":"upstream"}',
    });

    await expect(estimatePrompt('make something happen')).rejects.toThrow(
      'Prompt estimation failed (500)'
    );
  });
});
