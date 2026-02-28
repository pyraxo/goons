import { describe, expect, it } from 'vitest';

import { ARTIFACT_RESPONSE_SCHEMA } from './templateDrafts.js';

describe('ARTIFACT_RESPONSE_SCHEMA', () => {
  it('requires every hook property for strict structured outputs', () => {
    const hookSchema =
      ARTIFACT_RESPONSE_SCHEMA.properties.sandboxPatch.properties.mechanics.items.properties.hooks.items;

    expect(hookSchema.required).toEqual([
      'event',
      'intervalSeconds',
      'maxInvocationsPerTick',
      'invocations',
    ]);
  });
});
