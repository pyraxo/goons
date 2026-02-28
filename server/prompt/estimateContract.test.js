import { describe, expect, it } from 'vitest';

import { parseEstimateOutputText } from './estimateContract.js';

describe('parseEstimateOutputText', () => {
  it('accepts valid estimate json', () => {
    const result = parseEstimateOutputText(
      JSON.stringify({
        classifiedTypes: ['mechanics'],
        estimatedGoldCost: 120000,
        riskLevel: 'medium',
        requiresReview: false,
      })
    );

    expect(result.ok).toBe(true);
    expect(result.estimate?.classifiedTypes).toEqual(['mechanics']);
  });

  it('accepts estimate wrapped in code fences', () => {
    const result = parseEstimateOutputText(
      '```json\n{"classifiedTypes":["actions"],"estimatedGoldCost":50,"riskLevel":"low","requiresReview":false}\n```'
    );

    expect(result.ok).toBe(true);
    expect(result.estimate?.estimatedGoldCost).toBe(50);
  });

  it('rejects invalid json', () => {
    const result = parseEstimateOutputText('{"classifiedTypes":["actions"],');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not valid JSON');
  });
});
