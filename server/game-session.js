import { createInitialGameState, BASE_Z, CASTLE_WALL_FRONT_Z, COMMANDER_MIN_Z, COMMANDER_MAX_Z, GOON_ATTACK_DAMAGE, GOON_ATTACK_INTERVAL_SECONDS, KILL_GOLD_REWARD, LANE_COUNT, LANE_SPACING, START_Z } from '../src/game/config.js';
import { runAgenticApplyWorkflow } from './runtime/agenticApplyWorkflow.js';
import { deriveGlbAssetJobs } from './runtime/assets/glbAssetAgent.js';
import { MechanicRuntime } from './runtime/mechanicRuntime.js';
import { InMemorySandboxStateStore } from './runtime/persistence/sandboxStateStore.js';
import { createDefaultPrimitiveRegistry } from './runtime/primitives/primitiveRegistry.js';
import { handleSpellGenerate } from './spell-api.js';

const TICK_HZ = 30;
const TICK_DT = 1 / TICK_HZ;
const MAX_SNAPSHOT_ENEMIES = 256;
const MAX_SNAPSHOT_PROJECTILES = 128;
const MAX_WALLS = 12;
const SERVER_GLB_ASSET_ENDPOINT = process.env.GLB_ASSET_ENDPOINT || 'http://127.0.0.1:5173/api/assets/generate-glb';

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

function normalizeToken(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function colorFromText(value, fallback = '#8ab4ff') {
  const text = String(value ?? '').trim();
  if (!text) {
    return fallback;
  }
  if (/^#[0-9a-f]{6}$/i.test(text)) {
    return text.toLowerCase();
  }
  const aliases = {
    fire: '#ff8840',
    ice: '#98d8ff',
    storm: '#a8eeff',
    earth: '#96ac75',
    arcane: '#c59dff',
    poison: '#68be72',
  };
  return aliases[text.toLowerCase()] || fallback;
}

function normalizeGeneratedAssets(payloadAssets) {
  if (!Array.isArray(payloadAssets)) {
    return [];
  }

  return payloadAssets
    .map((asset) => ({
      id: String(asset?.id ?? asset?.assetId ?? '').trim(),
      name: String(asset?.name ?? '').trim(),
      kind: 'glb',
      path: String(asset?.path ?? '').trim(),
      sourceType: String(asset?.sourceType ?? '').trim(),
      sourceId: String(asset?.sourceId ?? '').trim(),
      generatedAt: String(asset?.generatedAt ?? '').trim(),
      model: String(asset?.model ?? '').trim(),
    }))
    .filter((asset) => asset.id && asset.path);
}

async function generateServerGlbAssetsForArtifact({ envelope, artifact }) {
  const jobs = deriveGlbAssetJobs(artifact);
  if (jobs.length === 0) {
    return { jobs: [], assets: [] };
  }

  const response = await fetch(SERVER_GLB_ASSET_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      promptId: envelope?.id ?? '',
      prompt: envelope?.rawPrompt ?? '',
      jobs,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GLB generation failed (${response.status}): ${errorText.slice(0, 320)}`);
  }

  const payload = await response.json();
  return {
    jobs,
    assets: normalizeGeneratedAssets(payload?.assets),
  };
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
    this.units = [];
    this.walls = [];
    this.projectiles = [];
    this.zones = [];
    this.actionVisuals = [];
    this.runtimeGoldMultipliers = new Map();
    this.activeDots = new Map();
    this.spellCooldowns = new Map();
    this.lastTickAt = Date.now();
    this.spawnTimer = 0;
    this.waveTimer = 0;
    this.comboCount = 0;
    this.comboTimer = 0;
    this.enemyIdCounter = 1;
    this.unitIdCounter = 1;
    this.wallIdCounter = 1;
    this.projectileIdCounter = 1;
    this.zoneIdCounter = 1;
    this.actionVisualIdCounter = 1;
    this.lastToast = null;
    this.snapshotVersion = 0;

    this.mechanicRuntime = new MechanicRuntime();
    this.primitiveRegistry = createDefaultPrimitiveRegistry();
    this.sandboxStateStore = new InMemorySandboxStateStore();
    this.goldReservations = createReservationStore(this.game);
    this.generatedUnitDefs = new Map();
    this.generatedActionDefs = new Map();
    this.generatedActionState = new Map();
    this.generatedAssets = [];
    this.mountedWidgets = new Map();

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

  syncGeneratedCatalogs(artifact, generatedAssets) {
    const patch = artifact?.sandboxPatch ?? {};
    const units = Array.isArray(patch.units) ? patch.units : [];
    const actions = Array.isArray(patch.actions) ? patch.actions : [];

    this.generatedUnitDefs.clear();
    this.generatedActionDefs.clear();
    this.generatedActionState.clear();
    this.generatedAssets = Array.isArray(generatedAssets) ? generatedAssets : [];

    for (const unit of units) {
      const key = normalizeToken(unit?.id || unit?.name);
      if (!key) continue;
      this.generatedUnitDefs.set(key, unit);
    }

    for (const action of actions) {
      const key = normalizeToken(action?.id || action?.name);
      if (!key) continue;
      this.generatedActionDefs.set(key, action);
      this.generatedActionState.set(key, {
        cooldownLeft: 0,
      });
    }
  }

  resolveAssetPath(sourceType, sourceId) {
    const typeToken = normalizeToken(sourceType);
    const idToken = normalizeToken(sourceId);
    if (!typeToken || !idToken) {
      return '';
    }
    const found = this.generatedAssets.find(
      (asset) => normalizeToken(asset?.sourceType) === typeToken && normalizeToken(asset?.sourceId) === idToken
    );
    return String(found?.path ?? '');
  }

  findGeneratedUnit(unitKind) {
    const token = normalizeToken(unitKind);
    if (!token) {
      return null;
    }
    return this.generatedUnitDefs.get(token) ?? null;
  }

  findGeneratedAction(actionName) {
    const token = normalizeToken(actionName);
    if (!token) {
      return null;
    }
    return this.generatedActionDefs.get(token) ?? null;
  }

  resolveGeneratedAction(actionName) {
    const token = normalizeToken(actionName);
    if (!token) {
      return null;
    }
    if (this.generatedActionDefs.has(token)) {
      return this.generatedActionDefs.get(token);
    }

    for (const [key, action] of this.generatedActionDefs.entries()) {
      if (key.includes(token) || token.includes(key)) {
        return action;
      }
      const actionNameToken = normalizeToken(action?.name);
      if (actionNameToken && (actionNameToken.includes(token) || token.includes(actionNameToken))) {
        return action;
      }
    }

    return null;
  }

  inferElementFromText(...parts) {
    const text = parts
      .map((value) => String(value ?? '').toLowerCase())
      .join(' ')
      .trim();
    if (text.includes('fire') || text.includes('burn') || text.includes('ember')) return 'fire';
    if (text.includes('ice') || text.includes('frost') || text.includes('freeze')) return 'ice';
    if (text.includes('storm') || text.includes('lightning') || text.includes('thunder')) return 'storm';
    if (text.includes('earth') || text.includes('stone')) return 'earth';
    return 'arcane';
  }

  parseActionIntervalSeconds(trigger) {
    const normalized = String(trigger ?? '').toLowerCase();
    const match = normalized.match(/every\s+(\d+(\.\d+)?)\s*(s|sec|secs|second|seconds)\b/);
    if (match) {
      const seconds = Number(match[1]);
      if (Number.isFinite(seconds) && seconds > 0) {
        return clamp(seconds, 0.1, 20);
      }
    }
    if (normalized.includes('every tick') || normalized.includes('continuous')) return 0.6;
    if (normalized.includes('on tick')) return 0.8;
    if (normalized.includes('wave')) return 8;
    if (normalized.includes('spawn')) return 1.2;
    return 1.5;
  }

  actionRunsOnEvent(action, eventName) {
    const trigger = String(action?.trigger ?? '').toLowerCase();
    if (eventName === 'onWaveStart') {
      return trigger.includes('wave');
    }
    if (eventName === 'onEnemySpawn') {
      return trigger.includes('spawn');
    }
    if (eventName === 'onTick') {
      if (trigger.includes('wave') || trigger.includes('spawn')) return false;
      return true;
    }
    return false;
  }

  reset(reason = 'manual') {
    this.mechanicRuntime.clear();
    void this.sandboxStateStore.reset();
    this.game = createInitialGameState();
    this.commander.x = 0;
    this.commander.z = BASE_Z - 5;
    this.input = { w: false, a: false, s: false, d: false };
    this.enemies = [];
    this.units = [];
    this.walls = [];
    this.projectiles = [];
    this.zones = [];
    this.actionVisuals = [];
    this.runtimeGoldMultipliers.clear();
    this.activeDots.clear();
    this.spellCooldowns.clear();
    this.spawnTimer = 0;
    this.waveTimer = 0;
    this.comboCount = 0;
    this.comboTimer = 0;
    this.enemyIdCounter = 1;
    this.unitIdCounter = 1;
    this.wallIdCounter = 1;
    this.projectileIdCounter = 1;
    this.zoneIdCounter = 1;
    this.actionVisualIdCounter = 1;
    this.generatedUnitDefs.clear();
    this.generatedActionDefs.clear();
    this.generatedActionState.clear();
    this.generatedAssets = [];
    this.mountedWidgets.clear();
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
    const { enforceCosts = true, showToast = true } = options;
    const spell = this.spells[spellName];
    if (!spell) {
      if (showToast) this.nowToast(`No spell match for "${spellName}"`);
      return false;
    }

    if (enforceCosts && this.game.globalCooldown > 0) {
      if (showToast) this.nowToast('Global cooldown active');
      return false;
    }

    const cooldown = this.spellCooldowns.get(spellName) || 0;
    if (enforceCosts && cooldown > 0) {
      if (showToast) this.nowToast(`${spellName} cooldown ${cooldown.toFixed(1)}s`);
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
      blocked: false,
      attackAccumulatorSeconds: 0,
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
    this.runGeneratedActions('onEnemySpawn');
  }

  spawnGeneratedUnit(unitKind, laneCandidate) {
    const definition = this.findGeneratedUnit(unitKind);
    const fallbackRole = String(unitKind ?? '').trim() || 'support';
    const role = String(definition?.role ?? fallbackRole).trim() || 'support';
    const behavior = String(definition?.behavior ?? 'hold_position').trim() || 'hold_position';
    const fallbackShape = String(definition?.visual?.fallbackShape ?? 'capsule');
    const tint = colorFromText(definition?.visual?.tint, '#8ab4ff');
    const scale = clamp(Number(definition?.visual?.scale ?? 1), 0.2, 4);
    const sourceId = String(definition?.id ?? unitKind ?? `unit_${this.unitIdCounter}`);
    const lane = Number.isInteger(laneCandidate)
      ? clamp(laneCandidate, 0, LANE_COUNT - 1)
      : clamp(this.lanePressure()[0]?.lane ?? 2, 0, LANE_COUNT - 1);

    this.units.push({
      id: `unit_${this.unitIdCounter++}`,
      kind: normalizeToken(unitKind) || normalizeToken(sourceId) || 'generated_unit',
      sourceId,
      lane,
      role,
      behavior,
      x: laneX(lane),
      z: CASTLE_WALL_FRONT_Z - 5 - Math.random() * 4,
      hp: 100,
      maxHp: 100,
      fallbackShape,
      tint,
      scale,
      assetPath: this.resolveAssetPath('unit', sourceId),
      attackCooldown: 0,
    });
  }

  spawnActionVisual(actionName) {
    const action = this.findGeneratedAction(actionName);
    const sourceId = String(action?.id ?? actionName ?? '');
    const shape = String(action?.visual?.vfxShape ?? 'ring');
    const durationMs = clamp(Number(action?.visual?.durationMs ?? 650), 100, 12_000);

    this.actionVisuals.push({
      id: `action_vfx_${this.actionVisualIdCounter++}`,
      actionName: String(actionName ?? '').trim().toLowerCase(),
      sourceId,
      kind: shape === 'wave' ? 'wave' : shape === 'orb' ? 'orb' : 'ring',
      x: this.commander.x,
      z: this.commander.z - 4.5,
      radius: 1.5,
      duration: durationMs / 1000,
      baseDuration: durationMs / 1000,
      color: colorFromText(action?.visual?.color, '#ff9f59'),
      assetPath: this.resolveAssetPath('action', sourceId),
    });
  }

  executeGeneratedAction(action, eventName = 'onTick') {
    if (!action) return false;

    const actionId = normalizeToken(action.id || action.name);
    const sourceId = String(action.id ?? action.name ?? actionId ?? '');
    const actionText = `${action.name || ''} ${action.effect || ''}`.toLowerCase();
    const element = this.inferElementFromText(action.name, action.effect);
    const lane = this.lanePressure()[0]?.lane ?? 2;
    const focusEnemy = this.enemies
      .filter((enemy) => !enemy.dead)
      .sort((a, b) => b.z - a.z)[0];
    const z = focusEnemy ? focusEnemy.z : Math.max(BASE_Z - 28, Math.min(BASE_Z - 9, this.commander.z - 8));

    if (actionText.includes('wall')) {
      if (this.walls.length < MAX_WALLS) {
        this.walls.push({
          id: `wall_${this.wallIdCounter++}`,
          lane,
          x: laneX(lane),
          z,
          hp: 130,
          maxHp: 130,
          duration: 6,
        });
      }
      this.zones.push({
        id: `zone_${this.zoneIdCounter++}`,
        kind: 'generated_wall_aura',
        laneMin: lane,
        laneMax: lane,
        z,
        radius: 2.4,
        duration: 6,
        timer: 0,
        tickRate: 0.5,
        damage: actionText.includes('fire') || actionText.includes('burn') ? 18 : 12,
        effects: actionText.includes('freeze') ? ['freeze'] : ['burn'],
      });
    } else if (actionText.includes('storm') || actionText.includes('lightning') || actionText.includes('chain')) {
      const targets = this.enemies
        .filter((enemy) => !enemy.dead)
        .sort((a, b) => b.z - a.z)
        .slice(0, 4);
      for (const enemy of targets) {
        this.projectiles.push({
          id: `proj_${this.projectileIdCounter++}`,
          kind: 'zap',
          x: enemy.x,
          y: 2.5,
          z: enemy.z,
          life: 0.2,
        });
        this.damageEnemy(enemy, 20);
      }
    } else {
      this.zones.push({
        id: `zone_${this.zoneIdCounter++}`,
        kind: 'generated_action_zone',
        laneMin: Math.max(0, lane - 1),
        laneMax: Math.min(LANE_COUNT - 1, lane + 1),
        z,
        radius: actionText.includes('burst') || actionText.includes('nova') ? 4 : 3,
        duration: 2.4,
        timer: 0,
        tickRate: 0.4,
        damage: 14,
        effects: actionText.includes('freeze') ? ['freeze'] : actionText.includes('burn') ? ['burn'] : [],
      });
    }

    this.actionVisuals.push({
      id: `action_vfx_${this.actionVisualIdCounter++}`,
      actionName: String(action.name ?? actionId ?? '').trim().toLowerCase(),
      sourceId,
      kind: actionText.includes('wave') || actionText.includes('wall') ? 'wave' : actionText.includes('orb') ? 'orb' : 'ring',
      x: laneX(lane),
      z,
      radius: 1.5,
      duration: 1.2,
      baseDuration: 1.2,
      color: colorFromText(action.visual?.color, colorFromText(element, '#ff9f59')),
      assetPath: this.resolveAssetPath('action', sourceId),
    });

    const state = this.generatedActionState.get(actionId) ?? { cooldownLeft: 0 };
    state.cooldownLeft = this.parseActionIntervalSeconds(action.trigger);
    this.generatedActionState.set(actionId, state);

    return true;
  }

  updateGeneratedActionStates(dt) {
    for (const state of this.generatedActionState.values()) {
      state.cooldownLeft = Math.max(0, Number(state.cooldownLeft || 0) - dt);
    }
  }

  runGeneratedActions(eventName = 'onTick') {
    for (const [key, action] of this.generatedActionDefs.entries()) {
      if (!this.actionRunsOnEvent(action, eventName)) {
        continue;
      }
      const state = this.generatedActionState.get(key) ?? { cooldownLeft: 0 };
      if (state.cooldownLeft > 0) {
        continue;
      }
      this.executeGeneratedAction(action, eventName);
    }
  }

  seedGeneratedStageEntities() {
    for (const action of this.generatedActionDefs.values()) {
      const trigger = String(action?.trigger ?? '').toLowerCase();
      if (trigger.includes('wave') || trigger.includes('spawn')) {
        continue;
      }
      this.executeGeneratedAction(action, 'onTick');
    }

    for (const unit of this.generatedUnitDefs.values()) {
      if (this.units.some((entry) => normalizeToken(entry.sourceId) === normalizeToken(unit.id))) {
        continue;
      }
      this.spawnGeneratedUnit(unit.id || unit.name, null);
    }
  }

  mountWidgetsFromArtifact(artifact) {
    const uiItems = Array.isArray(artifact?.sandboxPatch?.ui) ? artifact.sandboxPatch.ui : [];
    for (const item of uiItems) {
      const id = String(item?.id ?? '').trim();
      if (!id) continue;
      this.mountedWidgets.set(id, {
        id,
        title: String(item?.title ?? ''),
        content: String(item?.content ?? ''),
        position: String(item?.position ?? 'top-right'),
      });
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

      this.mechanicRuntime.dispatchEvent(
        'onWaveStart',
        {
          wave: this.game.wave,
          game: this.runtimeGameContext(),
        },
        (command) => this.applyRuntimeCommand(command)
      );
      this.runGeneratedActions('onWaveStart');
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
      let blockTarget = null;

      for (const wall of this.walls) {
        if (wall.lane !== enemy.lane) continue;
        const closeEnough = Math.abs(enemy.z - wall.z) < 1.65;
        if (closeEnough && enemy.z < wall.z + 0.6) {
          blocked = true;
          blockTarget = wall;
          break;
        }
      }

      if (!blocked) {
        for (const unit of this.units) {
          if (unit.hp <= 0) continue;
          if (unit.lane !== enemy.lane) continue;
          const closeEnough = Math.abs(enemy.z - unit.z) < 1.65;
          if (closeEnough && enemy.z < unit.z + 0.6) {
            blocked = true;
            blockTarget = unit;
            break;
          }
        }
      }

      if (!blocked) {
        enemy.z += enemy.speed * moveScale * dt;
        enemy.blocked = false;
      } else {
        enemy.blocked = true;
        enemy.atCastleWall = false;
      }

      if (!blocked && enemy.z >= CASTLE_WALL_FRONT_Z - 0.35) {
        enemy.atCastleWall = true;
        enemy.z = CASTLE_WALL_FRONT_Z - 0.35;
      } else if (!blocked) {
        enemy.atCastleWall = false;
      }

      // Attack whatever is blocking: wall, unit, or castle
      if (blocked || enemy.atCastleWall) {
        enemy.attackAccumulatorSeconds += dt * moveScale;
        while (enemy.attackAccumulatorSeconds >= GOON_ATTACK_INTERVAL_SECONDS) {
          enemy.attackAccumulatorSeconds -= GOON_ATTACK_INTERVAL_SECONDS;
          if (enemy.atCastleWall && this.game.baseHp > 0) {
            this.game.baseHp = Math.max(0, this.game.baseHp - GOON_ATTACK_DAMAGE);
          } else if (blockTarget) {
            blockTarget.hp -= enemy.damage;
          }
        }
      } else {
        enemy.attackAccumulatorSeconds = 0;
      }

      enemy.anim = enemy.hitTimer > 0 ? 'hit' : (enemy.atCastleWall || enemy.blocked) ? 'attack' : 'run';

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

  updateUnits(dt) {
    for (let i = this.units.length - 1; i >= 0; i -= 1) {
      const unit = this.units[i];
      if (unit.hp <= 0) {
        this.units.splice(i, 1);
        continue;
      }
      unit.attackCooldown = Math.max(0, Number(unit.attackCooldown || 0) - dt);
      const target = this.enemies.find((enemy) => !enemy.dead && enemy.lane === unit.lane);
      if (!target || unit.attackCooldown > 0) {
        continue;
      }
      this.damageEnemy(target, 7);
      unit.attackCooldown = 0.75;
      this.projectiles.push({
        id: `proj_${this.projectileIdCounter++}`,
        kind: 'zap',
        x: unit.x,
        y: 2.1,
        z: unit.z,
        targetX: target.x,
        targetZ: target.z,
        life: 0.45,
      });
    }
  }

  updateActionVisuals(dt) {
    for (let i = this.actionVisuals.length - 1; i >= 0; i -= 1) {
      const visual = this.actionVisuals[i];
      visual.duration -= dt;
      const progress = 1 - clamp(visual.duration / Math.max(0.001, visual.baseDuration), 0, 1);
      visual.radius = 1.5 + progress * (visual.kind === 'wave' ? 8.5 : visual.kind === 'orb' ? 2.2 : 4.8);
      if (visual.duration <= 0) {
        this.actionVisuals.splice(i, 1);
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
      if (ok) {
        applied += 1;
        this.projectiles.push({
          id: `proj_${this.projectileIdCounter++}`,
          kind: 'zap',
          x: (source.x + target.enemy.x) * 0.5,
          y: 2.2,
          z: (source.z + target.enemy.z) * 0.5,
          life: 0.3,
        });
      }
    }

    return applied;
  }

  applyRuntimeCommand(command) {
    if (!command || typeof command !== 'object') return;

    if (command.type === 'actions.castSpell') {
      const rawSpellName = String(command.payload?.spellName ?? '').trim().toLowerCase();
      if (rawSpellName) {
        const generated = this.resolveGeneratedAction(rawSpellName);
        if (generated) {
          this.executeGeneratedAction(generated, 'onTick');
        } else {
          const resolvedSpellName = this.spells[rawSpellName] ? rawSpellName : this.parseSpell(rawSpellName);
          if (resolvedSpellName) {
            this.castSpellByName(resolvedSpellName, {
              enforceCosts: false,
              showToast: false,
            });
            this.spawnActionVisual(rawSpellName);
          } else {
            this.spawnActionVisual(rawSpellName);
          }
        }
      }
      return;
    }

    if (command.type === 'units.spawn') {
      const unitKind = String(command.payload?.unitKind ?? '').trim();
      if (unitKind) {
        this.spawnGeneratedUnit(unitKind, command.payload?.lane);
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
        if (enemy) {
          this.damageEnemy(enemy, amount);
          this.projectiles.push({
            id: `proj_${this.projectileIdCounter++}`,
            kind: 'zap',
            x: enemy.x,
            y: 2.5,
            z: enemy.z,
            life: 0.35,
          });
        }
      }
      return;
    }

    if (command.type === 'combat.applyDot') {
      const targetId = String(command.payload?.targetId ?? '').trim();
      const dps = Number(command.payload?.dps);
      const durationSeconds = Number(command.payload?.durationSeconds);
      if (targetId && Number.isFinite(dps) && dps > 0 && Number.isFinite(durationSeconds) && durationSeconds > 0) {
        this.applyDotToEnemy(targetId, dps, durationSeconds);
        const enemy = this.findEnemyById(targetId);
        if (enemy) {
          this.projectiles.push({
            id: `proj_${this.projectileIdCounter++}`,
            kind: 'fireball',
            x: this.commander.x,
            y: 1.8,
            z: this.commander.z - 0.5,
            targetId,
            speed: 38,
            damage: 0,
            splash: 0,
            effects: [],
            intensity: 0.6,
          });
        }
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

    if (command.type === 'ui.mountWidget') {
      const props = command.payload?.props;
      const id = String(props?.id ?? '').trim();
      if (id) {
        this.mountedWidgets.set(id, {
          id,
          title: String(props?.title ?? ''),
          content: String(props?.content ?? ''),
          position: String(props?.position ?? 'top-right'),
        });
      }
      return;
    }
  }

  updateResources(dt) {
    this.game.mana = clamp(this.game.mana + this.game.manaRegen * dt, 0, this.game.maxMana);

    this.tickRuntimeMultipliers(dt);
    this.updateGeneratedActionStates(dt);
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
    this.updateUnits(dt);
    this.updateActionVisuals(dt);
    this.runGeneratedActions('onTick');
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
        generateAssets: ({ envelope: applyEnvelope, artifact: applyArtifact }) =>
          generateServerGlbAssetsForArtifact({
            envelope: applyEnvelope,
            artifact: applyArtifact,
          }),
        resetToBaseline: async () => {
          this.mechanicRuntime.clear();
          await this.sandboxStateStore.reset();
          this.generatedUnitDefs.clear();
          this.generatedActionDefs.clear();
          this.generatedActionState.clear();
          this.generatedAssets = [];
          this.mountedWidgets.clear();
          this.units = [];
          this.actionVisuals = [];
        },
        logger: console,
      });
      this.syncGeneratedCatalogs(artifact, result.assets);
      this.seedGeneratedStageEntities();
      this.mountWidgetsFromArtifact(artifact);
      this.goldReservations.commitReservedGold(reservationId);
      return {
        generatedAssets: result.assets.length,
        activatedMechanics: result.activatedMechanics,
        skippedMechanics: result.skippedMechanics,
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
      units: this.units.map((unit) => ({
        id: unit.id,
        kind: unit.kind,
        sourceId: unit.sourceId,
        lane: unit.lane,
        role: unit.role,
        behavior: unit.behavior,
        x: unit.x,
        z: unit.z,
        hp: unit.hp,
        maxHp: unit.maxHp,
        fallbackShape: unit.fallbackShape,
        tint: unit.tint,
        scale: unit.scale,
        assetPath: unit.assetPath,
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
      actionVisuals: this.actionVisuals.map((visual) => ({
        id: visual.id,
        actionName: visual.actionName,
        sourceId: visual.sourceId,
        kind: visual.kind,
        x: visual.x,
        z: visual.z,
        radius: visual.radius,
        color: visual.color,
        duration: visual.duration,
        assetPath: visual.assetPath,
      })),
      mountedWidgets: Array.from(this.mountedWidgets.values()),
      latestToast: this.lastToast,
    };
  }
}

export function createServerGameSession() {
  const session = new ServerGameSession();
  session.start();
  return session;
}
