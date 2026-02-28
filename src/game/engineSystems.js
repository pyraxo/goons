import * as THREE from 'three';
import { disposeEnemyVisual, setEnemyAnim, spawnEnemyVisual } from '../enemy-models.js';
import {
  BASE_Z,
  CASTLE_WALL_FRONT_Z,
  COMMANDER_MAX_Z,
  COMMANDER_MIN_Z,
  GOON_ATTACK_DAMAGE,
  GOON_ATTACK_INTERVAL_SECONDS,
  KILL_GOLD_REWARD,
  LANE_COUNT,
  START_Z,
} from './config.js';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

export function createEngineSystems({ scene, game, commander, laneX, rng, onToast, onHudChanged }) {
  const enemies = [];
  const projectiles = [];
  const walls = [];
  const spellCooldowns = new Map();
  const runtimeGoldMultipliers = new Map();
  const activeDots = new Map();
  let runtimeHooks = null;

  let spawnTimer = 0;
  let waveTimer = 0;
  let enemyIdCounter = 1;
  let comboCount = 0;
  let comboTimer = 0;

  function nearestEnemy() {
    let best = null;
    let bestDistSq = Infinity;
    for (const enemy of enemies) {
      if (enemy.dead) continue;
      const d = commander.mesh.position.distanceToSquared(enemy.mesh.position);
      if (d < bestDistSq) {
        bestDistSq = d;
        best = enemy;
      }
    }
    return best;
  }

  function lanePressure() {
    const summary = Array.from({ length: LANE_COUNT }, (_, lane) => ({ lane, value: 0 }));
    for (const enemy of enemies) {
      if (enemy.dead) continue;
      summary[enemy.lane].value += 1 + enemy.hp / enemy.maxHp;
    }
    return summary.sort((a, b) => b.value - a.value);
  }

  function damageEnemy(enemy, amount) {
    if (enemy.dead) {
      return;
    }

    enemy.hp -= amount;
    if (enemy.hp > 0) {
      enemy.hitTimer = 0.12;
      setEnemyAnim(enemy.visual, 'hit');
    }
  }

  function findEnemyById(enemyId) {
    return enemies.find((enemy) => enemy.id === enemyId && !enemy.dead) ?? null;
  }

  function getRuntimeGoldMultiplier() {
    let total = 1;
    for (const entry of runtimeGoldMultipliers.values()) {
      const multiplier = Number(entry?.multiplier);
      if (Number.isFinite(multiplier) && multiplier > 0) {
        total *= multiplier;
      }
    }
    return total;
  }

  function tickRuntimeMultipliers(dt) {
    for (const [key, entry] of runtimeGoldMultipliers.entries()) {
      if (!Number.isFinite(entry.remainingSeconds)) {
        continue;
      }
      entry.remainingSeconds -= dt;
      if (entry.remainingSeconds <= 0) {
        runtimeGoldMultipliers.delete(key);
      }
    }
  }

  function applyDotToEnemy(enemyId, dps, durationSeconds) {
    const enemy = findEnemyById(enemyId);
    if (!enemy) {
      return false;
    }

    const current = activeDots.get(enemyId);
    if (!current) {
      activeDots.set(enemyId, {
        dps,
        remainingSeconds: durationSeconds,
      });
      return true;
    }

    current.dps = Math.max(current.dps, dps);
    current.remainingSeconds = Math.max(current.remainingSeconds, durationSeconds);
    return true;
  }

  function spreadDotFromSource(sourceId, radius, maxTargets) {
    const source = findEnemyById(sourceId);
    const sourceDot = activeDots.get(sourceId);
    if (!source || !sourceDot) {
      return 0;
    }

    const targets = enemies
      .filter((enemy) => !enemy.dead && enemy.id !== sourceId)
      .map((enemy) => ({
        enemy,
        dist: enemy.mesh.position.distanceTo(source.mesh.position),
      }))
      .filter((entry) => entry.dist <= radius)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, maxTargets);

    let applied = 0;
    for (const target of targets) {
      const ok = applyDotToEnemy(
        target.enemy.id,
        Math.max(0.1, sourceDot.dps * 0.8),
        Math.max(0.1, sourceDot.remainingSeconds * 0.8)
      );
      if (ok) {
        applied += 1;
      }
    }
    return applied;
  }

  function spawnZap(pos) {
    const bolt = new THREE.Mesh(
      new THREE.CylinderGeometry(0.15, 0.15, 5, 6),
      new THREE.MeshStandardMaterial({ color: 0xa8eeff, emissive: 0x53b7ff, emissiveIntensity: 1.0 })
    );
    bolt.position.set(pos.x, 2.6, pos.z);
    scene.add(bolt);
    projectiles.push({
      kind: 'zap',
      mesh: bolt,
      life: 0.18,
    });
  }

  function castFireball() {
    const target = nearestEnemy();
    if (!target) {
      onToast('No target for fireball');
      return false;
    }

    const orb = new THREE.Mesh(
      new THREE.SphereGeometry(0.56, 10, 10),
      new THREE.MeshStandardMaterial({ color: 0xff8840, emissive: 0x8c2b00, emissiveIntensity: 0.9 })
    );
    orb.position.copy(commander.mesh.position).add(new THREE.Vector3(0, 1.8, -0.5));
    orb.castShadow = true;
    scene.add(orb);

    projectiles.push({
      kind: 'fireball',
      mesh: orb,
      target,
      speed: 32,
      damage: 60,
      splash: 3.4,
    });

    return true;
  }

  function castWall() {
    if (walls.length >= 6) {
      onToast('Too many active walls');
      return false;
    }

    const pressure = lanePressure();
    const lane = pressure[0].lane;

    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(5.6, 3.6, 1.2),
      new THREE.MeshStandardMaterial({ color: 0x6f7f95, roughness: 0.92 })
    );

    const z = Math.max(BASE_Z - 28, Math.min(BASE_Z - 9, commander.mesh.position.z - 8));
    mesh.position.set(laneX(lane), 1.8, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);

    walls.push({
      mesh,
      lane,
      hp: 140,
      duration: 12,
    });

    return true;
  }

  function castFrost() {
    const liveEnemies = enemies.filter((enemy) => !enemy.dead);
    if (!liveEnemies.length) {
      onToast('No enemies to freeze');
      return false;
    }

    for (const enemy of liveEnemies) {
      enemy.frozenFor = Math.max(enemy.frozenFor, 2.0);
    }

    return true;
  }

  function castBolt() {
    const liveEnemies = enemies.filter((enemy) => !enemy.dead);
    if (!liveEnemies.length) {
      onToast('No enemies for bolt');
      return false;
    }

    const sorted = [...liveEnemies].sort((a, b) => b.mesh.position.z - a.mesh.position.z).slice(0, 4);
    for (const enemy of sorted) {
      spawnZap(enemy.mesh.position);
      damageEnemy(enemy, 42);
    }

    return true;
  }

  const spells = {
    fireball: {
      cost: 16,
      cooldown: 0.6,
      description: 'Auto-targets nearest enemy and explodes.',
      cast: castFireball,
    },
    wall: {
      cost: 24,
      cooldown: 3,
      description: 'Summons a lane wall to stall enemies.',
      cast: castWall,
    },
    frost: {
      cost: 32,
      cooldown: 7,
      description: 'Freezes enemies in all lanes for 2s.',
      cast: castFrost,
    },
    bolt: {
      cost: 38,
      cooldown: 4,
      description: 'Chain lightning strikes multiple enemies.',
      cast: castBolt,
    },
  };

  function parseSpell(prompt) {
    const normalized = prompt.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!normalized) return null;

    const spellNames = Object.keys(spells);
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

  function castFromPrompt(rawPrompt) {
    if (game.globalCooldown > 0) {
      onToast('Global cooldown active');
      return;
    }

    const spellName = parseSpell(rawPrompt);
    if (!spellName) {
      onToast(`No spell match for "${rawPrompt}"`);
      return;
    }

    if (!game.unlocks.includes(spellName)) {
      onToast(`Spell not unlocked: ${spellName}`);
      return;
    }

    const spell = spells[spellName];
    const spellCd = spellCooldowns.get(spellName) || 0;

    if (spellCd > 0) {
      onToast(`${spellName} cooldown ${spellCd.toFixed(1)}s`);
      return;
    }

    if (game.mana < spell.cost) {
      onToast('Not enough mana');
      return;
    }

    const casted = spell.cast();
    if (!casted) {
      return;
    }

    game.mana -= spell.cost;
    spellCooldowns.set(spellName, spell.cooldown);
    game.globalCooldown = 0.2;
    onToast(`Cast ${spellName}: ${spell.description}`);
    onHudChanged?.();
  }

  function enemyConfig(kind) {
    const scale = 1 + (game.wave - 1) * 0.09;
    if (kind === 'tank') {
      return {
        hp: Math.round(95 * scale),
        speed: 2.3 + game.wave * 0.03,
        damage: 14,
        worth: 24,
        size: 2.4,
      };
    }

    if (kind === 'ranged') {
      return {
        hp: Math.round(40 * scale),
        speed: 3.9 + game.wave * 0.04,
        damage: 7,
        worth: 15,
        size: 1.45,
      };
    }

    return {
      hp: Math.round(58 * scale),
      speed: 4.3 + game.wave * 0.06,
      damage: 9,
      worth: 18,
      size: 1.7,
    };
  }

  function createEnemy(kind, lane) {
    const config = enemyConfig(kind);
    const spawnPosition = new THREE.Vector3(laneX(lane), 0, START_Z);
    const visual = spawnEnemyVisual(kind, lane, spawnPosition);
    setEnemyAnim(visual, 'run');
    scene.add(visual.group);

    return {
      id: `enemy_${enemyIdCounter++}`,
      mesh: visual.group,
      visual,
      lane,
      kind,
      hp: config.hp,
      maxHp: config.hp,
      speed: config.speed,
      damage: config.damage,
      worth: config.worth,
      aimHeight: Math.max(1.1, config.size * 0.95),
      frozenFor: 0,
      atCastleWall: false,
      wallAttackAccumulatorSeconds: 0,
      dead: false,
      deathTimer: 0,
      hitTimer: 0,
    };
  }

  function spawnEnemy() {
    const lane = rng.int(0, LANE_COUNT - 1);
    const roll = Math.random();
    let kind = 'melee';
    if (roll > 0.86 + Math.min(0.08, game.wave * 0.004)) {
      kind = 'tank';
    } else if (roll > 0.63) {
      kind = 'ranged';
    }

    const enemy = createEnemy(kind, lane);
    enemies.push(enemy);
    runtimeHooks?.onEnemySpawn?.({
      enemy: {
        id: enemy.id,
        lane: enemy.lane,
        kind: enemy.kind,
        hp: enemy.hp,
      },
    });
  }

  function tryUnlockSpell() {
    if (game.wave === 3 && !game.unlocks.includes('frost')) {
      game.unlocks.push('frost');
      onToast('Unlocked spell: frost');
    }

    if (game.wave === 6 && !game.unlocks.includes('bolt')) {
      game.unlocks.push('bolt');
      onToast('Unlocked spell: bolt');
    }
  }

  function updateCommander(dt, input) {
    const velocity = new THREE.Vector3();
    if (input.w) velocity.z -= 1;
    if (input.s) velocity.z += 1;
    if (input.a) velocity.x -= 1;
    if (input.d) velocity.x += 1;

    if (velocity.lengthSq() > 0) {
      velocity.normalize().multiplyScalar(commander.speed * dt);
      commander.mesh.position.add(velocity);
    }

    commander.mesh.position.x = clamp(commander.mesh.position.x, -18, 18);
    commander.mesh.position.z = clamp(commander.mesh.position.z, COMMANDER_MIN_Z, COMMANDER_MAX_Z);
  }

  function updateSpawning(dt) {
    const intensity = 1 + (game.wave - 1) * 0.05;
    const spawnEvery = Math.max(0.24, 1.18 / intensity);
    spawnTimer -= dt;

    if (spawnTimer <= 0) {
      spawnTimer = spawnEvery;
      spawnEnemy();
      if (Math.random() < Math.min(0.32, game.wave * 0.02)) {
        spawnEnemy();
      }
    }

    waveTimer += dt;
    if (waveTimer >= 24) {
      waveTimer = 0;
      game.wave += 1;
      runtimeHooks?.onWaveStart?.({
        wave: game.wave,
      });
      onToast(`Wave ${game.wave} begins`);
      tryUnlockSpell();
      onHudChanged?.();
    }
  }

  function destroyEnemy(index, slain) {
    const enemy = enemies[index];
    if (!enemy || enemy.dead) {
      return;
    }

    enemy.dead = true;
    enemy.deathTimer = 0.45;
    enemy.hitTimer = 0;
    enemy.visual.playbackScale = 1;
    setEnemyAnim(enemy.visual, 'die');

    if (slain) {
      const reward = Math.max(1, Math.round(KILL_GOLD_REWARD * getRuntimeGoldMultiplier()));
      game.score += enemy.worth;
      game.kills += 1;
      game.gold += reward;

      if (comboTimer > 0) {
        comboCount += 1;
      } else {
        comboCount = 1;
      }
      comboTimer = 0.5;

      runtimeHooks?.onEnemyDeath?.({
        enemy: {
          id: enemy.id,
          lane: enemy.lane,
          kind: enemy.kind,
        },
        rewardGold: reward,
      });
      runtimeHooks?.onKillCombo?.({
        comboCount,
        enemy: {
          id: enemy.id,
          lane: enemy.lane,
          kind: enemy.kind,
        },
      });
    }
  }

  function removeEnemy(index) {
    const enemy = enemies[index];
    if (!enemy) {
      return;
    }

    disposeEnemyVisual(enemy.visual);
    activeDots.delete(enemy.id);
    enemies.splice(index, 1);
  }

  function updateEnemies(dt) {
    const castleWallFrontZ = CASTLE_WALL_FRONT_Z;
    for (let i = enemies.length - 1; i >= 0; i -= 1) {
      const enemy = enemies[i];

      if (enemy.dead) {
        enemy.visual.playbackScale = 1;
        enemy.visual.update(dt);
        enemy.deathTimer -= dt;
        if (enemy.deathTimer <= 0) {
          removeEnemy(i);
        }
        continue;
      }

      if (enemy.frozenFor > 0) {
        enemy.frozenFor = Math.max(0, enemy.frozenFor - dt);
      }

      const dot = activeDots.get(enemy.id);
      if (dot) {
        damageEnemy(enemy, dot.dps * dt);
        dot.remainingSeconds -= dt;
        if (dot.remainingSeconds <= 0) {
          activeDots.delete(enemy.id);
        }
      }

      if (enemy.hitTimer > 0) {
        enemy.hitTimer = Math.max(0, enemy.hitTimer - dt);
        if (enemy.hitTimer === 0) {
          setEnemyAnim(enemy.visual, enemy.atCastleWall ? 'attack' : 'run');
        }
      }

      const moveScale = enemy.frozenFor > 0 ? 0.15 : 1;
      enemy.visual.playbackScale = moveScale;

      let blocked = false;
      for (const wall of walls) {
        if (wall.lane !== enemy.lane) continue;
        const closeEnough = Math.abs(enemy.mesh.position.z - wall.mesh.position.z) < 1.65;
        if (closeEnough && enemy.mesh.position.z < wall.mesh.position.z + 0.6) {
          blocked = true;
          wall.hp -= enemy.damage * dt;
          break;
        }
      }

      if (!blocked) {
        enemy.mesh.position.z += enemy.speed * moveScale * dt;
      } else {
        enemy.atCastleWall = false;
        enemy.wallAttackAccumulatorSeconds = 0;
        if (enemy.hitTimer === 0) {
          setEnemyAnim(enemy.visual, 'run');
        }
      }

      if (!blocked && enemy.mesh.position.z >= castleWallFrontZ - 0.35) {
        enemy.atCastleWall = true;
        enemy.mesh.position.z = castleWallFrontZ - 0.35;
      } else if (!blocked) {
        enemy.atCastleWall = false;
        enemy.wallAttackAccumulatorSeconds = 0;
        if (enemy.hitTimer === 0) {
          setEnemyAnim(enemy.visual, 'run');
        }
      }

      if (enemy.atCastleWall) {
        if (enemy.hitTimer === 0) {
          setEnemyAnim(enemy.visual, 'attack');
        }

        enemy.wallAttackAccumulatorSeconds += dt * moveScale;
        while (enemy.wallAttackAccumulatorSeconds >= GOON_ATTACK_INTERVAL_SECONDS && game.baseHp > 0) {
          enemy.wallAttackAccumulatorSeconds -= GOON_ATTACK_INTERVAL_SECONDS;
          game.baseHp = Math.max(0, game.baseHp - GOON_ATTACK_DAMAGE);
        }
      }

      if (enemy.hp <= 0) {
        destroyEnemy(i, true);
        continue;
      }

      enemy.visual.update(dt);
    }
  }

  function explodeProjectile(projectile) {
    const point = projectile.mesh.position;
    for (const enemy of enemies) {
      if (enemy.dead) continue;
      const d = enemy.mesh.position.distanceTo(point);
      if (d <= projectile.splash) {
        const falloff = 1 - d / projectile.splash;
        damageEnemy(enemy, projectile.damage * (0.4 + falloff * 0.6));
      }
    }

    const fx = new THREE.Mesh(
      new THREE.SphereGeometry(0.7, 8, 8),
      new THREE.MeshStandardMaterial({ color: 0xffb172, emissive: 0xff6a00, emissiveIntensity: 1 })
    );
    fx.position.copy(point);
    scene.add(fx);
    projectiles.push({ kind: 'zap', mesh: fx, life: 0.24 });
  }

  function updateProjectiles(dt) {
    for (let i = projectiles.length - 1; i >= 0; i -= 1) {
      const projectile = projectiles[i];

      if (projectile.kind === 'zap') {
        projectile.life -= dt;
        projectile.mesh.scale.y = Math.max(0.2, projectile.life * 5);
        if (projectile.life <= 0) {
          scene.remove(projectile.mesh);
          projectiles.splice(i, 1);
        }
        continue;
      }

      if (!projectile.target || projectile.target.dead || !enemies.includes(projectile.target)) {
        scene.remove(projectile.mesh);
        projectiles.splice(i, 1);
        continue;
      }

      const targetPos = projectile.target.mesh.position.clone();
      targetPos.y = projectile.target.aimHeight;
      const dir = targetPos.sub(projectile.mesh.position);
      const step = projectile.speed * dt;

      if (dir.lengthSq() <= step * step) {
        projectile.mesh.position.add(dir);
        explodeProjectile(projectile);
        scene.remove(projectile.mesh);
        projectiles.splice(i, 1);
        continue;
      }

      projectile.mesh.position.add(dir.normalize().multiplyScalar(step));
    }
  }

  function updateWalls(dt) {
    for (let i = walls.length - 1; i >= 0; i -= 1) {
      const wall = walls[i];
      wall.duration -= dt;
      if (wall.duration <= 0 || wall.hp <= 0) {
        scene.remove(wall.mesh);
        walls.splice(i, 1);
        continue;
      }

      wall.mesh.scale.y = 0.72 + (wall.hp / 140) * 0.28;
    }
  }

  function updateResources(dt) {
    game.mana = clamp(game.mana + game.manaRegen * dt, 0, game.maxMana);
    game.globalCooldown = Math.max(0, game.globalCooldown - dt);
    tickRuntimeMultipliers(dt);
    comboTimer = Math.max(0, comboTimer - dt);
    if (comboTimer === 0) {
      comboCount = 0;
    }

    for (const key of Object.keys(spells)) {
      const left = Math.max(0, (spellCooldowns.get(key) || 0) - dt);
      spellCooldowns.set(key, left);
    }
  }

  function applyRuntimeCommand(command) {
    if (!command || typeof command !== 'object') {
      return;
    }

    if (command.type === 'economy.addGold') {
      const amount = Number(command.payload?.amount);
      if (Number.isFinite(amount) && amount > 0) {
        game.gold += amount;
        onHudChanged?.();
      }
      return;
    }

    if (command.type === 'economy.addMultiplier') {
      const key = String(command.payload?.key ?? '').trim();
      const multiplier = Number(command.payload?.multiplier);
      if (key && Number.isFinite(multiplier) && multiplier > 0) {
        runtimeGoldMultipliers.set(key, {
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
        const enemy = findEnemyById(targetId);
        if (enemy) {
          damageEnemy(enemy, amount);
        }
      }
      return;
    }

    if (command.type === 'combat.applyDot') {
      const targetId = String(command.payload?.targetId ?? '').trim();
      const dps = Number(command.payload?.dps);
      const durationSeconds = Number(command.payload?.durationSeconds);
      if (targetId && Number.isFinite(dps) && dps > 0 && Number.isFinite(durationSeconds) && durationSeconds > 0) {
        applyDotToEnemy(targetId, dps, durationSeconds);
      }
      return;
    }

    if (command.type === 'combat.chainSpread') {
      const sourceId = String(command.payload?.sourceId ?? '').trim();
      const radius = Number(command.payload?.radius);
      const maxTargets = Number(command.payload?.maxTargets);
      if (
        sourceId &&
        Number.isFinite(radius) &&
        radius > 0 &&
        Number.isFinite(maxTargets) &&
        maxTargets > 0
      ) {
        spreadDotFromSource(sourceId, radius, Math.floor(maxTargets));
      }
      return;
    }
  }

  function resetDynamicState() {
    for (const enemy of enemies) {
      disposeEnemyVisual(enemy.visual);
    }
    enemies.length = 0;

    for (const wall of walls) {
      scene.remove(wall.mesh);
    }
    walls.length = 0;

    for (const projectile of projectiles) {
      scene.remove(projectile.mesh);
    }
    projectiles.length = 0;

    activeDots.clear();
    runtimeGoldMultipliers.clear();
    spellCooldowns.clear();
    spawnTimer = 0;
    waveTimer = 0;
    comboCount = 0;
    comboTimer = 0;
    enemyIdCounter = 1;
  }

  function setRuntimeHooks(nextHooks) {
    runtimeHooks = nextHooks ?? null;
  }

  return {
    castFromPrompt,
    updateCommander,
    updateSpawning,
    updateResources,
    updateWalls,
    updateEnemies,
    updateProjectiles,
    applyRuntimeCommand,
    resetDynamicState,
    setRuntimeHooks,
    enemies,
    walls,
    projectiles,
  };
}
