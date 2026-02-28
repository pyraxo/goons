import { describe, expect, it } from 'vitest';

import { parseArtifactOutputText } from './artifactContract.js';

function validOutput() {
  return JSON.stringify({
    summary: 'Adds combo economy mechanic.',
    classifiedTypes: ['mechanics', 'ui'],
    sandboxPatch: {
      resetToBaselineFirst: true,
      ui: [],
      mechanics: [
        {
          id: 'combo_gold',
          name: 'Combo Gold',
          description: 'Increases gold reward when kills chain quickly.',
          lifecycle: 'persistent',
          hooks: [
            {
              event: 'onKillCombo',
              intervalSeconds: 0,
              maxInvocationsPerTick: 4,
              invocations: [
                {
                  primitiveId: 'economy.add_multiplier',
                  argsJson: '{"key":"combo","multiplier":1.5,"durationSeconds":0.5}',
                },
              ],
            },
          ],
          limits: {
            maxCommandsPerTick: 12,
            maxInvocationsPerTick: 8,
            maxRuntimeMs: 2.2,
          },
        },
      ],
      units: [],
      actions: [],
    },
    observability: {
      mechanicsSummary: ['combo_gold on onKillCombo using economy.add_multiplier'],
      assumptions: ['intervalSeconds=0 for event-driven hook'],
    },
  });
}

describe('parseArtifactOutputText', () => {
  it('accepts valid structured artifact output', () => {
    const result = parseArtifactOutputText(validOutput());
    expect(result.ok).toBe(true);
    expect(result.artifact?.sandboxPatch.mechanics).toHaveLength(1);
  });

  it('rejects invalid argsJson', () => {
    const rawObject = JSON.parse(validOutput());
    rawObject.sandboxPatch.mechanics[0].hooks[0].invocations[0].argsJson = 'not-json';
    const result = parseArtifactOutputText(JSON.stringify(rawObject));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('argsJson');
  });

  it('accepts UI artifact with content and position', () => {
    const rawObject = JSON.parse(validOutput());
    rawObject.sandboxPatch.ui = [
      {
        id: 'kill_counter',
        title: 'Kill Counter',
        description: 'Shows total kills',
        content: 'Kills: 0',
        position: 'top-right',
      },
    ];
    const result = parseArtifactOutputText(JSON.stringify(rawObject));
    expect(result.ok).toBe(true);
    expect(result.artifact?.sandboxPatch.ui).toHaveLength(1);
    expect(result.artifact?.sandboxPatch.ui[0].content).toBe('Kills: 0');
  });

  it('rejects UI artifact without content field', () => {
    const rawObject = JSON.parse(validOutput());
    rawObject.sandboxPatch.ui = [
      {
        id: 'bad_widget',
        title: 'Bad Widget',
        description: 'Missing content',
      },
    ];
    const result = parseArtifactOutputText(JSON.stringify(rawObject));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('content');
  });

  it('rejects missing required hook fields', () => {
    const rawObject = JSON.parse(validOutput());
    delete rawObject.sandboxPatch.mechanics[0].hooks[0].intervalSeconds;
    const result = parseArtifactOutputText(JSON.stringify(rawObject));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('intervalSeconds');
  });
});
