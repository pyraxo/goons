import { z } from 'zod';

import { PROMPT_TYPES } from '../types/prompt.js';
import { MECHANIC_HOOK_EVENTS } from '../runtime/primitives/primitiveCatalog.js';

const LifecycleSchema = z.enum(['persistent', 'timed', 'wave']);
const PromptTypeSchema = z.enum(PROMPT_TYPES);
const HookEventSchema = z.enum(MECHANIC_HOOK_EVENTS);

function isJsonObjectString(value) {
  try {
    const parsed = JSON.parse(value);
    return Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

const UiArtifactSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().min(1),
  })
  .strict();

const MechanicInvocationSchema = z
  .object({
    primitiveId: z.string().min(1),
    argsJson: z.string().min(2).refine(isJsonObjectString, {
      message: 'argsJson must be a valid JSON object string',
    }),
  })
  .strict();

const MechanicHookSchema = z
  .object({
    event: HookEventSchema,
    intervalSeconds: z.number().min(0),
    maxInvocationsPerTick: z.number().int().min(1),
    invocations: z.array(MechanicInvocationSchema).min(1),
  })
  .strict();

const MechanicSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    lifecycle: LifecycleSchema,
    hooks: z.array(MechanicHookSchema).min(1),
    limits: z
      .object({
        maxCommandsPerTick: z.number().int().min(1),
        maxInvocationsPerTick: z.number().int().min(1),
        maxRuntimeMs: z.number().min(0.1),
      })
      .strict(),
  })
  .strict();

const UnitArtifactSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    role: z.string().min(1),
    behavior: z.string().min(1),
  })
  .strict();

const ActionArtifactSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    trigger: z.string().min(1),
    effect: z.string().min(1),
  })
  .strict();

const SandboxPatchSchema = z
  .object({
    resetToBaselineFirst: z.boolean(),
    ui: z.array(UiArtifactSchema),
    mechanics: z.array(MechanicSchema),
    units: z.array(UnitArtifactSchema),
    actions: z.array(ActionArtifactSchema),
  })
  .strict();

const ObservabilitySchema = z
  .object({
    mechanicsSummary: z.array(z.string().min(1)),
    assumptions: z.array(z.string().min(1)),
  })
  .strict();

export const ArtifactOutputSchema = z
  .object({
    summary: z.string().min(1),
    classifiedTypes: z.array(PromptTypeSchema).min(1),
    sandboxPatch: SandboxPatchSchema,
    observability: ObservabilitySchema,
  })
  .strict();

export function formatZodIssues(error) {
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

export function parseArtifactOutputText(outputText) {
  let parsed;
  try {
    parsed = JSON.parse(outputText);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid JSON';
    return {
      ok: false,
      error: `Artifact output is not valid JSON: ${message}`,
      artifact: null,
    };
  }

  const result = ArtifactOutputSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      error: `Artifact output failed Zod validation: ${formatZodIssues(result.error)}`,
      artifact: null,
    };
  }

  return {
    ok: true,
    error: null,
    artifact: result.data,
  };
}
