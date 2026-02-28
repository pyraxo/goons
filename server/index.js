import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  ARTIFACT_RESPONSE_SCHEMA,
  PROMPT_TEMPLATE_VERSION,
  SANDBOX_BASELINE_STATE,
  buildArtifactSystemPrompt,
  buildArtifactUserPrompt,
} from '../src/prompt/templateDrafts.js';
import { parseArtifactOutputText } from './prompt/artifactContract.js';
import { parseEstimateOutputText } from './prompt/estimateContract.js';
import { handleSpellGenerate } from './spell-api.js';
import { createServerGameSession } from './game-session.js';

const RESPONSES_API_URL = 'https://api.openai.com/v1/responses';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const FAST_ESTIMATOR_MODEL = 'gemini-3-flash-preview';
const GLB_ASSET_MODEL = 'gemini-3-flash-preview';
const PORT = Number(process.env.API_PORT || 8787);

function isGeminiModel(model) {
  return typeof model === 'string' && model.startsWith('gemini-');
}

function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  const result = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'additionalProperties' || key === 'minLength' || key === 'maxLength' ||
        key === 'minItems' || key === 'minimum' || key === 'maximum') continue;
    if (key === 'type' && typeof value === 'string') {
      result.type = value.toUpperCase();
    } else if (key === 'properties' && typeof value === 'object') {
      result.properties = {};
      for (const [propKey, propValue] of Object.entries(value)) {
        result.properties[propKey] = toGeminiSchema(propValue);
      }
    } else if (key === 'items' && typeof value === 'object') {
      result.items = toGeminiSchema(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

async function callGemini(model, systemPrompt, userContent, options = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Missing GEMINI_API_KEY in .env');

  const url = `${GEMINI_API_BASE}/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: userContent }] }],
    generationConfig: {},
  };

  if (systemPrompt) {
    body.systemInstruction = { parts: [{ text: systemPrompt }] };
  }

  if (options.responseSchema) {
    body.generationConfig.responseMimeType = 'application/json';
    body.generationConfig.responseSchema = toGeminiSchema(options.responseSchema);
  }

  if (options.maxOutputTokens) {
    body.generationConfig.maxOutputTokens = options.maxOutputTokens;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    return { ok: false, status: response.status, error: errorText.slice(0, 400) };
  }

  const json = await response.json();
  const parts = json?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts) ? parts.map((p) => p.text ?? '').join('') : '';

  return { ok: true, outputText: text, raw: json };
}

function parseDotEnv(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const entries = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    entries[key] = value;
  }
  return entries;
}

async function loadEnvFromDotFile() {
  try {
    const content = await readFile(resolve(process.cwd(), '.env'), 'utf8');
    const parsed = parseDotEnv(content);
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // optional
  }
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function makeRequestId() {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${rand}`;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(raw.length > 0 ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function extractOutputText(responseJson) {
  if (typeof responseJson?.output_text === 'string' && responseJson.output_text.length > 0) {
    return responseJson.output_text;
  }

  const outputs = Array.isArray(responseJson?.output) ? responseJson.output : [];
  const textBlocks = [];
  for (const item of outputs) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const block of content) {
      if (typeof block?.text === 'string' && block.text.length > 0) {
        textBlocks.push(block.text);
      }
    }
  }

  return textBlocks.join('');
}

function safeParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'invalid JSON',
    };
  }
}

async function estimateFromPrompt(prompt) {
  const systemPrompt = [
    'Estimate implementation scope for a tower-defense game prompt. The game has units (summoned defenders), actions (spell effects), mechanics (hook-driven behaviors), and ui (HUD widgets).',
    'Return only valid JSON matching the provided schema.',
    'Classification guide:',
    '- Prompts about creatures, vehicles, defenders, allies -> types: ["units"]',
    '- Prompts about spells, attacks, fire, ice, damage effects -> types: ["mechanics", "actions"]',
    '- Prompts about both summoning AND effects -> types: ["units", "mechanics", "actions"]',
    '- Prompts about displays, stats, information -> types: ["ui"]',
    'Cost guide: simple effect=75-150, unit=100-200, complex mechanic=200-500, multi-type=300-800.',
    'riskLevel: low for simple effects, medium for multi-type, high for game-changing mechanics.',
  ].join('\n');

  const estimateSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      classifiedTypes: {
        type: 'array',
        items: { type: 'string', enum: ['ui', 'mechanics', 'units', 'actions'] },
        minItems: 1,
      },
      estimatedGoldCost: { type: 'integer', minimum: 1 },
      riskLevel: { type: 'string', enum: ['low', 'medium', 'high'] },
      requiresReview: { type: 'boolean' },
    },
    required: ['classifiedTypes', 'estimatedGoldCost', 'riskLevel', 'requiresReview'],
  };

  if (isGeminiModel(FAST_ESTIMATOR_MODEL)) {
    return callGemini(FAST_ESTIMATOR_MODEL, systemPrompt, prompt, {
      responseSchema: estimateSchema,
    });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, status: 500, error: 'Missing OPENAI_API_KEY in .env' };

  const response = await fetch(RESPONSES_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: FAST_ESTIMATOR_MODEL,
      input: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'prompt_estimate',
          schema: estimateSchema,
        },
      },
      reasoning: { effort: 'low' },
      max_output_tokens: 120,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    return { ok: false, status: response.status, error: errorText.slice(0, 400) };
  }

  const json = await response.json();
  const outputText = extractOutputText(json);
  return { ok: true, outputText, raw: json };
}

async function executePromptWithModel(model, reasoningEffort, envelope) {
  if (isGeminiModel(model)) {
    return callGemini(model, buildArtifactSystemPrompt(), buildArtifactUserPrompt(envelope), {
      responseSchema: ARTIFACT_RESPONSE_SCHEMA,
    });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, status: 500, error: 'Missing OPENAI_API_KEY in .env' };

  const response = await fetch(RESPONSES_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: [
        { role: 'system', content: buildArtifactSystemPrompt() },
        { role: 'user', content: buildArtifactUserPrompt(envelope) },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'sandbox_patch_artifact',
          schema: ARTIFACT_RESPONSE_SCHEMA,
        },
      },
      reasoning: { effort: reasoningEffort || 'low' },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    return { ok: false, status: response.status, error: errorText.slice(0, 400) };
  }

  const json = await response.json();
  const outputText = extractOutputText(json);
  return { ok: true, outputText, raw: json };
}

function normalizeFileToken(value, fallback) {
  const token = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return token || fallback;
}

function fallbackAssetPlan(jobs) {
  return jobs.map((job, index) => ({
    assetId: String(job?.assetId ?? `asset_${index + 1}`),
    name: String(job?.label ?? `Generated ${index + 1}`),
    description: `Auto-generated placeholder for ${String(job?.sourceType ?? 'feature')}.`,
  }));
}

async function planGlbAssetsWithModel(prompt, jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return fallbackAssetPlan(jobs);
  }

  const glbSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      assets: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            assetId: { type: 'string', minLength: 1 },
            name: { type: 'string', minLength: 1 },
            description: { type: 'string', minLength: 1 },
          },
          required: ['assetId', 'name', 'description'],
        },
      },
    },
    required: ['assets'],
  };

  const systemPrompt =
    'You produce concise GLB asset planning metadata for gameplay mechanics. Return only valid JSON.';
  const userContent = JSON.stringify(
    {
      prompt,
      jobs,
      instructions: [
        'Return an assets array with one entry per job.',
        'Use the same assetId values from jobs.',
        'Generate short, production-friendly names.',
        'Descriptions should be one sentence.',
      ],
    },
    null,
    2
  );

  try {
    let outputText;

    if (isGeminiModel(GLB_ASSET_MODEL)) {
      const result = await callGemini(GLB_ASSET_MODEL, systemPrompt, userContent, {
        responseSchema: glbSchema,
      });
      if (!result.ok) return fallbackAssetPlan(jobs);
      outputText = result.outputText;
    } else {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return fallbackAssetPlan(jobs);

      const upstream = await fetch(RESPONSES_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: GLB_ASSET_MODEL,
          input: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
          text: {
            format: {
              type: 'json_schema',
              name: 'glb_asset_plan',
              schema: glbSchema,
            },
          },
          reasoning: { effort: 'low' },
          max_output_tokens: 280,
        }),
      });

      if (!upstream.ok) return fallbackAssetPlan(jobs);
      const upstreamJson = await upstream.json();
      outputText = extractOutputText(upstreamJson);
    }

    if (!outputText) return fallbackAssetPlan(jobs);

    const parsed = JSON.parse(outputText);
    if (!Array.isArray(parsed?.assets) || parsed.assets.length === 0) {
      return fallbackAssetPlan(jobs);
    }

    const byId = new Map(parsed.assets.map((asset) => [String(asset.assetId), asset]));
    return jobs.map((job, index) => {
      const key = String(job?.assetId ?? `asset_${index + 1}`);
      const candidate = byId.get(key);
      return {
        assetId: key,
        name: String(candidate?.name ?? job?.label ?? `Generated ${index + 1}`),
        description: String(
          candidate?.description ?? `Auto-generated placeholder for ${String(job?.sourceType ?? 'feature')}.`
        ),
      };
    });
  } catch {
    return fallbackAssetPlan(jobs);
  }
}

function createMinimalGlbBuffer({ name, description, prompt }) {
  const gltf = {
    asset: {
      version: '2.0',
      generator: 'goons-agentic-glb',
    },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      {
        name: name || 'GeneratedAsset',
        extras: {
          description: description || '',
          prompt: String(prompt ?? '').slice(0, 280),
        },
      },
    ],
  };

  const json = JSON.stringify(gltf);
  const jsonPayload = Buffer.from(json, 'utf-8');
  const paddedJsonLength = Math.ceil(jsonPayload.length / 4) * 4;
  const paddedJson = Buffer.alloc(paddedJsonLength, 0x20);
  jsonPayload.copy(paddedJson);

  const totalLength = 12 + 8 + paddedJsonLength;
  const glb = Buffer.alloc(totalLength);

  glb.writeUInt32LE(0x46546c67, 0);
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(totalLength, 8);
  glb.writeUInt32LE(paddedJsonLength, 12);
  glb.writeUInt32LE(0x4e4f534a, 16);
  paddedJson.copy(glb, 20);

  return glb;
}

async function generateGlbAssets({ promptId, prompt, jobs }) {
  const safeJobs = Array.isArray(jobs) ? jobs.slice(0, 8) : [];
  if (safeJobs.length === 0) {
    return [];
  }

  const plan = await planGlbAssetsWithModel(prompt, safeJobs);
  const planById = new Map(plan.map((entry) => [String(entry.assetId), entry]));

  const outputDir = resolve(process.cwd(), 'public/models/generated');
  await mkdir(outputDir, { recursive: true });

  const safePromptId = normalizeFileToken(promptId, `prompt-${Date.now()}`);
  const generatedAt = new Date().toISOString();
  const assets = [];

  for (let index = 0; index < safeJobs.length; index += 1) {
    const job = safeJobs[index];
    const assetId = String(job?.assetId ?? `asset_${index + 1}`);
    const planned = planById.get(assetId) ?? {};
    const name = String(planned?.name ?? job?.label ?? assetId).trim() || assetId;
    const description = String(planned?.description ?? '').trim();
    const fileToken = normalizeFileToken(assetId, `asset-${index + 1}`);
    const fileName = `${safePromptId}-${fileToken}.glb`;
    const absoluteFilePath = join(outputDir, fileName);

    const glbBuffer = createMinimalGlbBuffer({
      name,
      description,
      prompt,
    });
    await writeFile(absoluteFilePath, glbBuffer);

    assets.push({
      id: assetId,
      name,
      sourceType: String(job?.sourceType ?? ''),
      sourceId: String(job?.sourceId ?? ''),
      path: `/models/generated/${fileName}`,
      generatedAt,
      model: GLB_ASSET_MODEL,
    });
  }

  return assets;
}

async function createApiServer() {
  await loadEnvFromDotFile();

  const gameSession = createServerGameSession();

  const server = createServer(async (req, res) => {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname;

    try {
      if (path === '/api/game/state') {
        if (method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
        return sendJson(res, 200, { state: gameSession.snapshot() });
      }

      if (path === '/api/game/input') {
        if (method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
        const body = await readJsonBody(req);
        gameSession.setInput(body?.input ?? {});
        return sendJson(res, 200, { ok: true });
      }

      if (path === '/api/game/cast') {
        if (method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
        const body = await readJsonBody(req);
        const result = await gameSession.castPrompt(body?.prompt ?? '');
        return sendJson(res, 200, { result });
      }

      if (path === '/api/game/reset') {
        if (method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
        const body = await readJsonBody(req);
        const reason = typeof body?.reason === 'string' ? body.reason : 'manual';
        gameSession.reset(reason);
        return sendJson(res, 200, { ok: true, state: gameSession.snapshot() });
      }

      if (path === '/api/game/apply-artifact') {
        if (method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
        const body = await readJsonBody(req);
        const result = await gameSession.applyArtifact({
          envelope: body?.envelope ?? {},
          templateVersion: body?.templateVersion ?? PROMPT_TEMPLATE_VERSION,
          artifact: body?.artifact ?? null,
        });
        return sendJson(res, 200, { result });
      }

      if (path === '/api/prompt/estimate') {
        if (method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });

        const body = await readJsonBody(req);
        const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
        if (!prompt) return sendJson(res, 400, { error: 'Missing prompt' });

        const result = await estimateFromPrompt(prompt);
        if (!result.ok) {
          return sendJson(res, result.status || 502, { error: result.error });
        }

        if (!result.outputText) {
          return sendJson(res, 502, { error: 'Estimator returned no parseable output' });
        }

        const parsedEstimate = parseEstimateOutputText(result.outputText);
        if (!parsedEstimate.ok) {
          return sendJson(res, 502, { error: parsedEstimate.error });
        }

        return sendJson(res, 200, { estimate: parsedEstimate.estimate });
      }

      if (path === '/api/prompt/execute') {
        if (method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });

        const body = await readJsonBody(req);
        const model = body.model;
        const reasoningEffort = typeof body.reasoningEffort === 'string' ? body.reasoningEffort.trim() : '';
        const envelope = body.envelope;

        if (!model || !envelope?.prompt) {
          return sendJson(res, 400, { error: 'Missing model or envelope.prompt' });
        }

        const result = await executePromptWithModel(model, reasoningEffort, envelope);
        if (!result.ok) {
          return sendJson(res, result.status || 502, { error: result.error });
        }

        if (!result.outputText) {
          return sendJson(res, 502, { error: 'Generator returned no parseable output text' });
        }

        const parsed = parseArtifactOutputText(result.outputText);
        if (!parsed.ok) {
          return sendJson(res, 502, { error: parsed.error });
        }

        return sendJson(res, 200, {
          model,
          reasoningEffort: reasoningEffort || 'low',
          templateVersion: PROMPT_TEMPLATE_VERSION,
          baselineState: SANDBOX_BASELINE_STATE,
          artifact: parsed.artifact,
          outputText: result.outputText,
          upstream: result.raw,
        });
      }

      if (path === '/api/spells/generate') {
        if (method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
        const body = await readJsonBody(req);
        const result = await handleSpellGenerate(body, {
          requestId: makeRequestId(),
        });
        return sendJson(res, result.status, result.payload);
      }

      if (path === '/api/assets/generate-glb') {
        if (method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
        const body = await readJsonBody(req);
        const promptId = String(body?.promptId ?? '').trim();
        const prompt = String(body?.prompt ?? '').trim();
        const jobs = Array.isArray(body?.jobs) ? body.jobs : [];

        if (jobs.length === 0) {
          return sendJson(res, 200, { assets: [] });
        }

        const assets = await generateGlbAssets({
          promptId,
          prompt,
          jobs,
        });

        return sendJson(res, 200, { assets });
      }

      return sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      return sendJson(res, 500, { error: message });
    }
  });

  server.listen(PORT, () => {
    console.log(`[api] listening on http://localhost:${PORT}`);
  });

  const shutdown = () => {
    gameSession.stop();
    server.close(() => {
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void createApiServer();
