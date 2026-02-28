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
              content: { type: 'string', minLength: 1 },
              position: {
                type: 'string',
                enum: ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center-top'],
              },
            },
            required: ['id', 'title', 'description', 'content', 'position'],
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
              visual: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  assetRef: { type: 'string', minLength: 1 },
                  fallbackShape: {
                    type: 'string',
                    enum: ['box', 'capsule', 'sphere', 'cone'],
                  },
                  scale: { type: 'number', minimum: 0.2, maximum: 4 },
                  tint: { type: 'string', minLength: 1, maxLength: 24 },
                },
                required: ['assetRef', 'fallbackShape', 'scale', 'tint'],
              },
            },
            required: ['id', 'name', 'role', 'behavior', 'visual'],
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
              visual: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  assetRef: { type: 'string', minLength: 1 },
                  vfxShape: {
                    type: 'string',
                    enum: ['ring', 'orb', 'wave'],
                  },
                  color: { type: 'string', minLength: 1, maxLength: 24 },
                  durationMs: { type: 'integer', minimum: 100, maximum: 12000 },
                },
                required: ['assetRef', 'vfxShape', 'color', 'durationMs'],
              },
            },
            required: ['id', 'name', 'trigger', 'effect', 'visual'],
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
    'You generate structured sandbox patch artifacts for a top-down 3D tower defense game called "God of Goons".',
    'The player is a commander defending a castle base from waves of enemy goons (melee, ranged, tank types) that march down 5 lanes.',
    'Return only JSON that matches the required schema.',
    `Template version: ${PROMPT_TEMPLATE_VERSION}.`,
    '',
    'GAME CONTEXT:',
    '- Enemies spawn from the far end and walk toward the castle wall. The player can summon units, cast spells, and create mechanics.',
    '- Available baseline spells (use with actions.cast_spell): "fireball" (explosion), "wall" (lane barrier), "frost" (freeze), "bolt" (chain lightning).',
    '- Units are summoned defenders that block enemies and fight them. They have HP, a fallback shape, tint color, and scale.',
    '- Actions are spell-like effects with visual feedback (ring/orb/wave VFX).',
    '- Mechanics are hook-driven behaviors: they fire on events (onTick, onEnemySpawn, onEnemyDeath, onKillCombo, onWaveStart) and invoke primitives.',
    '',
    'CRITICAL RULES:',
    '- MATCH THE USER PROMPT LITERALLY. "fire wall" means a wall of fire that burns enemies, NOT a gold bonus.',
    '- "car" means spawn a car-like unit, NOT unrelated mechanics.',
    '- The classifiedTypes in the envelope tell you WHAT to generate. Respect them.',
    '- If types include "actions", generate actions with combat effects (deal_damage, apply_dot, cast_spell).',
    '- If types include "units", generate unit definitions with visual metadata.',
    '- If types include "mechanics", generate hook-based mechanics that implement the prompt behavior.',
    '- Do NOT generate unrelated mechanics (gold bonuses, scouts) unless explicitly asked.',
    '- Only use primitives listed in the provided primitive catalog.',
    '- Keep mechanics bounded with limits (runtime, commands, invocations).',
    '- The sandbox always starts from baseline on restart/refresh.',
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
        'CRITICAL: Generate artifacts that DIRECTLY implement what the user asked for. Do not substitute unrelated mechanics.',
        'Example: "fire wall" -> mechanic with combat.apply_dot on onEnemySpawn (burn enemies) + action with actions.cast_spell "wall" on onWaveStart.',
        'Example: "car" -> unit with id="car", name="Battle Car", role="tank", behavior="blocks enemies", visual with fallbackShape="box", scale=1.5.',
        'Example: "ice storm" -> mechanic with combat.deal_damage on onTick + action with actions.cast_spell "frost".',
        'The classifiedTypes in the envelope indicate what artifact types to produce. Respect them strictly.',
        'If types do not include "mechanics", mechanics must be an empty array. Same for units, actions, ui.',
        'For each mechanic hook invocation, pick only known primitive IDs from the catalog.',
        'Use argsJson as a JSON string object for primitive arguments.',
        'Primitive args inside argsJson may reference runtime context using "$path" syntax (example: "$enemy.id", "$comboCount").',
        'For combat mechanics targeting enemies, use "$enemy.id" as targetId with onEnemySpawn or onTick hooks.',
        'Always include visual metadata for units (fallbackShape, tint, scale) and actions (vfxShape, color, durationMs).',
        'Each hook must include intervalSeconds and maxInvocationsPerTick explicitly (use intervalSeconds=0 for non-tick hooks).',
        'All mechanic outputs must be bounded by limits.',
        'mechanicsSummary should be human-readable and describe the actual behavior implemented.',
        'UI widgets require id, title, description, and content fields. content is the text displayed in the widget panel.',
      ],
    },
    null,
    2
  );
}
