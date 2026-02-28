import { PROMPT_TYPES } from '../types/prompt.js';
import { BUILTIN_PRIMITIVE_CATALOG, MECHANIC_HOOK_EVENTS } from '../runtime/primitives/primitiveCatalog.js';

export const PROMPT_TEMPLATE_VERSION = 'sandbox-v1';

export const SANDBOX_BASELINE_STATE = {
  ui: [],
  mechanics: [],
  units: [],
  actions: [],
  notes: 'Baseline sandbox state with no generated layers applied.',
};

export const ARTIFACT_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: {
      type: 'string',
      minLength: 1,
    },
    classifiedTypes: {
      type: 'array',
      items: {
        type: 'string',
        enum: PROMPT_TYPES,
      },
      minItems: 1,
    },
    sandboxPatch: {
      type: 'object',
      additionalProperties: false,
      properties: {
        resetToBaselineFirst: {
          type: 'boolean',
        },
        ui: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', minLength: 1 },
              title: { type: 'string', minLength: 1 },
              description: { type: 'string', minLength: 1 },
            },
            required: ['id', 'title', 'description'],
          },
        },
        mechanics: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', minLength: 1 },
              name: { type: 'string', minLength: 1 },
              description: { type: 'string', minLength: 1 },
              lifecycle: {
                type: 'string',
                enum: ['persistent', 'timed', 'wave'],
              },
              hooks: {
                type: 'array',
                minItems: 1,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    event: {
                      type: 'string',
                      enum: MECHANIC_HOOK_EVENTS,
                    },
                    intervalSeconds: {
                      type: 'number',
                      minimum: 0,
                    },
                    maxInvocationsPerTick: {
                      type: 'integer',
                      minimum: 1,
                    },
                    invocations: {
                      type: 'array',
                      minItems: 1,
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          primitiveId: { type: 'string', minLength: 1 },
                          argsJson: { type: 'string', minLength: 2 },
                        },
                        required: ['primitiveId', 'argsJson'],
                      },
                    },
                  },
                  required: ['event', 'intervalSeconds', 'maxInvocationsPerTick', 'invocations'],
                },
              },
              limits: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  maxCommandsPerTick: {
                    type: 'integer',
                    minimum: 1,
                  },
                  maxInvocationsPerTick: {
                    type: 'integer',
                    minimum: 1,
                  },
                  maxRuntimeMs: {
                    type: 'number',
                    minimum: 0.1,
                  },
                },
                required: ['maxCommandsPerTick', 'maxInvocationsPerTick', 'maxRuntimeMs'],
              },
            },
            required: ['id', 'name', 'description', 'lifecycle', 'hooks', 'limits'],
          },
        },
        units: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', minLength: 1 },
              name: { type: 'string', minLength: 1 },
              role: { type: 'string', minLength: 1 },
              behavior: { type: 'string', minLength: 1 },
            },
            required: ['id', 'name', 'role', 'behavior'],
          },
        },
        actions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', minLength: 1 },
              name: { type: 'string', minLength: 1 },
              trigger: { type: 'string', minLength: 1 },
              effect: { type: 'string', minLength: 1 },
            },
            required: ['id', 'name', 'trigger', 'effect'],
          },
        },
      },
      required: ['resetToBaselineFirst', 'ui', 'mechanics', 'units', 'actions'],
    },
    observability: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mechanicsSummary: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
        },
        assumptions: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
        },
      },
      required: ['mechanicsSummary', 'assumptions'],
    },
  },
  required: ['summary', 'classifiedTypes', 'sandboxPatch', 'observability'],
};

export function buildArtifactSystemPrompt() {
  return [
    'You generate structured sandbox patch artifacts for a tower defense game.',
    'Return only JSON that matches the required schema.',
    `Template version: ${PROMPT_TEMPLATE_VERSION}.`,
    'Hard requirements:',
    '- The sandbox always starts from baseline on restart/refresh.',
    '- Assume baseline has no generated UI/mechanics/units/actions.',
    '- Put all generated behavior in sandboxPatch.',
    '- For mechanics, use hook+primitive invocations.',
    '- Only use primitives listed in the provided primitive catalog.',
    '- Keep mechanics bounded with limits (runtime, commands, invocations).',
    '- Keep entries concise and implementation-oriented.',
  ].join('\n');
}

export function buildArtifactUserPrompt(envelope) {
  const primitiveCatalog = BUILTIN_PRIMITIVE_CATALOG.map((primitive) => ({
    id: primitive.id,
    description: primitive.description,
    allowedEvents: primitive.allowedEvents,
    requiredArgs: primitive.requiredArgs,
    args: primitive.args,
  }));

  return JSON.stringify(
    {
      task: 'draft_sandbox_patch',
      templateVersion: PROMPT_TEMPLATE_VERSION,
      baselineState: SANDBOX_BASELINE_STATE,
      primitiveCatalog,
      envelope,
      authoringNotes: [
        'resetToBaselineFirst should normally be true.',
        'If no mechanics are requested, mechanics must be an empty array.',
        'For each mechanic hook invocation, pick only known primitive IDs.',
        'Use argsJson as a JSON string object for primitive arguments.',
        'Primitive args inside argsJson may reference runtime context using "$path" syntax (example: "$enemy.id", "$comboCount").',
        'Each hook must include intervalSeconds and maxInvocationsPerTick explicitly (use intervalSeconds=0 for non-tick hooks).',
        'All mechanic outputs must be bounded by limits.',
        'mechanicsSummary should be human-readable and specific.',
      ],
    },
    null,
    2
  );
}
