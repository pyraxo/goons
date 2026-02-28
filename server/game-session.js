import { createInitialGameState, BASE_Z, CASTLE_WALL_FRONT_Z, COMMANDER_MIN_Z, COMMANDER_MAX_Z, GOON_ATTACK_DAMAGE, GOON_ATTACK_INTERVAL_SECONDS, KILL_GOLD_REWARD, LANE_COUNT, LANE_SPACING, START_Z } from '../src/game/config.js';
import { MechanicRuntime } from '../src/runtime/mechanicRuntime.js';
import { InMemorySandboxStateStore } from '../src/runtime/persistence/sandboxStateStore.js';
import { createDefaultPrimitiveRegistry } from '../src/runtime/primitives/primitiveRegistry.js';
import { runAgenticApplyWorkflow } from '../src/runtime/agenticApplyWorkflow.js';
import { handleSpellGenerate } from './spell-api.js';

const TICK_HZ = 30;
const TICK_DT = 1 / TICK_HZ;
const MAX_SNAPSHOT_ENEMIES = 256;
const MAX_SNAPSHOT_PROJECTILES = 128;
const MAX_WALLS = 12;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function laneX(index) {
  return (index - (LANE_COUNT - 1) / 2) * LANE_SPACING;
}

function levenshtein(a, b) {
  const matrix = [];
  for (let i = 0; i <= b.length; i += 1) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j += 1) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i += 1) {
    for (let j = 1; j <= a.length; j += 1) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
      }
    }
  }

  return matrix[b.length][a.length];
}

function normalizePrompt(prompt) {
  return String(prompt ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function createReservationStore(game) {
  const reservations = new Map();

  function canSpendGold(amount) {
    return Number.isFinite(amount) && amount > 0 && game.gold >= amount;
  }

  function reserveGold(amount) {
    if (!canSpendGold(amount)) return null;
    game.gold -= amount;
    const id = `res_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    reservations.set(id, amount);
    return id;
  }

  function commitReservedGold(id) {
    if (!reservations.has(id)) return false;
    reservations.delete(id);
    return true;
  }

  function refundReservedGold(id) {
    const amount = reservations.get(id);
    if (amount === undefined) return false;
    reservations.delete(id);
    game.gold += amount;
    return true;
  }

  function getReservedGold() {
    let total = 0;
    for (const amount of reservations.values()) {
      total += amount;
    }
    return total;
  }

  function clearReservations() {
    reservations.clear();
  }

  return {
    canSpendGold,
    reserveGold,
    commitReservedGold,
    refundReservedGold,
    getReservedGold,
    clearReservations,
  };
}

export class ServerGameSession {
  constructor() {
    this.game = createInitialGameState();
    this.commander = {
      x: 0,
      z: BASE_Z - 5,
      speed: 15,
    };
    this.input = { w: false, a: false, s: false, d: false };
    this.enemies = [];
    this.walls = [];
    this.projectiles = [];
    this.zones = [];
    this.runtimeGoldMultipliers = new Map();
    this.activeDots = new Map();
    this.lastTickAt = Date.now();
    this.spawnTimer = 0;
    this.waveTimer = 0;
    this.comboCount = 0;
    this.comboTimer = 0;
    this.enemyIdCounter = 1;
    this.wallIdCounter = 1;
    this.projectileIdCounter = 1;
    this.zoneIdCounter = 1;
    this.lastToast = null;
    this.snapshotVersion = 0;

    this.mechanicRuntime = new MechanicRuntime();
    this.primitiveRegistry = createDefaultPrimitiveRegistry();
    this.sandboxStateStore = new InMemorySandboxStateStore();
    this.goldReservations = createReservationStore(this.game);

    this.spells = {
      fireball: {
        cost: 16,
        description: 'Auto-targets nearest enemy and explodes.',
        cast: () => this.castFireball(),
      },
      wall: {
        cost: 24,
        description: 'Summons a lane wall to stall enemies.',
        cast: () => this.castWall(),
      },
      frost: {
        cost: 32,
        description: 'Freezes enemies in all lanes for 2s.',
        cast: () => this.castFrost(),
      },
      bolt: {
        cost: 38,
        description: 'Chain lightning strikes multiple enemies.',
        cast: () => this.castBolt(),
      },
    };
  }

  start() {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => {
      this.tick(TICK_DT);
    }, Math.round(1000 / TICK_HZ));
    if (typeof this.tickTimer.unref === 'function') {
      this.tickTimer.unref();
    }
  }

  stop() {
    if (!this.tickTimer) return;
    clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  nowToast(message) {
    this.lastToast = {
      message,
      at: Date.now(),
    };
  }

  runtimeGameContext() {
    return {
      wave: this.game.wave,
      kills: this.game.kills,
      gold: this.game.gold,
      mana: this.game.mana,
      baseHp: this.game.baseHp,
    };
  }

  reset(reason = 'manual') {
    this.mechanicRuntime.clear();
    void this.sandboxStateStore.reset();
    this.game = createInitialGameState();
    this.commander.x = 0;
    this.commander.z = BASE_Z - 5;
    this.input = { w: false, a: false, s: false, d: false };
    this.enemies = [];
    this.walls = [];
    this.projectiles = [];
    this.zones = [];
    this.runtimeGoldMultipliers.clear();
    this.activeDots.clear();
    this.spawnTimer = 0;
    this.waveTimer = 0;
    this.comboCount = 0;
    this.comboTimer = 0;
    this.enemyIdCounter = 1;
    this.wallIdCounter = 1;
    this.projectileIdCounter = 1;
    this.zoneIdCounter = 1;
    this.goldReservations.clearReservations();
    this.nowToast(`Sandbox reset (${reason})`);
    this.snapshotVersion += 1;
  }

  setInput(nextInput) {
    this.input.w = Boolean(nextInput?.w);
    this.input.a = Boolean(nextInput?.a);
    this.input.s = Boolean(nextInput?.s);
    this.input.d = Boolean(nextInput?.d);
  }

  parseSpell(prompt) {
    const normalized = normalizePrompt(prompt);
    if (!normalized) return null;
    const spellNames = Object.keys(this.spells);

    const direct = spellNames.find((name) => normalized === name);
    if (direct) return direct;

    const words = normalized.split(' ');
    const contains = spellNames.find((name) => words.includes(name));
    if (contains) return contains;

    let best = null;
    let bestScore = Infinity;
    for (const spellName of spellNames) {
      const score = levenshtein(normalized, spellName);
      if (score < bestScore) {
        bestScore = score;
        best = spellName;
      }
    }

    if (bestScore <= 3 || bestScore <= Math.floor(normalized.length * 0.35)) {
      return best;
    }

    return null;
  }

  castSpellByName(spellName, options = {}) {
    const { enforceCosts = true, allowLocked = false, showToast = true } = options;
    const spell = this.spells[spellName];
    if (!spell) {
      if (showToast) this.nowToast(`No spell match for "${spellName}"`);
      return false;
    }

    if (!allowLocked && !this.game.unlocks.includes(spellName)) {
      if (showToast) this.nowToast(`Spell not unlocked: ${spellName}`);
      return false;
    }

    if (enforceCosts && this.game.mana < spell.cost) {
      if (showToast) this.nowToast('Not enough mana');
      return false;
    }

    const casted = spell.cast();
    if (!casted) return false;

    if (enforceCosts) {
      this.game.mana -= spell.cost;
    }

    if (showToast) {
      this.nowToast(`Cast ${spellName}: ${spell.description}`);
    }
    return true;
  }

  nearestEnemy() {
    let best = null;
    let bestDistSq = Infinity;
    for (const enemy of this.enemies) {
      if (enemy.dead) continue;
      const dx = this.commander.x - enemy.x;
      const dz = this.commander.z - enemy.z;
      const d = dx * dx + dz * dz;
      if (d < bestDistSq) {
        bestDistSq = d;
        best = enemy;
      }
    }
    return best;
  }

  lanePressure() {
    const summary = Array.from({ length: LANE_COUNT }, (_, lane) => ({ lane, value: 0 }));
    for (const enemy of this.enemies) {
      if (enemy.dead) continue;
      summary[enemy.lane].value += 1 + enemy.hp / enemy.maxHp;
    }
    return summary.sort((a, b) => b.value - a.value);
  }

  castFireball() {
    const target = this.nearestEnemy();
    if (!target) {
      this.nowToast('No target for fireball');
      return false;
    }

    this.projectiles.push({
      id: `proj_${this.projectileIdCounter++}`,
      kind: 'fireball',
      x: this.commander.x,
      y: 1.8,
      z: this.commander.z - 0.5,
      targetId: target.id,
      speed: 32,
      damage: 60,
      splash: 3.4,
      effects: ['burn'],
      intensity: 0.85,
    });

    return true;
  }

  castWall() {
    if (this.walls.length >= MAX_WALLS) {
      this.nowToast('Too many active walls');
      return false;
    }

    const pressure = this.lanePressure();
    const lane = pressure[0]?.lane ?? 2;
    const z = Math.max(BASE_Z - 28, Math.min(BASE_Z - 9, this.commander.z - 8));

    this.walls.push({
      id: `wall_${this.wallIdCounter++}`,
      lane,
      x: laneX(lane),
      z,
      hp: 140,
      maxHp: 140,
      duration: 12,
    });

    return true;
  }

  castFrost() {
    const liveEnemies = this.enemies.filter((enemy) => !enemy.dead);
    if (!liveEnemies.length) {
      this.nowToast('No enemies to freeze');
      return false;
    }

    for (const enemy of liveEnemies) {
      enemy.frozenFor = Math.max(enemy.frozenFor, 2.0);
    }

    return true;
  }

  castBolt() {
    const liveEnemies = this.enemies.filter((enemy) => !enemy.dead);
    if (!liveEnemies.length) {
      this.nowToast('No enemies for bolt');
      return false;
    }

    const sorted = [...liveEnemies].sort((a, b) => b.z - a.z).slice(0, 4);
    for (const enemy of sorted) {
      this.projectiles.push({
        id: `proj_${this.projectileIdCounter++}`,
        kind: 'zap',
        x: enemy.x,
        y: 2.6,
        z: enemy.z,
        life: 0.18,
      });
      this.damageEnemy(enemy, 42);
    }

    return true;
  }

  enemyConfig(kind) {
    const scale = 1 + (this.game.wave - 1) * 0.09;
    if (kind === 'tank') {
      return {
        hp: Math.round(95 * scale),
        speed: 2.3 + this.game.wave * 0.03,
        damage: 14,
        worth: 24,
      };
    }

    if (kind === 'ranged') {
      return {
        hp: Math.round(40 * scale),
        speed: 3.9 + this.game.wave * 0.04,
        damage: 7,
        worth: 15,
      };
    }

    return {
      hp: Math.round(58 * scale),
      speed: 4.3 + this.game.wave * 0.06,
      damage: 9,
      worth: 18,
    };
  }

  createEnemy(kind, lane) {
    const config = this.enemyConfig(kind);
    return {
      id: `enemy_${this.enemyIdCounter++}`,
      lane,
      kind,
      hp: config.hp,
      maxHp: config.hp,
      speed: config.speed,
      damage: config.damage,
      worth: config.worth,
      x: laneX(lane),
      z: START_Z,
      aimHeight: 1.2,
      frozenFor: 0,
      atCastleWall: false,
      wallAttackAccumulatorSeconds: 0,
      dead: false,
      deathTimer: 0,
      hitTimer: 0,
      anim: 'run',
    };
  }

  spawnEnemy() {
    const lane = Math.floor(Math.random() * LANE_COUNT);
    const roll = Math.random();
    let kind = 'melee';
    if (roll > 0.86 + Math.min(0.08, this.game.wave * 0.004)) {
      kind = 'tank';
    } else if (roll > 0.63) {
      kind = 'ranged';
    }

    const enemy = this.createEnemy(kind, lane);
    this.enemies.push(enemy);

    this.mechanicRuntime.dispatchEvent(
      'onEnemySpawn',
      {
        enemy: {
          id: enemy.id,
          lane: enemy.lane,
          kind: enemy.kind,
          hp: enemy.hp,
        },
        game: this.runtimeGameContext(),
      },
      (command) => this.applyRuntimeCommand(command)
    );
  }

  tryUnlockSpell() {
    if (this.game.wave === 3 && !this.game.unlocks.includes('frost')) {
      this.game.unlocks.push('frost');
      this.nowToast('Unlocked spell: frost');
    }

    if (this.game.wave === 6 && !this.game.unlocks.includes('bolt')) {
      this.game.unlocks.push('bolt');
      this.nowToast('Unlocked spell: bolt');
    }
  }

  updateCommander(dt) {
    let vx = 0;
    let vz = 0;
    if (this.input.w) vz -= 1;
    if (this.input.s) vz += 1;
    if (this.input.a) vx -= 1;
    if (this.input.d) vx += 1;

    const length = Math.hypot(vx, vz);
    if (length > 0) {
      const speed = this.commander.speed * dt;
      this.commander.x += (vx / length) * speed;
      this.commander.z += (vz / length) * speed;
    }

    this.commander.x = clamp(this.commander.x, -18, 18);
    this.commander.z = clamp(this.commander.z, COMMANDER_MIN_Z, COMMANDER_MAX_Z);
  }

  updateSpawning(dt) {
    const intensity = 1 + (this.game.wave - 1) * 0.05;
    const spawnEvery = Math.max(0.24, 1.18 / intensity);
    this.spawnTimer -= dt;

    if (this.spawnTimer <= 0) {
      this.spawnTimer = spawnEvery;
      this.spawnEnemy();
      if (Math.random() < Math.min(0.32, this.game.wave * 0.02)) {
        this.spawnEnemy();
      }
    }

    this.waveTimer += dt;
    if (this.waveTimer >= 24) {
      this.waveTimer = 0;
      this.game.wave += 1;
      this.nowToast(`Wave ${this.game.wave} begins`);
      this.tryUnlockSpell();

      this.mechanicRuntime.dispatchEvent(
        'onWaveStart',
        {
          wave: this.game.wave,
          game: this.runtimeGameContext(),
        },
        (command) => this.applyRuntimeCommand(command)
      );
    }
  }

  damageEnemy(enemy, amount) {
    if (!enemy || enemy.dead) return;
    enemy.hp -= amount;
    if (enemy.hp > 0) {
      enemy.hitTimer = 0.12;
      enemy.anim = 'hit';
    }
  }

  destroyEnemy(index, slain) {
    const enemy = this.enemies[index];
    if (!enemy || enemy.dead) return;

    enemy.dead = true;
    enemy.deathTimer = 0.45;
    enemy.hitTimer = 0;
    enemy.anim = 'die';

    if (slain) {
      const reward = Math.max(1, Math.round(KILL_GOLD_REWARD * this.getRuntimeGoldMultiplier()));
      this.game.score += enemy.worth;
      this.game.kills += 1;
      this.game.gold += reward;

      if (this.comboTimer > 0) {
        this.comboCount += 1;
      } else {
        this.comboCount = 1;
      }
      this.comboTimer = 0.5;

      const eventEnemy = {
        id: enemy.id,
        lane: enemy.lane,
        kind: enemy.kind,
      };

      this.mechanicRuntime.dispatchEvent(
        'onEnemyDeath',
        {
          enemy: eventEnemy,
          rewardGold: reward,
          game: this.runtimeGameContext(),
        },
        (command) => this.applyRuntimeCommand(command)
      );

      this.mechanicRuntime.dispatchEvent(
        'onKillCombo',
        {
          comboCount: this.comboCount,
          enemy: eventEnemy,
          game: this.runtimeGameContext(),
        },
        (command) => this.applyRuntimeCommand(command)
      );
    }
  }

  updateEnemies(dt) {
    for (let i = this.enemies.length - 1; i >= 0; i -= 1) {
      const enemy = this.enemies[i];

      if (enemy.dead) {
        enemy.deathTimer -= dt;
        if (enemy.deathTimer <= 0) {
          this.activeDots.delete(enemy.id);
          this.enemies.splice(i, 1);
        }
        continue;
      }

      if (enemy.frozenFor > 0) {
        enemy.frozenFor = Math.max(0, enemy.frozenFor - dt);
      }

      const dot = this.activeDots.get(enemy.id);
      if (dot) {
        this.damageEnemy(enemy, dot.dps * dt);
        dot.remainingSeconds -= dt;
        if (dot.remainingSeconds <= 0) {
          this.activeDots.delete(enemy.id);
        }
      }

      if (enemy.hitTimer > 0) {
        enemy.hitTimer = Math.max(0, enemy.hitTimer - dt);
      }

      const moveScale = enemy.frozenFor > 0 ? 0.15 : 1;

      let blocked = false;
      for (const wall of this.walls) {
        if (wall.lane !== enemy.lane) continue;
        const closeEnough = Math.abs(enemy.z - wall.z) < 1.65;
        if (closeEnough && enemy.z < wall.z + 0.6) {
          blocked = true;
          wall.hp -= enemy.damage * dt;
          break;
        }
      }

      if (!blocked) {
        enemy.z += enemy.speed * moveScale * dt;
      } else {
        enemy.atCastleWall = false;
        enemy.wallAttackAccumulatorSeconds = 0;
      }

      if (!blocked && enemy.z >= CASTLE_WALL_FRONT_Z - 0.35) {
        enemy.atCastleWall = true;
        enemy.z = CASTLE_WALL_FRONT_Z - 0.35;
      } else if (!blocked) {
        enemy.atCastleWall = false;
        enemy.wallAttackAccumulatorSeconds = 0;
      }

      if (enemy.atCastleWall) {
        enemy.wallAttackAccumulatorSeconds += dt * moveScale;
        while (enemy.wallAttackAccumulatorSeconds >= GOON_ATTACK_INTERVAL_SECONDS && this.game.baseHp > 0) {
          enemy.wallAttackAccumulatorSeconds -= GOON_ATTACK_INTERVAL_SECONDS;
          this.game.baseHp = Math.max(0, this.game.baseHp - GOON_ATTACK_DAMAGE);
        }
      }

      enemy.anim = enemy.hitTimer > 0 ? 'hit' : enemy.atCastleWall ? 'attack' : 'run';

      if (enemy.hp <= 0) {
        this.destroyEnemy(i, true);
      }
    }
  }

  updateWalls(dt) {
    for (let i = this.walls.length - 1; i >= 0; i -= 1) {
      const wall = this.walls[i];
      wall.duration -= dt;
      if (wall.duration <= 0 || wall.hp <= 0) {
        this.walls.splice(i, 1);
      }
    }
  }

  findEnemyById(id) {
    return this.enemies.find((enemy) => enemy.id === id && !enemy.dead) ?? null;
  }

  explodeProjectile(projectile) {
    const pointX = projectile.x;
    const pointZ = projectile.z;

    for (const enemy of this.enemies) {
      if (enemy.dead) continue;
      const dx = enemy.x - pointX;
      const dz = enemy.z - pointZ;
      const d = Math.hypot(dx, dz);
      if (d <= projectile.splash) {
        const falloff = 1 - d / projectile.splash;
        this.damageEnemy(enemy, projectile.damage * (0.4 + falloff * 0.6));
      }
    }

    this.projectiles.push({
      id: `proj_${this.projectileIdCounter++}`,
      kind: 'zap',
      x: pointX,
      y: 2.2,
      z: pointZ,
      life: 0.24,
    });
  }

  updateProjectiles(dt) {
    for (let i = this.projectiles.length - 1; i >= 0; i -= 1) {
      const projectile = this.projectiles[i];

      if (projectile.kind === 'zap') {
        projectile.life -= dt;
        if (projectile.life <= 0) {
          this.projectiles.splice(i, 1);
        }
        continue;
      }

      const target = this.findEnemyById(projectile.targetId);
      if (!target) {
        this.projectiles.splice(i, 1);
        continue;
      }

      const tx = target.x;
      const tz = target.z;
      const dx = tx - projectile.x;
      const dz = tz - projectile.z;
      const distanceSq = dx * dx + dz * dz;
      const step = projectile.speed * dt;

      if (distanceSq <= step * step) {
        projectile.x = tx;
        projectile.z = tz;
        this.explodeProjectile(projectile);
        this.projectiles.splice(i, 1);
        continue;
      }

      const distance = Math.sqrt(distanceSq);
      projectile.x += (dx / distance) * step;
      projectile.z += (dz / distance) * step;
    }
  }

  getRuntimeGoldMultiplier() {
    let total = 1;
    for (const entry of this.runtimeGoldMultipliers.values()) {
      const multiplier = Number(entry?.multiplier);
      if (Number.isFinite(multiplier) && multiplier > 0) {
        total *= multiplier;
      }
    }
    return total;
  }

  tickRuntimeMultipliers(dt) {
    for (const [key, entry] of this.runtimeGoldMultipliers.entries()) {
      if (!Number.isFinite(entry.remainingSeconds)) continue;
      entry.remainingSeconds -= dt;
      if (entry.remainingSeconds <= 0) {
        this.runtimeGoldMultipliers.delete(key);
      }
    }
  }

  applyDotToEnemy(enemyId, dps, durationSeconds) {
    const enemy = this.findEnemyById(enemyId);
    if (!enemy) return false;

    const current = this.activeDots.get(enemyId);
    if (!current) {
      this.activeDots.set(enemyId, {
        dps,
        remainingSeconds: durationSeconds,
      });
      return true;
    }

    current.dps = Math.max(current.dps, dps);
    current.remainingSeconds = Math.max(current.remainingSeconds, durationSeconds);
    return true;
  }

  spreadDotFromSource(sourceId, radius, maxTargets) {
    const source = this.findEnemyById(sourceId);
    const sourceDot = this.activeDots.get(sourceId);
    if (!source || !sourceDot) return 0;

    const targets = this.enemies
      .filter((enemy) => !enemy.dead && enemy.id !== sourceId)
      .map((enemy) => ({
        enemy,
        dist: Math.hypot(enemy.x - source.x, enemy.z - source.z),
      }))
      .filter((entry) => entry.dist <= radius)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, maxTargets);

    let applied = 0;
    for (const target of targets) {
      const ok = this.applyDotToEnemy(
        target.enemy.id,
        Math.max(0.1, sourceDot.dps * 0.8),
        Math.max(0.1, sourceDot.remainingSeconds * 0.8)
      );
      if (ok) applied += 1;
    }

    return applied;
  }

  applyRuntimeCommand(command) {
    if (!command || typeof command !== 'object') return;

    if (command.type === 'actions.castSpell') {
      const spellName = String(command.payload?.spellName ?? '').trim().toLowerCase();
      if (spellName) {
        this.castSpellByName(spellName, {
          enforceCosts: false,
          allowLocked: true,
          showToast: false,
        });
      }
      return;
    }

    if (command.type === 'economy.addGold') {
      const amount = Number(command.payload?.amount);
      if (Number.isFinite(amount) && amount > 0) {
        this.game.gold += amount;
      }
      return;
    }

    if (command.type === 'economy.addMultiplier') {
      const key = String(command.payload?.key ?? '').trim();
      const multiplier = Number(command.payload?.multiplier);
      if (key && Number.isFinite(multiplier) && multiplier > 0) {
        this.runtimeGoldMultipliers.set(key, {
          multiplier,
          remainingSeconds: Number(command.payload?.durationSeconds),
        });
      }
      return;
    }

    if (command.type === 'combat.dealDamage') {
      const targetId = String(command.payload?.targetId ?? '').trim();
      const amount = Number(command.payload?.amount);
      if (targetId && Number.isFinite(amount) && amount > 0) {
        const enemy = this.findEnemyById(targetId);
        if (enemy) this.damageEnemy(enemy, amount);
      }
      return;
    }

    if (command.type === 'combat.applyDot') {
      const targetId = String(command.payload?.targetId ?? '').trim();
      const dps = Number(command.payload?.dps);
      const durationSeconds = Number(command.payload?.durationSeconds);
      if (targetId && Number.isFinite(dps) && dps > 0 && Number.isFinite(durationSeconds) && durationSeconds > 0) {
        this.applyDotToEnemy(targetId, dps, durationSeconds);
      }
      return;
    }

    if (command.type === 'combat.chainSpread') {
      const sourceId = String(command.payload?.sourceId ?? '').trim();
      const radius = Number(command.payload?.radius);
      const maxTargets = Number(command.payload?.maxTargets);
      if (sourceId && Number.isFinite(radius) && radius > 0 && Number.isFinite(maxTargets) && maxTargets > 0) {
        this.spreadDotFromSource(sourceId, radius, Math.floor(maxTargets));
      }
      return;
    }
  }

  updateResources(dt) {
    this.game.mana = clamp(this.game.mana + this.game.manaRegen * dt, 0, this.game.maxMana);

    this.tickRuntimeMultipliers(dt);
    this.comboTimer = Math.max(0, this.comboTimer - dt);
    if (this.comboTimer === 0) this.comboCount = 0;
  }

  tick(dt = TICK_DT) {
    if (this.game.gameOver) return;

    this.game.elapsed += dt;

    this.updateCommander(dt);
    this.updateSpawning(dt);
    this.updateResources(dt);
    this.updateWalls(dt);
    this.updateZones(dt);
    this.updateEnemies(dt);
    this.updateProjectiles(dt);

    this.mechanicRuntime.tick(
      dt,
      {
        game: this.runtimeGameContext(),
      },
      (command) => this.applyRuntimeCommand(command)
    );

    if (this.game.baseHp <= 0) {
      this.game.baseHp = 0;
      this.game.gameOver = true;
      this.nowToast(`Base destroyed. Final score ${this.game.score}. Press Reset.`);
    }

    this.snapshotVersion += 1;
  }

  async castPrompt(prompt) {
    const rawPrompt = String(prompt ?? '').trim();
    if (!rawPrompt) {
      return { ok: false, message: 'Empty spell prompt' };
    }

    const parsed = this.parseSpell(rawPrompt);
    if (parsed) {
      const ok = this.castSpellByName(parsed, {
        enforceCosts: true,
        allowLocked: false,
        showToast: true,
      });
      return {
        ok,
        message: this.lastToast?.message ?? null,
        source: 'local',
      };
    }

    try {
      const result = await handleSpellGenerate(
        {
          prompt: rawPrompt,
          wave: this.game.wave,
          mana: this.game.mana,
          unlocks: this.game.unlocks,
          nearbyEnemies: this.enemies
            .filter((enemy) => !enemy.dead)
            .slice(0, 24)
            .map((enemy) => ({
              lane: enemy.lane,
              kind: enemy.kind,
              hp: enemy.hp,
              z: enemy.z,
            })),
        },
        { requestId: `game_${Date.now()}` }
      );

      const spell = result?.payload?.spell;
      const casted = this.castGeneratedSpell(spell);
      if (casted) {
        if (result?.payload?.source === 'fallback') {
          const reason = result?.payload?.meta?.fallbackReason;
          this.nowToast(reason ? `Fallback cast (${reason})` : 'Fallback cast');
        } else {
          const effects = Array.isArray(spell?.effects) ? spell.effects.join('+') : 'none';
          this.nowToast(`LLM: ${spell?.archetype || 'spell'}/${effects || 'none'}`);
        }
        return {
          ok: true,
          message: this.lastToast.message,
          source: result?.payload?.source || 'llm',
        };
      }

      this.nowToast('Unable to cast generated spell');
      return { ok: false, message: this.lastToast.message, source: 'llm' };
    } catch (error) {
      this.nowToast('Spell generation failed');
      return {
        ok: false,
        message: this.lastToast.message,
        source: 'error',
        error: error instanceof Error ? error.message : 'unknown error',
      };
    }
  }

  castGeneratedSpell(spell) {
    if (!spell || typeof spell !== 'object') return false;
    const cost = Number(spell?.cost?.mana);

    if (!Number.isFinite(cost) || cost <= 0 || this.game.mana < cost) {
      this.nowToast('Not enough mana');
      return false;
    }

    const archetype = String(spell.archetype || 'projectile');
    const numbers = spell.numbers || {};
    const effects = Array.isArray(spell.effects) ? spell.effects : [];

    let casted = false;

    if (archetype === 'chain') {
      const targets = this.enemies
        .filter((enemy) => !enemy.dead)
        .sort((a, b) => b.z - a.z)
        .slice(0, Math.max(1, Math.floor(numbers.chainCount || 3)));
      for (const enemy of targets) {
        this.projectiles.push({
          id: `proj_${this.projectileIdCounter++}`,
          kind: 'zap',
          x: enemy.x,
          y: 2.5,
          z: enemy.z,
          life: 0.2,
        });
        this.damageEnemy(enemy, Number(numbers.damage) || 20);
      }
      casted = targets.length > 0;
    } else if (archetype === 'zone_control') {
      const lane = this.lanePressure()[0]?.lane ?? 2;
      const radius = clamp(Number(numbers.radius) || 2, 1, 8);
      this.zones.push({
        id: `zone_${this.zoneIdCounter++}`,
        kind: 'circle',
        laneMin: Math.max(0, lane - Math.floor((Number(numbers.laneSpan) || 1) / 2)),
        laneMax: Math.min(LANE_COUNT - 1, lane + Math.floor((Number(numbers.laneSpan) || 1) / 2)),
        z: Math.max(BASE_Z - 30, Math.min(BASE_Z - 8, this.commander.z - 10)),
        radius,
        duration: clamp(Number(numbers.durationSec) || 3, 0.2, 10),
        timer: 0,
        tickRate: clamp(Number(numbers.tickRate) || 0.8, 0.1, 3),
        damage: clamp(Number(numbers.damage) || 16, 1, 200),
        effects,
      });
      casted = true;
    } else {
      const target = this.nearestEnemy();
      if (!target) {
        this.nowToast('No target for spell');
        return false;
      }
      this.projectiles.push({
        id: `proj_${this.projectileIdCounter++}`,
        kind: 'fireball',
        x: this.commander.x,
        y: 1.8,
        z: this.commander.z - 0.5,
        targetId: target.id,
        speed: clamp(Number(numbers.speed) || 28, 8, 60),
        damage: clamp(Number(numbers.damage) || 24, 1, 200),
        splash: clamp(Number(numbers.radius) || 2.2, 0.4, 12),
        effects,
        intensity: clamp(Number(spell?.vfx?.intensity) || 0.8, 0.2, 1.4),
      });
      casted = true;
    }

    if (!casted) {
      return false;
    }

    this.game.mana -= cost;
    return true;
  }

  updateZones(dt) {
    for (let i = this.zones.length - 1; i >= 0; i -= 1) {
      const zone = this.zones[i];
      zone.duration -= dt;
      zone.timer += dt;

      while (zone.timer >= zone.tickRate) {
        zone.timer -= zone.tickRate;
        for (const enemy of this.enemies) {
          if (enemy.dead) continue;
          const inLane = enemy.lane >= zone.laneMin && enemy.lane <= zone.laneMax;
          const inDepth = Math.abs(enemy.z - zone.z) <= zone.radius;
          if (!inLane || !inDepth) continue;
          this.damageEnemy(enemy, zone.damage * zone.tickRate);
          for (const effect of zone.effects) {
            if (effect === 'freeze') {
              enemy.frozenFor = Math.max(enemy.frozenFor, 0.8);
            }
          }
        }
      }

      if (zone.duration <= 0) {
        this.zones.splice(i, 1);
      }
    }
  }

  async applyArtifact({ envelope, templateVersion, artifact }) {
    const estimatedGoldCost = Number(envelope?.estimatedGoldCost);
    const reservationId = this.goldReservations.reserveGold(estimatedGoldCost);
    if (!reservationId) {
      throw new Error('insufficient gold for artifact apply');
    }

    try {
      const result = await runAgenticApplyWorkflow({
        artifact,
        envelope,
        templateVersion,
        primitiveRegistry: this.primitiveRegistry,
        mechanicRuntime: this.mechanicRuntime,
        sandboxStateStore: this.sandboxStateStore,
        generateAssets: async () => ({ jobs: [], assets: [] }),
        resetToBaseline: async () => {
          this.mechanicRuntime.clear();
          await this.sandboxStateStore.reset();
        },
        logger: console,
      });
      this.goldReservations.commitReservedGold(reservationId);
      return {
        generatedAssets: result.assets.length,
        activatedMechanics: result.activatedMechanics,
      };
    } catch (error) {
      this.goldReservations.refundReservedGold(reservationId);
      throw error;
    }
  }

  snapshot() {
    return {
      version: this.snapshotVersion,
      ts: Date.now(),
      game: {
        ...this.game,
      },
      commander: {
        x: this.commander.x,
        z: this.commander.z,
      },
      reservedGold: this.goldReservations.getReservedGold(),
      enemies: this.enemies.slice(0, MAX_SNAPSHOT_ENEMIES).map((enemy) => ({
        id: enemy.id,
        lane: enemy.lane,
        kind: enemy.kind,
        hp: enemy.hp,
        maxHp: enemy.maxHp,
        x: enemy.x,
        z: enemy.z,
        frozenFor: enemy.frozenFor,
        dead: enemy.dead,
        anim: enemy.anim,
      })),
      walls: this.walls.map((wall) => ({
        id: wall.id,
        lane: wall.lane,
        hp: wall.hp,
        maxHp: wall.maxHp,
        duration: wall.duration,
        x: wall.x,
        z: wall.z,
      })),
      projectiles: this.projectiles.slice(0, MAX_SNAPSHOT_PROJECTILES).map((projectile) => ({
        id: projectile.id,
        kind: projectile.kind,
        x: projectile.x,
        y: projectile.y,
        z: projectile.z,
        life: projectile.life ?? null,
      })),
      zones: this.zones.map((zone) => ({
        id: zone.id,
        kind: zone.kind,
        laneMin: zone.laneMin,
        laneMax: zone.laneMax,
        z: zone.z,
        radius: zone.radius,
        duration: zone.duration,
      })),
      latestToast: this.lastToast,
    };
  }
}

export function createServerGameSession() {
  const session = new ServerGameSession();
  session.start();
  return session;
}
