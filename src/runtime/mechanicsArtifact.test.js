import { describe, expect, it } from 'vitest';

import { compileMechanicArtifact, validateMechanicArtifact } from './mechanicsArtifact.js';
import { createDefaultPrimitiveRegistry } from './primitives/primitiveRegistry.js';

function makeArtifact() {
  return {
    id: 'combo_gold',
    name: 'Combo Gold',
    description: 'Adds bonus gold over time for testing.',
    lifecycle: 'persistent',
    limits: {
      maxCommandsPerTick: 4,
      maxInvocationsPerTick: 4,
      maxRuntimeMs: 2,
    },
    hooks: [
      {
        event: 'onTick',
        intervalSeconds: 0.5,
        invocations: [
          {
            primitiveId: 'economy.add_gold',
            argsJson: '{"amount":10,"reason":"combo test"}',
          },
        ],
      },
    ],
  };
}

describe('mechanicsArtifact', () => {
  it('validates mechanic artifact with known primitives', () => {
    const registry = createDefaultPrimitiveRegistry();
    const result = validateMechanicArtifact(makeArtifact(), registry);
    expect(result.ok).toBe(true);
  });

  it('rejects unknown primitive', () => {
    const registry = createDefaultPrimitiveRegistry();
    const artifact = makeArtifact();
    artifact.hooks[0].invocations[0].primitiveId = 'economy.unknown';
    const result = validateMechanicArtifact(artifact, registry);
    expect(result.ok).toBe(false);
  });

  it('compiles onTick hooks into runtime handlers', () => {
    const registry = createDefaultPrimitiveRegistry();
    const compiled = compileMechanicArtifact(makeArtifact(), registry);

    const tick1 = compiled.handlers.onTick({ dt: 0.2, game: { wave: 1 } });
    const tick2 = compiled.handlers.onTick({ dt: 0.31, game: { wave: 1 } });

    expect(tick1).toHaveLength(0);
    expect(tick2).toHaveLength(1);
    expect(tick2[0].type).toBe('economy.addGold');
  });

  it('rejects malformed argsJson', () => {
    const registry = createDefaultPrimitiveRegistry();
    const artifact = makeArtifact();
    artifact.hooks[0].invocations[0].argsJson = '{"amount":10';
    const result = validateMechanicArtifact(artifact, registry);
    expect(result.ok).toBe(false);
  });

  it('supports legacy args object as fallback', () => {
    const registry = createDefaultPrimitiveRegistry();
    const artifact = makeArtifact();
    delete artifact.hooks[0].invocations[0].argsJson;
    artifact.hooks[0].invocations[0].args = { amount: 12, reason: 'legacy' };
    const result = validateMechanicArtifact(artifact, registry);
    expect(result.ok).toBe(true);
  });
});
