import { PROMPT_TYPES } from '../types/prompt.js';

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
              rules: {
                type: 'array',
                items: { type: 'string', minLength: 1 },
              },
            },
            required: ['id', 'name', 'description', 'rules'],
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
    '- For mechanics, include concrete rules that can be inspected later.',
    '- Keep entries concise and implementation-oriented.',
  ].join('\n');
}

export function buildArtifactUserPrompt(envelope) {
  return JSON.stringify(
    {
      task: 'draft_sandbox_patch',
      templateVersion: PROMPT_TEMPLATE_VERSION,
      baselineState: SANDBOX_BASELINE_STATE,
      envelope,
      authoringNotes: [
        'resetToBaselineFirst should normally be true.',
        'If no mechanics are requested, mechanics must be an empty array.',
        'mechanicsSummary should be human-readable and specific.',
      ],
    },
    null,
    2
  );
}
