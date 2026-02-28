import * as THREE from 'three';
import { disposeEnemyVisual, loadEnemyModels, setEnemyAnim, spawnEnemyVisual } from './enemy-models.js';
import { estimatePrompt } from './prompt/costEstimator.js';
import { MODEL_PRESET_MAP, PromptProcessor } from './prompt/promptProcessor.js';
import { PROMPT_TEMPLATE_VERSION } from './prompt/templateDrafts.js';

const LANE_COUNT = 5;
const LANE_SPACING = 8;
const START_Z = -78;
const BASE_Z = 33;
const MAP_WIDTH = 52;
const STARTING_GOLD = 1_000_000;
const KILL_GOLD_REWARD = 10;
const CASTLE_WALL_DEPTH = 4;
const CASTLE_WALL_FRONT_Z = BASE_Z - 18;
const CASTLE_WALL_Z = CASTLE_WALL_FRONT_Z + CASTLE_WALL_DEPTH * 0.5;
const COMMANDER_MIN_Z = CASTLE_WALL_FRONT_Z + CASTLE_WALL_DEPTH + 0.35;
const COMMANDER_MAX_Z = BASE_Z + 4;
const GOON_ATTACK_INTERVAL_SECONDS = 3;
const GOON_ATTACK_DAMAGE = 1;

const GAME = {
  baseHp: 260,
  maxMana: 120,
  mana: 120,
  manaRegen: 14,
  score: 0,
  gold: STARTING_GOLD,
  wave: 1,
  elapsed: 0,
  kills: 0,
  unlocks: ['fireball', 'wall'],
  globalCooldown: 0,
  gameOver: false,
};

const BASELINE_HISTORY_TEXT =
  `No applied prompts yet.\n` +
  `Sandbox baseline: no generated ui/mechanics/units/actions.\n` +
  `Template: ${PROMPT_TEMPLATE_VERSION}`;

const SPELLS = {
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

const spellCooldowns = new Map();
const goldReservations = new Map();
const enemies = [];
const projectiles = [];
const walls = [];

const dom = {
  baseHp: document.getElementById('baseHp'),
  mana: document.getElementById('mana'),
  wave: document.getElementById('wave'),
  score: document.getElementById('score'),
  gold: document.getElementById('gold'),
  reservedGold: document.getElementById('reservedGold'),
  unlocks: document.getElementById('unlocks'),
  loopStatus: document.getElementById('loopStatus'),
  queueStatus: document.getElementById('queueStatus'),
  applyStatus: document.getElementById('applyStatus'),
  commandWrap: document.getElementById('commandWrap'),
  commandInput: document.getElementById('commandInput'),
  preview: document.getElementById('preview'),
  previewBody: document.getElementById('previewBody'),
  historyScript: document.getElementById('historyScript'),
  promptInput: document.getElementById('promptInput'),
  modelPreset: document.getElementById('modelPreset'),
  estimateBtn: document.getElementById('estimateBtn'),
  applyBtn: document.getElementById('applyBtn'),
  toast: document.getElementById('toast'),
};

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x0a1119, 55, 170);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 320);
camera.position.set(0, 46, 42);
camera.lookAt(0, 0, -8);

const ambient = new THREE.AmbientLight(0x87a8cc, 0.38);
scene.add(ambient);

const mainLight = new THREE.DirectionalLight(0xcde5ff, 1.05);
mainLight.position.set(12, 38, 16);
mainLight.castShadow = true;
mainLight.shadow.mapSize.set(2048, 2048);
mainLight.shadow.camera.left = -70;
mainLight.shadow.camera.right = 70;
mainLight.shadow.camera.top = 70;
mainLight.shadow.camera.bottom = -70;
scene.add(mainLight);

const fillLight = new THREE.DirectionalLight(0x5fa2d8, 0.55);
fillLight.position.set(-25, 16, -32);
scene.add(fillLight);

buildMap();

const commander = createCommander();
scene.add(commander.mesh);

const input = {
  w: false,
  a: false,
  s: false,
  d: false,
  commandOpen: false,
};

const rng = {
  next(min, max) {
    return min + Math.random() * (max - min);
  },
  int(min, max) {
    return Math.floor(this.next(min, max + 1));
  },
};

const promptProcessor = new PromptProcessor(
  {
    reserveGold,
    commitReservedGold,
    refundReservedGold,
  },
  {
    onQueueUpdated: (queueSize) => {
      dom.queueStatus.textContent = `Queue: ${queueSize}`;
      syncApplyButtonState();
    },
    onStatus: (message) => {
      dom.applyStatus.textContent = message;
    },
    onHistoryUpdated: () => {
      const script = promptProcessor.getReplayScript();
      dom.historyScript.textContent = script.length > 0 ? script : BASELINE_HISTORY_TEXT;
    },
  },
  {
    generationMode: import.meta.env.VITE_GENERATION_MODE ?? 'openai-api-key',
  }
);

let lastEstimate = null;
let estimateInFlight = false;
let spawnTimer = 0;
let waveTimer = 0;
let lastTime = performance.now();
let toastTimer = 0;

window.addEventListener('resize', onResize);
window.addEventListener('keydown', onKeyDown);
window.addEventListener('keyup', onKeyUp);

dom.commandInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    const value = dom.commandInput.value.trim();
    dom.commandInput.value = '';
    closeCommand();
    if (value) {
      castFromPrompt(value);
    }
  }

  if (event.key === 'Escape') {
    closeCommand();
  }
});

setupPromptUi();
bootstrap();

async function bootstrap() {
  refreshHud();
  dom.loopStatus.textContent = 'Loop: Running';
  dom.loopStatus.classList.remove('status-danger');
  dom.loopStatus.classList.add('status-ok');

  try {
    await loadEnemyModels(scene);
  } catch (error) {
    console.warn('[main] Enemy model preload failed. Fallback meshes will be used.', error);
  }

  animate();
}

function buildMap() {
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(MAP_WIDTH, 150, 2, 16),
    new THREE.MeshStandardMaterial({ color: 0x213245, roughness: 0.95, metalness: 0.02 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.z = -8;
  ground.receiveShadow = true;
  scene.add(ground);

  const laneMat = new THREE.MeshStandardMaterial({ color: 0x30475f, roughness: 0.93, metalness: 0.03 });
  for (let i = 0; i < LANE_COUNT; i += 1) {
    const lane = new THREE.Mesh(new THREE.PlaneGeometry(6, 145), laneMat);
    lane.rotation.x = -Math.PI / 2;
    lane.position.set(laneX(i), 0.02, -8);
    scene.add(lane);
  }

  const base = new THREE.Mesh(
    new THREE.BoxGeometry(26, 8, 10),
    new THREE.MeshStandardMaterial({ color: 0x6686a9, roughness: 0.8 })
  );
  base.position.set(0, 4.2, BASE_Z + 6);
  base.castShadow = true;
  base.receiveShadow = true;
  scene.add(base);

  const core = new THREE.Mesh(
    new THREE.CylinderGeometry(2.2, 2.4, 5, 8),
    new THREE.MeshStandardMaterial({ color: 0x7ac9ff, emissive: 0x215e8c, emissiveIntensity: 0.6 })
  );
  core.position.set(0, 4.7, BASE_Z + 0.8);
  core.castShadow = true;
  scene.add(core);

  const castleWall = new THREE.Mesh(
    new THREE.BoxGeometry(MAP_WIDTH - 4.5, 5.4, CASTLE_WALL_DEPTH),
    new THREE.MeshStandardMaterial({ color: 0x6a635c, roughness: 0.9, metalness: 0.04 })
  );
  castleWall.position.set(0, 2.7, CASTLE_WALL_Z);
  castleWall.castShadow = true;
  castleWall.receiveShadow = true;
  scene.add(castleWall);

  const battlementMat = new THREE.MeshStandardMaterial({ color: 0x7c736a, roughness: 0.88 });
  const battlementCount = 9;
  for (let i = 0; i < battlementCount; i += 1) {
    const t = battlementCount === 1 ? 0.5 : i / (battlementCount - 1);
    const x = -((MAP_WIDTH - 9) / 2) + t * (MAP_WIDTH - 9);
    const battlement = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.45, 1.2), battlementMat);
    battlement.position.set(x, 6.05, CASTLE_WALL_Z - CASTLE_WALL_DEPTH * 0.35);
    battlement.castShadow = true;
    battlement.receiveShadow = true;
    scene.add(battlement);
  }

  const borderLeft = new THREE.Mesh(
    new THREE.BoxGeometry(2, 3.2, 150),
    new THREE.MeshStandardMaterial({ color: 0x1b2837 })
  );
  borderLeft.position.set(-MAP_WIDTH / 2, 1.6, -8);
  borderLeft.receiveShadow = true;
  scene.add(borderLeft);

  const borderRight = borderLeft.clone();
  borderRight.position.x *= -1;
  scene.add(borderRight);
}

function createCommander() {
  const group = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(1.2, 1.4, 2.2, 8),
    new THREE.MeshStandardMaterial({ color: 0x9ec2d8, roughness: 0.7 })
  );
  body.position.y = 1.2;
  body.castShadow = true;
  group.add(body);

  const visor = new THREE.Mesh(
    new THREE.BoxGeometry(1.4, 0.5, 0.5),
    new THREE.MeshStandardMaterial({ color: 0x86d6ff, emissive: 0x1a5d87, emissiveIntensity: 0.5 })
  );
  visor.position.set(0, 1.45, 0.9);
  group.add(visor);

  group.position.set(0, 0, BASE_Z - 5);

  return {
    mesh: group,
    speed: 15,
  };
}

function createEnemy(kind, lane) {
  const config = enemyConfig(kind);
  const spawnPosition = new THREE.Vector3(laneX(lane), 0, START_Z);
  const visual = spawnEnemyVisual(kind, lane, spawnPosition);
  setEnemyAnim(visual, 'run');
  scene.add(visual.group);

  return {
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

function enemyConfig(kind) {
  const scale = 1 + (GAME.wave - 1) * 0.09;
  if (kind === 'tank') {
    return {
      hp: Math.round(95 * scale),
      speed: 2.3 + GAME.wave * 0.03,
      damage: 14,
      worth: 24,
      size: 2.4,
      color: 0x49566f,
    };
  }

  if (kind === 'ranged') {
    return {
      hp: Math.round(40 * scale),
      speed: 3.9 + GAME.wave * 0.04,
      damage: 7,
      worth: 15,
      size: 1.45,
      color: 0x7a4963,
    };
  }

  return {
    hp: Math.round(58 * scale),
    speed: 4.3 + GAME.wave * 0.06,
    damage: 9,
    worth: 18,
    size: 1.7,
    color: 0x6f8062,
  };
}

function laneX(index) {
  return (index - (LANE_COUNT - 1) / 2) * LANE_SPACING;
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function onKeyDown(event) {
  if (GAME.gameOver) {
    if (event.key === 'r' || event.key === 'R') {
      window.location.reload();
    }
    return;
  }

  if (isTypingTarget(event.target) && event.target !== dom.commandInput) {
    return;
  }

  if (event.key === 'Enter') {
    if (input.commandOpen) {
      return;
    }
    openCommand();
    return;
  }

  if (input.commandOpen) {
    return;
  }

  if (event.key === 'w' || event.key === 'W') input.w = true;
  if (event.key === 'a' || event.key === 'A') input.a = true;
  if (event.key === 's' || event.key === 'S') input.s = true;
  if (event.key === 'd' || event.key === 'D') input.d = true;
}

function onKeyUp(event) {
  if (event.key === 'w' || event.key === 'W') input.w = false;
  if (event.key === 'a' || event.key === 'A') input.a = false;
  if (event.key === 's' || event.key === 'S') input.s = false;
  if (event.key === 'd' || event.key === 'D') input.d = false;
}

function openCommand() {
  input.commandOpen = true;
  dom.commandWrap.classList.remove('hidden');
  dom.commandInput.focus();
}

function closeCommand() {
  input.commandOpen = false;
  dom.commandWrap.classList.add('hidden');
  dom.commandInput.blur();
}

function setupPromptUi() {
  dom.estimateBtn.addEventListener('click', async () => {
    if (estimateInFlight) {
      return;
    }

    const raw = dom.promptInput.value.trim();
    if (!raw) {
      return;
    }

    estimateInFlight = true;
    dom.estimateBtn.disabled = true;
    dom.applyStatus.textContent = 'Estimating with fast model...';

    try {
      lastEstimate = await estimatePrompt(raw);
      renderEstimate(lastEstimate);
      dom.applyStatus.textContent = `Estimated ${lastEstimate.id} with fast model`;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      dom.applyStatus.textContent = `Estimate failed: ${message}`;
      lastEstimate = null;
      dom.preview.hidden = true;
    } finally {
      estimateInFlight = false;
      dom.estimateBtn.disabled = false;
      syncApplyButtonState();
    }
  });

  dom.applyBtn.addEventListener('click', () => {
    if (!lastEstimate) {
      return;
    }

    if (!canSpendGold(lastEstimate.estimatedGoldCost)) {
      dom.applyStatus.textContent = 'Apply blocked: not enough Gold at queue time';
      syncApplyButtonState();
      return;
    }

    const preset = dom.modelPreset.value;
    promptProcessor.enqueue(lastEstimate, preset);
    dom.applyStatus.textContent = `Queued ${lastEstimate.id} with preset ${preset}`;
    dom.promptInput.value = '';
    lastEstimate = null;
    dom.preview.hidden = true;
    syncApplyButtonState();
  });

  window.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      dom.estimateBtn.click();
    }
  });

  dom.queueStatus.textContent = `Queue: ${promptProcessor.getQueueSize()}`;
  dom.applyStatus.textContent = 'No prompt applied yet';
  dom.historyScript.textContent = BASELINE_HISTORY_TEXT;
}

function renderEstimate(estimate) {
  const canAfford = canSpendGold(estimate.estimatedGoldCost);
  const selectedPreset = dom.modelPreset.value;

  dom.previewBody.innerHTML = `
    <div><strong>Types:</strong> ${estimate.classifiedTypes.join(', ')}</div>
    <div><strong>Risk:</strong> ${estimate.riskLevel}</div>
    <div><strong>Cost:</strong> ${estimate.estimatedGoldCost} Gold</div>
    <div><strong>Estimator:</strong> gpt-5.3-codex (reasoning: low)</div>
    <div><strong>Preset Model:</strong> ${MODEL_PRESET_MAP[selectedPreset]}</div>
    <div><strong>Review Required:</strong> ${estimate.requiresReview ? 'yes' : 'no'}</div>
    <div><strong>Can Afford:</strong> ${canAfford ? 'yes' : 'no'}</div>
  `;

  dom.preview.hidden = false;
}

function syncApplyButtonState() {
  const canApply =
    Boolean(lastEstimate) &&
    !estimateInFlight &&
    canSpendGold(lastEstimate.estimatedGoldCost) &&
    !GAME.gameOver;
  dom.applyBtn.disabled = !canApply;
}

function canSpendGold(amount) {
  return GAME.gold >= amount;
}

function reserveGold(amount) {
  if (!canSpendGold(amount)) {
    return null;
  }

  GAME.gold -= amount;
  const reservationId = `res_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  goldReservations.set(reservationId, amount);
  refreshHud();
  return reservationId;
}

function commitReservedGold(reservationId) {
  if (!goldReservations.has(reservationId)) {
    return false;
  }

  goldReservations.delete(reservationId);
  refreshHud();
  return true;
}

function refundReservedGold(reservationId) {
  const amount = goldReservations.get(reservationId);
  if (amount === undefined) {
    return false;
  }

  goldReservations.delete(reservationId);
  GAME.gold += amount;
  refreshHud();
  return true;
}

function getReservedGold() {
  let total = 0;
  for (const amount of goldReservations.values()) {
    total += amount;
  }
  return total;
}

function castFromPrompt(rawPrompt) {
  if (GAME.globalCooldown > 0) {
    setToast('Global cooldown active');
    return;
  }

  const spellName = parseSpell(rawPrompt);
  if (!spellName) {
    setToast(`No spell match for "${rawPrompt}"`);
    return;
  }

  if (!GAME.unlocks.includes(spellName)) {
    setToast(`Spell not unlocked: ${spellName}`);
    return;
  }

  const spell = SPELLS[spellName];
  const spellCd = spellCooldowns.get(spellName) || 0;

  if (spellCd > 0) {
    setToast(`${spellName} cooldown ${spellCd.toFixed(1)}s`);
    return;
  }

  if (GAME.mana < spell.cost) {
    setToast('Not enough mana');
    return;
  }

  const casted = spell.cast();
  if (!casted) {
    return;
  }

  GAME.mana -= spell.cost;
  spellCooldowns.set(spellName, spell.cooldown);
  GAME.globalCooldown = 0.2;
  setToast(`Cast ${spellName}: ${spell.description}`);
  refreshHud();
}

function parseSpell(prompt) {
  const normalized = prompt.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  const direct = Object.keys(SPELLS).find((name) => normalized === name);
  if (direct) return direct;

  const words = normalized.split(' ');
  const contains = Object.keys(SPELLS).find((name) => words.includes(name));
  if (contains) return contains;

  let best = null;
  let bestScore = Infinity;
  for (const spellName of Object.keys(SPELLS)) {
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

function castFireball() {
  const target = nearestEnemy();
  if (!target) {
    setToast('No target for fireball');
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
    setToast('Too many active walls');
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
    setToast('No enemies to freeze');
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
    setToast('No enemies for bolt');
    return false;
  }

  const sorted = [...liveEnemies].sort((a, b) => b.mesh.position.z - a.mesh.position.z).slice(0, 4);
  for (const enemy of sorted) {
    spawnZap(enemy.mesh.position);
    damageEnemy(enemy, 42);
  }

  return true;
}

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

function spawnEnemy() {
  const lane = rng.int(0, LANE_COUNT - 1);
  const roll = Math.random();
  let kind = 'melee';
  if (roll > 0.86 + Math.min(0.08, GAME.wave * 0.004)) {
    kind = 'tank';
  } else if (roll > 0.63) {
    kind = 'ranged';
  }

  enemies.push(createEnemy(kind, lane));
}

function updateCommander(dt) {
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
  const intensity = 1 + (GAME.wave - 1) * 0.05;
  const spawnEvery = Math.max(0.24, 1.18 / intensity);
  spawnTimer -= dt;

  if (spawnTimer <= 0) {
    spawnTimer = spawnEvery;
    spawnEnemy();
    if (Math.random() < Math.min(0.32, GAME.wave * 0.02)) {
      spawnEnemy();
    }
  }

  waveTimer += dt;
  if (waveTimer >= 24) {
    waveTimer = 0;
    GAME.wave += 1;
    setToast(`Wave ${GAME.wave} begins`);
    tryUnlockSpell();
    refreshHud();
  }
}

function tryUnlockSpell() {
  if (GAME.wave === 3 && !GAME.unlocks.includes('frost')) {
    GAME.unlocks.push('frost');
    setToast('Unlocked spell: frost');
  }

  if (GAME.wave === 6 && !GAME.unlocks.includes('bolt')) {
    GAME.unlocks.push('bolt');
    setToast('Unlocked spell: bolt');
  }
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
      while (enemy.wallAttackAccumulatorSeconds >= GOON_ATTACK_INTERVAL_SECONDS && GAME.baseHp > 0) {
        enemy.wallAttackAccumulatorSeconds -= GOON_ATTACK_INTERVAL_SECONDS;
        GAME.baseHp = Math.max(0, GAME.baseHp - GOON_ATTACK_DAMAGE);
      }
    }

    if (enemy.hp <= 0) {
      destroyEnemy(i, true);
      continue;
    }

    enemy.visual.update(dt);
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
    GAME.score += enemy.worth;
    GAME.kills += 1;
    GAME.gold += KILL_GOLD_REWARD;
  }
}

function removeEnemy(index) {
  const enemy = enemies[index];
  if (!enemy) {
    return;
  }

  disposeEnemyVisual(enemy.visual);
  enemies.splice(index, 1);
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
  GAME.mana = clamp(GAME.mana + GAME.manaRegen * dt, 0, GAME.maxMana);
  GAME.globalCooldown = Math.max(0, GAME.globalCooldown - dt);

  for (const key of Object.keys(SPELLS)) {
    const left = Math.max(0, (spellCooldowns.get(key) || 0) - dt);
    spellCooldowns.set(key, left);
  }
}

function updateHud() {
  dom.baseHp.textContent = Math.max(0, Math.floor(GAME.baseHp));
  dom.mana.textContent = `${Math.floor(GAME.mana)} / ${GAME.maxMana}`;
  dom.wave.textContent = String(GAME.wave);
  dom.score.textContent = String(GAME.score);
  dom.gold.textContent = Math.floor(GAME.gold).toLocaleString();
  dom.reservedGold.textContent = Math.floor(getReservedGold()).toLocaleString();
  dom.unlocks.textContent = GAME.unlocks.join(', ');
  syncApplyButtonState();
}

function refreshHud() {
  updateHud();
}

function setToast(text) {
  dom.toast.textContent = text;
  dom.toast.classList.add('show');
  toastTimer = 1.8;
}

function updateToast(dt) {
  if (toastTimer <= 0) return;
  toastTimer -= dt;
  if (toastTimer <= 0) {
    dom.toast.classList.remove('show');
  }
}

function gameOver() {
  GAME.gameOver = true;
  dom.loopStatus.textContent = 'Loop: Halted';
  dom.loopStatus.classList.remove('status-ok');
  dom.loopStatus.classList.add('status-danger');
  dom.applyStatus.textContent = 'Prompt apply disabled (game over)';
  setToast(`Base destroyed. Final score ${GAME.score}. Press R to restart.`);
}

function animate() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  if (!GAME.gameOver) {
    GAME.elapsed += dt;
    updateCommander(dt);
    updateSpawning(dt);
    updateResources(dt);
    updateWalls(dt);
    updateEnemies(dt);
    updateProjectiles(dt);
    updateHud();

    if (GAME.baseHp <= 0) {
      gameOver();
    }
  }

  updateToast(dt);
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function isTypingTarget(target) {
  if (!target || typeof target.closest !== 'function') {
    return false;
  }

  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}
