import {
  buildSpellVariantSignature,
  deterministicFallback,
  getToolDefinition,
  validateAndFinalizeSpell,
} from './spell-engine.js';
import { getSpellTemplateCatalogVersion, matchSpellTemplate } from './spell-template-matcher.js';
import { inspect } from 'node:util';

const metrics = {
  total: 0,
  llmSuccess: 0,
  schemaFail: 0,
  validationFail: 0,
  fallback: 0,
  totalLatencyMs: 0,
  providerLatencyMs: [],
};

import { OPENAI_MODEL } from '../config.js';

const MODEL = OPENAI_MODEL;
const API_TIMEOUT_MS = Number(process.env.SPELL_API_TIMEOUT_MS || 10000);
const DEBUG_FULL_PAYLOAD = process.env.SPELL_API_DEBUG_FULL_PAYLOAD !== '0';
const REASONING_EFFORT = process.env.SPELL_REASONING_EFFORT || 'minimal';
const PRIMARY_MAX_OUTPUT_TOKENS = Number(process.env.SPELL_API_MAX_OUTPUT_TOKENS || 420);
const RETRY_MAX_OUTPUT_TOKENS = Number(
  process.env.SPELL_API_RETRY_MAX_OUTPUT_TOKENS || Math.max(PRIMARY_MAX_OUTPUT_TOKENS, 700)
);
const VARIANT_SIGNATURE_WINDOW = Number(process.env.SPELL_VARIANT_SIGNATURE_WINDOW || 4);
const MAX_VARIANT_ANCHORS = Number(process.env.SPELL_VARIANT_MAX_ANCHORS || 120);
const variantState = new Map();

export async function handleSpellGenerate(requestBody, obs = {}) {
  const requestId = obs.requestId || 'req-unknown';
  const log = createLogger(requestId);
  const startedAt = Date.now();
  metrics.total += 1;
  log('request_received', {
    hasBody: Boolean(requestBody && typeof requestBody === 'object'),
  });

  const context = sanitizeRequestBody(requestBody);
  if (!context.ok) {
    log('request_invalid', { error: context.error });
    return {
      status: 400,
      payload: {
        error: context.error,
      },
    };
  }

  const ctx = context.value;
  const prompt = ctx.prompt;
  const templateMatch = matchSpellTemplate(prompt);
  const spellIdentity = buildSpellIdentity(prompt, templateMatch);
  const variantContext = buildVariantContext(spellIdentity.anchorKey);
  const runtimeContext = {
    ...ctx,
    spellIdentity,
    variantContext,
  };
  log('request_validated', {
    promptPreview: prompt.slice(0, 60),
    wave: ctx.wave,
    mana: ctx.mana,
    unlocks: ctx.unlocks,
    nearbyEnemyCount: ctx.nearbyEnemies.length,
    anchorKey: spellIdentity.anchorKey,
    anchorPolicy: spellIdentity.anchorPolicy,
    variantCastIndex: variantContext.castIndex,
  });
  if (templateMatch) {
    log('template_match', {
      key: templateMatch.key,
      alias: templateMatch.alias,
      catalogVersion: getSpellTemplateCatalogVersion(),
    });
  } else {
    log('template_no_match', {
      catalogVersion: getSpellTemplateCatalogVersion(),
    });
  }

  let source = 'fallback';
  let resolved;
  let fallbackReason = null;

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      fallbackReason = 'missing_api_key';
      throw new Error('OPENAI_API_KEY missing');
    }

    const draft = await fetchSpellDraftFromOpenAI(apiKey, prompt, runtimeContext, templateMatch, log);
    const finalized = validateAndFinalizeSpell(draft, runtimeContext);

    if (!finalized.ok) {
      metrics.validationFail += 1;
      fallbackReason = `validation_failed:${finalized.reason}`;
      throw new Error(`validation_failed:${finalized.reason}`);
    }

    resolved = finalized;
    source = 'llm';
    metrics.llmSuccess += 1;
    log('spell_validated', {
      source,
      archetype: resolved.spell?.archetype,
      effects: resolved.spell?.effects || [],
      powerScore: resolved.powerScore,
      cost: resolved.spell?.cost || null,
    });
  } catch (error) {
    metrics.fallback += 1;
    const message = String(error?.message || '');
    if (message.startsWith('schema_')) {
      metrics.schemaFail += 1;
    }
    fallbackReason = fallbackReason || message || 'unknown_error';

    resolved = deterministicFallback(prompt, runtimeContext);
    if (!resolved.ok) {
      const emergency = deterministicFallback('default arcane projectile', {
        ...runtimeContext,
        unlocks: ['fireball', 'wall', 'frost', 'bolt'],
      });
      resolved = emergency;
    }
    log('fallback_applied', {
      fallbackReason,
      archetype: resolved?.spell?.archetype,
      effects: resolved?.spell?.effects || [],
      powerScore: resolved?.powerScore,
      cost: resolved?.spell?.cost || null,
      warnings: resolved?.warnings || [],
    });
  }

  const variantSignature = buildSpellVariantSignature(resolved?.spell);
  rememberVariantSignature(spellIdentity.anchorKey, variantSignature);

  const latencyMs = Date.now() - startedAt;
  metrics.totalLatencyMs += latencyMs;
  log('response_ready', {
    source,
    latencyMs,
    fallbackReason,
  });

  return {
    status: 200,
    payload: {
      source,
      spell: resolved.spell,
      meta: {
        latencyMs,
        powerScore: resolved.powerScore,
        warnings: resolved.warnings,
        fallbackReason,
        templateMatch: templateMatch
          ? {
              key: templateMatch.key,
              alias: templateMatch.alias,
            }
          : null,
        spellIdentity: {
          anchorKey: spellIdentity.anchorKey,
          anchorPolicy: spellIdentity.anchorPolicy,
          source: spellIdentity.source,
          curatedKey: spellIdentity.curatedKey,
        },
        variant: {
          castIndex: variantContext.castIndex,
          signature: variantSignature,
        },
        expandedPromptPreview: templateMatch ? truncate(templateMatch.expansion, 180) : null,
        telemetry: summarizeMetrics(),
      },
    },
  };
}

function summarizeMetrics() {
  const count = Math.max(1, metrics.total);
  return {
    total: metrics.total,
    llmSuccess: metrics.llmSuccess,
    schemaFail: metrics.schemaFail,
    validationFail: metrics.validationFail,
    fallback: metrics.fallback,
    avgLatencyMs: Math.round(metrics.totalLatencyMs / count),
    providerLatencyP50Ms: percentile(metrics.providerLatencyMs, 0.5),
    providerLatencyP95Ms: percentile(metrics.providerLatencyMs, 0.95),
    providerLatencyMaxMs: metrics.providerLatencyMs.length ? Math.max(...metrics.providerLatencyMs) : 0,
    timeoutMs: API_TIMEOUT_MS,
  };
}

async function fetchSpellDraftFromOpenAI(apiKey, prompt, context, templateMatch, log) {
  const attempts = [PRIMARY_MAX_OUTPUT_TOKENS, RETRY_MAX_OUTPUT_TOKENS];
  let lastError = null;

  for (let index = 0; index < attempts.length; index += 1) {
    const maxOutputTokens = attempts[index];
    if (!Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) {
      continue;
    }

    try {
      return await fetchSpellDraftFromOpenAIAttempt(apiKey, prompt, context, templateMatch, log, {
        attempt: index + 1,
        maxOutputTokens: Math.round(maxOutputTokens),
      });
    } catch (error) {
      lastError = error;
      const reason = String(error?.message || '');
      const hasNextAttempt = index + 1 < attempts.length;
      const retryable = reason === 'schema_no_tool_call:max_output_tokens';
      if (retryable && hasNextAttempt) {
        log('provider_call_retry', {
          reason,
          fromMaxOutputTokens: Math.round(maxOutputTokens),
          toMaxOutputTokens: Math.round(attempts[index + 1]),
          attempt: index + 2,
        });
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error('provider_no_attempts');
}

async function fetchSpellDraftFromOpenAIAttempt(apiKey, prompt, context, templateMatch, log, options) {
  const { attempt, maxOutputTokens } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  const providerStart = Date.now();
  const tool = getToolDefinition();
  const requestPayload = {
    model: MODEL,
    max_output_tokens: maxOutputTokens,
    reasoning: {
      effort: REASONING_EFFORT,
    },
    tool_choice: 'required',
    parallel_tool_calls: false,
    tools: [tool],
    instructions: `You are a master spell designer for a dark-fantasy tower defense game. Your job is to craft spells that feel SPECTACULAR - visually striking, thematically rich, and mechanically sound.

CREATIVE PRIORITIES (most important):
- Give every spell a memorable, evocative NAME that sounds like it belongs in an epic fantasy game. Never generic names like "Fire Spell". Think "Pyroclastic Ruin", "Shardstorm Aria", "Abyssal Undertow".
- Write a punchy DESCRIPTION that makes the player feel powerful. One vivid sentence.
- Choose primaryColor and secondaryColor hex values that create beautiful, dramatic contrast. Think complementary palettes - molten orange with deep crimson, icy cyan with white, toxic green with violet.
- Pick trailEffect and impactEffect that match the spell's fantasy. A meteor should explode, not ripple. Lightning should flash, not vortex.
- Optionally set `vfx.particleTheme` (`embers`, `mist`, `glyph`, `stormthread`, `torch`, `sparks`) to tune the trail look and `vfx.colors` with extra layers:
  - `core` for base body
  - `accent` for secondary glow
  - `ring` for discs and rings
  - `glow` for additive bloom
  - `edge` for trim highlights
- For layered projectiles, set `vfx.secondaryShape` and tune `vfx.shapeScale` + `vfx.shapeBlend`.
- Scale screenShake to the spell's drama: a tiny bolt gets 0.1, a cataclysmic zone gets 0.7+.
- particleDensity should match spectacle: subtle precision spells ~0.5, dramatic area spells ~1.5.
- castStyle shapes the launch animation: launch for thrown projectiles, slam for ground impacts, channel for sustained effects, sweep for wide arcs, pulse for radial bursts, smite for sky-to-ground strikes, focus for channeled beams.
- Expand sound detail with sfx fields. `sfx.cue` is mandatory, `sfx.impactCue` optional for detonation, `sfx.layer` (`cast|sustain|impact|ambient`), and `sfx.volume`/`sfx.impactVolume`/`sfx.pitch` for cinematic control.

ARCHETYPE-SPECIFIC VFX DESIGN (critical for visual quality):
- zone_control + wave shape (lane_sweep pattern): These render as a multi-layered wave with a bright crest on top and foam at the leading edge. Choose a saturated, rich primaryColor for the wave body and a lighter/brighter secondaryColor for the crest and spray particles. Use high particleDensity (1.2-1.8) for spectacular sweeps. impactEffect should be 'ripple' for water/ice or 'explosion' for fire/earth sweeps. screenShake 0.3-0.6. castStyle 'sweep' or 'slam'. Set laneSpan 2-4 for wide sweeps, speed 10-20.
- zone_control + ring shape (lane_circle pattern): These render as a glowing ground disc with a pulsing outer ring and counter-rotating inner ring. Use contrasting primaryColor/secondaryColor that create a visible glow boundary (e.g. deep blue + bright cyan, dark purple + pink). impactEffect 'ripple' or 'vortex'. particleDensity 1.0-1.5 for rising zone particles. screenShake 0.2-0.4. castStyle 'pulse' or 'slam'.
- zone_control + wall shape: These render as solid barriers with magical shimmer and glow. Use earthy/solid primaryColor with a magical secondaryColor for the emissive glow edge. impactEffect 'ripple' or 'pillar'. Low particleDensity (0.4-0.8). castStyle 'slam'. intensity 0.6-0.8.
- chain archetype: Renders as lightning arcs between targets. Use bright, electric primaryColor with white or pale secondaryColor for maximum contrast. trailEffect 'lightning_arc'. impactEffect 'flash'. intensity 1.0+. castStyle 'pulse'.
- projectile/aoe_burst: Single projectile with trail particles and impact explosion. Vivid element-matching colors. impactEffect 'explosion' for fire/earth, 'shatter' for ice, 'flash' for arcane/storm. screenShake 0.4-0.7 for bursts. particleDensity 1.2+ for trails. castStyle 'launch'.
- strike archetype: Instant sky-to-ground bolt that deals massive burst damage in a radius at the target point. No travel time. Renders as a glowing pillar descending from the sky with a ground impact ring. Use shape 'pillar', pattern 'ground_strike'. castStyle 'smite'. High screenShake (0.5-0.8). impactEffect 'explosion'. Dramatic primaryColor/secondaryColor. particleDensity 1.4+. Perfect for meteors, divine smites, lightning bolts from the sky, seismic slams.
- beam archetype: Sustained channeled ray from the commander toward enemies in a line. Deals tick damage over its duration. Renders as a glowing cylinder with pulsing core and outer glow. Use shape 'beam', pattern 'line_from_caster', targeting mode 'commander_facing'. castStyle 'focus'. Set durationSec 1.5-4, tickRate 0.2-0.5, length 20-60, width 2-6. impactEffect 'pillar'. Low screenShake (0.1-0.3). Perfect for sun beams, dragon breath, laser rays, energy channels.

MECHANICAL RULES:
- Return exactly one craft_spell tool call.
- Use targeting.pattern/targeting.singleTarget and numbers.width/numbers.length to match prompt geometry.
- If templateContext.expandedIntent is provided, treat it as supplemental guidance while preserving the user prompt intent.
- Balance damage/radius/duration for fair real-time gameplay.
- If spellIdentity.anchorPolicy is "strong", keep the spell anchored to that core fantasy (no element/archetype drift away from the anchor identity).
- Build hybrid concepts as deliberate pairings. For prompts like "storm + ice wave", keep one primary archetype and express the secondary motif through effects + `vfx.secondaryShape` + `shapeScale`/`shapeBlend`, then adjust colors, trail theme, and screenShake.
- Prefer combos when wording suggests layered fantasy (e.g., "rune + cyclone", "frost prison", "comet + wave", "sun + eclipse", "grave + storm"), and ensure each combo feels like two distinct mechanics in one shape.
- Generate a fresh variant for this cast; do not mirror recentVariantSignatures.
- Use wave/mana/nearbyEnemies as the primary driver for variant choice.
- Keep power swing in a narrow band, roughly within +-12% of a normal cast for this anchor.
- If prompt includes short modifiers (for example "fireball but wider"), honor those modifiers strongly while preserving anchor identity.`,
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: JSON.stringify({
              prompt,
              wave: context.wave,
              mana: context.mana,
              unlocks: context.unlocks,
              nearbyEnemies: context.nearbyEnemies,
              spellIdentity: context.spellIdentity
                ? {
                    anchorKey: context.spellIdentity.anchorKey,
                    anchorPolicy: context.spellIdentity.anchorPolicy,
                    source: context.spellIdentity.source,
                    curatedKey: context.spellIdentity.curatedKey,
                  }
                : undefined,
              variantContext: context.variantContext
                ? {
                    castIndex: context.variantContext.castIndex,
                    recentVariantSignatures: context.variantContext.recentSignatures,
                  }
                : undefined,
              templateContext: templateMatch
                ? {
                    matchedKey: templateMatch.key,
                    matchedAlias: templateMatch.alias,
                    expandedIntent: templateMatch.expansion,
                  }
                : undefined,
            }),
          },
        ],
      },
    ],
  };
  const requestBody = JSON.stringify(requestPayload);
  log('provider_call_start', {
    attempt,
    model: MODEL,
    timeoutMs: API_TIMEOUT_MS,
    reasoningEffort: REASONING_EFFORT,
    maxOutputTokens,
    bodyBytes: byteLength(requestBody),
    promptChars: prompt.length,
    nearbyEnemyCount: context.nearbyEnemies.length,
    toolStrict: tool.strict,
    templateMatched: Boolean(templateMatch),
    templateKey: templateMatch?.key || null,
  });
  if (DEBUG_FULL_PAYLOAD) {
    log('provider_request_payload_full', {
      payloadPreview: truncate(requestBody, 4000),
    });
  }

  let response;
  try {
    response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: requestBody,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      log('provider_call_error', {
        reason: `provider_timeout_${API_TIMEOUT_MS}ms`,
      });
      throw new Error(`provider_timeout_${API_TIMEOUT_MS}ms`);
    }
    log('provider_call_error', {
      reason: `provider_fetch_error:${String(error?.message || error)}`,
    });
    throw new Error(`provider_fetch_error:${String(error?.message || error)}`);
  } finally {
    clearTimeout(timeout);
  }
  const providerElapsedMs = Date.now() - providerStart;
  log('provider_call_done', {
    status: response.status,
    elapsedMs: providerElapsedMs,
  });
  metrics.providerLatencyMs.push(providerElapsedMs);
  if (metrics.providerLatencyMs.length > 200) {
    metrics.providerLatencyMs.shift();
  }

  const responseReadStart = Date.now();
  const responseText = await response.text();
  const responseReadMs = Date.now() - responseReadStart;
  log('provider_response_body', {
    status: response.status,
    readMs: responseReadMs,
    bodyBytes: byteLength(responseText),
  });

  if (!response.ok) {
    log('provider_call_error', {
      reason: `provider_http_${response.status}`,
      bodyPreview: truncate(responseText, 400),
    });
    throw new Error(`provider_http_${response.status}:${truncate(responseText, 120)}`);
  }

  let json;
  try {
    json = JSON.parse(responseText);
  } catch {
    log('provider_call_error', {
      reason: 'provider_response_not_json',
      bodyPreview: truncate(responseText, 280),
    });
    throw new Error('provider_response_not_json');
  }
  log('provider_response_shape', {
    responseStatus: json?.status || null,
    outputCount: Array.isArray(json?.output) ? json.output.length : 0,
    outputTypes: Array.isArray(json?.output) ? json.output.slice(0, 8).map((item) => item?.type || 'unknown') : [],
    hasUsage: Boolean(json?.usage),
    usage: json?.usage
      ? {
          inputTokens: json.usage.input_tokens ?? null,
          outputTokens: json.usage.output_tokens ?? null,
          totalTokens: json.usage.total_tokens ?? null,
        }
      : null,
    incompleteDetails: json?.incomplete_details || null,
  });
  const toolCall = extractToolCall(json);
  if (!toolCall) {
    const incompleteReason = json?.incomplete_details?.reason || null;
    log('provider_call_error', {
      reason: incompleteReason ? `schema_no_tool_call:${incompleteReason}` : 'schema_no_tool_call',
    });
    if (incompleteReason) {
      throw new Error(`schema_no_tool_call:${incompleteReason}`);
    }
    throw new Error('schema_no_tool_call');
  }

  const argsRaw = toolCall.arguments;
  if (typeof argsRaw !== 'string') {
    log('provider_call_error', {
      reason: 'schema_invalid_tool_args',
    });
    throw new Error('schema_invalid_tool_args');
  }
  log('provider_tool_call_found', {
    name: toolCall.name,
    argsChars: argsRaw.length,
    argsPreview: truncate(argsRaw, 800),
  });
  if (DEBUG_FULL_PAYLOAD) {
    log('provider_tool_call_args_full', {
      argsPreview: truncate(argsRaw, 4000),
    });
  }

  let draft;
  try {
    draft = JSON.parse(argsRaw);
  } catch {
    log('provider_call_error', {
      reason: 'schema_args_not_json',
    });
    throw new Error('schema_args_not_json');
  }
  log('spell_tool_call', {
    tool: toolCall.name,
    draft,
  });

  return draft;
}

function extractToolCall(payload) {
  if (!payload || !Array.isArray(payload.output)) {
    return null;
  }

  for (const item of payload.output) {
    if (item?.type === 'function_call' && item?.name === 'craft_spell') {
      return item;
    }

    if (Array.isArray(item?.tool_calls)) {
      for (const toolCall of item.tool_calls) {
        const name = toolCall?.name ?? toolCall?.function?.name;
        const args = toolCall?.arguments ?? toolCall?.function?.arguments;
        if (name === 'craft_spell') {
          return {
            type: 'function_call',
            name,
            arguments: args,
          };
        }
      }
    }

    if (Array.isArray(item?.content)) {
      for (const contentItem of item.content) {
        if (contentItem?.type === 'function_call' && contentItem?.name === 'craft_spell') {
          return contentItem;
        }
      }
    }
  }

  return null;
}

function sanitizeRequestBody(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'invalid request body' };
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) {
    return { ok: false, error: 'prompt is required' };
  }

  const nearbyEnemies = Array.isArray(body.nearbyEnemies)
    ? body.nearbyEnemies
        .map((enemy) => ({
          lane: clamp(Math.round(Number(enemy?.lane ?? 2)), 0, 4),
          kind: typeof enemy?.kind === 'string' ? enemy.kind.slice(0, 16) : 'melee',
          hp: clamp(Number(enemy?.hp ?? 20), 1, 200),
          z: clamp(Number(enemy?.z ?? 0), -120, 100),
        }))
        .sort((a, b) => Math.abs(a.z) - Math.abs(b.z))
        .slice(0, 16)
    : [];

  const wave = clamp(Math.round(Number(body.wave ?? 1)), 1, 60);
  const mana = clamp(Number(body.mana ?? 0), 0, 999);
  const unlocks = Array.isArray(body.unlocks)
    ? body.unlocks.filter((value) => typeof value === 'string').slice(0, 8)
    : [];

  return {
    ok: true,
    value: {
      prompt,
      wave,
      mana,
      unlocks,
      nearbyEnemies,
    },
  };
}

function buildSpellIdentity(prompt, templateMatch) {
  if (templateMatch?.key) {
    return {
      anchorKey: normalizeAnchorKey(templateMatch.key),
      curatedKey: normalizeAnchorKey(templateMatch.key),
      anchorPolicy: 'strong',
      source: 'curated_lexicon',
    };
  }

  const freeformAnchor = deriveFreeformAnchor(prompt);
  return {
    anchorKey: freeformAnchor,
    curatedKey: null,
    anchorPolicy: 'adaptive',
    source: 'freeform',
  };
}

function deriveFreeformAnchor(prompt) {
  const normalized = normalizeAnchorKey(prompt).replace(/[^a-z0-9 ]/g, ' ');
  const compact = normalized.replace(/\s+/g, ' ').trim();
  if (!compact) {
    return 'spell';
  }

  const words = compact.split(' ');
  if (words.length === 1) {
    return words[0];
  }
  return words[0];
}

function buildVariantContext(anchorKey) {
  const normalizedAnchor = normalizeAnchorKey(anchorKey) || 'spell';
  const existing = variantState.get(normalizedAnchor) || {
    castCount: 0,
    recentSignatures: [],
    touchedAt: Date.now(),
  };

  return {
    castIndex: existing.castCount + 1,
    recentSignatures: existing.recentSignatures.slice(0, VARIANT_SIGNATURE_WINDOW),
  };
}

function rememberVariantSignature(anchorKey, signature) {
  const normalizedAnchor = normalizeAnchorKey(anchorKey) || 'spell';
  const safeSignature = typeof signature === 'string' && signature.trim() ? signature.trim() : 'invalid';
  const existing = variantState.get(normalizedAnchor) || {
    castCount: 0,
    recentSignatures: [],
    touchedAt: 0,
  };

  const nextRecent = [safeSignature, ...existing.recentSignatures.filter((entry) => entry !== safeSignature)].slice(
    0,
    VARIANT_SIGNATURE_WINDOW
  );

  variantState.set(normalizedAnchor, {
    castCount: existing.castCount + 1,
    recentSignatures: nextRecent,
    touchedAt: Date.now(),
  });

  trimVariantState();
}

function trimVariantState() {
  if (variantState.size <= MAX_VARIANT_ANCHORS) {
    return;
  }
  const entries = [...variantState.entries()].sort((a, b) => Number(a[1]?.touchedAt || 0) - Number(b[1]?.touchedAt || 0));
  while (entries.length > MAX_VARIANT_ANCHORS) {
    const oldest = entries.shift();
    if (!oldest) {
      break;
    }
    variantState.delete(oldest[0]);
  }
}

function normalizeAnchorKey(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function createLogger(requestId) {
  return (event, fields = {}) => {
    const payload = { requestId, ...fields };
    const msg = inspect(payload, {
      depth: null,
      maxArrayLength: null,
      maxStringLength: null,
      compact: false,
      breakLength: 120,
      sorted: true,
    });
    console.log(`[spell-api] ${event} ${msg}`);
  };
}

function percentile(values, ratio) {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * ratio)));
  return sorted[idx];
}

export function getSpellApiMetrics() {
  return summarizeMetrics();
}

function truncate(value, maxChars) {
  const text = String(value ?? '');
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}...[truncated ${text.length - maxChars} chars]`;
}

function byteLength(value) {
  return Buffer.byteLength(String(value ?? ''), 'utf8');
}
