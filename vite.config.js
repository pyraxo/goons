import { defineConfig, loadEnv } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  ARTIFACT_RESPONSE_SCHEMA,
  PROMPT_TEMPLATE_VERSION,
  SANDBOX_BASELINE_STATE,
  buildArtifactSystemPrompt,
  buildArtifactUserPrompt,
} from './src/prompt/templateDrafts.js';
import { parseArtifactOutputText } from './src/prompt/artifactContract.js';
import { parseEstimateOutputText } from './src/prompt/estimateContract.js';
import { handleSpellGenerate } from './server/spell-api.js';
import { createServerGameSession } from './server/game-session.js';

const RESPONSES_API_URL = 'https://api.openai.com/v1/responses';
const FAST_ESTIMATOR_MODEL = 'gpt-5.3-codex';
const GLB_ASSET_MODEL = 'gpt-5.3-codex';

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

function makeRequestId() {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${rand}`;
}

function estimateFromPrompt(prompt, apiKey) {
  return fetch(RESPONSES_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: FAST_ESTIMATOR_MODEL,
      input: [
        {
          role: 'system',
          content:
            'Estimate implementation scope for a tower-defense game prompt. Return only valid JSON matching the provided schema.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'prompt_estimate',
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              classifiedTypes: {
                type: 'array',
                items: {
                  type: 'string',
                  enum: ['ui', 'mechanics', 'units', 'actions'],
                },
                minItems: 1,
              },
              estimatedGoldCost: {
                type: 'integer',
                minimum: 1,
              },
              riskLevel: {
                type: 'string',
                enum: ['low', 'medium', 'high'],
              },
              requiresReview: {
                type: 'boolean',
              },
            },
            required: ['classifiedTypes', 'estimatedGoldCost', 'riskLevel', 'requiresReview'],
          },
        },
      },
      reasoning: {
        effort: 'low',
      },
      max_output_tokens: 120,
    }),
  });
}

function executePromptWithModel(model, reasoningEffort, envelope, apiKey) {
  return fetch(RESPONSES_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: 'system',
          content: buildArtifactSystemPrompt(),
        },
        {
          role: 'user',
          content: buildArtifactUserPrompt(envelope),
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'sandbox_patch_artifact',
          schema: ARTIFACT_RESPONSE_SCHEMA,
        },
      },
      reasoning: {
        effort: reasoningEffort || 'low',
      },
    }),
  });
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

async function planGlbAssetsWithModel(prompt, jobs, apiKey) {
  if (!apiKey || !Array.isArray(jobs) || jobs.length === 0) {
    return fallbackAssetPlan(jobs);
  }

  try {
    const upstream = await fetch(RESPONSES_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: GLB_ASSET_MODEL,
        input: [
          {
            role: 'system',
            content:
              'You produce concise GLB asset planning metadata for gameplay mechanics. Return only valid JSON.',
          },
          {
            role: 'user',
            content: JSON.stringify(
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
            ),
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'glb_asset_plan',
            schema: {
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
            },
          },
        },
        reasoning: {
          effort: 'low',
        },
        max_output_tokens: 280,
      }),
    });

    if (!upstream.ok) {
      return fallbackAssetPlan(jobs);
    }

    const upstreamJson = await upstream.json();
    const outputText = extractOutputText(upstreamJson);
    if (!outputText) {
      return fallbackAssetPlan(jobs);
    }

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

async function generateGlbAssets({ promptId, prompt, jobs, apiKey }) {
  const safeJobs = Array.isArray(jobs) ? jobs.slice(0, 8) : [];
  if (safeJobs.length === 0) {
    return [];
  }

  const plan = await planGlbAssetsWithModel(prompt, safeJobs, apiKey);
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
      model: apiKey ? GLB_ASSET_MODEL : 'local-fallback',
    });
  }

  return assets;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  process.env = { ...process.env, ...env };
  const apiKey = process.env.OPENAI_API_KEY;

  return {
    plugins: [
      {
        name: 'openai-api-key-endpoints',
        configureServer(server) {
          const gameSession = createServerGameSession();
          server.httpServer?.once('close', () => {
            gameSession.stop();
          });

          server.middlewares.use('/api/game/state', async (req, res) => {
            if (req.method !== 'GET') {
              res.statusCode = 405;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Method not allowed' }));
              return;
            }

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ state: gameSession.snapshot() }));
          });

          server.middlewares.use('/api/game/input', async (req, res) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Method not allowed' }));
              return;
            }

            try {
              const body = await readJsonBody(req);
              gameSession.setInput(body?.input ?? {});
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ ok: true }));
            } catch (error) {
              const message = error instanceof Error ? error.message : 'unknown error';
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: message }));
            }
          });

          server.middlewares.use('/api/game/cast', async (req, res) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Method not allowed' }));
              return;
            }

            try {
              const body = await readJsonBody(req);
              const result = await gameSession.castPrompt(body?.prompt ?? '');
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ result }));
            } catch (error) {
              const message = error instanceof Error ? error.message : 'unknown error';
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: message }));
            }
          });

          server.middlewares.use('/api/game/reset', async (req, res) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Method not allowed' }));
              return;
            }

            try {
              const body = await readJsonBody(req);
              const reason = typeof body?.reason === 'string' ? body.reason : 'manual';
              gameSession.reset(reason);
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ ok: true, state: gameSession.snapshot() }));
            } catch (error) {
              const message = error instanceof Error ? error.message : 'unknown error';
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: message }));
            }
          });

          server.middlewares.use('/api/game/apply-artifact', async (req, res) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Method not allowed' }));
              return;
            }

            try {
              const body = await readJsonBody(req);
              const result = await gameSession.applyArtifact({
                envelope: body?.envelope ?? {},
                templateVersion: body?.templateVersion ?? PROMPT_TEMPLATE_VERSION,
                artifact: body?.artifact ?? null,
              });
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ result }));
            } catch (error) {
              const message = error instanceof Error ? error.message : 'unknown error';
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: message }));
            }
          });

          server.middlewares.use('/api/prompt/estimate', async (req, res) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Method not allowed' }));
              return;
            }

            try {
              if (!apiKey) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'Missing OPENAI_API_KEY in .env' }));
                return;
              }

              const body = await readJsonBody(req);
              const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
              if (!prompt) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'Missing prompt' }));
                return;
              }

              const upstream = await estimateFromPrompt(prompt, apiKey);
              const upstreamText = await upstream.text();
              if (!upstream.ok) {
                res.statusCode = upstream.status;
                res.setHeader('Content-Type', 'application/json');
                res.end(upstreamText);
                return;
              }

              const upstreamParsed = safeParseJson(upstreamText);
              if (!upstreamParsed.ok) {
                res.statusCode = 502;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: `Estimator upstream returned invalid JSON: ${upstreamParsed.error}` }));
                return;
              }

              const upstreamJson = upstreamParsed.value;
              const outputText = extractOutputText(upstreamJson);
              if (!outputText) {
                res.statusCode = 502;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'Estimator returned no parseable output' }));
                return;
              }

              const parsedEstimate = parseEstimateOutputText(outputText);
              if (!parsedEstimate.ok) {
                res.statusCode = 502;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: parsedEstimate.error }));
                return;
              }

              const estimate = parsedEstimate.estimate;
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ estimate }));
            } catch (error) {
              const message = error instanceof Error ? error.message : 'unknown error';
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: message }));
            }
          });

          server.middlewares.use('/api/prompt/execute', async (req, res) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Method not allowed' }));
              return;
            }

            try {
              if (!apiKey) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'Missing OPENAI_API_KEY in .env' }));
                return;
              }

              const body = await readJsonBody(req);
              const model = body.model;
              const reasoningEffort = typeof body.reasoningEffort === 'string' ? body.reasoningEffort.trim() : '';
              const envelope = body.envelope;

              if (!model || !envelope?.prompt) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'Missing model or envelope.prompt' }));
                return;
              }

              const upstream = await executePromptWithModel(model, reasoningEffort, envelope, apiKey);
              const text = await upstream.text();
              if (!upstream.ok) {
                res.statusCode = upstream.status;
                res.setHeader('Content-Type', 'application/json');
                res.end(text);
                return;
              }

              let upstreamJson = {};
              try {
                upstreamJson = JSON.parse(text);
              } catch {
                upstreamJson = {};
              }

              const outputText = extractOutputText(upstreamJson);
              if (!outputText) {
                res.statusCode = 502;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'Generator returned no parseable output text' }));
                return;
              }

              const parsed = parseArtifactOutputText(outputText);
              if (!parsed.ok) {
                res.statusCode = 502;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: parsed.error }));
                return;
              }

              const artifact = parsed.artifact;

              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json');
              res.end(
                JSON.stringify({
                  model,
                  reasoningEffort: reasoningEffort || 'low',
                  templateVersion: PROMPT_TEMPLATE_VERSION,
                  baselineState: SANDBOX_BASELINE_STATE,
                  artifact,
                  outputText,
                  upstream: upstreamJson,
                })
              );
            } catch (error) {
              const message = error instanceof Error ? error.message : 'unknown error';
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: message }));
            }
          });

          server.middlewares.use('/api/spells/generate', async (req, res) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Method not allowed' }));
              return;
            }

            try {
              const body = await readJsonBody(req);
              const result = await handleSpellGenerate(body, {
                requestId: makeRequestId(),
              });
              res.statusCode = result.status;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(result.payload));
            } catch (error) {
              const message = error instanceof Error ? error.message : 'unknown error';
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: message }));
            }
          });

          server.middlewares.use('/api/assets/generate-glb', async (req, res) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Method not allowed' }));
              return;
            }

            try {
              const body = await readJsonBody(req);
              const promptId = String(body?.promptId ?? '').trim();
              const prompt = String(body?.prompt ?? '').trim();
              const jobs = Array.isArray(body?.jobs) ? body.jobs : [];

              if (jobs.length === 0) {
                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ assets: [] }));
                return;
              }

              const assets = await generateGlbAssets({
                promptId,
                prompt,
                jobs,
                apiKey,
              });

              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ assets }));
            } catch (error) {
              const message = error instanceof Error ? error.message : 'unknown error';
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: message }));
            }
          });
        },
      },
    ],
    server: {
      port: 5173,
    },
  };
});
