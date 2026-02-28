import { defineConfig, loadEnv } from 'vite';
import {
  ARTIFACT_RESPONSE_SCHEMA,
  PROMPT_TEMPLATE_VERSION,
  SANDBOX_BASELINE_STATE,
  buildArtifactSystemPrompt,
  buildArtifactUserPrompt,
} from './src/prompt/templateDrafts.js';

const RESPONSES_API_URL = 'https://api.openai.com/v1/responses';
const FAST_ESTIMATOR_MODEL = 'gpt-5.3-codex';

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
  for (const item of outputs) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const block of content) {
      if (typeof block?.text === 'string' && block.text.length > 0) {
        return block.text;
      }
    }
  }

  return '';
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

function executePromptWithModel(model, envelope, apiKey) {
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
    }),
  });
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  process.env = { ...process.env, ...env };
  const apiKey = process.env.OPENAI_API_KEY;
  const backendHost = process.env.SPELL_BACKEND_HOST || '127.0.0.1';
  const backendPort = Number(process.env.SPELL_BACKEND_PORT || 8787);

  return {
    plugins: [
      {
        name: 'openai-api-key-endpoints',
        configureServer(server) {
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

              const upstreamJson = JSON.parse(upstreamText);
              const outputText = extractOutputText(upstreamJson);
              if (!outputText) {
                res.statusCode = 502;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'Estimator returned no parseable output' }));
                return;
              }

              const estimate = JSON.parse(outputText);
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
              const envelope = body.envelope;

              if (!model || !envelope?.prompt) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'Missing model or envelope.prompt' }));
                return;
              }

              const upstream = await executePromptWithModel(model, envelope, apiKey);
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
              let artifact = null;
              if (outputText) {
                try {
                  artifact = JSON.parse(outputText);
                } catch {
                  artifact = null;
                }
              }

              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json');
              res.end(
                JSON.stringify({
                  model,
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
        },
      },
    ],
    server: {
      host: true,
      port: 5173,
      proxy: {
        '/api/spells': {
          target: `http://${backendHost}:${backendPort}`,
          changeOrigin: true,
        },
      },
    },
  };
});
