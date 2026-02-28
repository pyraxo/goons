import * as THREE from 'three';
import {
  ZONE_IMPULSE_COOLDOWN_SEC,
  applyImpulseToVelocity,
  canApplyZoneImpulse,
  computeImpulseVector,
  integrateVelocity,
  profileForEnemyKind,
  updatePoiseAndStagger,
} from './combat/reaction-physics.js';
import { disposeEnemyVisual, loadEnemyModels, setEnemyAnim, spawnEnemyVisual } from './enemy-models.js';
import { estimatePrompt } from './prompt/costEstimator.js';
import { MODEL_PRESET_MAP, PromptProcessor, REASONING_EFFORT_PRESET_MAP } from './prompt/promptProcessor.js';
import { OPENAI_MODEL } from '../config.js';
import { PROMPT_TEMPLATE_VERSION } from './prompt/templateDrafts.js';

const LANE_COUNT = 5;
const LANE_SPACING = 8;
const LANE_HALF_WIDTH = 2.9;
const START_Z = -78;
const ENEMY_MIN_Z = START_Z + 2;
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
const SPELL_API_TARGET_KEY = 'spellApiTarget';
const SPELL_API_TARGETS = {
  vite: 'vite',
  backend: 'backend',
};
const DIRECT_SPELL_BACKEND_ORIGIN = import.meta.env.VITE_SPELL_BACKEND_ORIGIN || 'http://127.0.0.1:8787';
const MAX_SPELL_HISTORY_ITEMS = 18;

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
  unlocks: ['fireball', 'wall', 'frost', 'bolt'],
  gameOver: false,
};

const BASELINE_HISTORY_TEXT =
  `No applied prompts yet.\n` +
  `Sandbox baseline: no generated ui/mechanics/units/actions.\n` +
  `Template: ${PROMPT_TEMPLATE_VERSION}`;

const SPELLS = {
  fireball: {
    cost: 16,
    description: 'Auto-targets nearest enemy and explodes.',
    cast: castFireball,
  },
  wall: {
    cost: 24,
    description: 'Summons a lane wall to stall enemies.',
    cast: castWall,
  },
  frost: {
    cost: 32,
    description: 'Freezes enemies in all lanes for 2s.',
    cast: castFrost,
  },
  bolt: {
    cost: 38,
    description: 'Chain lightning strikes multiple enemies.',
    cast: castBolt,
  },
};

const goldReservations = new Map();
const enemies = [];
const projectiles = [];
const walls = [];
const zones = [];
const beams = [];
const spellQueue = [];
let spellQueueProcessing = false;

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
  spellHistoryList: document.getElementById('spellHistoryList'),
  promptInput: document.getElementById('promptInput'),
  spellApiTarget: document.getElementById('spellApiTarget'),
  modelPreset: document.getElementById('modelPreset'),
  estimateBtn: document.getElementById('estimateBtn'),
  applyBtn: document.getElementById('applyBtn'),
  cancelSpellQueueBtn: document.getElementById('cancelSpellQueueBtn'),
  resetSandboxBtn: document.getElementById('resetSandboxBtn'),
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
let resetInFlight = false;
const spellHistory = [];

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

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
    slowFor: 0,
    slowFactor: 1,
    stunnedFor: 0,
    burningFor: 0,
    burnDps: 0,
    atCastleWall: false,
    wallAttackAccumulatorSeconds: 0,
    velX: 0,
    velZ: 0,
    staggerFor: 0,
    poiseDamage: 0,
    lastZoneImpulseAt: Number.NEGATIVE_INFINITY,
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

function enemyLaneBounds(enemy) {
  const center = laneX(enemy.lane);
  return {
    minX: center - LANE_HALF_WIDTH,
    maxX: center + LANE_HALF_WIDTH,
  };
}

function applyHitReaction(enemy, reaction) {
  if (!enemy || enemy.dead) {
    return;
  }

  const profile = profileForEnemyKind(enemy.kind);
  const laneBounds = enemyLaneBounds(enemy);
  const impactPoint = reaction?.impactPoint || enemy.mesh.position;
  const impulse = computeImpulseVector({
    source: reaction?.source || 'projectile',
    damage: Number(reaction?.damage) || 0,
    intensity: Number(reaction?.intensity) || 0.8,
    effects: Array.isArray(reaction?.effects) ? reaction.effects : [],
    impactPoint: {
      x: Number(impactPoint.x) || enemy.mesh.position.x,
      z: Number(impactPoint.z) || enemy.mesh.position.z,
    },
    enemyPosition: {
      x: enemy.mesh.position.x,
      z: enemy.mesh.position.z,
    },
    laneMinX: laneBounds.minX,
    laneMaxX: laneBounds.maxX,
    maxImpulse: profile.maxImpulse,
  });

  if (impulse.magnitude <= 0) {
    return;
  }

  const nextVelocity = applyImpulseToVelocity(
    { velX: enemy.velX, velZ: enemy.velZ },
    { x: impulse.x, z: impulse.z },
    profile
  );
  enemy.velX = nextVelocity.velX;
  enemy.velZ = nextVelocity.velZ;

  const nextPoise = updatePoiseAndStagger(
    { poiseDamage: enemy.poiseDamage, staggerFor: enemy.staggerFor },
    impulse.magnitude,
    profile,
    0
  );
  enemy.poiseDamage = nextPoise.poiseDamage;
  enemy.staggerFor = nextPoise.staggerFor;
  if (nextPoise.didStagger) {
    enemy.wallAttackAccumulatorSeconds = 0;
    enemy.hitTimer = Math.max(enemy.hitTimer, 0.14);
    setEnemyAnim(enemy.visual, 'hit');
  }
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
  const savedSpellApiTarget = localStorage.getItem(SPELL_API_TARGET_KEY);
  if (savedSpellApiTarget === SPELL_API_TARGETS.backend || savedSpellApiTarget === SPELL_API_TARGETS.vite) {
    dom.spellApiTarget.value = savedSpellApiTarget;
  }

  dom.spellApiTarget.addEventListener('change', () => {
    const selected = dom.spellApiTarget.value === SPELL_API_TARGETS.backend ? SPELL_API_TARGETS.backend : SPELL_API_TARGETS.vite;
    localStorage.setItem(SPELL_API_TARGET_KEY, selected);
    const targetText = selected === SPELL_API_TARGETS.backend ? 'Backend direct' : 'Vite proxy';
    setToast(`Spell API target: ${targetText}`);
  });

  function submitPromptInputToSpellApi() {
    const raw = dom.promptInput.value.trim();
    if (!raw) {
      return;
    }
    dom.promptInput.value = '';
    lastEstimate = null;
    dom.preview.hidden = true;
    syncApplyButtonState();
    dom.applyStatus.textContent = 'Sending prompt to spell API backend...';
    void castFromPrompt(raw);
  }

  dom.estimateBtn.addEventListener('click', async () => {
    if (estimateInFlight) {
      return;
    }

    if (isSpellApiBackendSelected()) {
      submitPromptInputToSpellApi();
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
    if (isSpellApiBackendSelected()) {
      submitPromptInputToSpellApi();
      return;
    }

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

  dom.cancelSpellQueueBtn.addEventListener('click', () => {
    cancelQueuedSpells();
  });

  dom.resetSandboxBtn?.addEventListener('click', () => {
    void resetSandboxToTemplate('manual');
  });

  function forceApplyFromPromptInput() {
    if (isSpellApiBackendSelected()) {
      submitPromptInputToSpellApi();
      return;
    }

    const raw = dom.promptInput.value.trim();
    if (!raw) {
      return;
    }

    if (GAME.gameOver) {
      dom.applyStatus.textContent = 'Prompt apply disabled (game over)';
      return;
    }

    const preset = dom.modelPreset.value;
    const envelope = {
      id: `prompt_force_${Date.now()}`,
      inputMode: 'text',
      rawPrompt: raw,
      classifiedTypes: ['actions'],
      estimatedGoldCost: 0,
      riskLevel: 'medium',
      requiresReview: false,
    };

    promptProcessor.enqueue(envelope, preset);
    dom.applyStatus.textContent = `Force-queued ${envelope.id} with preset ${preset} (no estimate)`;
    dom.promptInput.value = '';
    lastEstimate = null;
    dom.preview.hidden = true;
    syncApplyButtonState();
  }

  window.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      if (isSpellApiBackendSelected()) {
        submitPromptInputToSpellApi();
        return;
      }
      if (event.shiftKey) {
        dom.estimateBtn.click();
        return;
      }
      forceApplyFromPromptInput();
    }
  });

  dom.promptInput.addEventListener('keydown', (event) => {
    if (!isSpellApiBackendSelected()) {
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submitPromptInputToSpellApi();
    }
  });

  dom.queueStatus.textContent = `Queue: ${promptProcessor.getQueueSize()}`;
  dom.applyStatus.textContent = 'No prompt applied yet';
  dom.historyScript.textContent = BASELINE_HISTORY_TEXT;
  renderSpellHistory();
  syncSpellQueueUi();
}

function renderEstimate(estimate) {
  const canAfford = canSpendGold(estimate.estimatedGoldCost);
  const selectedPreset = dom.modelPreset.value;

  dom.previewBody.innerHTML = `
    <div><strong>Types:</strong> ${estimate.classifiedTypes.join(', ')}</div>
    <div><strong>Risk:</strong> ${estimate.riskLevel}</div>
    <div><strong>Cost:</strong> ${estimate.estimatedGoldCost} Gold</div>
    <div><strong>Estimator:</strong> ${OPENAI_MODEL} (reasoning: low)</div>
    <div><strong>Preset Model:</strong> ${MODEL_PRESET_MAP[selectedPreset]} (reasoning: ${REASONING_EFFORT_PRESET_MAP[selectedPreset]})</div>
    <div><strong>Review Required:</strong> ${estimate.requiresReview ? 'yes' : 'no'}</div>
    <div><strong>Can Afford:</strong> ${canAfford ? 'yes' : 'no'}</div>
  `;

  dom.preview.hidden = false;
}

function syncApplyButtonState() {
  const canApply =
    Boolean(lastEstimate) &&
    !estimateInFlight &&
    !resetInFlight &&
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

async function castFromPrompt(rawPrompt) {
  const historyId = appendSpellHistory(rawPrompt);
  spellQueue.push({ rawPrompt, historyId });
  const queuedAhead = spellQueue.length - 1;
  if (queuedAhead > 0) {
    dom.applyStatus.textContent = `Spell queued (${queuedAhead} ahead)`;
  }
  syncSpellQueueUi();
  void processSpellQueue();
}

async function processSpellQueue() {
  if (spellQueueProcessing) {
    return;
  }

  spellQueueProcessing = true;
  try {
    while (spellQueue.length > 0) {
      const next = spellQueue.shift();
      syncSpellQueueUi();
      if (!next) {
        continue;
      }
      await castQueuedSpell(next.rawPrompt, next.historyId);
    }
  } finally {
    spellQueueProcessing = false;
    syncSpellQueueUi();
  }
}

async function castQueuedSpell(rawPrompt, historyId) {
  if (GAME.gameOver) {
    updateSpellHistory(historyId, 'failed', 'Game over');
    return;
  }

  markSpellHistoryCastStart(historyId);

  const payload = {
    prompt: rawPrompt,
    wave: GAME.wave,
    mana: GAME.mana,
    unlocks: GAME.unlocks,
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

  try {
    const response = await fetch(getSpellGenerateEndpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const json = await response.json();
    const castResult = castFromConfig(json?.spell);
    if (!castResult.casted) {
      updateSpellHistory(historyId, 'failed', castResult.reason || 'Spell could not be cast');
      return;
    }

    if (json?.source === 'fallback') {
      const reason = json?.meta?.fallbackReason ? ` (${json.meta.fallbackReason})` : '';
      setToast(`Fallback cast${reason}`);
      updateSpellHistory(
        historyId,
        'casted',
        `Fallback ${json?.spell?.name || json?.spell?.archetype || 'spell'}${reason}`
      );
      console.warn('[spell] fallback', {
        reason: json?.meta?.fallbackReason || null,
        warnings: json?.meta?.warnings || [],
        latencyMs: json?.meta?.latencyMs,
      });
    } else {
      const spellName = json?.spell?.name || json?.spell?.archetype || 'spell';
      setToast(spellName);
      updateSpellHistory(historyId, 'casted', spellName);
    }
  } catch (error) {
    console.warn('[main] spell generation failed', error);
    const message = error instanceof Error ? error.message : String(error);
    const endpoint = getSpellGenerateEndpoint();
    dom.applyStatus.textContent = `Spell API request failed (${endpoint}): ${message}`;
    setToast('Spell engine unavailable');
    updateSpellHistory(historyId, 'failed', `Spell API failed: ${message}`);
  }
}

function cancelQueuedSpells() {
  if (spellQueue.length === 0) {
    return;
  }

  const pending = [...spellQueue];
  spellQueue.length = 0;
  for (const queued of pending) {
    updateSpellHistory(queued.historyId, 'failed', 'Cancelled from queue');
  }

  dom.applyStatus.textContent = `Cancelled ${pending.length} queued spell${pending.length === 1 ? '' : 's'}`;
  setToast('Queued spells cancelled');
  syncSpellQueueUi();
}

async function resetSandboxToTemplate(reason) {
  if (resetInFlight) {
    return;
  }

  resetInFlight = true;
  if (dom.resetSandboxBtn) {
    dom.resetSandboxBtn.disabled = true;
  }
  dom.applyStatus.textContent = 'Resetting sandbox to template baseline...';

  try {
    promptProcessor.clearQueuedJobs();
    await promptProcessor.waitForIdle(15_000);
    promptProcessor.clearHistory();
    cancelQueuedSpells();
    await sleep(120);
    setToast(`Reset sandbox (${reason}), reloading baseline...`);
    window.location.reload();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    dom.applyStatus.textContent = `Sandbox reset failed: ${message}`;
    resetInFlight = false;
    if (dom.resetSandboxBtn) {
      dom.resetSandboxBtn.disabled = false;
    }
    syncApplyButtonState();
  }
}

function syncSpellQueueUi() {
  if (!dom.cancelSpellQueueBtn) {
    return;
  }

  const queuedCount = spellQueue.length;
  dom.cancelSpellQueueBtn.disabled = queuedCount === 0;
  dom.cancelSpellQueueBtn.textContent =
    queuedCount > 0 ? `Cancel Queue (${queuedCount})` : 'Cancel Queue';
}

function getSpellGenerateEndpoint() {
  if (dom.spellApiTarget.value === SPELL_API_TARGETS.backend) {
    return `${DIRECT_SPELL_BACKEND_ORIGIN}/api/spells/generate`;
  }
  return '/api/spells/generate';
}

function isSpellApiBackendSelected() {
  return dom.spellApiTarget.value === SPELL_API_TARGETS.backend;
}

function castFromConfig(spell) {
  if (!spell || typeof spell !== 'object') {
    return {
      casted: false,
      reason: 'Invalid spell payload',
    };
  }

  const archetype = String(spell.archetype || 'projectile');

  const cost = spell.cost || {};
  const manaCost = clamp(Number(cost.mana || 12), 8, 65);

  if (GAME.mana < manaCost) {
    setToast('Not enough mana');
    return {
      casted: false,
      reason: 'Not enough mana',
    };
  }

  let casted = false;
  if (archetype === 'zone_control') {
    casted = castZoneFromConfig(spell);
  } else if (archetype === 'chain') {
    casted = castChainFromConfig(spell);
  } else if (archetype === 'strike') {
    casted = castStrikeFromConfig(spell);
  } else if (archetype === 'beam') {
    casted = castBeamFromConfig(spell);
  } else {
    casted = castProjectileFromConfig(spell, archetype);
  }

  if (!casted) {
    return {
      casted: false,
      reason: 'No valid target or spell effect failed',
    };
  }

  GAME.mana -= manaCost;
  refreshHud();
  return {
    casted: true,
    reason: '',
  };
}

function appendSpellHistory(prompt) {
  const now = Date.now();
  const entry = {
    id: `spell_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    prompt: String(prompt || '').trim() || '(empty prompt)',
    status: 'queued',
    detail: '',
    updatedAt: now,
    queuedAt: now,
    castStartedAt: null,
    castFinishedAt: null,
    castDurationMs: null,
  };

  spellHistory.unshift(entry);
  if (spellHistory.length > MAX_SPELL_HISTORY_ITEMS) {
    spellHistory.length = MAX_SPELL_HISTORY_ITEMS;
  }

  renderSpellHistory();
  return entry.id;
}

function markSpellHistoryCastStart(id) {
  const entry = spellHistory.find((item) => item.id === id);
  if (!entry) {
    return;
  }

  const now = Date.now();
  entry.castStartedAt = now;
  entry.updatedAt = now;
  renderSpellHistory();
}

function updateSpellHistory(id, status, detail = '') {
  const entry = spellHistory.find((item) => item.id === id);
  if (!entry) {
    return;
  }

  const now = Date.now();
  entry.status = status;
  entry.detail = String(detail || '').trim();
  entry.updatedAt = now;
  if (entry.castStartedAt !== null) {
    entry.castFinishedAt = now;
    entry.castDurationMs = Math.max(0, now - entry.castStartedAt);
  }
  renderSpellHistory();
}

function renderSpellHistory() {
  const container = dom.spellHistoryList;
  if (!container) {
    return;
  }

  container.textContent = '';

  if (spellHistory.length === 0) {
    const item = document.createElement('li');
    item.className = 'spell-history-empty';
    item.textContent = 'No spell casts yet.';
    container.append(item);
    return;
  }

  for (const entry of spellHistory) {
    const item = document.createElement('li');
    item.className = 'spell-history-item';

    const time = document.createElement('span');
    time.className = 'spell-history-time';
    time.textContent = formatSpellHistoryTime(entry.updatedAt);

    const status = document.createElement('span');
    status.className = `spell-status spell-status-${entry.status}`;
    status.textContent = entry.status;

    const prompt = document.createElement('span');
    prompt.className = 'spell-history-prompt';
    prompt.textContent = entry.prompt;

    item.append(time, status, prompt);

    if (entry.detail) {
      const detail = document.createElement('div');
      detail.className = 'spell-history-detail';
      detail.textContent = entry.detail;
      item.append(detail);
    }

    if (entry.castDurationMs !== null) {
      const duration = document.createElement('div');
      duration.className = 'spell-history-detail';
      duration.textContent = `Duration: ${formatSpellDuration(entry.castDurationMs)}`;
      item.append(duration);
    }

    container.append(item);
  }
}

function formatSpellHistoryTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatSpellDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 1000) {
    return `${Math.max(0, Math.round(durationMs))}ms`;
  }
  return `${(durationMs / 1000).toFixed(2)}s`;
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

const trailParticles = [];
const impactFlashes = [];
let shakeIntensity = 0;
let shakeDecay = 0;
const zoneParticles = [];
const cameraBasePosition = new THREE.Vector3(0, 46, 42);

function parseHexColor(hex) {
  if (typeof hex !== 'string') return null;
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return null;
  return Number.parseInt(clean, 16);
}

function spawnTrailParticle(position, spell) {
  const vfx = spell?.vfx || {};
  const density = clamp(Number(vfx.particleDensity) || 1.0, 0.2, 2.0);
  if (Math.random() > density * 0.4) return;

  const color = parseHexColor(vfx.secondaryColor) || parseHexColor(vfx.primaryColor) || 0xffffff;
  const trailAlias = vfx.particleTheme || vfx.trailEffect || 'spark';
  const trail = trailAlias === 'torch' || trailAlias === 'embers'
    ? 'ember_trail'
    : trailAlias === 'sparks'
      ? 'spark'
    : trailAlias === 'mist'
      ? 'frost_mist'
      : trailAlias === 'glyph'
        ? 'lightning_arc'
      : trailAlias === 'glyphs'
        ? 'lightning_arc'
        : trailAlias === 'stormthread'
          ? 'lightning_arc'
          : trailAlias;

  let geo;
  let size;

  if (trail === 'ember_trail' || trail === 'spark') {
    size = 0.12 + Math.random() * 0.18;
    geo = new THREE.SphereGeometry(size, 4, 4);
  } else if (trail === 'frost_mist' || trail === 'smoke') {
    size = 0.25 + Math.random() * 0.35;
    geo = new THREE.SphereGeometry(size, 5, 5);
  } else if (trail === 'lightning_arc') {
    size = 0.08 + Math.random() * 0.12;
    geo = new THREE.CylinderGeometry(size * 0.3, size * 0.3, size * 4, 4);
  } else if (trail === 'holy_motes' || trail === 'shadow_wisp') {
    size = 0.1 + Math.random() * 0.15;
    geo = new THREE.OctahedronGeometry(size, 0);
  } else {
    return;
  }

  const mat = new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: trail === 'lightning_arc' ? 1.5 : 0.9,
    transparent: true,
    opacity: 0.85,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(position);
  mesh.position.x += (Math.random() - 0.5) * 0.6;
  mesh.position.y += (Math.random() - 0.5) * 0.4;
  mesh.position.z += (Math.random() - 0.5) * 0.6;
  if (trail === 'lightning_arc') {
    mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
  }
  scene.add(mesh);

  trailParticles.push({
    mesh,
    life: 0.25 + Math.random() * 0.35,
    velY: (trail === 'ember_trail' || trail === 'spark') ? 1.5 + Math.random() * 2 : 0.3 + Math.random() * 0.6,
    drift: (Math.random() - 0.5) * 1.2,
    fadeRate: trail === 'smoke' || trail === 'frost_mist' ? 1.2 : 2.5,
  });
}

function spawnImpactEffect(position, spell) {
  const vfx = spell?.vfx || {};
  const impact = vfx.impactEffect || 'flash';
  const primary = parseHexColor(vfx.primaryColor) || 0xffffff;
  const secondary = parseHexColor(vfx.secondaryColor) || primary;
  const density = clamp(Number(vfx.particleDensity) || 1.0, 0.2, 2.0);

  if (impact === 'explosion') {
    const count = Math.floor(8 * density);
    for (let i = 0; i < count; i++) {
      const size = 0.2 + Math.random() * 0.4;
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(size, 5, 5),
        new THREE.MeshStandardMaterial({
          color: i % 2 === 0 ? primary : secondary,
          emissive: primary,
          emissiveIntensity: 1.2,
          transparent: true,
          opacity: 1,
        })
      );
      mesh.position.copy(position);
      const angle = (i / count) * Math.PI * 2;
      const speed = 4 + Math.random() * 6;
      scene.add(mesh);
      impactFlashes.push({
        mesh,
        life: 0.3 + Math.random() * 0.25,
        velX: Math.cos(angle) * speed,
        velY: 2 + Math.random() * 4,
        velZ: Math.sin(angle) * speed,
      });
    }
    const coreFlash = new THREE.Mesh(
      new THREE.SphereGeometry(1.5, 10, 10),
      new THREE.MeshStandardMaterial({
        color: secondary,
        emissive: secondary,
        emissiveIntensity: 2,
        transparent: true,
        opacity: 0.9,
      })
    );
    coreFlash.position.copy(position);
    scene.add(coreFlash);
    impactFlashes.push({ mesh: coreFlash, life: 0.18, velX: 0, velY: 0, velZ: 0 });
  } else if (impact === 'shatter') {
    const count = Math.floor(6 * density);
    for (let i = 0; i < count; i++) {
      const size = 0.15 + Math.random() * 0.25;
      const mesh = new THREE.Mesh(
        new THREE.TetrahedronGeometry(size),
        new THREE.MeshStandardMaterial({
          color: i % 3 === 0 ? secondary : primary,
          emissive: primary,
          emissiveIntensity: 0.8,
          transparent: true,
          opacity: 1,
        })
      );
      mesh.position.copy(position);
      const angle = (i / count) * Math.PI * 2;
      const speed = 3 + Math.random() * 5;
      scene.add(mesh);
      impactFlashes.push({
        mesh,
        life: 0.35 + Math.random() * 0.3,
        velX: Math.cos(angle) * speed,
        velY: 3 + Math.random() * 5,
        velZ: Math.sin(angle) * speed,
      });
    }
  } else if (impact === 'ripple') {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.3, 0.6, 24),
      new THREE.MeshStandardMaterial({
        color: primary,
        emissive: primary,
        emissiveIntensity: 1.5,
        transparent: true,
        opacity: 0.8,
        side: THREE.DoubleSide,
      })
    );
    ring.position.copy(position);
    ring.position.y = 0.15;
    ring.rotation.x = -Math.PI / 2;
    scene.add(ring);
    impactFlashes.push({ mesh: ring, life: 0.5, velX: 0, velY: 0, velZ: 0, isRipple: true });
  } else if (impact === 'vortex') {
    for (let i = 0; i < 3; i++) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.4 + i * 0.3, 0.08, 8, 16),
        new THREE.MeshStandardMaterial({
          color: i === 0 ? primary : secondary,
          emissive: primary,
          emissiveIntensity: 1.0,
          transparent: true,
          opacity: 0.8,
        })
      );
      ring.position.copy(position);
      ring.position.y += i * 0.5;
      scene.add(ring);
      impactFlashes.push({ mesh: ring, life: 0.4 + i * 0.1, velX: 0, velY: 1.5, velZ: 0, isVortex: true, spin: 6 + i * 3 });
    }
  } else if (impact === 'pillar') {
    const pillar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.4, 0.6, 8, 8),
      new THREE.MeshStandardMaterial({
        color: primary,
        emissive: secondary,
        emissiveIntensity: 1.5,
        transparent: true,
        opacity: 0.85,
      })
    );
    pillar.position.copy(position);
    pillar.position.y = 4;
    scene.add(pillar);
    impactFlashes.push({ mesh: pillar, life: 0.35, velX: 0, velY: 0, velZ: 0 });
  } else {
    const flash = new THREE.Mesh(
      new THREE.SphereGeometry(0.8, 8, 8),
      new THREE.MeshStandardMaterial({
        color: primary,
        emissive: secondary,
        emissiveIntensity: 2,
        transparent: true,
        opacity: 1,
      })
    );
    flash.position.copy(position);
    scene.add(flash);
    impactFlashes.push({ mesh: flash, life: 0.15, velX: 0, velY: 0, velZ: 0 });
  }

  const shake = clamp(Number(vfx.screenShake) || 0, 0, 1);
  if (shake > 0) {
    shakeIntensity = Math.max(shakeIntensity, shake);
    shakeDecay = 0.35;
  }
}

function updateTrailParticles(dt) {
  for (let i = trailParticles.length - 1; i >= 0; i--) {
    const p = trailParticles[i];
    p.life -= dt;
    p.mesh.position.y += p.velY * dt;
    p.mesh.position.x += p.drift * dt;
    p.mesh.material.opacity = Math.max(0, p.mesh.material.opacity - p.fadeRate * dt);
    if (p.life <= 0 || p.mesh.material.opacity <= 0) {
      scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      p.mesh.material.dispose();
      trailParticles.splice(i, 1);
    }
  }
}

function updateImpactFlashes(dt) {
  for (let i = impactFlashes.length - 1; i >= 0; i--) {
    const f = impactFlashes[i];
    f.life -= dt;
    f.mesh.position.x += f.velX * dt;
    f.mesh.position.y += f.velY * dt;
    f.mesh.position.z += f.velZ * dt;
    if (f.velY !== 0 && !f.isRipple && !f.isVortex) {
      f.velY -= 12 * dt;
    }
    if (f.isRipple) {
      f.mesh.scale.multiplyScalar(1 + dt * 8);
    }
    if (f.isVortex) {
      f.mesh.rotation.y += (f.spin || 6) * dt;
      f.mesh.scale.multiplyScalar(1 + dt * 3);
    }
    const fadeProgress = Math.max(0, f.life / 0.4);
    f.mesh.material.opacity = fadeProgress;
    if (f.life <= 0) {
      scene.remove(f.mesh);
      f.mesh.geometry.dispose();
      f.mesh.material.dispose();
      impactFlashes.splice(i, 1);
    }
  }
}

function updateScreenShake(dt) {
  if (shakeIntensity <= 0) return;
  shakeDecay -= dt;
  if (shakeDecay <= 0) {
    shakeIntensity = 0;
    camera.position.copy(cameraBasePosition);
    return;
  }
  const factor = shakeIntensity * (shakeDecay / 0.35);
  camera.position.x = cameraBasePosition.x + (Math.random() - 0.5) * factor * 1.5;
  camera.position.y = cameraBasePosition.y + (Math.random() - 0.5) * factor * 0.8;
}

function spawnZoneParticle(position, vfx, mode) {
  if (zoneParticles.length >= 120) return;
  const color = parseHexColor(vfx?.secondaryColor) || parseHexColor(vfx?.primaryColor) || 0xffffff;
  const size = mode === 'spray' ? 0.1 + Math.random() * 0.15 : 0.08 + Math.random() * 0.12;
  const geo = mode === 'spray'
    ? new THREE.SphereGeometry(size, 4, 4)
    : new THREE.OctahedronGeometry(size, 0);
  const mat = new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: mode === 'spray' ? 1.2 : 0.8,
    transparent: true,
    opacity: 0.75,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(position);
  scene.add(mesh);
  const life = mode === 'spray' ? 0.3 + Math.random() * 0.3 : 0.6 + Math.random() * 0.5;
  zoneParticles.push({
    mesh,
    life,
    velY: mode === 'spray' ? 2 + Math.random() * 3 : 1.2 + Math.random() * 2,
    driftX: mode === 'spray' ? (Math.random() - 0.5) * 3 : (Math.random() - 0.5) * 0.8,
    driftZ: mode === 'spray' ? -(1 + Math.random() * 2) : (Math.random() - 0.5) * 0.5,
    fadeRate: 1 / life,
  });
}

function updateZoneParticles(dt) {
  for (let i = zoneParticles.length - 1; i >= 0; i--) {
    const p = zoneParticles[i];
    p.life -= dt;
    p.mesh.position.y += p.velY * dt;
    p.mesh.position.x += p.driftX * dt;
    p.mesh.position.z += p.driftZ * dt;
    p.mesh.material.opacity = Math.max(0, p.life * p.fadeRate);
    if (p.life <= 0) {
      scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      p.mesh.material.dispose();
      zoneParticles.splice(i, 1);
    }
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
  if (shape === 'cone') {
    return new THREE.ConeGeometry(baseRadius * 0.85, baseRadius * 2.4, 14);
  }
  if (shape === 'helix') {
    return new THREE.TorusKnotGeometry(baseRadius * 0.85, Math.max(0.05, baseRadius * 0.25), 64, 8);
  }
  if (shape === 'sphereburst') {
    return new THREE.IcosahedronGeometry(baseRadius * 0.95, 1);
  }
  if (shape === 'crystal') {
    return new THREE.DodecahedronGeometry(baseRadius * 0.8, 0);
  }
  return new THREE.SphereGeometry(baseRadius, 12, 12);
}

function castProjectileFromConfig(spell, archetype = 'projectile') {
  const target = selectTarget(spell.targeting);
  if (!target) {
    setToast('No target for projectile');
    return false;
  }

  const power = clamp(Number(spell?.vfx?.intensity || 0.85), 0.2, 1.4);
  const shape = ['orb', 'ring', 'wall', 'arc', 'cone', 'helix', 'sphereburst', 'crystal'].includes(spell?.vfx?.shape)
    ? spell.vfx.shape
    : 'orb';
  const shapeSize = clamp(Number(spell?.vfx?.size ?? 1), 0.4, 2.2);
  const baseRadius = (archetype === 'aoe_burst' ? 0.62 : 0.5) * shapeSize;
  const secondaryShape = ['orb', 'ring', 'wall', 'arc', 'cone', 'helix', 'sphereburst', 'crystal'].includes(spell?.vfx?.secondaryShape)
    ? spell?.vfx?.secondaryShape
    : null;
  const secondaryScale = clamp(Number(spell?.vfx?.shapeScale ?? 1), 0.5, 2.6);
  const secondaryBlend = clamp(Number(spell?.vfx?.shapeBlend ?? 0.45), 0, 1);
  const secondaryRadius = baseRadius * secondaryScale;
  const elementColor = colorForElement(spell?.element);
  const primaryHex = parseHexColor(spell?.vfx?.primaryColor);
  const secondaryHex = parseHexColor(spell?.vfx?.secondaryColor);
  const colorPalette = spell?.vfx?.colors || {};
  const mainColor = parseHexColor(colorPalette.core) || primaryHex || elementColor.base;
  const glowColor = parseHexColor(colorPalette.glow) || secondaryHex || elementColor.emissive;
  const edgeColor = parseHexColor(colorPalette.edge) || glowColor;

  const projectileMesh = new THREE.Mesh(
    projectileGeometryForShape(shape, baseRadius),
    new THREE.MeshStandardMaterial({
      color: mainColor,
      emissive: glowColor,
      emissiveIntensity: 0.55 + power * 0.45,
    })
  );
  projectileMesh.position.copy(commander.mesh.position).add(new THREE.Vector3(0, 1.8, -0.5));
  if (shape === 'arc') {
    projectileMesh.rotation.x = Math.PI * 0.5;
  }
  projectileMesh.castShadow = true;
  scene.add(projectileMesh);
  const glowLight = new THREE.PointLight(mainColor, power * 2.5, 6);
  glowLight.position.set(0, 0, 0);
  projectileMesh.add(glowLight);

  let secondaryMesh = null;
  if (secondaryShape && secondaryShape !== shape) {
    secondaryMesh = new THREE.Mesh(
      projectileGeometryForShape(secondaryShape, secondaryRadius),
      new THREE.MeshStandardMaterial({
        color: edgeColor,
        emissive: edgeColor,
        emissiveIntensity: 0.3 + power * 0.35,
        transparent: true,
        opacity: 0.35 + secondaryBlend * 0.45,
      })
    );
    secondaryMesh.position.copy(projectileMesh.position);
    secondaryMesh.rotation.x = Math.PI * (0.05 + secondaryBlend * 0.15);
    secondaryMesh.scale.multiplyScalar(0.65 + secondaryBlend * 0.5);
    scene.add(secondaryMesh);
    glowLight.intensity = power * (2.6 + secondaryBlend * 0.6);
  }

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
    secondaryShape,
    secondaryMesh,
    spellVfx: spell?.vfx || null,
    glowLight,
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
  const primaryHex = parseHexColor(spell?.vfx?.primaryColor);
  const baseColor = primaryHex ?? colorForElement(element).base;
  const color = zoneColorForSpell(spell, baseColor);
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
      setToast('Too many active walls');
      return false;
    }

    const wallAccent = parseHexColor(spell?.vfx?.secondaryColor) ?? colorForElement(element).emissive;
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(5.6, 3.6, 1.2),
      new THREE.MeshStandardMaterial({
        color,
        emissive: wallAccent,
        emissiveIntensity: 0.15,
        roughness: 0.85,
      })
    );
    wall.position.set(laneX(lane), 1.8, z);
    wall.castShadow = true;
    wall.receiveShadow = true;
    const wallGlow = new THREE.PointLight(wallAccent, 1.2, 8);
    wallGlow.position.set(0, 0.5, 0);
    wall.add(wallGlow);
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
      element,
      timer: 0,
      isLinkedWall: true,
    });
  } else if (shape === 'wave' || targetingPattern === 'lane_sweep') {
    const activeWaves = zones.filter((zone) => zone.kind === 'wave').length;
    if (activeWaves >= 4) {
      setToast('Too many active sweep spells');
      return false;
    }

    const laneCoverage = laneBounds.laneMax - laneBounds.laneMin + 1;
    const waveWidth = clamp(Math.max(width, laneCoverage * LANE_SPACING - 1.4), 6, MAP_WIDTH - 2);
    const hitDepth = clamp(radius, 1, 5);
    const waveAccent = parseHexColor(spell?.vfx?.secondaryColor) ?? colorForElement(element).emissive;

    const waveGroup = new THREE.Group();
    waveGroup.position.set(centerX, 0, z);

    const bodyMesh = new THREE.Mesh(
      new THREE.BoxGeometry(waveWidth, 2.2, Math.max(1.4, hitDepth * 2)),
      new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.38,
        transparent: true,
        opacity: 0.52,
      })
    );
    bodyMesh.position.y = 1.1;
    bodyMesh.castShadow = true;
    waveGroup.add(bodyMesh);

    const crestMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.5, 0.7, waveWidth * 0.88, 14),
      new THREE.MeshStandardMaterial({
        color: waveAccent,
        emissive: waveAccent,
        emissiveIntensity: 0.9,
        transparent: true,
        opacity: 0.65,
      })
    );
    crestMesh.rotation.z = Math.PI / 2;
    crestMesh.position.set(0, 2.55, -(hitDepth * 0.45));
    waveGroup.add(crestMesh);

    const foamMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(waveWidth * 0.8, 1.8),
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        emissive: waveAccent,
        emissiveIntensity: 0.45,
        transparent: true,
        opacity: 0.22,
        side: THREE.DoubleSide,
      })
    );
    foamMesh.rotation.x = -Math.PI / 2;
    foamMesh.position.set(0, 0.05, -(hitDepth + 0.5));
    waveGroup.add(foamMesh);

    const waveGlow = new THREE.PointLight(color, 2, 14);
    waveGlow.position.set(0, 2.2, 0);
    waveGroup.add(waveGlow);

    scene.add(waveGroup);

    const travelSpeed = clamp(Number(spell?.numbers?.speed || 14), 6, 26);
    const travelLength = clamp(length, 8, 90);
    zones.push({
      kind: 'wave',
      mesh: waveGroup,
      bodyMesh,
      crestMesh,
      foamMesh,
      laneMin: laneBounds.laneMin,
      laneMax: laneBounds.laneMax,
      radius: hitDepth,
      z,
      minZ: z - travelLength,
      damage,
      duration,
      initialDuration: duration,
      tickRate,
      effects,
      element,
      speed: travelSpeed,
      pushPerSecond: clamp(7 + Number(spell?.vfx?.intensity || 0.9) * 8, 5, 20),
      timer: 0,
      isLinkedWall: false,
      spellVfx: spell?.vfx || null,
    });
  } else {
    const halfWidth = clamp(Math.max(width * 0.5, laneBounds.span * 3.1), 2.2, MAP_WIDTH * 0.45);
    const halfLength = clamp(Math.max(length * 0.5, radius), 1.4, 12);
    const visibility = clamp(Number(spell?.vfx?.visibility ?? 1), 0.4, 2.2);
    const ringAccent = parseHexColor(spell?.vfx?.secondaryColor) ?? colorForElement(element).emissive;

    const ringGroup = new THREE.Group();
    ringGroup.position.set(centerX, 0, z);

    const glowDisc = new THREE.Mesh(
      new THREE.CircleGeometry(1, 32),
      new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: clamp(0.3 + visibility * 0.2, 0.3, 0.8),
        transparent: true,
        opacity: clamp(0.18 + visibility * 0.08, 0.15, 0.35),
        side: THREE.DoubleSide,
      })
    );
    glowDisc.rotation.x = -Math.PI / 2;
    glowDisc.scale.set(halfWidth * 0.92, halfLength * 0.92, 1);
    glowDisc.position.y = 0.04;
    ringGroup.add(glowDisc);

    const ringMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1, 0.45, 24, 1, true),
      new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: clamp(0.24 + visibility * 0.26, 0.24, 0.95),
        transparent: true,
        opacity: clamp(0.58 + visibility * 0.18, 0.55, 0.95),
      })
    );
    ringMesh.scale.set(halfWidth, 1, halfLength);
    ringMesh.position.y = 0.24;
    ringGroup.add(ringMesh);

    const innerRing = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1, 0.3, 20, 1, true),
      new THREE.MeshStandardMaterial({
        color: ringAccent,
        emissive: ringAccent,
        emissiveIntensity: clamp(0.4 + visibility * 0.3, 0.4, 1.0),
        transparent: true,
        opacity: clamp(0.3 + visibility * 0.12, 0.28, 0.55),
      })
    );
    innerRing.scale.set(halfWidth * 0.55, 0.8, halfLength * 0.55);
    innerRing.position.y = 0.22;
    ringGroup.add(innerRing);

    const zoneGlow = new THREE.PointLight(color, 1.5, 10);
    zoneGlow.position.y = 0.6;
    ringGroup.add(zoneGlow);

    scene.add(ringGroup);
    zones.push({
      kind: 'ring',
      mesh: ringGroup,
      ringMesh,
      glowDisc,
      innerRing,
      laneMin: laneBounds.laneMin,
      laneMax: laneBounds.laneMax,
      radius: halfLength,
      halfWidth,
      halfLength,
      z,
      damage,
      duration,
      initialDuration: duration,
      tickRate,
      effects,
      element,
      timer: 0,
      isLinkedWall: false,
      spellVfx: spell?.vfx || null,
    });
  }

  if (effects.includes('freeze')) {
    for (const enemy of enemies) {
      if (!enemy.dead) {
        enemy.frozenFor = Math.max(enemy.frozenFor, Math.min(2.6, duration));
      }
    }
  }

  if (spell?.vfx) {
    const impactPos = new THREE.Vector3(centerX, 0.5, z);
    spawnImpactEffect(impactPos, { vfx: spell.vfx });
  }

  return true;
}

function castChainFromConfig(spell) {
  const liveEnemies = enemies.filter((enemy) => !enemy.dead);
  if (!liveEnemies.length) {
    setToast('No enemies for chain');
    return false;
  }

  const damage = clamp(Number(spell?.numbers?.damage || 34), 8, 120);
  const chainCount = clamp(Math.floor(Number(spell?.numbers?.chainCount || 3)), 2, 7);
  const effects = Array.isArray(spell?.effects) ? spell.effects : [];
  const sorted = [...liveEnemies].sort((a, b) => b.mesh.position.z - a.mesh.position.z).slice(0, chainCount);

  const primaryHex = parseHexColor(spell?.vfx?.primaryColor);
  const secondaryHex = parseHexColor(spell?.vfx?.secondaryColor);

  for (let i = 0; i < sorted.length; i += 1) {
    const enemy = sorted[i];
    spawnZap(enemy.mesh.position, spell?.element, primaryHex, secondaryHex);
    const falloff = 1 - i * 0.12;
    const dealt = damage * falloff;
    damageEnemy(enemy, dealt);
    applyImpactEffects(enemy, effects, spell?.element, 0.85);
    applyHitReaction(enemy, {
      source: 'chain',
      damage: dealt,
      intensity: 0.85,
      effects,
      impactPoint: {
        x: enemy.mesh.position.x,
        z: enemy.mesh.position.z + 1.35,
      },
    });

    if (spell?.vfx && i === 0) {
      spawnImpactEffect(enemy.mesh.position, { vfx: { ...spell.vfx, screenShake: (spell.vfx.screenShake || 0) * 0.5 } });
    }
  }

  if (sorted.length >= 2) {
    for (let i = 0; i < sorted.length - 1; i++) {
      spawnChainArc(sorted[i].mesh.position, sorted[i + 1].mesh.position, primaryHex ?? colorForElement(spell?.element || 'storm').base);
    }
  }

  return true;
}

function castStrikeFromConfig(spell) {
  const liveEnemies = enemies.filter((enemy) => !enemy.dead);
  if (!liveEnemies.length) {
    setToast('No target for strike');
    return false;
  }

  const target = selectTarget(spell?.targeting);
  if (!target) {
    setToast('No target for strike');
    return false;
  }

  const damage = clamp(Number(spell?.numbers?.damage || 60), 8, 150);
  const radius = clamp(Number(spell?.numbers?.radius || 3.0), 1.5, 6);
  const effects = Array.isArray(spell?.effects) ? spell.effects : [];
  const element = spell?.element || 'fire';
  const intensity = clamp(Number(spell?.vfx?.intensity || 1.0), 0.2, 1.4);
  const primaryHex = parseHexColor(spell?.vfx?.primaryColor);
  const secondaryHex = parseHexColor(spell?.vfx?.secondaryColor);
  const elementColor = colorForElement(element);
  const mainColor = primaryHex ?? elementColor.base;
  const glowColor = secondaryHex ?? elementColor.emissive;

  const strikeX = target.mesh.position.x;
  const strikeZ = target.mesh.position.z;
  const skyY = 28;

  const boltGeo = new THREE.CylinderGeometry(0.35, 0.6, skyY, 8);
  const boltMat = new THREE.MeshStandardMaterial({
    color: mainColor,
    emissive: glowColor,
    emissiveIntensity: 2.0,
    transparent: true,
    opacity: 0.92,
  });
  const bolt = new THREE.Mesh(boltGeo, boltMat);
  bolt.position.set(strikeX, skyY / 2, strikeZ);
  bolt.castShadow = true;
  scene.add(bolt);

  const boltGlow = new THREE.PointLight(mainColor, intensity * 5, 16);
  boltGlow.position.set(strikeX, 4, strikeZ);
  scene.add(boltGlow);

  const groundRing = new THREE.Mesh(
    new THREE.RingGeometry(0.3, radius, 24),
    new THREE.MeshStandardMaterial({
      color: mainColor,
      emissive: mainColor,
      emissiveIntensity: 1.5,
      transparent: true,
      opacity: 0.7,
      side: THREE.DoubleSide,
    })
  );
  groundRing.rotation.x = -Math.PI / 2;
  groundRing.position.set(strikeX, 0.1, strikeZ);
  scene.add(groundRing);

  projectiles.push({
    kind: 'strike_bolt',
    mesh: bolt,
    life: 0.35,
    glowLight: boltGlow,
    groundRing,
  });

  const impactPos = new THREE.Vector3(strikeX, 0.5, strikeZ);
  for (const enemy of enemies) {
    if (enemy.dead) continue;
    const d = enemy.mesh.position.distanceTo(impactPos);
    if (d <= radius) {
      const falloff = 1 - d / radius;
      const dealt = damage * (0.5 + falloff * 0.5);
      damageEnemy(enemy, dealt);
      applyImpactEffects(enemy, effects, element, intensity);
      applyHitReaction(enemy, {
        source: 'strike',
        damage: dealt,
        intensity,
        effects,
        impactPoint: { x: strikeX, z: strikeZ },
      });
    }
  }

  if (spell?.vfx) {
    spawnImpactEffect(impactPos, { vfx: spell.vfx });
  }

  return true;
}

function castBeamFromConfig(spell) {
  const liveEnemies = enemies.filter((enemy) => !enemy.dead);
  if (!liveEnemies.length) {
    setToast('No targets for beam');
    return false;
  }

  if (beams.length >= 3) {
    setToast('Too many active beams');
    return false;
  }

  const damage = clamp(Number(spell?.numbers?.damage || 18), 4, 80);
  const duration = clamp(Number(spell?.numbers?.durationSec || 2.5), 1, 6);
  const tickRate = clamp(Number(spell?.numbers?.tickRate || 0.3), 0.15, 0.8);
  const beamLength = clamp(Number(spell?.numbers?.length || 35), 10, 80);
  const beamWidth = clamp(Number(spell?.numbers?.width || 3), 1.5, 8);
  const effects = Array.isArray(spell?.effects) ? spell.effects : [];
  const element = spell?.element || 'fire';
  const intensity = clamp(Number(spell?.vfx?.intensity || 1.0), 0.2, 1.4);
  const primaryHex = parseHexColor(spell?.vfx?.primaryColor);
  const secondaryHex = parseHexColor(spell?.vfx?.secondaryColor);
  const elementColor = colorForElement(element);
  const mainColor = primaryHex ?? elementColor.base;
  const glowColor = secondaryHex ?? elementColor.emissive;

  const originX = commander.mesh.position.x;
  const originZ = commander.mesh.position.z - 0.5;
  const originY = 1.8;

  const front = [...liveEnemies].sort((a, b) => b.mesh.position.z - a.mesh.position.z)[0];
  const targetLane = front ? front.lane : Math.round(clamp((originX + (LANE_COUNT - 1) * LANE_SPACING / 2) / LANE_SPACING, 0, LANE_COUNT - 1));
  const targetX = laneX(targetLane);
  const aimDirX = targetX - originX;
  const aimDirZ = -beamLength;
  const aimLen = Math.sqrt(aimDirX * aimDirX + aimDirZ * aimDirZ);
  const normX = aimDirX / aimLen;
  const normZ = aimDirZ / aimLen;

  const beamGroup = new THREE.Group();
  beamGroup.position.set(originX, originY, originZ);

  const coreMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(beamWidth * 0.15, beamWidth * 0.2, beamLength, 8),
    new THREE.MeshStandardMaterial({
      color: mainColor,
      emissive: mainColor,
      emissiveIntensity: 1.8,
      transparent: true,
      opacity: 0.85,
    })
  );
  coreMesh.rotation.x = Math.PI / 2;
  coreMesh.position.set((targetX - originX) * 0.5, 0, -beamLength / 2);
  beamGroup.add(coreMesh);

  const outerMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(beamWidth * 0.4, beamWidth * 0.5, beamLength, 10),
    new THREE.MeshStandardMaterial({
      color: glowColor,
      emissive: glowColor,
      emissiveIntensity: 0.6,
      transparent: true,
      opacity: 0.3,
    })
  );
  outerMesh.rotation.x = Math.PI / 2;
  outerMesh.position.set((targetX - originX) * 0.5, 0, -beamLength / 2);
  beamGroup.add(outerMesh);

  const beamGlow = new THREE.PointLight(mainColor, intensity * 3, 12);
  beamGlow.position.set((targetX - originX) * 0.3, 0, -beamLength * 0.3);
  beamGroup.add(beamGlow);

  const endGlow = new THREE.PointLight(mainColor, intensity * 2, 8);
  endGlow.position.set(targetX - originX, 0, -beamLength * 0.85);
  beamGroup.add(endGlow);

  const angle = Math.atan2(targetX - originX, -(originZ - beamLength));
  beamGroup.rotation.y = angle * 0.15;

  scene.add(beamGroup);

  beams.push({
    mesh: beamGroup,
    coreMesh,
    outerMesh,
    originX,
    originZ,
    originY,
    dirX: normX,
    dirZ: normZ,
    targetX,
    beamLength,
    beamWidth,
    damage,
    duration,
    initialDuration: duration,
    tickRate,
    timer: 0,
    effects,
    element,
    intensity,
    spellVfx: spell?.vfx || null,
  });

  if (spell?.vfx) {
    const startPos = new THREE.Vector3(originX, originY, originZ);
    spawnImpactEffect(startPos, { vfx: { ...spell.vfx, screenShake: 0 } });
  }

  return true;
}

function laneSpanFromNumbers(numbers, width, enforceSweepSpan = false) {
  const laneSpanRaw = Number(numbers?.laneSpan);
  const explicitSpan = Number.isFinite(laneSpanRaw) ? Math.round(laneSpanRaw) : 0;
  const widthSpan = Math.round(clamp((Number(width) || 8) / LANE_SPACING, 1, LANE_COUNT));
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
  if (targeting?.mode === 'nearest' || targeting?.mode === 'nearest_enemy') {
    const nearest = nearestEnemy();
    if (nearest) return nearest.lane;
  }
  if ((targeting?.mode === 'lane' || targeting?.mode === 'lane_cluster') && Number.isFinite(targeting.lane)) {
    return clamp(Math.round(targeting.lane), 0, LANE_COUNT - 1);
  }
  if (targeting?.mode === 'lane_cluster') {
    const pressure = lanePressure();
    const activeLane = pressure.find((entry) => enemies.some((enemy) => !enemy.dead && enemy.lane === entry.lane));
    if (activeLane) return activeLane.lane;
  }
  if (targeting?.mode === 'front_cluster') {
    const front = [...enemies].filter((enemy) => !enemy.dead).sort((a, b) => b.mesh.position.z - a.mesh.position.z)[0];
    if (front) return front.lane;
  }
  return lanePressure()[0].lane;
}

function zoneZForTargeting(targeting, preferredLane = null) {
  if (targeting?.mode === 'nearest' || targeting?.mode === 'nearest_enemy') {
    const nearest = nearestEnemy();
    if (nearest) return nearest.mesh.position.z;
  }
  if (targeting?.mode === 'lane_cluster') {
    const lane =
      Number.isFinite(targeting?.lane) && targeting?.lane >= 0
        ? clamp(Math.round(targeting.lane), 0, LANE_COUNT - 1)
        : preferredLane ?? chooseLaneForZone(targeting);
    const laneEnemies = enemies
      .filter((enemy) => !enemy.dead && enemy.lane === lane)
      .sort((a, b) => b.mesh.position.z - a.mesh.position.z);
    if (laneEnemies.length) {
      const sample = laneEnemies.slice(0, 3);
      const avgZ = sample.reduce((sum, enemy) => sum + enemy.mesh.position.z, 0) / sample.length;
      return clamp(avgZ, START_Z + 6, BASE_Z - 4);
    }
  }
  if (targeting?.mode === 'front_cluster') {
    const front = [...enemies].filter((enemy) => !enemy.dead).sort((a, b) => b.mesh.position.z - a.mesh.position.z)[0];
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
    if (laneEnemies.length) {
      return laneEnemies.sort((a, b) => b.mesh.position.z - a.mesh.position.z)[0];
    }
  }
  if (targeting?.mode === 'front_cluster') {
    const front = [...enemies].filter((enemy) => !enemy.dead).sort((a, b) => b.mesh.position.z - a.mesh.position.z)[0];
    if (front) return front;
  }
  return nearestEnemy();
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

function spawnZap(pos, element = 'storm', primaryOverride = null, secondaryOverride = null) {
  const palette = colorForElement(element);
  const mainColor = primaryOverride ?? palette.base;
  const glowColor = secondaryOverride ?? palette.emissive;
  const bolt = new THREE.Mesh(
    new THREE.CylinderGeometry(0.15, 0.15, 5, 6),
    new THREE.MeshStandardMaterial({ color: mainColor, emissive: glowColor, emissiveIntensity: 1.0 })
  );
  bolt.position.set(pos.x, 2.6, pos.z);
  scene.add(bolt);
  projectiles.push({
    kind: 'zap',
    mesh: bolt,
    life: 0.18,
  });
}

function spawnChainArc(from, to, color) {
  const midX = (from.x + to.x) / 2 + (Math.random() - 0.5) * 2;
  const midY = Math.max(from.y, to.y) + 1.5 + Math.random() * 2;
  const midZ = (from.z + to.z) / 2 + (Math.random() - 0.5) * 2;
  const curve = new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(from.x, from.y + 1.5, from.z),
    new THREE.Vector3(midX, midY, midZ),
    new THREE.Vector3(to.x, to.y + 1.5, to.z)
  );
  const geo = new THREE.TubeGeometry(curve, 12, 0.06, 4, false);
  const mat = new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: 2,
    transparent: true,
    opacity: 0.9,
  });
  const tube = new THREE.Mesh(geo, mat);
  scene.add(tube);
  impactFlashes.push({ mesh: tube, life: 0.2, velX: 0, velY: 0, velZ: 0 });
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
  // Unlock progression removed: all core spells are available from wave 1.
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

    const reactionProfile = profileForEnemyKind(enemy.kind);
    const nextPoise = updatePoiseAndStagger(
      { poiseDamage: enemy.poiseDamage, staggerFor: enemy.staggerFor },
      0,
      reactionProfile,
      dt
    );
    enemy.poiseDamage = nextPoise.poiseDamage;
    enemy.staggerFor = nextPoise.staggerFor;

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

    if (enemy.hitTimer > 0) {
      enemy.hitTimer = Math.max(0, enemy.hitTimer - dt);
      if (enemy.hitTimer === 0 && enemy.staggerFor === 0) {
        setEnemyAnim(enemy.visual, enemy.atCastleWall ? 'attack' : 'run');
      }
    }

    const movementInterrupted = enemy.staggerFor > 0 || enemy.stunnedFor > 0;
    const moveScale = movementInterrupted ? 0 : enemy.frozenFor > 0 ? 0.15 : enemy.slowFactor;
    enemy.visual.playbackScale = moveScale;

    const laneBounds = enemyLaneBounds(enemy);
    const integrated = integrateVelocity(
      {
        positionX: enemy.mesh.position.x,
        positionZ: enemy.mesh.position.z,
        velX: enemy.velX,
        velZ: enemy.velZ,
      },
      dt,
      {
        minX: laneBounds.minX,
        maxX: laneBounds.maxX,
        minZ: ENEMY_MIN_Z,
        maxZ: castleWallFrontZ - 0.35,
        drag: reactionProfile.drag,
        maxSpeedX: reactionProfile.maxSpeedX,
        maxSpeedZ: reactionProfile.maxSpeedZ,
      }
    );
    enemy.mesh.position.x = integrated.positionX;
    enemy.mesh.position.z = integrated.positionZ;
    enemy.velX = integrated.velX;
    enemy.velZ = integrated.velZ;

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
      enemy.mesh.position.z = Math.max(ENEMY_MIN_Z, enemy.mesh.position.z);
    } else {
      if (enemy.velZ > 0) {
        enemy.velZ = 0;
      }
      enemy.atCastleWall = false;
      enemy.wallAttackAccumulatorSeconds = 0;
      if (enemy.hitTimer === 0 && enemy.staggerFor === 0) {
        setEnemyAnim(enemy.visual, 'run');
      }
    }

    if (!blocked && enemy.mesh.position.z >= castleWallFrontZ - 0.35) {
      enemy.atCastleWall = true;
      enemy.mesh.position.z = castleWallFrontZ - 0.35;
    } else if (!blocked) {
      enemy.atCastleWall = false;
      enemy.wallAttackAccumulatorSeconds = 0;
      if (enemy.hitTimer === 0 && enemy.staggerFor === 0) {
        setEnemyAnim(enemy.visual, 'run');
      }
    }

    if (enemy.atCastleWall) {
      const canAttackWall = enemy.staggerFor === 0 && enemy.stunnedFor === 0;
      if (enemy.hitTimer === 0 && canAttackWall) {
        setEnemyAnim(enemy.visual, 'attack');
      }

      if (canAttackWall) {
        const attackScale = enemy.frozenFor > 0 ? 0.15 : enemy.slowFactor;
        enemy.wallAttackAccumulatorSeconds += dt * attackScale;
        while (enemy.wallAttackAccumulatorSeconds >= GOON_ATTACK_INTERVAL_SECONDS && GAME.baseHp > 0) {
          enemy.wallAttackAccumulatorSeconds -= GOON_ATTACK_INTERVAL_SECONDS;
          GAME.baseHp = Math.max(0, GAME.baseHp - GOON_ATTACK_DAMAGE);
        }
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

    if (projectile.kind === 'strike_bolt') {
      projectile.life -= dt;
      const fade = clamp(projectile.life / 0.35, 0, 1);
      projectile.mesh.material.opacity = fade * 0.92;
      projectile.mesh.scale.x = 0.6 + fade * 0.4;
      projectile.mesh.scale.z = 0.6 + fade * 0.4;
      if (projectile.glowLight) {
        projectile.glowLight.intensity = fade * 5;
      }
      if (projectile.groundRing) {
        projectile.groundRing.material.opacity = fade * 0.7;
        projectile.groundRing.scale.setScalar(1 + (1 - fade) * 2);
      }
      if (projectile.life <= 0) {
        scene.remove(projectile.mesh);
        if (projectile.glowLight) scene.remove(projectile.glowLight);
        if (projectile.groundRing) {
          scene.remove(projectile.groundRing);
          projectile.groundRing.geometry.dispose();
          projectile.groundRing.material.dispose();
        }
        projectile.mesh.geometry.dispose();
        projectile.mesh.material.dispose();
        projectiles.splice(i, 1);
      }
      continue;
    }

    if (!projectile.target || projectile.target.dead || !enemies.includes(projectile.target)) {
      if (projectile.secondaryMesh) {
        scene.remove(projectile.secondaryMesh);
        projectile.secondaryMesh.geometry.dispose();
        projectile.secondaryMesh.material.dispose();
      }
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
      if (projectile.secondaryMesh) {
        projectile.secondaryMesh.position.copy(projectile.mesh.position);
      }
      explodeProjectile(projectile);
      if (projectile.glowLight) projectile.mesh.remove(projectile.glowLight);
      if (projectile.secondaryMesh) {
        scene.remove(projectile.secondaryMesh);
        projectile.secondaryMesh.geometry.dispose();
        projectile.secondaryMesh.material.dispose();
      }
      scene.remove(projectile.mesh);
      projectiles.splice(i, 1);
      continue;
    }

    projectile.mesh.position.add(dir.normalize().multiplyScalar(step));
    if (projectile.secondaryMesh) {
      projectile.secondaryMesh.position.copy(projectile.mesh.position);
    }
    if (projectile.spellVfx && projectile.spellVfx.trailEffect !== 'none') {
      spawnTrailParticle(projectile.mesh.position, { vfx: projectile.spellVfx });
    }
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
      applyImpactEffects(enemy, projectile.effects, projectile.element, projectile.intensity || 0.8);
      applyHitReaction(enemy, {
        source: 'projectile',
        damage: dealt,
        intensity: projectile.intensity || 0.8,
        effects: projectile.effects,
        impactPoint: point,
      });
    }
  }

  if (projectile.spellVfx) {
    spawnImpactEffect(point, { vfx: projectile.spellVfx });
  } else {
    const elementColor = colorForElement(projectile.element || 'fire');
    const fx = new THREE.Mesh(
      new THREE.SphereGeometry(0.7, 8, 8),
      new THREE.MeshStandardMaterial({ color: elementColor.base, emissive: elementColor.emissive, emissiveIntensity: 1 })
    );
    fx.position.copy(point);
    scene.add(fx);
    projectiles.push({ kind: 'zap', mesh: fx, life: 0.24 });
  }
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

function applyImpactEffects(enemy, effects, element, intensity = 0.8) {
  if (!Array.isArray(effects) || !effects.length || enemy.dead) {
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

  if (effects.includes('shield_break') && enemy.kind === 'tank') {
    damageEnemy(enemy, 5 + intensity * 7);
  }

  void element;
}

function colorForElement(element) {
  if (element === 'fire') return { base: 0xff8840, emissive: 0x8c2b00 };
  if (element === 'ice') return { base: 0x98d8ff, emissive: 0x246ca9 };
  if (element === 'storm') return { base: 0xa8eeff, emissive: 0x53b7ff };
  if (element === 'earth') return { base: 0x96ac75, emissive: 0x40542a };
  return { base: 0xc59dff, emissive: 0x5d2e8a };
}

function zoneColorForSpell(spell, fallback) {
  const ringColor = spell?.vfx?.ringColor;
  if (typeof ringColor !== 'string') {
    return fallback;
  }
  const normalized = ringColor.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(normalized)) {
    return Number.parseInt(normalized.slice(1), 16);
  }
  if (/^(0x)?[0-9a-f]{6}$/.test(normalized)) {
    return Number.parseInt(normalized.replace(/^0x/, ''), 16);
  }
  return fallback;
}

function enemyInsideZone(enemy, zone) {
  const inLane = enemy.lane >= zone.laneMin && enemy.lane <= zone.laneMax;
  const inDepth = Math.abs(enemy.mesh.position.z - zone.z) <= zone.radius;
  return inLane && inDepth;
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

    wall.mesh.scale.y = 0.72 + (wall.hp / wall.maxHp) * 0.28;
    if (wall.mesh.material && wall.mesh.material.emissiveIntensity !== undefined) {
      wall.mesh.material.emissiveIntensity = 0.12 + Math.sin(GAME.elapsed * 3 + i * 1.1) * 0.08;
    }
  }
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
      const waveFade = clamp(zone.duration / (zone.initialDuration || 6), 0.12, 1);
      if (zone.bodyMesh) {
        zone.bodyMesh.material.opacity = clamp(0.2 + waveFade * 0.35, 0.15, 0.55);
        zone.bodyMesh.rotation.x = Math.sin(GAME.elapsed * 6 + i) * 0.04;
      }
      if (zone.crestMesh) {
        zone.crestMesh.position.y = 2.55 + Math.sin(GAME.elapsed * 4.5 + i * 1.7) * 0.35;
        zone.crestMesh.material.opacity = clamp(0.3 + waveFade * 0.4, 0.18, 0.7);
        zone.crestMesh.scale.y = 1 + Math.sin(GAME.elapsed * 3.2 + i) * 0.08;
      }
      if (zone.foamMesh) {
        zone.foamMesh.material.opacity = clamp(0.08 + waveFade * 0.18, 0.04, 0.28);
        zone.foamMesh.scale.x = 1 + Math.sin(GAME.elapsed * 5 + i * 2.3) * 0.06;
      }
      if (zone.spellVfx && Math.random() < 0.45) {
        const sprayPos = zone.mesh.position.clone();
        sprayPos.x += (Math.random() - 0.5) * 8;
        sprayPos.y += 1.5 + Math.random() * 1.5;
        sprayPos.z -= zone.radius + Math.random() * 1.5;
        spawnZoneParticle(sprayPos, zone.spellVfx, 'spray');
      }
      if (zone.z <= zone.minZ) {
        zone.duration = 0;
      }
      for (const enemy of enemies) {
        if (enemy.dead) continue;
        if (!enemyInsideZone(enemy, zone)) continue;
        enemy.mesh.position.z = Math.max(ENEMY_MIN_Z, enemy.mesh.position.z - zone.pushPerSecond * dt);
      }
    } else if (!zone.isLinkedWall) {
      const ringFade = clamp(zone.duration / (zone.initialDuration || 6), 0.12, 1);
      const pulse = 1 + Math.sin(GAME.elapsed * 2.8 + i * 1.3) * 0.06;
      if (zone.ringMesh) {
        zone.ringMesh.rotation.y += dt * 0.8;
        zone.ringMesh.material.opacity = clamp(0.3 + ringFade * 0.45, 0.2, 0.72);
        zone.ringMesh.scale.set((zone.halfWidth || 1) * pulse, 1, (zone.halfLength || 1) * pulse);
      }
      if (zone.glowDisc) {
        zone.glowDisc.material.opacity = clamp(0.06 + ringFade * 0.22, 0.04, 0.32);
      }
      if (zone.innerRing) {
        zone.innerRing.rotation.y -= dt * 1.4;
        zone.innerRing.material.opacity = clamp(0.12 + ringFade * 0.3, 0.08, 0.48);
        const hw = (zone.halfWidth || 1) * 0.55;
        const hl = (zone.halfLength || 1) * 0.55;
        zone.innerRing.scale.set(hw * pulse, 0.8, hl * pulse);
      }
      if (!zone.ringMesh && zone.mesh.material) {
        zone.mesh.rotation.y += dt * 0.8;
        zone.mesh.material.opacity = clamp(0.25 + (zone.duration / 6) * 0.45, 0.2, 0.72);
      }
      if (zone.spellVfx && Math.random() < 0.25) {
        const risePos = zone.mesh.position.clone();
        risePos.x += (Math.random() - 0.5) * (zone.halfWidth || 3) * 1.4;
        risePos.z += (Math.random() - 0.5) * (zone.radius || 2) * 1.4;
        risePos.y = 0.1;
        spawnZoneParticle(risePos, zone.spellVfx, 'rise');
      }
    }

    while (zone.timer >= zone.tickRate) {
      zone.timer -= zone.tickRate;
      for (const enemy of enemies) {
        if (enemy.dead) continue;
        if (enemyInsideZone(enemy, zone)) {
          const tickDamage = zone.damage * zone.tickRate;
          const tickIntensity = zone.kind === 'wave' ? 0.95 : 0.7;
          damageEnemy(enemy, tickDamage);
          applyImpactEffects(enemy, zone.effects, zone.element || 'arcane', tickIntensity);
          if (canApplyZoneImpulse(GAME.elapsed, enemy.lastZoneImpulseAt, ZONE_IMPULSE_COOLDOWN_SEC)) {
            applyHitReaction(enemy, {
              source: 'zone_tick',
              damage: tickDamage,
              intensity: tickIntensity,
              effects: zone.effects,
              impactPoint: {
                x: zone.mesh.position.x,
                z: zone.z,
              },
            });
            enemy.lastZoneImpulseAt = GAME.elapsed;
          }
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

function updateBeams(dt) {
  for (let i = beams.length - 1; i >= 0; i -= 1) {
    const beam = beams[i];
    beam.duration -= dt;
    beam.timer += dt;

    const fade = clamp(beam.duration / (beam.initialDuration || 2.5), 0.1, 1);
    const pulse = 1 + Math.sin(GAME.elapsed * 8 + i * 2.1) * 0.12;

    if (beam.coreMesh) {
      beam.coreMesh.material.opacity = clamp(0.5 + fade * 0.35, 0.3, 0.85) * pulse;
      beam.coreMesh.material.emissiveIntensity = 1.2 + fade * 0.8;
    }
    if (beam.outerMesh) {
      beam.outerMesh.material.opacity = clamp(0.1 + fade * 0.25, 0.05, 0.35);
      beam.outerMesh.scale.x = pulse;
      beam.outerMesh.scale.z = pulse;
    }

    if (beam.spellVfx && Math.random() < 0.4) {
      const t = Math.random();
      const particlePos = new THREE.Vector3(
        beam.originX + (beam.targetX - beam.originX) * t + (Math.random() - 0.5) * beam.beamWidth,
        beam.originY + (Math.random() - 0.5) * 0.5,
        beam.originZ - beam.beamLength * t
      );
      spawnZoneParticle(particlePos, beam.spellVfx, 'rise');
    }

    while (beam.timer >= beam.tickRate) {
      beam.timer -= beam.tickRate;
      for (const enemy of enemies) {
        if (enemy.dead) continue;
        const ez = enemy.mesh.position.z;
        const ex = enemy.mesh.position.x;
        const inZ = ez <= beam.originZ && ez >= beam.originZ - beam.beamLength;
        const beamXAtZ = beam.originX + (beam.targetX - beam.originX) * ((beam.originZ - ez) / beam.beamLength);
        const inX = Math.abs(ex - beamXAtZ) <= beam.beamWidth * 0.6;
        if (inZ && inX) {
          const tickDamage = beam.damage * beam.tickRate;
          damageEnemy(enemy, tickDamage);
          applyImpactEffects(enemy, beam.effects, beam.element, beam.intensity * 0.7);
          applyHitReaction(enemy, {
            source: 'beam',
            damage: tickDamage,
            intensity: beam.intensity * 0.5,
            effects: beam.effects,
            impactPoint: { x: beamXAtZ, z: ez },
          });
        }
      }
    }

    if (beam.duration <= 0) {
      scene.remove(beam.mesh);
      beams.splice(i, 1);
    }
  }
}

function updateResources(dt) {
  GAME.mana = clamp(GAME.mana + GAME.manaRegen * dt, 0, GAME.maxMana);
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
    updateZones(dt);
    updateBeams(dt);
    updateEnemies(dt);
    updateProjectiles(dt);
    updateTrailParticles(dt);
    updateImpactFlashes(dt);
    updateScreenShake(dt);
    updateZoneParticles(dt);
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
