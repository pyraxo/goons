import * as THREE from 'three';
import { loadEnemyModels } from './enemy-models.js';
import { estimatePrompt } from './prompt/costEstimator.js';
import { MODEL_PRESET_MAP, PromptProcessor, REASONING_EFFORT_PRESET_MAP } from './prompt/promptProcessor.js';
import { PROMPT_TEMPLATE_VERSION } from './prompt/templateDrafts.js';
import { createGoldReservationStore } from './game/economy.js';
import { createEngineSystems } from './game/engineSystems.js';
import { BASE_Z, createInitialGameState } from './game/config.js';
import { buildMap, createCommander, laneX } from './game/world.js';
import { runAgenticApplyWorkflow } from './runtime/agenticApplyWorkflow.js';
import { generateGlbAssetsForArtifact } from './runtime/assets/glbAssetAgent.js';
import { MechanicRuntime } from './runtime/mechanicRuntime.js';
import { InMemorySandboxStateStore } from './runtime/persistence/sandboxStateStore.js';
import { createDefaultPrimitiveRegistry } from './runtime/primitives/primitiveRegistry.js';

const GAME = createInitialGameState();
const PROMPT_EXECUTION_PRESET = 'fast';
const BASELINE_HISTORY_TEXT =
  `No applied prompts yet.\n` +
  `Sandbox baseline: no generated ui/mechanics/units/actions.\n` +
  `Template: ${PROMPT_TEMPLATE_VERSION}`;

const mechanicRuntime = new MechanicRuntime();
const primitiveRegistry = createDefaultPrimitiveRegistry();
const sandboxStateStore = new InMemorySandboxStateStore();

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
  estimateBtn: document.getElementById('estimateBtn'),
  applyBtn: document.getElementById('applyBtn'),
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

const rng = {
  next(min, max) {
    return min + Math.random() * (max - min);
  },
  int(min, max) {
    return Math.floor(this.next(min, max + 1));
  },
};

const goldStore = createGoldReservationStore({
  game: GAME,
  onChanged: refreshHud,
});

const engineSystems = createEngineSystems({
  scene,
  game: GAME,
  commander,
  laneX,
  rng,
  onToast: setToast,
  onHudChanged: refreshHud,
});

engineSystems.setRuntimeHooks({
  onEnemySpawn: ({ enemy }) => {
    mechanicRuntime.dispatchEvent(
      'onEnemySpawn',
      {
        enemy,
        game: runtimeGameContext(),
      },
      engineSystems.applyRuntimeCommand
    );
  },
  onEnemyDeath: ({ enemy, rewardGold }) => {
    mechanicRuntime.dispatchEvent(
      'onEnemyDeath',
      {
        enemy,
        rewardGold,
        game: runtimeGameContext(),
      },
      engineSystems.applyRuntimeCommand
    );
  },
  onKillCombo: ({ comboCount, enemy }) => {
    mechanicRuntime.dispatchEvent(
      'onKillCombo',
      {
        comboCount,
        enemy,
        game: runtimeGameContext(),
      },
      engineSystems.applyRuntimeCommand
    );
  },
  onWaveStart: ({ wave }) => {
    mechanicRuntime.dispatchEvent(
      'onWaveStart',
      {
        wave,
        game: runtimeGameContext(),
      },
      engineSystems.applyRuntimeCommand
    );
  },
});

const promptProcessor = new PromptProcessor(
  {
    reserveGold: goldStore.reserveGold,
    commitReservedGold: goldStore.commitReservedGold,
    refundReservedGold: goldStore.refundReservedGold,
  },
  {
    onQueueUpdated: (queueSize) => {
      dom.queueStatus.textContent = `Queue: ${queueSize}`;
      syncApplyButtonState();
    },
    onStatus: (message) => {
      dom.applyStatus.textContent = message;
    },
    onArtifactApplied: ({ envelope, templateVersion, artifact }) => {
      return applyArtifactToSandbox({ envelope, templateVersion, artifact });
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
let lastTime = performance.now();
let toastTimer = 0;
let resetInFlight = false;
let spellRequestInFlight = false;

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
  await resetSandboxToTemplate('bootstrap');
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

    if (!goldStore.canSpendGold(lastEstimate.estimatedGoldCost)) {
      dom.applyStatus.textContent = 'Apply blocked: not enough Gold at queue time';
      syncApplyButtonState();
      return;
    }

    const preset = PROMPT_EXECUTION_PRESET;
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
  const canAfford = goldStore.canSpendGold(estimate.estimatedGoldCost);
  const selectedPreset = PROMPT_EXECUTION_PRESET;

  dom.previewBody.innerHTML = `
    <div><strong>Types:</strong> ${estimate.classifiedTypes.join(', ')}</div>
    <div><strong>Risk:</strong> ${estimate.riskLevel}</div>
    <div><strong>Cost:</strong> ${estimate.estimatedGoldCost} Gold</div>
    <div><strong>Estimator:</strong> gpt-5.3-codex (reasoning: low)</div>
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
    goldStore.canSpendGold(lastEstimate.estimatedGoldCost) &&
    !GAME.gameOver;
  dom.applyBtn.disabled = !canApply;
}

function updateHud() {
  dom.baseHp.textContent = Math.max(0, Math.floor(GAME.baseHp));
  dom.mana.textContent = `${Math.floor(GAME.mana)} / ${GAME.maxMana}`;
  dom.wave.textContent = String(GAME.wave);
  dom.score.textContent = String(GAME.score);
  dom.gold.textContent = Math.floor(GAME.gold).toLocaleString();
  dom.reservedGold.textContent = Math.floor(goldStore.getReservedGold()).toLocaleString();
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

async function resetSandboxToTemplate(reason) {
  if (resetInFlight) {
    return;
  }

  resetInFlight = true;
  dom.resetSandboxBtn.disabled = true;
  dom.estimateBtn.disabled = true;
  dom.applyBtn.disabled = true;
  dom.applyStatus.textContent = 'Resetting sandbox to template baseline...';

  try {
    promptProcessor.clearQueuedJobs();
    await promptProcessor.waitForIdle(15_000);
    await resetSandboxToBaseline(reason);

    Object.assign(GAME, createInitialGameState());
    engineSystems.resetDynamicState();
    goldStore.clearReservations();
    promptProcessor.clearHistory();

    input.w = false;
    input.a = false;
    input.s = false;
    input.d = false;
    lastEstimate = null;
    estimateInFlight = false;
    spellRequestInFlight = false;
    dom.promptInput.value = '';
    dom.commandInput.value = '';
    dom.preview.hidden = true;
    closeCommand();

    commander.mesh.position.set(0, 0, BASE_Z - 5);
    toastTimer = 0;
    dom.toast.classList.remove('show');
    lastTime = performance.now();

    dom.loopStatus.textContent = 'Loop: Running';
    dom.loopStatus.classList.remove('status-danger');
    dom.loopStatus.classList.add('status-ok');
    refreshHud();
    dom.applyStatus.textContent = 'Sandbox reset to template baseline';
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    dom.applyStatus.textContent = `Sandbox reset failed: ${message}`;
  } finally {
    resetInFlight = false;
    dom.resetSandboxBtn.disabled = false;
    dom.estimateBtn.disabled = false;
    syncApplyButtonState();
  }
}

async function handleSpellCommand(rawPrompt) {
  if (spellRequestInFlight) {
    setToast('Spellcrafting in progress');
    return;
  }

  if (GAME.globalCooldown > 0) {
    engineSystems.castFromPrompt(rawPrompt);
    return;
  }

  spellRequestInFlight = true;
  try {
    const response = await fetch('/api/spells/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'same-origin',
      body: JSON.stringify(engineSystems.buildSpellGenerationContext(rawPrompt)),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    const casted = engineSystems.castFromGeneratedSpell(payload?.spell);
    if (!casted) {
      engineSystems.castFromPrompt(rawPrompt);
      return;
    }

    if (payload?.source === 'fallback') {
      const reason = payload?.meta?.fallbackReason ? ` (${payload.meta.fallbackReason})` : '';
      setToast(`Fallback cast${reason}`);
      return;
    }

    const effectText =
      Array.isArray(payload?.spell?.effects) && payload.spell.effects.length > 0
        ? payload.spell.effects.join('+')
        : 'none';
    setToast(`LLM: ${payload?.spell?.archetype || 'spell'}/${effectText}`);
  } catch (error) {
    console.warn('[main] spell generation failed, falling back to local parser', error);
    engineSystems.castFromPrompt(rawPrompt);
  } finally {
    spellRequestInFlight = false;
  }
}

function animate() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  if (!GAME.gameOver) {
    GAME.elapsed += dt;
    engineSystems.updateCommander(dt, input);
    engineSystems.updateSpawning(dt);
    engineSystems.updateResources(dt);
    engineSystems.updateWalls(dt);
    engineSystems.updateZones(dt);
    engineSystems.updateEnemies(dt);
    engineSystems.updateProjectiles(dt);
    mechanicRuntime.tick(
      dt,
      {
        game: runtimeGameContext(),
      },
      engineSystems.applyRuntimeCommand
    );
    updateHud();

    if (GAME.baseHp <= 0) {
      gameOver();
    }
  }

  updateToast(dt);
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

function runtimeGameContext() {
  return {
    wave: GAME.wave,
    kills: GAME.kills,
    gold: GAME.gold,
    mana: GAME.mana,
    baseHp: GAME.baseHp,
  };
}

async function resetSandboxToBaseline(reason) {
  mechanicRuntime.clear();
  await sandboxStateStore.reset();
  console.info(`[sandbox] baseline reset (${reason})`);
}

async function applyArtifactToSandbox({ envelope, templateVersion, artifact }) {
  const result = await runAgenticApplyWorkflow({
    artifact,
    envelope,
    templateVersion: templateVersion ?? PROMPT_TEMPLATE_VERSION,
    primitiveRegistry,
    mechanicRuntime,
    sandboxStateStore,
    generateAssets: ({ envelope: nextEnvelope, artifact: nextArtifact }) =>
      generateGlbAssetsForArtifact({
        envelope: nextEnvelope,
        artifact: nextArtifact,
      }),
    resetToBaseline: resetSandboxToBaseline,
    logger: console,
  });

  return {
    generatedAssets: result.assets.length,
    activatedMechanics: result.activatedMechanics,
  };
}

function isTypingTarget(target) {
  if (!target || typeof target.closest !== 'function') {
    return false;
  }

  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}
