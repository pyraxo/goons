import { z } from 'zod';

import { PROMPT_TYPES, RISK_LEVELS } from '../types/prompt.js';

const PromptTypeSchema = z.enum(PROMPT_TYPES);
const RiskLevelSchema = z.enum(RISK_LEVELS);

export const PromptEstimateSchema = z
  .object({
    classifiedTypes: z.array(PromptTypeSchema).min(1),
    estimatedGoldCost: z.number().int().min(1),
    riskLevel: RiskLevelSchema,
    requiresReview: z.boolean(),
  })
  .strict();

function cleanText(rawText) {
  const trimmed = String(rawText ?? '').trim();
  if (trimmed.startsWith('```')) {
    return trimmed.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '').trim();
  }
  return trimmed;
}

function tryParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'invalid JSON',
    };
  }
}

function extractJsonObjectCandidate(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) {
    return null;
  }
  return text.slice(start, end + 1);
}

function parseJsonObjectFromText(rawText) {
  const cleaned = cleanText(rawText);
  const direct = tryParseJson(cleaned);
  if (direct.ok) {
    return { ok: true, value: direct.value };
  }

  const candidate = extractJsonObjectCandidate(cleaned);
  if (candidate) {
    const second = tryParseJson(candidate);
    if (second.ok) {
      return { ok: true, value: second.value };
    }
    return { ok: false, error: second.error };
  }

  return { ok: false, error: direct.error };
}

function formatZodIssues(error) {
  const issues = error?.issues ?? [];
  if (!Array.isArray(issues) || issues.length === 0) {
    return 'Unknown schema validation error';
  }

  return issues
    .slice(0, 8)
    .map((issue) => {
      const path = Array.isArray(issue.path) && issue.path.length > 0 ? issue.path.join('.') : '<root>';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

export function parseEstimateOutputText(outputText) {
  const parsedJson = parseJsonObjectFromText(outputText);
  if (!parsedJson.ok) {
    return {
      ok: false,
      error: `Estimator output is not valid JSON: ${parsedJson.error}`,
      estimate: null,
    };
  }

  const result = PromptEstimateSchema.safeParse(parsedJson.value);
  if (!result.success) {
    return {
      ok: false,
      error: `Estimator output failed Zod validation: ${formatZodIssues(result.error)}`,
      estimate: null,
    };
  }

  return {
    ok: true,
    error: null,
    estimate: result.data,
  };
}
