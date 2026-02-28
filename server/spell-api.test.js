import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleSpellGenerate } from './spell-api.js';

const draft = {
  archetype: 'projectile',
  element: 'storm',
  targeting: { mode: 'nearest' },
  numbers: { damage: 26, radius: 1.8, durationSec: 0, speed: 24 },
  effects: ['slow'],
  vfx: { palette: 'foam', intensity: 0.8, shape: 'orb' },
  sfx: { cue: 'wave-cast' },
};

const baseRequest = {
  prompt: 'tidal wave',
  wave: 2,
  mana: 120,
  unlocks: ['fireball', 'wall'],
  nearbyEnemies: [
    { lane: 1, kind: 'melee', hp: 58, z: 30 },
    { lane: 2, kind: 'ranged', hp: 40, z: -10 },
  ],
};

describe('spell-api', () => {
  const originalApiKey = process.env.OPENAI_API_KEY;

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
  });

  it('retries when first provider response is token-incomplete without tool call', async () => {
    process.env.OPENAI_API_KEY = 'test-key';

    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(
            JSON.stringify({
              status: 'incomplete',
              output: [{ type: 'reasoning' }],
              incomplete_details: { reason: 'max_output_tokens' },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        return new Response(
          JSON.stringify({
            status: 'completed',
            output: [{ type: 'function_call', name: 'craft_spell', arguments: JSON.stringify(draft) }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      })
    );

    const result = await handleSpellGenerate(baseRequest, { requestId: 'test-retry' });
    expect(calls).toBe(2);
    expect(result.status).toBe(200);
    expect(result.payload.source).toBe('llm');
    expect(result.payload.meta.fallbackReason).toBeNull();
  });

  it('falls back when provider never emits a tool call', async () => {
    process.env.OPENAI_API_KEY = 'test-key';

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            status: 'completed',
            output: [{ type: 'reasoning' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    );

    const result = await handleSpellGenerate(baseRequest, { requestId: 'test-fallback' });
    expect(result.status).toBe(200);
    expect(result.payload.source).toBe('fallback');
    expect(result.payload.meta.fallbackReason).toBe('schema_no_tool_call');
  });
});
