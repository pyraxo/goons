import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getSpellApiMetrics, handleSpellGenerate } from './spell-api.js';

loadEnvFile();

const PORT = Number(process.env.SPELL_BACKEND_PORT || 8787);
const HOST = process.env.SPELL_BACKEND_HOST || '127.0.0.1';

const server = createServer(async (req, res) => {
  const start = Date.now();

  if (req.method === 'GET' && req.url === '/healthz') {
    json(res, 200, {
      ok: true,
      service: 'spell-backend',
      hasApiKey: Boolean(process.env.OPENAI_API_KEY),
      model: process.env.OPENAI_MODEL || 'gpt-5',
      telemetry: getSpellApiMetrics(),
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/spells/generate') {
    const requestId = makeRequestId();
    try {
      const rawBody = await readBody(req);
      const parsed = rawBody ? JSON.parse(rawBody) : {};
      const result = await handleSpellGenerate(parsed, { requestId });
      logRequest(result, parsed, Date.now() - start, requestId);
      json(res, result.status, result.payload);
      return;
    } catch (error) {
      const detail = String(error?.message || error);
      console.error('[spell-api] request_failed', { requestId, detail });
      json(res, 500, {
        error: 'internal spell api error',
        detail,
      });
      return;
    }
  }

  json(res, 404, { error: 'not_found' });
});

server.listen(PORT, HOST, () => {
  console.log(`[spell-backend] listening on http://${HOST}:${PORT}`);
  console.log('[spell-backend] env', {
    hasApiKey: Boolean(process.env.OPENAI_API_KEY),
    model: process.env.OPENAI_MODEL || 'gpt-5',
    timeoutMs: Number(process.env.SPELL_API_TIMEOUT_MS || 10000),
  });
});

function json(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 512_000) {
        rejectBody(new Error('request_body_too_large'));
      }
    });
    req.on('end', () => resolveBody(data));
    req.on('error', rejectBody);
  });
}

function logRequest(result, parsed, elapsedMs, requestId) {
  const meta = result?.payload?.meta || {};
  const payloadSpell = result?.payload?.spell || {};
  const source = result?.payload?.source || 'unknown';
  const prompt = typeof parsed?.prompt === 'string' ? parsed.prompt.slice(0, 60) : '';
  const warnings = Array.isArray(meta.warnings) ? meta.warnings : [];

  const line = {
    source,
    archetype: payloadSpell.archetype,
    effects: payloadSpell.effects,
    powerScore: meta.powerScore,
    cost: payloadSpell.cost || null,
    latencyMs: meta.latencyMs,
    elapsedMs,
    fallbackReason: meta.fallbackReason || null,
    warnings,
    prompt,
  };

  if (source === 'fallback') {
    console.warn('[spell-api] fallback', { requestId, ...line });
  } else {
    console.log('[spell-api] llm_cast', { requestId, ...line });
  }
}

function loadEnvFile() {
  const envPath = resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) {
    return;
  }

  const content = readFileSync(envPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const idx = trimmed.indexOf('=');
    if (idx === -1) {
      continue;
    }

    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function makeRequestId() {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${rand}`;
}
