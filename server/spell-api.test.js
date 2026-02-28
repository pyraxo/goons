import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSpellGenerate } from './spell-api.js';

const draft = {
  name: 'Thundertide Lance',
  description: 'A crackling spear of compressed storm energy that pierces through the frontline.',
  archetype: 'projectile',
  element: 'storm',
  targeting: { mode: 'nearest' },
  numbers: { damage: 26, radius: 1.8, durationSec: 0, speed: 24 },
  effects: ['slow'],
  vfx: { palette: 'foam', intensity: 0.8, shape: 'orb', primaryColor: '#88ddff', secondaryColor: '#ffffff', trailEffect: 'lightning_arc', impactEffect: 'flash', particleDensity: 1.0, screenShake: 0.2 },
  sfx: { cue: 'wave-cast' },
  castStyle: 'launch',
};

const baseRequest = {
  prompt: 'sand blast',
  wave: 2,
  mana: 120,
  unlocks: ['fireball', 'wall'],
  nearbyEnemies: [
    { lane: 1, kind: 'melee', hp: 58, z: 30 },
    { lane: 2, kind: 'ranged', hp: 40, z: -10 },
  ],
};

function extractProviderInputPayload(call) {
  const request = JSON.parse(call.body);
  const inputText = request?.input?.[0]?.content?.[0]?.text;
  assert.equal(typeof inputText, 'string');
  return JSON.parse(inputText);
}

test('retries when first provider response is token-incomplete without tool call', async () => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';

  let calls = 0;
  const providerCalls = [];
  global.fetch = async (_url, init = {}) => {
    providerCalls.push({
      body: String(init.body ?? ''),
    });
    calls += 1;
    if (calls === 1) {
      return new Response(
        JSON.stringify({
          status: 'incomplete',
          output: [{ type: 'reasoning' }],
          incomplete_details: { reason: 'max_output_tokens' },
          usage: { input_tokens: 100, output_tokens: 200, total_tokens: 300 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({
        status: 'completed',
        output: [{ type: 'function_call', name: 'craft_spell', arguments: JSON.stringify(draft) }],
        usage: { input_tokens: 90, output_tokens: 40, total_tokens: 130 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  try {
    const result = await handleSpellGenerate(baseRequest, { requestId: 'test-retry' });
    assert.equal(calls, 2);
    assert.equal(result.status, 200);
    assert.equal(result.payload.source, 'llm');
    assert.equal(result.payload.meta.fallbackReason, null);
    assert.equal(result.payload.spell.archetype, 'projectile');
    assert.equal(result.payload.meta.templateMatch, null);
    assert.equal(result.payload.meta.expandedPromptPreview, null);
    const providerInput = extractProviderInputPayload(providerCalls[0]);
    assert.equal(providerInput.prompt, baseRequest.prompt);
    assert.equal(providerInput.templateContext, undefined);
  } finally {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
  }
});

test('falls back when provider never emits a tool call', async () => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';

  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        status: 'completed',
        output: [{ type: 'reasoning' }],
        usage: { input_tokens: 80, output_tokens: 80, total_tokens: 160 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  try {
    const result = await handleSpellGenerate(baseRequest, { requestId: 'test-fallback' });
    assert.equal(calls, 1);
    assert.equal(result.status, 200);
    assert.equal(result.payload.source, 'fallback');
    assert.equal(result.payload.meta.fallbackReason, 'schema_no_tool_call');
    assert.equal(result.payload.meta.templateMatch, null);
    assert.equal(result.payload.meta.expandedPromptPreview, null);
  } finally {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
  }
});

test('injects template context and response meta when prompt matches spell template', async () => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';

  const providerCalls = [];
  global.fetch = async (_url, init = {}) => {
    providerCalls.push({
      body: String(init.body ?? ''),
    });
    return new Response(
      JSON.stringify({
        status: 'completed',
        output: [{ type: 'function_call', name: 'craft_spell', arguments: JSON.stringify(draft) }],
        usage: { input_tokens: 90, output_tokens: 40, total_tokens: 130 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  try {
    const result = await handleSpellGenerate(
      {
        ...baseRequest,
        prompt: 'cast fireball now',
      },
      { requestId: 'test-template-match' }
    );
    assert.equal(result.status, 200);
    assert.equal(result.payload.source, 'llm');
    assert.deepEqual(result.payload.meta.templateMatch, {
      key: 'fireball',
      alias: 'fireball',
    });
    assert.equal(typeof result.payload.meta.expandedPromptPreview, 'string');
    assert.ok(result.payload.meta.expandedPromptPreview.length > 0);

    const providerInput = extractProviderInputPayload(providerCalls[0]);
    assert.equal(providerInput.prompt, 'cast fireball now');
    assert.deepEqual(providerInput.templateContext?.matchedKey, 'fireball');
    assert.deepEqual(providerInput.templateContext?.matchedAlias, 'fireball');
    assert.equal(typeof providerInput.templateContext?.expandedIntent, 'string');
    assert.ok(providerInput.templateContext.expandedIntent.length > 0);
  } finally {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
  }
});
