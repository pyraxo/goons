import { describe, expect, it } from 'vitest';

import { ServerGameSession } from './game-session.js';

describe('ServerGameSession', () => {
  it('casts baseline fireball server-side and consumes mana', () => {
    const session = new ServerGameSession();
    const enemy = session.createEnemy('melee', 2);
    enemy.z = session.commander.z - 20;
    session.enemies.push(enemy);

    const manaBefore = session.game.mana;
    const ok = session.castSpellByName('fireball', {
      enforceCosts: true,
      showToast: false,
    });

    expect(ok).toBe(true);
    expect(session.game.mana).toBeLessThan(manaBefore);
    expect(session.projectiles.length).toBeGreaterThan(0);
  });

  it('applies movement input and advances simulation on tick', () => {
    const session = new ServerGameSession();
    const zBefore = session.commander.z;

    session.setInput({ w: true });
    session.tick(0.1);

    expect(session.commander.z).toBeLessThan(zBefore);
    expect(session.snapshot().version).toBeGreaterThan(0);
  });

  it('spawns generated units from runtime commands and includes them in snapshot', () => {
    const session = new ServerGameSession();
    session.syncGeneratedCatalogs(
      {
        sandboxPatch: {
          units: [
            {
              id: 'car_unit',
              name: 'Car Unit',
              role: 'striker',
              behavior: 'lane_hunter',
              visual: { fallbackShape: 'box', tint: '#77aaff', scale: 1.2 },
            },
          ],
          actions: [],
        },
      },
      []
    );

    session.applyRuntimeCommand({
      type: 'units.spawn',
      payload: { unitKind: 'car_unit', lane: 1 },
    });

    const snapshot = session.snapshot();
    expect(snapshot.units).toHaveLength(1);
    expect(snapshot.units[0].kind).toBe('car_unit');
    expect(snapshot.units[0].lane).toBe(1);
  });

  it('mounts a widget via applyRuntimeCommand and includes it in snapshot', () => {
    const session = new ServerGameSession();
    session.applyRuntimeCommand({
      type: 'ui.mountWidget',
      payload: {
        props: { id: 'kill_counter', title: 'Kills', content: '0', position: 'top-right' },
      },
    });

    const snapshot = session.snapshot();
    expect(snapshot.mountedWidgets).toHaveLength(1);
    expect(snapshot.mountedWidgets[0].id).toBe('kill_counter');
    expect(snapshot.mountedWidgets[0].content).toBe('0');
    expect(snapshot.mountedWidgets[0].position).toBe('top-right');
  });

  it('upserts widget with same id instead of duplicating', () => {
    const session = new ServerGameSession();
    session.applyRuntimeCommand({
      type: 'ui.mountWidget',
      payload: {
        props: { id: 'score', title: 'Score', content: '10', position: 'top-left' },
      },
    });
    session.applyRuntimeCommand({
      type: 'ui.mountWidget',
      payload: {
        props: { id: 'score', title: 'Score', content: '25', position: 'top-left' },
      },
    });

    const snapshot = session.snapshot();
    expect(snapshot.mountedWidgets).toHaveLength(1);
    expect(snapshot.mountedWidgets[0].content).toBe('25');
  });

  it('clears mounted widgets on reset', () => {
    const session = new ServerGameSession();
    session.applyRuntimeCommand({
      type: 'ui.mountWidget',
      payload: {
        props: { id: 'w1', title: 'W', content: 'test' },
      },
    });
    expect(session.snapshot().mountedWidgets).toHaveLength(1);

    session.reset('test');
    expect(session.snapshot().mountedWidgets).toHaveLength(0);
  });

  it('executes generated action fallback when castSpell name is not a baseline spell', () => {
    const session = new ServerGameSession();
    session.syncGeneratedCatalogs(
      {
        sandboxPatch: {
          units: [],
          actions: [
            {
              id: 'wall_of_fire',
              name: 'Wall of Fire',
              trigger: 'onWaveStart',
              effect: 'summon a burning wall in the hottest lane',
              visual: { vfxShape: 'wave', color: '#ff8840' },
            },
          ],
        },
      },
      []
    );

    session.applyRuntimeCommand({
      type: 'actions.castSpell',
      payload: { spellName: 'wall of fire' },
    });

    const snapshot = session.snapshot();
    expect(snapshot.walls.length).toBeGreaterThan(0);
    expect(snapshot.zones.length).toBeGreaterThan(0);
    expect(snapshot.actionVisuals.length).toBeGreaterThan(0);
  });
});
