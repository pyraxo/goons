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
      allowLocked: true,
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
});
