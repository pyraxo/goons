import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { disposeEnemyVisual, loadEnemyModels, setEnemyAnim, spawnEnemyVisual } from './enemy-models.js';
import { estimatePrompt } from './prompt/costEstimator.js';
import { MODEL_PRESET_MAP, PromptProcessor, REASONING_EFFORT_PRESET_MAP } from './prompt/promptProcessor.js';
import { PROMPT_TEMPLATE_VERSION } from './prompt/templateDrafts.js';
import { BASE_Z } from './game/config.js';
import { buildMap, createCommander } from './game/world.js';

const PROMPT_EXECUTION_PRESET = 'fast';
const STATE_POLL_INTERVAL_MS = 50;
const INPUT_PUSH_INTERVAL_MS = 35;

const GAME = {
  baseHp: 10000,
  maxMana: 120,
  mana: 120,
  score: 0,
  wave: 1,
  gold: 0,
  gameOver: false,
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

const BASELINE_HISTORY_TEXT =
  `No applied prompts yet.\n` +
  `Sandbox baseline: no generated ui/mechanics/units/actions.\n` +
  `Template: ${PROMPT_TEMPLATE_VERSION}`;

const dom = {
  baseHp: document.getElementById('baseHp'),
  mana: document.getElementById('mana'),
  wave: document.getElementById('wave'),
  score: document.getElementById('score'),
  gold: document.getElementById('gold'),
  reservedGold: document.getElementById('reservedGold'),
  loopStatus: document.getElementById('loopStatus'),
  queueStatus: document.getElementById('queueStatus'),
  applyStatus: document.getElementById('applyStatus'),
  commandWrap: document.getElementById('commandWrap'),
  commandInput: document.getElementById('commandInput'),
  preview: document.getElementById('preview'),
  previewBody: document.getElementById('previewBody'),
  historyScript: document.getElementById('historyScript'),
  promptInput: document.getElementById('promptInput'),
  submitPromptBtn: document.getElementById('submitPromptBtn'),
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

buildMap(scene);

const commander = createCommander();
scene.add(commander.mesh);

const input = {
  w: false,
  a: false,
  s: false,
  d: false,
  commandOpen: false,
};

const promptReservations = new Map();

const promptReservationStore = {
  canSpendGold(amount) {
    const numeric = Number(amount);
    return Number.isFinite(numeric) && numeric > 0 && GAME.gold >= numeric;
  },
  reserveGold(amount) {
    const numeric = Number(amount);
    if (!this.canSpendGold(numeric)) {
      return null;
    }
    const id = `res_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    promptReservations.set(id, numeric);
    return id;
  },
  commitReservedGold(reservationId) {
    if (!promptReservations.has(reservationId)) {
      return false;
    }
    promptReservations.delete(reservationId);
    return true;
  },
  refundReservedGold(reservationId) {
    if (!promptReservations.has(reservationId)) {
      return false;
    }
    promptReservations.delete(reservationId);
    return true;
  },
  getReservedGold() {
    let total = 0;
    for (const amount of promptReservations.values()) {
      total += amount;
    }
    return total;
  },
  clearReservations() {
    promptReservations.clear();
  },
};

const promptProcessor = new PromptProcessor(
  {
    reserveGold: (amount) => promptReservationStore.reserveGold(amount),
    commitReservedGold: (id) => promptReservationStore.commitReservedGold(id),
    refundReservedGold: (id) => promptReservationStore.refundReservedGold(id),
  },
  {
    onQueueUpdated: (queueSize) => {
      dom.queueStatus.textContent = `Queue: ${queueSize}`;
      syncSubmitButtonState();
    },
    onStatus: (message) => {
      dom.applyStatus.textContent = message;
    },
    onArtifactApplied: async ({ envelope, templateVersion, artifact }) => {
      const response = await fetch('/api/game/apply-artifact', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'same-origin',
        body: JSON.stringify({
          envelope,
          templateVersion,
          artifact,
        }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(String(payload?.error || `HTTP ${response.status}`));
      }

      await pollGameState(true);
      return payload?.result ?? { generatedAssets: 0, activatedMechanics: 0, skippedMechanics: [] };
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

const enemyVisuals = new Map();
const unitVisuals = new Map();
const wallVisuals = new Map();
const projectileVisuals = new Map();
const zoneVisuals = new Map();
const actionVisualMeshes = new Map();
const widgetElements = new Map();
const widgetZones = new Map();

const glbLoader = new GLTFLoader();
const glbModelCache = new Map();

let latestSnapshot = null;
let lastEstimate = null;
let estimateInFlight = false;
let resetInFlight = false;
let stateRequestInFlight = false;
let lastStatePollAt = 0;
let lastInputPushAt = 0;
let toastTimer = 0;
let lastTime = performance.now();

window.addEventListener('resize', onResize);
window.addEventListener('keydown', onKeyDown);
window.addEventListener('keyup', onKeyUp);

dom.resetSandboxBtn.addEventListener('click', () => {
  void resetSandboxToTemplate('manual');
});

window.resetSandboxToTemplate = () => resetSandboxToTemplate('manual');

dom.commandInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    const value = dom.commandInput.value.trim();
    dom.commandInput.value = '';
    closeCommand();
    if (value) {
      void handleSpellCommand(value);
    }
  }

  if (event.key === 'Escape') {
    closeCommand();
  }
});

setupPromptUi();
bootstrap();

async function bootstrap() {
  dom.loopStatus.textContent = 'Loop: Syncing';
  dom.loopStatus.classList.remove('status-danger');
  dom.loopStatus.classList.remove('status-ok');

  try {
    await loadEnemyModels(scene);
  } catch (error) {
    console.warn('[main] Enemy model preload failed. Fallback meshes will be used.', error);
  }

  await resetSandboxToTemplate('bootstrap');

  dom.loopStatus.textContent = 'Loop: Running';
  dom.loopStatus.classList.remove('status-danger');
  dom.loopStatus.classList.add('status-ok');

  animate();
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function onKeyDown(event) {
  if (GAME.gameOver) {
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

  let changed = false;
  if (event.key === 'w' || event.key === 'W') {
    changed = !input.w;
    input.w = true;
  }
  if (event.key === 'a' || event.key === 'A') {
    changed = changed || !input.a;
    input.a = true;
  }
  if (event.key === 's' || event.key === 'S') {
    changed = changed || !input.s;
    input.s = true;
  }
  if (event.key === 'd' || event.key === 'D') {
    changed = changed || !input.d;
    input.d = true;
  }

  if (changed) {
    void pushInputState(true);
  }
}

function onKeyUp(event) {
  let changed = false;
  if (event.key === 'w' || event.key === 'W') {
    changed = changed || input.w;
    input.w = false;
  }
  if (event.key === 'a' || event.key === 'A') {
    changed = changed || input.a;
    input.a = false;
  }
  if (event.key === 's' || event.key === 'S') {
    changed = changed || input.s;
    input.s = false;
  }
  if (event.key === 'd' || event.key === 'D') {
    changed = changed || input.d;
    input.d = false;
  }

  if (changed) {
    void pushInputState(true);
  }
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

async function submitPrompt() {
  if (estimateInFlight) return;

  const raw = dom.promptInput.value.trim();
  if (!raw) return;

  estimateInFlight = true;
  dom.submitPromptBtn.disabled = true;
  dom.applyStatus.textContent = 'Estimating...';

  try {
    const estimate = await estimatePrompt(raw);

    if (!promptReservationStore.canSpendGold(estimate.estimatedGoldCost)) {
      dom.applyStatus.textContent = `Not enough Gold (need ${estimate.estimatedGoldCost})`;
      return;
    }

    const preset = PROMPT_EXECUTION_PRESET;
    promptProcessor.enqueue(estimate, preset);
    dom.applyStatus.textContent = `Queued ${estimate.id} (cost: ${estimate.estimatedGoldCost}g)`;
    dom.promptInput.value = '';
    lastEstimate = null;
    dom.preview.hidden = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    dom.applyStatus.textContent = `Submit failed: ${message}`;
  } finally {
    estimateInFlight = false;
    dom.submitPromptBtn.disabled = false;
    syncSubmitButtonState();
  }
}

function setupPromptUi() {
  dom.submitPromptBtn.addEventListener('click', () => submitPrompt());

  dom.promptInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submitPrompt();
    }
  });

  dom.queueStatus.textContent = `Queue: ${promptProcessor.getQueueSize()}`;
  dom.applyStatus.textContent = 'Ready';
  dom.historyScript.textContent = BASELINE_HISTORY_TEXT;
}

function renderEstimate(estimate) {
  const canAfford = promptReservationStore.canSpendGold(estimate.estimatedGoldCost);
  const selectedPreset = PROMPT_EXECUTION_PRESET;

  dom.previewBody.innerHTML = `
    <div><strong>Types:</strong> ${estimate.classifiedTypes.join(', ')}</div>
    <div><strong>Risk:</strong> ${estimate.riskLevel}</div>
    <div><strong>Cost:</strong> ${estimate.estimatedGoldCost} Gold</div>
    <div><strong>Estimator:</strong> gemini-3-flash-preview</div>
    <div><strong>Preset Model:</strong> ${MODEL_PRESET_MAP[selectedPreset]} (reasoning: ${REASONING_EFFORT_PRESET_MAP[selectedPreset]})</div>
    <div><strong>Review Required:</strong> ${estimate.requiresReview ? 'yes' : 'no'}</div>
    <div><strong>Can Afford:</strong> ${canAfford ? 'yes' : 'no'}</div>
  `;

  dom.preview.hidden = false;
}

function syncSubmitButtonState() {
  dom.submitPromptBtn.disabled = estimateInFlight || GAME.gameOver;
}

function updateHud() {
  dom.baseHp.textContent = Math.max(0, Math.floor(GAME.baseHp));
  dom.mana.textContent = `${Math.floor(GAME.mana)} / ${GAME.maxMana}`;
  dom.wave.textContent = String(GAME.wave);
  dom.score.textContent = String(GAME.score);
  dom.gold.textContent = Math.floor(GAME.gold).toLocaleString();

  const reservedFromState = Number(latestSnapshot?.reservedGold);
  const fallbackReserved = promptReservationStore.getReservedGold();
  dom.reservedGold.textContent = Math.floor(Number.isFinite(reservedFromState) ? reservedFromState : fallbackReserved).toLocaleString();

  syncSubmitButtonState();
}

function setToast(text) {
  if (!text) return;
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

async function pushInputState(force = false) {
  const now = Date.now();
  if (!force && now - lastInputPushAt < INPUT_PUSH_INTERVAL_MS) {
    return;
  }
  lastInputPushAt = now;

  try {
    await fetch('/api/game/input', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'same-origin',
      body: JSON.stringify({
        input: {
          w: input.w,
          a: input.a,
          s: input.s,
          d: input.d,
        },
      }),
    });
  } catch (error) {
    console.warn('[main] failed to push input state', error);
  }
}

async function pollGameState(force = false) {
  const now = Date.now();
  if (!force && now - lastStatePollAt < STATE_POLL_INTERVAL_MS) {
    return;
  }
  if (stateRequestInFlight) {
    return;
  }

  stateRequestInFlight = true;
  lastStatePollAt = now;

  try {
    const response = await fetch('/api/game/state', {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    const state = payload?.state;
    if (!state || typeof state !== 'object') {
      return;
    }

    latestSnapshot = state;
    applySnapshot(state);
  } catch (error) {
    console.warn('[main] game state poll failed', error);
  } finally {
    stateRequestInFlight = false;
  }
}

function applySnapshot(state) {
  const game = state?.game ?? {};
  GAME.baseHp = Number(game.baseHp ?? GAME.baseHp);
  GAME.maxMana = Number(game.maxMana ?? GAME.maxMana);
  GAME.mana = Number(game.mana ?? GAME.mana);
  GAME.score = Number(game.score ?? GAME.score);
  GAME.wave = Number(game.wave ?? GAME.wave);
  GAME.gold = Number(game.gold ?? GAME.gold);
  GAME.gameOver = Boolean(game.gameOver);

  if (GAME.gameOver) {
    dom.loopStatus.textContent = 'Loop: Halted';
    dom.loopStatus.classList.remove('status-ok');
    dom.loopStatus.classList.add('status-danger');
  } else {
    dom.loopStatus.textContent = 'Loop: Running';
    dom.loopStatus.classList.remove('status-danger');
    dom.loopStatus.classList.add('status-ok');
  }

  commander.mesh.position.x = Number(state?.commander?.x ?? commander.mesh.position.x);
  commander.mesh.position.z = Number(state?.commander?.z ?? commander.mesh.position.z);

  syncEnemyVisuals(state?.enemies ?? []);
  syncUnitVisuals(state?.units ?? []);
  syncWallVisuals(state?.walls ?? []);
  syncProjectileVisuals(state?.projectiles ?? []);
  syncZoneVisuals(state?.zones ?? []);
  syncActionVisuals(state?.actionVisuals ?? []);
  syncWidgetPanels(state?.mountedWidgets ?? []);

  const toastMessage = String(state?.latestToast?.message ?? '').trim();
  if (toastMessage) {
    const toastAt = Number(state?.latestToast?.at ?? 0);
    const knownAt = Number(dom.toast.dataset.at || 0);
    if (!knownAt || (Number.isFinite(toastAt) && toastAt > knownAt)) {
      dom.toast.dataset.at = String(toastAt || Date.now());
      setToast(toastMessage);
    }
  }

  updateHud();
}

function syncEnemyVisuals(enemies) {
  const nextIds = new Set();

  for (const enemy of enemies) {
    if (!enemy || enemy.dead) continue;
    const id = String(enemy.id);
    nextIds.add(id);

    let entry = enemyVisuals.get(id);
    if (!entry) {
      const visual = spawnEnemyVisual(
        String(enemy.kind || 'melee'),
        Number(enemy.lane || 0),
        new THREE.Vector3(Number(enemy.x || 0), 0, Number(enemy.z || 0))
      );
      scene.add(visual.group);
      entry = {
        visual,
        state: null,
      };
      enemyVisuals.set(id, entry);
    }

    entry.visual.group.position.x = Number(enemy.x || 0);
    entry.visual.group.position.z = Number(enemy.z || 0);
    entry.visual.playbackScale = Number(enemy.frozenFor || 0) > 0 ? 0.15 : 1;

    const anim = String(enemy.anim || 'run');
    if (entry.state !== anim) {
      setEnemyAnim(entry.visual, anim);
      entry.state = anim;
    }
  }

  for (const [id, entry] of enemyVisuals.entries()) {
    if (nextIds.has(id)) continue;
    disposeEnemyVisual(entry.visual);
    enemyVisuals.delete(id);
  }
}

function wallMaterial() {
  return new THREE.MeshStandardMaterial({ color: 0x6f7f95, roughness: 0.92 });
}

function parseColor(value, fallback) {
  const text = String(value ?? '').trim();
  if (/^#[0-9a-f]{6}$/i.test(text)) {
    return Number.parseInt(text.slice(1), 16);
  }
  return fallback;
}

const ROLE_TINTS = {
  striker: 0xff6633,
  tank: 0x4488dd,
  healer: 0x44cc66,
  support: 0x9966cc,
  ranged: 0xddaa33,
};

function roleTint(role) {
  const key = String(role || '').toLowerCase();
  return ROLE_TINTS[key] ?? 0x8ab4ff;
}

function createUnitMesh(shape, tintHex, role) {
  const color = parseColor(tintHex, roleTint(role));
  const emissive = color;
  const mat = { color, emissive, emissiveIntensity: 0.3, roughness: 0.38, metalness: 0.12 };
  const safeShape = String(shape || 'capsule');
  if (safeShape === 'box') {
    return new THREE.Mesh(new THREE.BoxGeometry(1.8, 2.2, 1.8), new THREE.MeshStandardMaterial(mat));
  }
  if (safeShape === 'sphere') {
    return new THREE.Mesh(new THREE.SphereGeometry(1.1, 16, 16), new THREE.MeshStandardMaterial(mat));
  }
  if (safeShape === 'cone') {
    return new THREE.Mesh(new THREE.ConeGeometry(1.1, 2.8, 10), new THREE.MeshStandardMaterial(mat));
  }
  return new THREE.Mesh(new THREE.CapsuleGeometry(0.85, 1.4, 6, 10), new THREE.MeshStandardMaterial(mat));
}

function loadGlbModel(path) {
  const cached = glbModelCache.get(path);
  if (cached) return cached;

  const promise = glbLoader
    .loadAsync(path)
    .then((gltf) => {
      const model = gltf.scene;
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const targetHeight = 1.6;
      const scaleFactor = targetHeight / Math.max(size.y, 0.01);
      model.scale.multiplyScalar(scaleFactor);

      const groundOffset = -box.min.y * scaleFactor;
      model.position.y = groundOffset;

      model.traverse((child) => {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });

      return model;
    })
    .catch((err) => {
      console.warn(`[main] GLB load failed for ${path}`, err);
      glbModelCache.delete(path);
      return null;
    });

  glbModelCache.set(path, promise);
  return promise;
}

function syncUnitVisuals(units) {
  const nextIds = new Set();

  for (const unit of units) {
    const id = String(unit.id);
    nextIds.add(id);

    let entry = unitVisuals.get(id);
    if (!entry) {
      const mesh = createUnitMesh(unit.fallbackShape, unit.tint, unit.role);
      mesh.castShadow = true;
      scene.add(mesh);
      entry = { mesh, glbAttempted: false, assetPath: '' };
      unitVisuals.set(id, entry);
    }

    const assetPath = String(unit.assetPath || '');
    if (assetPath && (!entry.glbAttempted || entry.assetPath !== assetPath)) {
      entry.glbAttempted = true;
      entry.assetPath = assetPath;
      loadGlbModel(assetPath).then((model) => {
        if (!model) return;
        const current = unitVisuals.get(id);
        if (!current) return;
        const cloned = model.clone();
        cloned.position.copy(current.mesh.position);
        cloned.scale.copy(current.mesh.scale);
        scene.remove(current.mesh);
        scene.add(cloned);
        current.mesh = cloned;
      });
    }

    const scale = clamp(Number(unit.scale || 1), 0.8, 4);
    const heightScale = scale * (1 + Math.abs(((unit.id?.charCodeAt?.(5) || 0) % 5) * 0.15));
    entry.mesh.position.set(Number(unit.x || 0), scale * 1.1, Number(unit.z || 0));
    entry.mesh.scale.set(scale, heightScale, scale);
    if (entry.mesh.material) {
      const tint = parseColor(unit.tint, roleTint(unit.role));
      entry.mesh.material.color.setHex(tint);
    }
  }

  for (const [id, entry] of unitVisuals.entries()) {
    if (nextIds.has(id)) continue;
    scene.remove(entry.mesh);
    unitVisuals.delete(id);
  }
}

function syncWallVisuals(walls) {
  const nextIds = new Set();

  for (const wall of walls) {
    const id = String(wall.id);
    nextIds.add(id);

    let mesh = wallVisuals.get(id);
    if (!mesh) {
      mesh = new THREE.Mesh(new THREE.BoxGeometry(5.6, 3.6, 1.2), wallMaterial());
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
      wallVisuals.set(id, mesh);
    }

    mesh.position.set(Number(wall.x || 0), 1.8, Number(wall.z || 0));
    const hp = Number(wall.hp || 0);
    const maxHp = Math.max(1, Number(wall.maxHp || 140));
    mesh.scale.y = 0.72 + clamp(hp / maxHp, 0, 1) * 0.28;
  }

  for (const [id, mesh] of wallVisuals.entries()) {
    if (nextIds.has(id)) continue;
    scene.remove(mesh);
    wallVisuals.delete(id);
  }
}

function projectileMesh(kind) {
  if (kind === 'zap') {
    return new THREE.Mesh(
      new THREE.CylinderGeometry(0.15, 0.15, 5, 6),
      new THREE.MeshStandardMaterial({ color: 0xa8eeff, emissive: 0x53b7ff, emissiveIntensity: 1.0 })
    );
  }

  return new THREE.Mesh(
    new THREE.SphereGeometry(0.56, 10, 10),
    new THREE.MeshStandardMaterial({ color: 0xff8840, emissive: 0x8c2b00, emissiveIntensity: 0.9 })
  );
}

function syncProjectileVisuals(projectiles) {
  const nextIds = new Set();

  for (const projectile of projectiles) {
    const id = String(projectile.id);
    nextIds.add(id);

    let mesh = projectileVisuals.get(id);
    if (!mesh) {
      mesh = projectileMesh(String(projectile.kind || 'fireball'));
      mesh.castShadow = true;
      scene.add(mesh);
      projectileVisuals.set(id, mesh);
    }

    mesh.position.set(Number(projectile.x || 0), Number(projectile.y || 1.5), Number(projectile.z || 0));
  }

  for (const [id, mesh] of projectileVisuals.entries()) {
    if (nextIds.has(id)) continue;
    scene.remove(mesh);
    projectileVisuals.delete(id);
  }
}

function zoneMaterial() {
  return new THREE.MeshStandardMaterial({
    color: 0xffa347,
    emissive: 0xff5e00,
    emissiveIntensity: 0.25,
    transparent: true,
    opacity: 0.45,
  });
}

function syncZoneVisuals(zones) {
  const nextIds = new Set();

  for (const zone of zones) {
    const id = String(zone.id);
    nextIds.add(id);

    let mesh = zoneVisuals.get(id);
    if (!mesh) {
      mesh = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.22, 24), zoneMaterial());
      mesh.receiveShadow = true;
      scene.add(mesh);
      zoneVisuals.set(id, mesh);
    }

    const laneMin = Number(zone.laneMin ?? 0);
    const laneMax = Number(zone.laneMax ?? laneMin);
    const centerLane = (laneMin + laneMax) * 0.5;
    const x = (centerLane - 2) * 8;
    const radius = Math.max(0.8, Number(zone.radius || 2));
    const laneWidth = Math.max(1, laneMax - laneMin + 1);
    mesh.position.set(x, 0.12, Number(zone.z || 0));
    mesh.scale.set(radius * laneWidth, 1, radius * 1.2);
  }

  for (const [id, mesh] of zoneVisuals.entries()) {
    if (nextIds.has(id)) continue;
    scene.remove(mesh);
    zoneVisuals.delete(id);
  }
}

function actionMesh(kind, colorHex) {
  if (kind === 'orb') {
    return new THREE.Mesh(
      new THREE.SphereGeometry(0.8, 12, 12),
      new THREE.MeshStandardMaterial({
        color: colorHex,
        emissive: colorHex,
        emissiveIntensity: 0.7,
        transparent: true,
        opacity: 0.55,
      })
    );
  }
  if (kind === 'wave') {
    return new THREE.Mesh(
      new THREE.BoxGeometry(4.5, 0.35, 1.8),
      new THREE.MeshStandardMaterial({
        color: colorHex,
        emissive: colorHex,
        emissiveIntensity: 0.45,
        transparent: true,
        opacity: 0.5,
      })
    );
  }
  return new THREE.Mesh(
    new THREE.TorusGeometry(1.2, 0.12, 10, 20),
    new THREE.MeshStandardMaterial({
      color: colorHex,
      emissive: colorHex,
      emissiveIntensity: 0.7,
      transparent: true,
      opacity: 0.58,
    })
  );
}

function syncActionVisuals(actionVisuals) {
  const nextIds = new Set();

  for (const visual of actionVisuals) {
    const id = String(visual.id);
    nextIds.add(id);
    const colorHex = parseColor(visual.color, 0xff9f59);

    let mesh = actionVisualMeshes.get(id);
    if (!mesh) {
      mesh = actionMesh(String(visual.kind || 'ring'), colorHex);
      scene.add(mesh);
      actionVisualMeshes.set(id, mesh);
    }

    mesh.position.set(Number(visual.x || 0), 0.3, Number(visual.z || 0));
    const radius = Math.max(0.6, Number(visual.radius || 1.5));
    if (visual.kind === 'wave') {
      mesh.scale.set(radius, 1, 1);
    } else {
      mesh.scale.set(radius, 1, radius);
    }
  }

  for (const [id, mesh] of actionVisualMeshes.entries()) {
    if (nextIds.has(id)) continue;
    scene.remove(mesh);
    actionVisualMeshes.delete(id);
  }
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getWidgetZone(position) {
  const key = String(position || 'top-right');
  let zone = widgetZones.get(key);
  if (!zone) {
    zone = document.createElement('div');
    zone.className = `widget-zone widget-zone--${key}`;
    document.body.appendChild(zone);
    widgetZones.set(key, zone);
  }
  return zone;
}

function syncWidgetPanels(widgets) {
  const nextIds = new Set();

  for (const widget of widgets) {
    const id = String(widget.id);
    nextIds.add(id);

    let panel = widgetElements.get(id);
    const position = String(widget.position || 'top-right');

    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'widget-panel';
      panel.dataset.widgetId = id;
      panel.innerHTML = `<div class="widget-title"></div><pre class="widget-content"></pre>`;
      const zone = getWidgetZone(position);
      zone.appendChild(panel);
      widgetElements.set(id, { el: panel, position });
    }

    if (panel.position !== position) {
      const zone = getWidgetZone(position);
      zone.appendChild(panel.el);
      panel.position = position;
    }

    panel.el.querySelector('.widget-title').textContent = String(widget.title || '');
    panel.el.querySelector('.widget-content').textContent = String(widget.content || '');
  }

  for (const [id, panel] of widgetElements.entries()) {
    if (nextIds.has(id)) continue;
    panel.el.remove();
    widgetElements.delete(id);
  }
}

function clearAllWidgets() {
  for (const [, panel] of widgetElements) {
    panel.el.remove();
  }
  widgetElements.clear();
  for (const [, zone] of widgetZones) {
    zone.remove();
  }
  widgetZones.clear();
}

async function resetSandboxToTemplate(reason) {
  if (resetInFlight) {
    return;
  }

  resetInFlight = true;
  dom.resetSandboxBtn.disabled = true;
  dom.submitPromptBtn.disabled = true;
  dom.applyStatus.textContent = 'Resetting sandbox to template baseline...';

  try {
    promptProcessor.clearQueuedJobs();
    await promptProcessor.waitForIdle(15_000);
    promptReservationStore.clearReservations();
    promptProcessor.clearHistory();

    input.w = false;
    input.a = false;
    input.s = false;
    input.d = false;

    lastEstimate = null;
    estimateInFlight = false;
    dom.promptInput.value = '';
    dom.commandInput.value = '';
    dom.preview.hidden = true;
    closeCommand();

    const response = await fetch('/api/game/reset', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'same-origin',
      body: JSON.stringify({ reason }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(String(body?.error || `HTTP ${response.status}`));
    }

    await pushInputState(true);
    await pollGameState(true);

    clearAllWidgets();
    glbModelCache.clear();
    commander.mesh.position.set(0, 0, BASE_Z - 5);
    toastTimer = 0;
    dom.toast.classList.remove('show');
    dom.loopStatus.textContent = 'Loop: Running';
    dom.loopStatus.classList.remove('status-danger');
    dom.loopStatus.classList.add('status-ok');
    dom.applyStatus.textContent = 'Sandbox reset to template baseline';
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    dom.applyStatus.textContent = `Sandbox reset failed: ${message}`;
  } finally {
    resetInFlight = false;
    dom.resetSandboxBtn.disabled = false;
    dom.submitPromptBtn.disabled = false;
    syncSubmitButtonState();
  }
}

async function handleSpellCommand(rawPrompt) {
  try {
    const response = await fetch('/api/game/cast', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'same-origin',
      body: JSON.stringify({ prompt: rawPrompt }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(String(payload?.error || `HTTP ${response.status}`));
    }

    const message = String(payload?.result?.message ?? '').trim();
    if (message) {
      setToast(message);
    }

    await pollGameState(true);
  } catch (error) {
    console.warn('[main] spell command failed', error);
    setToast('Spell command failed');
  }
}

function animate() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  void pollGameState(false);
  void pushInputState(false);

  for (const entry of enemyVisuals.values()) {
    entry.visual.update(dt);
  }

  updateToast(dt);
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

function isTypingTarget(target) {
  if (!target || typeof target.closest !== 'function') {
    return false;
  }

  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}
