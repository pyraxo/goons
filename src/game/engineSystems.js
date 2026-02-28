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
  MAP_WIDTH,
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
  const zones = [];
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

  function colorForElement(element) {
    if (element === 'fire') return { base: 0xff8840, emissive: 0x8c2b00 };
    if (element === 'ice') return { base: 0x98d8ff, emissive: 0x246ca9 };
    if (element === 'storm') return { base: 0xa8eeff, emissive: 0x53b7ff };
    if (element === 'earth') return { base: 0x96ac75, emissive: 0x40542a };
    return { base: 0xc59dff, emissive: 0x5d2e8a };
  }

  function spawnZap(pos, element = 'storm') {
    const palette = colorForElement(element);
    const bolt = new THREE.Mesh(
      new THREE.CylinderGeometry(0.15, 0.15, 5, 6),
      new THREE.MeshStandardMaterial({ color: palette.base, emissive: palette.emissive, emissiveIntensity: 1.0 })
    );
    bolt.position.set(pos.x, 2.6, pos.z);
    scene.add(bolt);
    projectiles.push({
      kind: 'zap',
      mesh: bolt,
      life: 0.18,
    });
  }

  function applyImpactEffects(enemy, effects, intensity = 0.8) {
    if (!Array.isArray(effects) || effects.length === 0 || enemy.dead) {
      return;
    }

    if (effects.includes('burn')) {
      enemy.burningFor = Math.max(enemy.burningFor, 2.2 * intensity);
      enemy.burnDps = Math.max(enemy.burnDps, 4 + 8 * intensity);
    }

    if (effects.includes('freeze')) {
      enemy.frozenFor = Math.max(enemy.frozenFor, 1.4 * intensity + 0.4);
    }

    if (effects.includes('stun')) {
      enemy.stunnedFor = Math.max(enemy.stunnedFor, 0.45 + intensity * 0.35);
    }

    if (effects.includes('slow')) {
      enemy.slowFor = Math.max(enemy.slowFor, 1.8 * intensity + 0.5);
      enemy.slowFactor = Math.min(enemy.slowFactor, 0.55);
    }

    if (effects.includes('knockback')) {
      enemy.mesh.position.z = Math.max(START_Z + 2, enemy.mesh.position.z - (0.6 + intensity * 1.2));
    }

    if (effects.includes('shield_break') && enemy.kind === 'tank') {
      damageEnemy(enemy, 5 + intensity * 7);
    }
  }

  function projectileGeometryForShape(shape, baseRadius) {
    if (shape === 'ring') {
      return new THREE.TorusGeometry(baseRadius, Math.max(0.08, baseRadius * 0.3), 10, 18);
    }
    if (shape === 'wall') {
      return new THREE.BoxGeometry(baseRadius * 1.7, baseRadius * 1.2, baseRadius * 0.9);
    }
    if (shape === 'arc') {
      return new THREE.ConeGeometry(baseRadius * 0.9, baseRadius * 2.1, 9);
    }
    return new THREE.SphereGeometry(baseRadius, 12, 12);
  }

  function laneSpanFromNumbers(numbers, width, enforceSweepSpan = false) {
    const laneSpanRaw = Number(numbers?.laneSpan);
    const explicitSpan = Number.isFinite(laneSpanRaw) ? Math.round(laneSpanRaw) : 0;
    const widthSpan = Math.round(clamp((Number(width) || 8) / 8, 1, LANE_COUNT));
    const minSpan = enforceSweepSpan ? 2 : 1;
    return clamp(Math.max(minSpan, explicitSpan || 1, widthSpan || 1), 1, LANE_COUNT);
  }

  function laneBoundsForSpan(centerLane, span) {
    const safeSpan = clamp(Math.round(span || 1), 1, LANE_COUNT);
    let laneMin = clamp(Math.round(centerLane) - Math.floor(safeSpan / 2), 0, LANE_COUNT - safeSpan);
    laneMin = clamp(laneMin, 0, LANE_COUNT - safeSpan);
    return {
      laneMin,
      laneMax: laneMin + safeSpan - 1,
      span: safeSpan,
    };
  }

  function laneCenterXFromBounds(bounds) {
    return laneX((bounds.laneMin + bounds.laneMax) * 0.5);
  }

  function chooseLaneForZone(targeting) {
    if ((targeting?.mode === 'lane' || targeting?.mode === 'lane_cluster') && Number.isFinite(targeting.lane)) {
      return clamp(Math.round(targeting.lane), 0, LANE_COUNT - 1);
    }
    if (targeting?.mode === 'lane_cluster') {
      const pressure = lanePressure();
      const activeLane = pressure.find((entry) => enemies.some((enemy) => !enemy.dead && enemy.lane === entry.lane));
      if (activeLane) return activeLane.lane;
    }
    if (targeting?.mode === 'front_cluster') {
      const front = [...enemies]
        .filter((enemy) => !enemy.dead)
        .sort((a, b) => b.mesh.position.z - a.mesh.position.z)[0];
      if (front) return front.lane;
    }
    return lanePressure()[0].lane;
  }

  function zoneZForTargeting(targeting, preferredLane = null) {
    if (targeting?.mode === 'lane_cluster') {
      const lane =
        Number.isFinite(targeting?.lane) && targeting?.lane >= 0
          ? clamp(Math.round(targeting.lane), 0, LANE_COUNT - 1)
          : preferredLane ?? chooseLaneForZone(targeting);
      const laneEnemies = enemies
        .filter((enemy) => !enemy.dead && enemy.lane === lane)
        .sort((a, b) => b.mesh.position.z - a.mesh.position.z);
      if (laneEnemies.length > 0) {
        const sample = laneEnemies.slice(0, 3);
        const avgZ = sample.reduce((sum, enemy) => sum + enemy.mesh.position.z, 0) / sample.length;
        return clamp(avgZ, START_Z + 6, BASE_Z - 4);
      }
    }
    if (targeting?.mode === 'front_cluster') {
      const front = [...enemies]
        .filter((enemy) => !enemy.dead)
        .sort((a, b) => b.mesh.position.z - a.mesh.position.z)[0];
      if (front) return front.mesh.position.z;
    }
    return Math.max(BASE_Z - 28, Math.min(BASE_Z - 9, commander.mesh.position.z - 8));
  }

  function selectTarget(targeting) {
    if (targeting?.mode === 'lane' || targeting?.mode === 'lane_cluster') {
      const lane = Number.isFinite(targeting?.lane)
        ? clamp(Math.round(targeting.lane), 0, LANE_COUNT - 1)
        : chooseLaneForZone(targeting);
      const laneEnemies = enemies.filter((enemy) => !enemy.dead && enemy.lane === lane);
      if (laneEnemies.length > 0) {
        return laneEnemies.sort((a, b) => b.mesh.position.z - a.mesh.position.z)[0];
      }
    }
    if (targeting?.mode === 'front_cluster') {
      const front = [...enemies]
        .filter((enemy) => !enemy.dead)
        .sort((a, b) => b.mesh.position.z - a.mesh.position.z)[0];
      if (front) return front;
    }
    return nearestEnemy();
  }

  function castProjectileFromConfig(spell, archetype = 'projectile') {
    const target = selectTarget(spell?.targeting);
    if (!target) {
      onToast('No target for projectile');
      return false;
    }

    const power = clamp(Number(spell?.vfx?.intensity || 0.85), 0.2, 1.4);
    const shape = ['orb', 'ring', 'wall', 'arc'].includes(spell?.vfx?.shape) ? spell.vfx.shape : 'orb';
    const shapeSize = clamp(Number(spell?.vfx?.size ?? 1), 0.4, 2.2);
    const baseRadius = (archetype === 'aoe_burst' ? 0.62 : 0.5) * shapeSize;
    const elementColor = colorForElement(spell?.element);
    const projectileMesh = new THREE.Mesh(
      projectileGeometryForShape(shape, baseRadius),
      new THREE.MeshStandardMaterial({
        color: elementColor.base,
        emissive: elementColor.emissive,
        emissiveIntensity: 0.55 + power * 0.45,
      })
    );
    projectileMesh.position.copy(commander.mesh.position).add(new THREE.Vector3(0, 1.8, -0.5));
    if (shape === 'arc') {
      projectileMesh.rotation.x = Math.PI * 0.5;
    }
    projectileMesh.castShadow = true;
    scene.add(projectileMesh);

    projectiles.push({
      kind: archetype,
      mesh: projectileMesh,
      target,
      speed: clamp(Number(spell?.numbers?.speed || 30), 8, 44),
      damage: clamp(Number(spell?.numbers?.damage || 24), 8, 150),
      splash: clamp(
        Number(
          spell?.targeting?.singleTarget
            ? spell?.numbers?.radius || 1.0
            : spell?.numbers?.radius || (archetype === 'aoe_burst' ? 3.4 : 2.0)
        ),
        0.8,
        8
      ),
      effects: Array.isArray(spell?.effects) ? spell.effects : [],
      element: spell?.element || 'arcane',
      intensity: power,
    });

    return true;
  }

  function castZoneFromConfig(spell) {
    const duration = clamp(Number(spell?.numbers?.durationSec || 4), 1, 10);
    const radius = clamp(Number(spell?.numbers?.radius || 2.2), 1, 8);
    const damage = clamp(Number(spell?.numbers?.damage || 12), 1, 120);
    const tickRate = clamp(Number(spell?.numbers?.tickRate || 0.8), 0.2, 2);
    const effects = Array.isArray(spell?.effects) ? spell.effects : [];
    const element = spell?.element || 'arcane';
    const color = colorForElement(element).base;
    const shape = String(spell?.vfx?.shape || 'ring');
    const targetingPattern = String(spell?.targeting?.pattern || '');
    const width = clamp(Number(spell?.numbers?.width || radius * 2), 1, MAP_WIDTH - 2);
    const length = clamp(Number(spell?.numbers?.length || radius * 2), 1, 120);
    const lane = chooseLaneForZone(spell?.targeting);
    const z = zoneZForTargeting(spell?.targeting, lane);
    const laneSpan = laneSpanFromNumbers(spell?.numbers, width, targetingPattern === 'lane_sweep');
    const laneBounds = laneBoundsForSpan(lane, laneSpan);
    const centerX = laneCenterXFromBounds(laneBounds);

    if (shape === 'wall') {
      if (walls.length >= 6) {
        onToast('Too many active walls');
        return false;
      }

      const wall = new THREE.Mesh(
        new THREE.BoxGeometry(5.6, 3.6, 1.2),
        new THREE.MeshStandardMaterial({ color, roughness: 0.92 })
      );
      wall.position.set(laneX(lane), 1.8, z);
      wall.castShadow = true;
      wall.receiveShadow = true;
      scene.add(wall);
      const wallHp = clamp(100 + damage * 1.2 + duration * 9, 80, 240);
      walls.push({
        mesh: wall,
        lane,
        hp: wallHp,
        maxHp: wallHp,
        duration,
      });
      zones.push({
        kind: 'wall_aura',
        mesh: wall,
        laneMin: lane,
        laneMax: lane,
        radius,
        z,
        damage: damage * 0.35,
        duration,
        tickRate,
        effects,
        timer: 0,
        isLinkedWall: true,
      });
    } else if (shape === 'wave' || targetingPattern === 'lane_sweep') {
      const activeWaves = zones.filter((zone) => zone.kind === 'wave').length;
      if (activeWaves >= 4) {
        onToast('Too many active sweep spells');
        return false;
      }

      const laneCoverage = laneBounds.laneMax - laneBounds.laneMin + 1;
      const waveWidth = clamp(Math.max(width, laneCoverage * 8 - 1.4), 6, MAP_WIDTH - 2);
      const hitDepth = clamp(radius, 1, 5);
      const wave = new THREE.Mesh(
        new THREE.BoxGeometry(waveWidth, 2.8, Math.max(1.2, hitDepth * 2)),
        new THREE.MeshStandardMaterial({
          color,
          emissive: color,
          emissiveIntensity: 0.32,
          transparent: true,
          opacity: 0.68,
        })
      );
      wave.position.set(centerX, 1.45, z);
      wave.castShadow = true;
      scene.add(wave);

      const travelSpeed = clamp(Number(spell?.numbers?.speed || 14), 6, 26);
      const travelLength = clamp(length, 8, 90);
      const configuredMinZ = z - travelLength;
      const mapEndMinZ = START_Z + hitDepth;
      const travelMinZ = laneSpan > 1 ? Math.min(configuredMinZ, mapEndMinZ) : configuredMinZ;
      zones.push({
        kind: 'wave',
        mesh: wave,
        laneMin: laneBounds.laneMin,
        laneMax: laneBounds.laneMax,
        radius: hitDepth,
        z,
        minZ: travelMinZ,
        damage,
        duration,
        tickRate,
        effects,
        speed: travelSpeed,
        pushPerSecond: clamp(7 + Number(spell?.vfx?.intensity || 0.9) * 8, 5, 20),
        timer: 0,
        isLinkedWall: false,
      });
    } else {
      const halfWidth = clamp(Math.max(width * 0.5, laneBounds.span * 3.1), 2.2, MAP_WIDTH * 0.45);
      const halfLength = clamp(Math.max(length * 0.5, radius), 1.4, 12);
      const ring = new THREE.Mesh(
        new THREE.CylinderGeometry(1, 1, 0.45, 24, 1, true),
        new THREE.MeshStandardMaterial({
          color,
          emissive: color,
          emissiveIntensity: 0.24,
          transparent: true,
          opacity: 0.7,
        })
      );
      ring.scale.set(halfWidth, 1, halfLength);
      ring.position.set(centerX, 0.24, z);
      scene.add(ring);
      zones.push({
        kind: 'ring',
        mesh: ring,
        laneMin: laneBounds.laneMin,
        laneMax: laneBounds.laneMax,
        radius: halfLength,
        z,
        damage,
        duration,
        tickRate,
        effects,
        timer: 0,
        isLinkedWall: false,
      });
    }

    if (effects.includes('freeze')) {
      for (const enemy of enemies) {
        if (!enemy.dead) {
          enemy.frozenFor = Math.max(enemy.frozenFor, Math.min(2.6, duration));
        }
      }
    }

    return true;
  }

  function castChainFromConfig(spell) {
    const liveEnemies = enemies.filter((enemy) => !enemy.dead);
    if (!liveEnemies.length) {
      onToast('No enemies for chain');
      return false;
    }

    const damage = clamp(Number(spell?.numbers?.damage || 34), 8, 120);
    const chainCount = clamp(Math.floor(Number(spell?.numbers?.chainCount || 3)), 2, 7);
    const effects = Array.isArray(spell?.effects) ? spell.effects : [];
    const sorted = [...liveEnemies].sort((a, b) => b.mesh.position.z - a.mesh.position.z).slice(0, chainCount);
    for (let i = 0; i < sorted.length; i += 1) {
      const enemy = sorted[i];
      spawnZap(enemy.mesh.position, spell?.element);
      const falloff = 1 - i * 0.12;
      damageEnemy(enemy, damage * falloff);
      applyImpactEffects(enemy, effects, 0.85);
    }

    return true;
  }

  function castFromGeneratedSpell(spell) {
    if (!spell || typeof spell !== 'object') {
      return false;
    }

    const archetype = String(spell.archetype || 'projectile');
    const cost = spell.cost || {};
    const manaCost = clamp(Number(cost.mana || 12), 8, 65);
    const cooldown = clamp(Number(cost.cooldownSec || 0.6), 0.2, 10);
    const spellCd = spellCooldowns.get(archetype) || 0;

    if (spellCd > 0) {
      onToast(`${archetype} cooldown ${spellCd.toFixed(1)}s`);
      return false;
    }

    if (game.mana < manaCost) {
      onToast('Not enough mana');
      return false;
    }

    let casted = false;
    if (archetype === 'zone_control') {
      casted = castZoneFromConfig(spell);
    } else if (archetype === 'chain') {
      casted = castChainFromConfig(spell);
    } else {
      casted = castProjectileFromConfig(spell, archetype);
    }

    if (!casted) {
      return false;
    }

    game.mana -= manaCost;
    spellCooldowns.set(archetype, cooldown);
    game.globalCooldown = 0.2;
    onHudChanged?.();
    return true;
  }

  function castFireball() {
    return castProjectileFromConfig(
      {
        archetype: 'aoe_burst',
        element: 'fire',
        targeting: { mode: 'nearest' },
        numbers: { damage: 60, radius: 3.4, speed: 32, durationSec: 0 },
        effects: ['burn'],
        vfx: { intensity: 1, shape: 'orb' },
      },
      'aoe_burst'
    );
  }

  function castWall() {
    return castZoneFromConfig({
      archetype: 'zone_control',
      element: 'earth',
      targeting: { mode: 'lane' },
      numbers: { damage: 10, radius: 2.0, durationSec: 8, tickRate: 0.8 },
      effects: ['slow', 'knockback'],
      vfx: { intensity: 0.75, shape: 'wall' },
    });
  }

  function castFrost() {
    return castZoneFromConfig({
      archetype: 'zone_control',
      element: 'ice',
      targeting: { mode: 'front_cluster' },
      numbers: { damage: 14, radius: 4.2, durationSec: 2.2, tickRate: 0.7 },
      effects: ['freeze', 'slow'],
      vfx: { intensity: 0.9, shape: 'ring' },
    });
  }

  function castBolt() {
    return castChainFromConfig({
      archetype: 'chain',
      element: 'storm',
      targeting: { mode: 'front_cluster', pattern: 'single_enemy', singleTarget: false },
      numbers: { damage: 42, radius: 2.1, durationSec: 0, chainCount: 4, width: 4, length: 6, laneSpan: 1 },
      effects: ['stun'],
      vfx: { intensity: 1.1, shape: 'arc' },
    });
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

  function castSpellByName(spellName, options = {}) {
    const {
      enforceCosts = true,
      allowLocked = false,
      showToast = true,
    } = options;

    const spell = spells[spellName];
    if (!spell) {
      if (showToast) {
        onToast(`No spell match for "${spellName}"`);
      }
      return false;
    }

    if (!allowLocked && !game.unlocks.includes(spellName)) {
      if (showToast) {
        onToast(`Spell not unlocked: ${spellName}`);
      }
      return false;
    }

    if (enforceCosts && game.globalCooldown > 0) {
      if (showToast) {
        onToast('Global cooldown active');
      }
      return false;
    }

    const spellCd = spellCooldowns.get(spellName) || 0;
    if (enforceCosts && spellCd > 0) {
      if (showToast) {
        onToast(`${spellName} cooldown ${spellCd.toFixed(1)}s`);
      }
      return false;
    }

    if (enforceCosts && game.mana < spell.cost) {
      if (showToast) {
        onToast('Not enough mana');
      }
      return false;
    }

    const casted = spell.cast();
    if (!casted) {
      return false;
    }

    if (enforceCosts) {
      game.mana -= spell.cost;
      spellCooldowns.set(spellName, spell.cooldown);
      game.globalCooldown = 0.2;
    }
    if (showToast) {
      onToast(`Cast ${spellName}: ${spell.description}`);
    }
    onHudChanged?.();
    return true;
  }

  function castFromPrompt(rawPrompt) {
    const spellName = parseSpell(rawPrompt);
    if (!spellName) {
      onToast(`No spell match for "${rawPrompt}"`);
      return false;
    }

    return castSpellByName(spellName, {
      enforceCosts: true,
      allowLocked: false,
      showToast: true,
    });
  }

  function buildSpellGenerationContext(prompt) {
    return {
      prompt,
      wave: game.wave,
      mana: game.mana,
      unlocks: game.unlocks,
      nearbyEnemies: enemies
        .filter((enemy) => !enemy.dead)
        .slice(0, 24)
        .map((enemy) => ({
          lane: enemy.lane,
          kind: enemy.kind,
          hp: enemy.hp,
          z: enemy.mesh.position.z,
        })),
    };
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
      slowFor: 0,
      slowFactor: 1,
      stunnedFor: 0,
      burningFor: 0,
      burnDps: 0,
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
      if (enemy.slowFor > 0) {
        enemy.slowFor = Math.max(0, enemy.slowFor - dt);
        if (enemy.slowFor === 0) {
          enemy.slowFactor = 1;
        }
      }
      if (enemy.stunnedFor > 0) {
        enemy.stunnedFor = Math.max(0, enemy.stunnedFor - dt);
      }
      if (enemy.burningFor > 0) {
        enemy.burningFor = Math.max(0, enemy.burningFor - dt);
        damageEnemy(enemy, enemy.burnDps * dt);
        if (enemy.burningFor === 0) {
          enemy.burnDps = 0;
        }
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

      const moveScale = enemy.stunnedFor > 0 ? 0 : enemy.frozenFor > 0 ? 0.15 : enemy.slowFactor;
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
        const dealt = projectile.damage * (0.4 + falloff * 0.6);
        damageEnemy(enemy, dealt);
        applyImpactEffects(enemy, projectile.effects, projectile.intensity || 0.8);
      }
    }

    const elementColor = colorForElement(projectile.element || 'fire');
    const fx = new THREE.Mesh(
      new THREE.SphereGeometry(0.7, 8, 8),
      new THREE.MeshStandardMaterial({
        color: elementColor.base,
        emissive: elementColor.emissive,
        emissiveIntensity: 1,
      })
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

      wall.mesh.scale.y = 0.72 + (wall.hp / (wall.maxHp || 140)) * 0.28;
    }
  }

  function enemyInsideZone(enemy, zone) {
    const inLane = enemy.lane >= zone.laneMin && enemy.lane <= zone.laneMax;
    const inDepth = Math.abs(enemy.mesh.position.z - zone.z) <= zone.radius;
    return inLane && inDepth;
  }

  function updateZones(dt) {
    for (let i = zones.length - 1; i >= 0; i -= 1) {
      const zone = zones[i];
      if (zone.isLinkedWall && !walls.some((wall) => wall.mesh === zone.mesh)) {
        zones.splice(i, 1);
        continue;
      }
      zone.duration -= dt;
      zone.timer += dt;

      if (zone.kind === 'wave') {
        zone.z -= zone.speed * dt;
        zone.mesh.position.z = zone.z;
        zone.mesh.material.opacity = clamp(0.2 + (zone.duration / 6) * 0.5, 0.18, 0.72);
        zone.mesh.rotation.x = Math.sin(game.elapsed * 6 + i) * 0.05;
        if (zone.z <= zone.minZ) {
          zone.duration = 0;
        }
        for (const enemy of enemies) {
          if (enemy.dead) continue;
          if (!enemyInsideZone(enemy, zone)) continue;
          enemy.mesh.position.z = Math.max(START_Z + 2, enemy.mesh.position.z - zone.pushPerSecond * dt);
        }
      } else if (!zone.isLinkedWall) {
        zone.mesh.rotation.y += dt * 0.8;
        zone.mesh.material.opacity = clamp(0.25 + (zone.duration / 6) * 0.45, 0.2, 0.72);
      }

      while (zone.timer >= zone.tickRate) {
        zone.timer -= zone.tickRate;
        for (const enemy of enemies) {
          if (enemy.dead) continue;
          if (enemyInsideZone(enemy, zone)) {
            damageEnemy(enemy, zone.damage * zone.tickRate);
            applyImpactEffects(enemy, zone.effects, zone.kind === 'wave' ? 0.95 : 0.7);
          }
        }
      }

      if (zone.duration <= 0) {
        if (!zone.isLinkedWall) {
          scene.remove(zone.mesh);
        }
        zones.splice(i, 1);
      }
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

    for (const key of spellCooldowns.keys()) {
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

    if (command.type === 'actions.castSpell') {
      const spellName = String(command.payload?.spellName ?? '').trim().toLowerCase();
      if (!spellName) {
        return;
      }
      castSpellByName(spellName, {
        enforceCosts: false,
        allowLocked: true,
        showToast: false,
      });
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

    for (const zone of zones) {
      if (!zone.isLinkedWall && zone.mesh) {
        scene.remove(zone.mesh);
      }
    }
    zones.length = 0;

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
    castFromGeneratedSpell,
    buildSpellGenerationContext,
    updateCommander,
    updateSpawning,
    updateResources,
    updateWalls,
    updateZones,
    updateEnemies,
    updateProjectiles,
    applyRuntimeCommand,
    resetDynamicState,
    setRuntimeHooks,
    enemies,
    walls,
    zones,
    projectiles,
  };
}
