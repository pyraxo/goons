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
import { disposeEnemyVisual, flashEnemyHit, loadEnemyModels, setEnemyAnim, spawnEnemyVisual } from './enemy-models.js';
import { PromptProcessor } from './prompt/promptProcessor.js';
import { PROMPT_TEMPLATE_VERSION } from './prompt/templateDrafts.js';
import { playHurt, playDeath } from './sfx.js';

const LANE_COUNT = 5;
const LANE_SPACING = 8;
const LANE_HALF_WIDTH = 2.9;
const START_Z = -78;
const ENEMY_MIN_Z = START_Z + 2;
const BASE_Z = 33;
const MAP_WIDTH = 52;
const CASTLE_WALL_DEPTH = 4;
const CASTLE_WALL_FRONT_Z = BASE_Z - 18;
const CASTLE_WALL_Z = CASTLE_WALL_FRONT_Z + CASTLE_WALL_DEPTH * 0.5;
const COMMANDER_MIN_Z = CASTLE_WALL_FRONT_Z + CASTLE_WALL_DEPTH + 0.35;
const COMMANDER_MAX_Z = BASE_Z + 4;
const GOON_ATTACK_INTERVAL_SECONDS = 3;
const GOON_ATTACK_DAMAGE = 1;
const DIRECT_SPELL_BACKEND_ORIGIN = import.meta.env.VITE_SPELL_BACKEND_ORIGIN || 'http://127.0.0.1:8787';
const MAX_SPELL_HISTORY_ITEMS = 18;

const GAME = {
  baseHp: 200,
  score: 0,
  wave: 1,
  elapsed: 0,
  kills: 0,
  unlocks: ['fireball', 'wall', 'frost', 'bolt'],
  gameOver: false,
};


const SPELLS = {
  fireball: {
    description: 'Auto-targets nearest enemy and explodes.',
    cast: castFireball,
  },
  wall: {
    description: 'Summons a lane wall to stall enemies.',
    cast: castWall,
  },
  frost: {
    description: 'Freezes enemies in all lanes for 2s.',
    cast: castFrost,
  },
  bolt: {
    description: 'Chain lightning strikes multiple enemies.',
    cast: castBolt,
  },
  arcane_missiles: {
    description: 'Rapid 3-shot arcane burst at nearest enemies.',
    cast: castArcaneMissiles,
  },
  meteor: {
    description: 'Massive fireball from the sky. Burns and knocks back.',
    cast: castMeteor,
  },
  vines: {
    description: 'Thorny vines root and slow enemies in an area.',
    cast: castVines,
  },
};

const enemies = [];
const projectiles = [];
const walls = [];
const zones = [];
const spellQueue = [];
let spellQueueProcessing = false;

const dom = {
  baseHp: document.getElementById('baseHp'),
  baseHpBar: document.getElementById('baseHpBar'),
  wave: document.getElementById('wave'),
  score: document.getElementById('score'),
  unlocks: document.getElementById('unlocks'),
  loopStatus: document.getElementById('loopStatus'),
  queueStatus: document.getElementById('queueStatus'),
  applyStatus: document.getElementById('applyStatus'),
  historyScript: document.getElementById('historyScript'),
  spellHistoryList: document.getElementById('spellHistoryList'),
  promptInput: document.getElementById('promptInput'),
  cancelSpellQueueBtn: document.getElementById('cancelSpellQueueBtn'),
  resetSandboxBtn: document.getElementById('resetSandboxBtn'),
  toast: document.getElementById('toast'),
  statsFps: document.getElementById('statsFps'),
  statsEnemies: document.getElementById('statsEnemies'),
  statsDraws: document.getElementById('statsDraws'),
  statsTris: document.getElementById('statsTris'),
};

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x1a0800, 60, 170);

const POOL_GEO = {
  sphereSmall: new THREE.SphereGeometry(1, 4, 4),
  sphereMed: new THREE.SphereGeometry(1, 5, 5),
  cylinder: new THREE.CylinderGeometry(0.3, 0.3, 4, 4),
  octahedron: new THREE.OctahedronGeometry(1, 0),
  ring: new THREE.RingGeometry(0.4, 1, 6),
};

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.4;
document.body.appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 320);
camera.position.set(0, 46, 42);
camera.lookAt(0, 0, -8);

const ambient = new THREE.AmbientLight(0xcc8866, 0.7);
scene.add(ambient);

const mainLight = new THREE.DirectionalLight(0xffaa66, 1.6);
mainLight.position.set(12, 38, 16);
mainLight.castShadow = true;
mainLight.shadow.mapSize.set(2048, 2048);
mainLight.shadow.camera.left = -70;
mainLight.shadow.camera.right = 70;
mainLight.shadow.camera.top = 70;
mainLight.shadow.camera.bottom = -70;
scene.add(mainLight);

const fillLight = new THREE.DirectionalLight(0xcc5522, 0.8);
fillLight.position.set(-25, 16, -32);
scene.add(fillLight);

const lavaUnderglow = new THREE.DirectionalLight(0xff4400, 0.4);
lavaUnderglow.position.set(0, -5, -30);
scene.add(lavaUnderglow);

const emberParticles = [];
const animatedEnv = { torchLights: [], lavaPools: [], lavaRiverMats: [], smokeColumns: [], bannerMeshes: [] };
buildMap();

const commander = createCommander();
scene.add(commander.mesh);

const input = {
  w: false,
  a: false,
  s: false,
  d: false,
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
  {},
  {
    onQueueUpdated: (queueSize) => {
      dom.queueStatus.textContent = `Queue: ${queueSize}`;
    },
    onStatus: (message) => {
      dom.applyStatus.textContent = message;
    },
    onHistoryUpdated: () => {},
  },
  {
    generationMode: import.meta.env.VITE_GENERATION_MODE ?? 'openai-api-key',
  }
);

let spawnTimer = 0;
let waveTimer = 0;
let lastTime = performance.now();
let toastTimer = 0;
const frameTimes = [];
let statsAccum = 0;
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

setupPromptUi();
initOnboarding();

function initOnboarding() {
  const overlay = document.getElementById('onboarding');
  const startBtn = document.getElementById('obStartBtn');
  if (!overlay) {
    bootstrap();
    return;
  }

  // Preload models while user reads the onboarding screen
  const preload = loadEnemyModels(scene);

  // bg soundtrack - god of goons (needs user gesture to play)
  const bgm = new Audio('/god-of-goons.mp3');
  bgm.loop = true;
  bgm.volume = 0.2;

  let dismissed = false;
  function dismiss() {
    if (dismissed) return;
    dismissed = true;
    bgm.play().catch(() => {});
    overlay.classList.add('ob-exiting');
    setTimeout(() => overlay.remove(), 800);
    bootstrap(preload);
  }

  startBtn.addEventListener('click', dismiss);

  window.addEventListener('keydown', function onFirstKey(e) {
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
    window.removeEventListener('keydown', onFirstKey);
    dismiss();
  });
}

async function bootstrap(preload) {
  refreshHud();
  dom.loopStatus.textContent = 'Loop: Running';
  dom.loopStatus.classList.remove('status-danger');
  dom.loopStatus.classList.add('status-ok');

  try {
    await (preload || loadEnemyModels(scene));
  } catch (error) {
    console.warn('[main] Enemy model preload failed. Fallback meshes will be used.', error);
  }

  animate();
}


// ═══════════════════════════════════════════════════════════════
// PROCEDURAL TEXTURE GENERATORS
// ═══════════════════════════════════════════════════════════════

function makeGroundTexture(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');

  // Deep scorched earth base
  ctx.fillStyle = '#3d2b1f';
  ctx.fillRect(0, 0, size, size);

  // Multi-octave noise for stone grain
  for (let oct = 0; oct < 3; oct++) {
    const count = [size * size * 0.5, size * size * 0.3, size * size * 0.15][oct];
    const scale = [1, 2, 4][oct];
    const alpha = [0.18, 0.12, 0.08][oct];
    for (let i = 0; i < count; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const b = 25 + Math.random() * 40;
      ctx.fillStyle = `rgba(${b + Math.random() * 15 | 0},${b * 0.7 + Math.random() * 10 | 0},${b * 0.5 + Math.random() * 6 | 0},${alpha + Math.random() * 0.1})`;
      ctx.fillRect(x, y, scale + Math.random() * scale, scale + Math.random() * scale);
    }
  }

  // Dark crevices
  for (let i = 0; i < 60; i++) {
    ctx.beginPath();
    ctx.lineWidth = 0.3 + Math.random() * 2;
    ctx.strokeStyle = `rgba(10,5,2,${0.5 + Math.random() * 0.3})`;
    let cx = Math.random() * size, cy = Math.random() * size;
    ctx.moveTo(cx, cy);
    for (let s = 0; s < 3 + (Math.random() * 8 | 0); s++) {
      cx += (Math.random() - 0.5) * 50;
      cy += (Math.random() - 0.5) * 50;
      ctx.lineTo(cx, cy);
    }
    ctx.stroke();
  }

  // Lava glow veins in cracks
  for (let i = 0; i < 25; i++) {
    ctx.beginPath();
    ctx.lineWidth = 0.8 + Math.random() * 1.5;
    ctx.strokeStyle = `rgba(200,60,10,${0.06 + Math.random() * 0.08})`;
    ctx.shadowColor = 'rgba(255,80,10,0.3)';
    ctx.shadowBlur = 4;
    let cx = Math.random() * size, cy = Math.random() * size;
    ctx.moveTo(cx, cy);
    for (let s = 0; s < 2 + (Math.random() * 5 | 0); s++) {
      cx += (Math.random() - 0.5) * 40;
      cy += (Math.random() - 0.5) * 40;
      ctx.lineTo(cx, cy);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // Scattered rocks / pebbles
  for (let i = 0; i < 300; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 0.8 + Math.random() * 3;
    const b = 35 + Math.random() * 30;
    ctx.fillStyle = `rgba(${b + 10 | 0},${b | 0},${b * 0.7 | 0},${0.25 + Math.random() * 0.35})`;
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * (0.5 + Math.random() * 0.5), Math.random() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 18);
  return tex;
}

function makeGroundNormal(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgb(128,128,255)';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < size * size * 0.5; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const dx = (Math.random() - 0.5) * 30 + 128;
    const dy = (Math.random() - 0.5) * 30 + 128;
    ctx.fillStyle = `rgb(${dx | 0},${dy | 0},${220 + Math.random() * 35 | 0})`;
    ctx.fillRect(x, y, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 18);
  return tex;
}

function makeSkyDome() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const ctx = c.getContext('2d');

  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#0a0200');
  grad.addColorStop(0.2, '#1a0800');
  grad.addColorStop(0.35, '#3d1508');
  grad.addColorStop(0.5, '#5a1a06');
  grad.addColorStop(0.65, '#3d1508');
  grad.addColorStop(0.8, '#1a0800');
  grad.addColorStop(1, '#0a0200');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 512, 256);

  // Roiling volcanic clouds
  for (let i = 0; i < 400; i++) {
    const x = Math.random() * 512;
    const y = 30 + Math.random() * 180;
    const w = 20 + Math.random() * 80;
    const h = 8 + Math.random() * 25;
    const distFromCenter = Math.abs(y - 128) / 128;
    const brightness = (1 - distFromCenter) * 0.15;
    const rr = 140 + Math.random() * 80;
    const gg = 40 + Math.random() * 40;
    const bb = 5 + Math.random() * 15;
    ctx.fillStyle = `rgba(${rr | 0},${gg | 0},${bb | 0},${brightness * (0.3 + Math.random() * 0.4)})`;
    ctx.beginPath();
    ctx.ellipse(x, y, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Bright ember highlights in clouds
  for (let i = 0; i < 60; i++) {
    const x = Math.random() * 512;
    const y = 60 + Math.random() * 120;
    const r = 2 + Math.random() * 6;
    const grad2 = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad2.addColorStop(0, 'rgba(255,140,30,0.3)');
    grad2.addColorStop(1, 'rgba(255,60,0,0)');
    ctx.fillStyle = grad2;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  return tex;
}

function makeLavaTexture(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, '#ffcc44');
  grad.addColorStop(0.3, '#ff6600');
  grad.addColorStop(0.7, '#cc2200');
  grad.addColorStop(1, '#440800');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < size * size * 0.3; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const dist = Math.hypot(x - size / 2, y - size / 2) / (size / 2);
    const b = (1 - dist) * 255;
    ctx.fillStyle = `rgba(${Math.min(255, b + 50) | 0},${b * 0.4 | 0},0,${0.05 + Math.random() * 0.1})`;
    ctx.fillRect(x, y, 1 + Math.random() * 3, 1 + Math.random() * 3);
  }
  for (let i = 0; i < 30; i++) {
    ctx.beginPath();
    ctx.strokeStyle = `rgba(30,10,0,${0.3 + Math.random() * 0.3})`;
    ctx.lineWidth = 1 + Math.random() * 3;
    let cx = Math.random() * size, cy = Math.random() * size;
    ctx.moveTo(cx, cy);
    for (let s = 0; s < 4; s++) { cx += (Math.random() - 0.5) * 40; cy += (Math.random() - 0.5) * 40; ctx.lineTo(cx, cy); }
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function makeStoneTexture(size, baseR, baseG, baseB) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = `rgb(${baseR},${baseG},${baseB})`;
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < size * size * 0.4; i++) {
    const x = Math.random() * size, y = Math.random() * size;
    const v = (Math.random() - 0.5) * 25;
    ctx.fillStyle = `rgba(${baseR + v | 0},${baseG + v | 0},${baseB + v * 0.7 | 0},0.2)`;
    ctx.fillRect(x, y, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
  for (let row = 0; row < size; row += 16 + Math.random() * 8) {
    ctx.strokeStyle = `rgba(${baseR * 0.5 | 0},${baseG * 0.5 | 0},${baseB * 0.5 | 0},0.3)`;
    ctx.lineWidth = 0.5 + Math.random();
    ctx.beginPath(); ctx.moveTo(0, row); ctx.lineTo(size, row); ctx.stroke();
    const offset = (row / 20 | 0) % 2 === 0 ? 0 : size * 0.3;
    for (let col = offset; col < size; col += 24 + Math.random() * 16) {
      ctx.beginPath(); ctx.moveTo(col, row); ctx.lineTo(col, row + 20); ctx.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// ═══════════════════════════════════════════════════════════════
// DYNAMIC ENVIRONMENT STATE
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// BUILD MAP
// ═══════════════════════════════════════════════════════════════

function buildMap() {
  // ── Sky dome ──
  scene.background = makeSkyDome();

  // ── Scorched volcanic ground ──
  const groundTex = makeGroundTexture(512);
  const groundNorm = makeGroundNormal(256);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(MAP_WIDTH, 150, 48, 96),
    new THREE.MeshStandardMaterial({
      map: groundTex, normalMap: groundNorm, normalScale: new THREE.Vector2(0.6, 0.6),
      roughness: 0.92, metalness: 0.06,
    })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.z = -8;
  ground.receiveShadow = true;
  const pos = ground.geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    const n = Math.sin(x * 0.7) * Math.cos(y * 0.5) * 0.3
            + Math.sin(x * 2.1 + y * 1.3) * 0.15
            + Math.sin(x * 4.7 - y * 3.2) * 0.08
            + Math.sin(x * 8.3 + y * 6.1) * 0.03;
    pos.setZ(i, pos.getZ(i) + n);
  }
  pos.needsUpdate = true;
  ground.geometry.computeVertexNormals();
  scene.add(ground);

  // ── Lava rivers (wide flowing channels along borders) ──
  const lavaRiverTex = makeLavaTexture(256);
  lavaRiverTex.repeat.set(1, 8);
  const lavaRiverMat = new THREE.MeshStandardMaterial({
    map: lavaRiverTex, emissive: 0xff4400, emissiveIntensity: 1.5,
    roughness: 0.2, metalness: 0.1,
  });
  animatedEnv.lavaRiverMats.push(lavaRiverMat);
  for (const side of [-1, 1]) {
    const river = new THREE.Mesh(new THREE.PlaneGeometry(5, 140), lavaRiverMat);
    river.rotation.x = -Math.PI / 2;
    river.position.set(side * (MAP_WIDTH / 2 - 1), 0.02, -8);
    scene.add(river);
  }

  // ── Lava cracks across the battlefield ──
  const lavaCrackMat = new THREE.MeshStandardMaterial({
    color: 0xff4400, emissive: 0xff2200, emissiveIntensity: 2.0,
    roughness: 0.3, transparent: true, opacity: 0.7,
  });
  const cracks = [
    { x: -18, z: -40, sx: 0.6, sz: 30, r: 0.15 }, { x: 10, z: -25, sx: 0.5, sz: 24, r: -0.1 },
    { x: -6, z: -55, sx: 0.4, sz: 20, r: 0.3 },   { x: 20, z: -50, sx: 0.35, sz: 18, r: -0.2 },
    { x: -14, z: 0, sx: 0.5, sz: 22, r: 0.05 },    { x: 5, z: -65, sx: 0.4, sz: 14, r: -0.35 },
    { x: -2, z: -35, sx: 0.3, sz: 16, r: 0.4 },    { x: 14, z: -10, sx: 0.35, sz: 12, r: -0.25 },
  ];
  for (const c of cracks) {
    const crack = new THREE.Mesh(new THREE.PlaneGeometry(c.sx, c.sz), lavaCrackMat);
    crack.rotation.x = -Math.PI / 2;
    crack.rotation.z = c.r;
    crack.position.set(c.x, 0.04, c.z);
    scene.add(crack);
  }

  // ── Lava pools with animated glow ──
  const lavaPoolTex = makeLavaTexture(128);
  const poolSpots = [
    { x: -28, z: -30, r: 5 },  { x: 29, z: -50, r: 4.5 },
    { x: -30, z: -60, r: 3.8 }, { x: 28, z: -10, r: 4.5 },
    { x: -29, z: 5, r: 4 },     { x: 30, z: -75, r: 3.5 },
  ];
  for (const p of poolSpots) {
    const poolMat = new THREE.MeshStandardMaterial({
      map: lavaPoolTex, emissive: 0xff3300, emissiveIntensity: 2.0,
      roughness: 0.15, transparent: true, opacity: 0.85,
    });
    const pool = new THREE.Mesh(new THREE.CircleGeometry(p.r, 24), poolMat);
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(p.x, 0.05, p.z);
    scene.add(pool);
    animatedEnv.lavaPools.push({ mat: poolMat, phase: Math.random() * 6.28 });

    // Single smoke column rising from each pool
    const smoke = new THREE.Mesh(
      new THREE.SphereGeometry(0.6 + Math.random() * 0.8, 6, 5),
      new THREE.MeshStandardMaterial({ color: 0x222222, transparent: true, opacity: 0.2, depthWrite: false })
    );
    smoke.position.set(p.x + (Math.random() - 0.5) * 2, 1, p.z + (Math.random() - 0.5) * 2);
    scene.add(smoke);
    animatedEnv.smokeColumns.push({
      mesh: smoke, baseX: smoke.position.x, baseZ: smoke.position.z,
      baseY: smoke.position.y, speed: 0.8 + Math.random() * 0.6, phase: Math.random() * 6.28,
    });
  }

  // ── Fortress base (dark obsidian keep) ──
  const fortressTex = makeStoneTexture(256, 58, 53, 53);
  fortressTex.repeat.set(3, 1);
  const darkStoneMat = new THREE.MeshStandardMaterial({ map: fortressTex, roughness: 0.82, metalness: 0.18 });
  const base = new THREE.Mesh(new THREE.BoxGeometry(26, 8, 10), darkStoneMat);
  base.position.set(0, 4.2, BASE_Z + 6);
  base.castShadow = true;
  base.receiveShadow = true;
  scene.add(base);

  // Fortress spire towers
  const towerMat = new THREE.MeshStandardMaterial({ color: 0x2e2a28, roughness: 0.85, metalness: 0.2 });
  for (const tx of [-11, 11]) {
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 2.2, 14, 6), towerMat);
    tower.position.set(tx, 7, BASE_Z + 6);
    tower.castShadow = true;
    scene.add(tower);
    const spike = new THREE.Mesh(
      new THREE.ConeGeometry(1.5, 4, 6),
      new THREE.MeshStandardMaterial({ color: 0x1a1816, roughness: 0.7, metalness: 0.3 })
    );
    spike.position.set(tx, 16, BASE_Z + 6);
    spike.castShadow = true;
    scene.add(spike);
  }

  // ── The Eye — fiery core ──
  const core = new THREE.Mesh(
    new THREE.CylinderGeometry(2.2, 2.4, 5, 8),
    new THREE.MeshStandardMaterial({
      color: 0xff4400, emissive: 0xff2200, emissiveIntensity: 1.5, roughness: 0.25, metalness: 0.2,
    })
  );
  core.position.set(0, 4.7, BASE_Z + 0.8);
  core.castShadow = true;
  scene.add(core);
  const eyeGlow = new THREE.PointLight(0xff3300, 4, 40);
  eyeGlow.position.set(0, 6, BASE_Z + 0.8);
  scene.add(eyeGlow);
  animatedEnv.torchLights.push({ light: eyeGlow, baseIntensity: 4, phase: 0 });

  // ── Fortress wall (textured stone) ──
  const wallTex = makeStoneTexture(256, 64, 54, 46);
  wallTex.repeat.set(6, 1);
  const wallMat = new THREE.MeshStandardMaterial({
    map: wallTex, roughness: 0.85, metalness: 0.12,
    transparent: true, opacity: 0.55,
    emissive: 0x331100, emissiveIntensity: 0.2,
  });
  const castleWall = new THREE.Mesh(
    new THREE.BoxGeometry(MAP_WIDTH - 4.5, 5.4, CASTLE_WALL_DEPTH), wallMat
  );
  castleWall.position.set(0, 2.7, CASTLE_WALL_Z);
  castleWall.castShadow = false;
  castleWall.receiveShadow = true;
  castleWall.renderOrder = 1;
  scene.add(castleWall);

  // ── Jagged battlements with skull ornaments ──
  const battlementMat = new THREE.MeshStandardMaterial({
    color: 0x4a3e38, roughness: 0.82, metalness: 0.12,
    transparent: true, opacity: 0.55,
  });
  for (let i = 0; i < 11; i++) {
    const t = i / 10;
    const x = -((MAP_WIDTH - 9) / 2) + t * (MAP_WIDTH - 9);
    const h = 1.6 + Math.sin(i * 2.3) * 0.5;
    const batt = new THREE.Mesh(new THREE.BoxGeometry(2.2, h, 1.2), battlementMat);
    batt.position.set(x, 5.4 + h / 2, CASTLE_WALL_Z - CASTLE_WALL_DEPTH * 0.35);
    batt.castShadow = true;
    batt.receiveShadow = true;
    scene.add(batt);
    if (i % 2 === 0) {
      const ornament = new THREE.Mesh(
        new THREE.SphereGeometry(0.35, 5, 4),
        new THREE.MeshStandardMaterial({ color: 0x8a7e6c, roughness: 0.9 })
      );
      ornament.scale.set(1, 0.85, 0.9);
      ornament.position.set(x, 5.4 + h + 0.4, CASTLE_WALL_Z - CASTLE_WALL_DEPTH * 0.5);
      scene.add(ornament);
    }
  }

  // ── Wall-top torches ──
  const torchSpacing = (MAP_WIDTH - 10) / 7;
  for (let i = 0; i < 8; i++) {
    const tx = -(MAP_WIDTH - 10) / 2 + i * torchSpacing;
    // Torch post
    const tpost = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.1, 1.6, 4),
      new THREE.MeshStandardMaterial({ color: 0x3a3028, roughness: 0.9, metalness: 0.3 })
    );
    tpost.position.set(tx, 6.2, CASTLE_WALL_Z - 1.5);
    scene.add(tpost);
    // Layered flame cones
    for (let f = 0; f < 3; f++) {
      const flame = new THREE.Mesh(
        new THREE.ConeGeometry(0.2 + f * 0.08, 0.7 - f * 0.15, 5),
        new THREE.MeshStandardMaterial({
          color: f === 0 ? 0xffcc44 : f === 1 ? 0xff6622 : 0xff3300,
          emissive: f === 0 ? 0xffaa22 : 0xff4400,
          emissiveIntensity: 3 - f * 0.5,
          transparent: true, opacity: 0.85 - f * 0.15,
        })
      );
      flame.position.set(tx + (Math.random() - 0.5) * 0.1, 7.1 + f * 0.15, CASTLE_WALL_Z - 1.5);
      scene.add(flame);
    }
  }

  // ── War banners ──
  const bannerColors = [0x8b1a1a, 0x6b0f0f, 0x991515, 0x7a1010];
  for (let i = 0; i < 4; i++) {
    const bx = -15 + i * 10;
    const bannerGeo = new THREE.PlaneGeometry(1.8, 4, 1, 8);
    const bp = bannerGeo.attributes.position;
    for (let v = 0; v < bp.count; v++) { bp.setZ(v, Math.sin(bp.getY(v) * 1.5) * 0.15); }
    bp.needsUpdate = true;
    bannerGeo.computeVertexNormals();
    const banner = new THREE.Mesh(bannerGeo, new THREE.MeshStandardMaterial({
      color: bannerColors[i], roughness: 0.9, side: THREE.DoubleSide, emissive: 0x220000, emissiveIntensity: 0.2,
    }));
    banner.position.set(bx, 4.5, CASTLE_WALL_Z - CASTLE_WALL_DEPTH * 0.52);
    scene.add(banner);
    animatedEnv.bannerMeshes.push({ mesh: banner, geo: bannerGeo, phase: i * 1.5 });
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.06, 5.5, 4),
      new THREE.MeshStandardMaterial({ color: 0x2a2220, metalness: 0.4, roughness: 0.7 })
    );
    pole.position.set(bx, 5.2, CASTLE_WALL_Z - CASTLE_WALL_DEPTH * 0.52);
    scene.add(pole);
  }

  // ── Volcanic rock border walls ──
  const borderMat = new THREE.MeshStandardMaterial({ color: 0x2e2420, roughness: 0.88, metalness: 0.05 });
  const borderLeft = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 150), borderMat);
  borderLeft.position.set(-MAP_WIDTH / 2, 2, -8);
  borderLeft.receiveShadow = true;
  scene.add(borderLeft);
  const borderRight = borderLeft.clone();
  borderRight.position.x *= -1;
  scene.add(borderRight);

  // ── Jagged rock spires ──
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x3a2e24, roughness: 0.9, metalness: 0.06 });
  for (let side = -1; side <= 1; side += 2) {
    for (let i = 0; i < 16; i++) {
      const z = -75 + i * 9.5 + Math.sin(i * 3.7) * 3;
      const h = 4 + Math.sin(i * 2.1) * 3.5;
      const r = 0.8 + Math.sin(i * 1.7) * 0.5;
      const spire = new THREE.Mesh(new THREE.ConeGeometry(r, h, 5), rockMat);
      spire.position.set(side * (MAP_WIDTH / 2 + 1.5 + Math.sin(i) * 0.8), h / 2, z);
      spire.rotation.set(side * 0.08, 0, side * (0.1 + Math.sin(i * 1.3) * 0.1));
      spire.castShadow = true;
      scene.add(spire);
    }
  }

  // ── Distant volcanic mountains ──
  const mountainMat = new THREE.MeshStandardMaterial({ color: 0x2a201a, roughness: 0.95 });
  const volcanoMat = new THREE.MeshStandardMaterial({ color: 0x241c16, roughness: 0.9 });
  const mountains = [
    { x: -45, z: -120, r: 22, h: 40 }, { x: 50, z: -130, r: 18, h: 35 },
    { x: 0, z: -140, r: 30, h: 55, volcano: true },
    { x: -70, z: -110, r: 15, h: 28 }, { x: 75, z: -115, r: 16, h: 30 },
    { x: 30, z: -105, r: 14, h: 24 }, { x: -30, z: -100, r: 14, h: 26 },
    { x: -55, z: -135, r: 20, h: 32 }, { x: 60, z: -125, r: 17, h: 30 },
  ];
  for (const m of mountains) {
    const mtn = new THREE.Mesh(new THREE.ConeGeometry(m.r, m.h, 8), m.volcano ? volcanoMat : mountainMat);
    mtn.position.set(m.x, m.h / 2 - 2, m.z);
    scene.add(mtn);
    if (m.volcano) {
      const lavaCap = new THREE.Mesh(
        new THREE.CircleGeometry(6, 12),
        new THREE.MeshStandardMaterial({ color: 0xff5500, emissive: 0xff3300, emissiveIntensity: 3.5, transparent: true, opacity: 0.85 })
      );
      lavaCap.rotation.x = -Math.PI / 2;
      lavaCap.position.set(m.x, m.h - 2, m.z);
      scene.add(lavaCap);
      // Lava flow streaks down the volcano
      for (let f = 0; f < 4; f++) {
        const angle = (f / 4) * Math.PI * 2 + 0.3;
        const flow = new THREE.Mesh(
          new THREE.PlaneGeometry(0.8, m.h * 0.6),
          new THREE.MeshStandardMaterial({
            color: 0xff4400, emissive: 0xff2200, emissiveIntensity: 1.8,
            transparent: true, opacity: 0.5, side: THREE.DoubleSide,
          })
        );
        flow.position.set(m.x + Math.cos(angle) * m.r * 0.35, m.h * 0.35, m.z + Math.sin(angle) * m.r * 0.35);
        flow.rotation.set(0.5, angle, 0);
        scene.add(flow);
      }
    }
  }

  // ── Ruined pillars with rubble ──
  const ruinMat = new THREE.MeshStandardMaterial({ color: 0x4a4540, roughness: 0.88, metalness: 0.08 });
  const ruins = [
    { x: -20, z: -30, h: 4.5, r: 0.8, tilt: 0.3 }, { x: 15, z: -50, h: 5.5, r: 0.7, tilt: -0.15 },
    { x: -10, z: -65, h: 3.5, r: 0.9, tilt: 0.5 }, { x: 22, z: -20, h: 5, r: 0.7, tilt: -0.4 },
    { x: -22, z: -55, h: 3.5, r: 0.8, tilt: 0.2 }, { x: 8, z: -40, h: 6.5, r: 0.6, tilt: -0.08 },
    { x: -15, z: -15, h: 4, r: 0.75, tilt: 0.35 }, { x: 18, z: -70, h: 3, r: 0.85, tilt: -0.3 },
  ];
  for (const r of ruins) {
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(r.r * 0.65, r.r, r.h, 7), ruinMat);
    pillar.position.set(r.x, r.h / 2, r.z);
    pillar.rotation.z = r.tilt;
    pillar.castShadow = true;
    pillar.receiveShadow = true;
    scene.add(pillar);
    for (let rb = 0; rb < 3; rb++) {
      const rubble = new THREE.Mesh(new THREE.DodecahedronGeometry(0.3 + Math.random() * 0.4, 0), ruinMat);
      rubble.position.set(r.x + (Math.random() - 0.5) * 2, 0.2 + Math.random() * 0.2, r.z + (Math.random() - 0.5) * 2);
      rubble.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      scene.add(rubble);
    }
  }

  // ── Skull piles, bones & weapons ──
  const boneMat = new THREE.MeshStandardMaterial({ color: 0x8a7e6c, roughness: 0.92 });
  const skullSpots = [
    { x: -16, z: -20, n: 7 }, { x: 12, z: -35, n: 5 }, { x: -8, z: -70, n: 6 },
    { x: 18, z: -60, n: 8 }, { x: -20, z: -45, n: 5 }, { x: 4, z: -15, n: 4 },
    { x: -12, z: -55, n: 6 }, { x: 16, z: -42, n: 5 },
  ];
  for (const s of skullSpots) {
    for (let j = 0; j < s.n; j++) {
      const skull = new THREE.Mesh(new THREE.SphereGeometry(0.3 + Math.random() * 0.15, 5, 4), boneMat);
      skull.position.set(s.x + (Math.random() - 0.5) * 2.5, 0.2 + Math.random() * 0.15, s.z + (Math.random() - 0.5) * 2.5);
      skull.scale.y = 0.75 + Math.random() * 0.15;
      scene.add(skull);
    }
    if (Math.random() > 0.4) {
      const sword = new THREE.Mesh(
        new THREE.BoxGeometry(0.06, 1.8, 0.15),
        new THREE.MeshStandardMaterial({ color: 0x606060, metalness: 0.6, roughness: 0.5 })
      );
      sword.position.set(s.x + (Math.random() - 0.5), 0.9, s.z + (Math.random() - 0.5));
      sword.rotation.z = (Math.random() - 0.5) * 0.6;
      sword.rotation.x = (Math.random() - 0.5) * 0.3;
      scene.add(sword);
    }
  }

  // ── Dark obelisks with glowing runes ──
  const obeliskMat = new THREE.MeshStandardMaterial({
    color: 0x1e1a18, roughness: 0.75, metalness: 0.25, emissive: 0x220800, emissiveIntensity: 0.1,
  });
  for (const o of [{ x: -23, z: -35 }, { x: 23, z: -55 }, { x: -23, z: -65 }, { x: 23, z: -15 }]) {
    const h = 6 + Math.random() * 3;
    const ob = new THREE.Mesh(new THREE.BoxGeometry(1.2, h, 1.2), obeliskMat);
    ob.position.set(o.x, h / 2, o.z);
    ob.rotation.y = Math.random() * 0.3;
    ob.castShadow = true;
    scene.add(ob);
    const rune = new THREE.Mesh(
      new THREE.PlaneGeometry(0.6, 0.6),
      new THREE.MeshStandardMaterial({ color: 0xff4400, emissive: 0xff2200, emissiveIntensity: 2.5, transparent: true, opacity: 0.8 })
    );
    rune.position.set(o.x, h - 0.5, o.z + 0.61);
    scene.add(rune);
  }

  // ── Embers & ash (200 particles) ──
  const emberMat = new THREE.MeshStandardMaterial({
    color: 0xff6622, emissive: 0xff4400, emissiveIntensity: 2.5, transparent: true, opacity: 0.9,
  });
  const ashMat = new THREE.MeshStandardMaterial({
    color: 0x555555, emissive: 0x222222, emissiveIntensity: 0.3, transparent: true, opacity: 0.45, depthWrite: false,
  });
  for (let i = 0; i < 80; i++) {
    const isEmber = Math.random() > 0.35;
    const mat = isEmber ? emberMat : ashMat;
    const size = isEmber ? 0.06 + Math.random() * 0.12 : 0.12 + Math.random() * 0.2;
    const ember = new THREE.Mesh(new THREE.SphereGeometry(size, 4, 3), mat);
    ember.position.set(
      (Math.random() - 0.5) * MAP_WIDTH * 1.5,
      Math.random() * 25,
      -85 + Math.random() * 125
    );
    scene.add(ember);
    emberParticles.push({
      mesh: ember, baseY: ember.position.y, baseX: ember.position.x,
      speed: 0.3 + Math.random() * 1.5, drift: (Math.random() - 0.5) * 0.8,
      sway: 0.5 + Math.random() * 1.5, phase: Math.random() * Math.PI * 2, isEmber,
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// ENVIRONMENT ANIMATION
// ═══════════════════════════════════════════════════════════════

function updateEnvironment(elapsed, dt) {
  // Flickering torches & braziers
  for (const t of animatedEnv.torchLights) {
    const flicker = Math.sin(elapsed * 12 + t.phase) * 0.15
                  + Math.sin(elapsed * 7.3 + t.phase * 2) * 0.1
                  + Math.sin(elapsed * 19 + t.phase * 0.5) * 0.05;
    t.light.intensity = t.baseIntensity * (1 + flicker);
  }
  // Pulsing lava pools
  for (const p of animatedEnv.lavaPools) {
    const pulse = Math.sin(elapsed * 1.5 + p.phase) * 0.3 + Math.sin(elapsed * 3.2 + p.phase) * 0.15;
    p.mat.emissiveIntensity = 2.0 + pulse * 0.8;
  }
  // Flowing lava rivers
  for (const m of animatedEnv.lavaRiverMats) {
    m.map.offset.y = elapsed * 0.15;
  }
  // Smoke columns rising
  for (const s of animatedEnv.smokeColumns) {
    s.mesh.position.y = s.baseY + (elapsed * s.speed) % 8;
    s.mesh.position.x = s.baseX + Math.sin(elapsed * 0.6 + s.phase) * 0.8;
    s.mesh.position.z = s.baseZ + Math.cos(elapsed * 0.4 + s.phase) * 0.6;
    const life = (s.mesh.position.y - s.baseY) / 8;
    s.mesh.material.opacity = 0.22 * (1 - life);
    s.mesh.scale.setScalar(1 + life * 2.5);
  }
  // Waving banners
  for (const b of animatedEnv.bannerMeshes) {
    const bp = b.geo.attributes.position;
    for (let v = 0; v < bp.count; v++) {
      const vy = bp.getY(v);
      bp.setZ(v, Math.sin(vy * 1.5 + elapsed * 2.5 + b.phase) * 0.2 + Math.sin(vy * 3 + elapsed * 4 + b.phase) * 0.06);
    }
    bp.needsUpdate = true;
    b.geo.computeVertexNormals();
  }
  // Embers & ash
  for (const e of emberParticles) {
    e.mesh.position.y = (e.baseY + elapsed * e.speed) % 26;
    e.mesh.position.x = e.baseX + Math.sin(elapsed * e.sway + e.phase) * 1.5 * e.drift;
    if (e.isEmber) {
      e.mesh.material.opacity = 0.4 + Math.sin(elapsed * 4 + e.phase) * 0.5;
    }
  }
}

function createCommander() {
  const group = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(1.2, 1.4, 2.2, 8),
    new THREE.MeshStandardMaterial({ color: 0x3a3538, roughness: 0.6, metalness: 0.4 })
  );
  body.position.y = 1.2;
  body.castShadow = true;
  group.add(body);

  const visor = new THREE.Mesh(
    new THREE.BoxGeometry(1.4, 0.5, 0.5),
    new THREE.MeshStandardMaterial({
      color: 0xff5500, emissive: 0xff3300, emissiveIntensity: 1.2,
    })
  );
  visor.position.set(0, 1.45, 0.9);
  group.add(visor);

  const commanderGlow = new THREE.PointLight(0xff4400, 1.0, 8);
  commanderGlow.position.set(0, 2, 0);
  group.add(commanderGlow);

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
    rootedFor: 0,
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

  if (isTypingTarget(event.target)) {
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

function setupPromptUi() {
  function submitPrompt() {
    const raw = dom.promptInput.value.trim();
    if (!raw) {
      return;
    }
    dom.promptInput.value = '';
    dom.applyStatus.textContent = 'Sending prompt to spell API backend...';
    void castFromPrompt(raw);
  }

  dom.cancelSpellQueueBtn.addEventListener('click', () => {
    cancelQueuedSpells();
  });

  dom.resetSandboxBtn?.addEventListener('click', () => {
    void resetSandboxToTemplate('manual');
  });

  window.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      submitPrompt();
    }
  });

  dom.promptInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submitPrompt();
    }
  });

  dom.queueStatus.textContent = `Queue: ${promptProcessor.getQueueSize()}`;
  dom.applyStatus.textContent = 'No prompt applied yet';
  renderSpellHistory();
  syncSpellQueueUi();
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

    const spellName = json?.spell?.name || json?.spell?.archetype || 'spell';
    const archetype = json?.spell?.archetype || '';
    const element = json?.spell?.element || '';
    const origin = json?.source || 'unknown';
    const originTag = origin === 'fallback' ? 'fallback' : 'llm';
    const detailParts = [spellName];
    if (archetype) detailParts.push(`[${archetype}]`);
    if (element) detailParts.push(`(${element})`);
    detailParts.push(`{${originTag}}`);
    const detail = detailParts.join(' ');

    if (origin === 'fallback') {
      const reason = json?.meta?.fallbackReason ? ` (${json.meta.fallbackReason})` : '';
      setToast(`Fallback cast${reason}`);
      updateSpellHistory(historyId, 'casted', detail);
      console.warn('[spell] fallback', {
        reason: json?.meta?.fallbackReason || null,
        warnings: json?.meta?.warnings || [],
        latencyMs: json?.meta?.latencyMs,
      });
    } else {
      setToast(spellName);
      updateSpellHistory(historyId, 'casted', detail);
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
  return `${DIRECT_SPELL_BACKEND_ORIGIN}/api/spells/generate`;
}

function castFromConfig(spell) {
  if (!spell || typeof spell !== 'object') {
    return {
      casted: false,
      reason: 'Invalid spell payload',
    };
  }

  // Check if a baseline spell matches by name — use its dedicated cast function
  const spellName = String(spell.name || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
  const baselineKey = Object.keys(SPELLS).find((key) => spellName === key);
  if (baselineKey && SPELLS[baselineKey].cast) {
    const casted = SPELLS[baselineKey].cast();
    if (casted) {
      refreshHud();
      return { casted: true, reason: '' };
    }
  }

  const archetype = String(spell.archetype || 'projectile');

  let casted = false;
  if (archetype === 'zone_control') {
    casted = castZoneFromConfig(spell);
  } else if (archetype === 'chain') {
    casted = castChainFromConfig(spell);
  } else if (archetype === 'strike') {
    casted = castStrikeFromConfig(spell);
  } else {
    casted = castProjectileFromConfig(spell, archetype);
  }

  if (!casted) {
    return {
      casted: false,
      reason: 'No valid target or spell effect failed',
    };
  }

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

function castArcaneMissiles() {
  // Rapid-fire 3-shot burst at nearest enemies
  const liveEnemies = enemies.filter((e) => !e.dead);
  if (!liveEnemies.length) {
    setToast('No targets for arcane missiles');
    return false;
  }
  const sorted = [...liveEnemies].sort((a, b) => {
    const da = a.mesh.position.distanceTo(commander.mesh.position);
    const db = b.mesh.position.distanceTo(commander.mesh.position);
    return da - db;
  });
  for (let i = 0; i < 3; i++) {
    const target = sorted[i % sorted.length];
    const spell = {
      archetype: 'projectile',
      element: 'arcane',
      targeting: { mode: 'nearest' },
      numbers: { damage: 22, radius: 1.2, speed: 38, durationSec: 0 },
      effects: [],
      vfx: {
        intensity: 0.7,
        shape: 'orb',
        size: 0.6,
        trailEffect: 'holy_motes',
        impactEffect: 'flash',
        primaryColor: '#c59dff',
        secondaryColor: '#9b6dff',
      },
    };
    const power = 0.7;
    const baseRadius = 0.3;
    const projectileMesh = new THREE.Mesh(
      new THREE.SphereGeometry(baseRadius, 8, 8),
      new THREE.MeshStandardMaterial({
        color: 0xc59dff,
        emissive: 0x5d2e8a,
        emissiveIntensity: 0.55 + power * 0.45,
      })
    );
    const offset = (i - 1) * 1.2;
    projectileMesh.position.copy(commander.mesh.position).add(new THREE.Vector3(offset, 1.8 + i * 0.4, -0.5));
    scene.add(projectileMesh);
    const glowLight = new THREE.PointLight(0xc59dff, power * 1.5, 4);
    projectileMesh.add(glowLight);
    projectiles.push({
      kind: 'projectile',
      mesh: projectileMesh,
      target,
      speed: 38,
      damage: 22,
      splash: 1.2,
      effects: [],
      element: 'arcane',
      intensity: power,
      spellVfx: spell.vfx,
      glowLight,
    });
  }
  return true;
}

function castMeteor() {
  // Delayed overhead strike — massive AoE burst with burn + knockback
  const target = selectTarget({ mode: 'front_cluster' });
  if (!target) {
    setToast('No target for meteor');
    return false;
  }
  const impactPos = target.mesh.position.clone();
  impactPos.y = 0.5;

  // Shadow warning circle on ground
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(2.8, 20),
    new THREE.MeshStandardMaterial({
      color: 0xff4400,
      emissive: 0xff4400,
      emissiveIntensity: 0.5,
      transparent: true,
      opacity: 0.3,
      side: THREE.DoubleSide,
    })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(impactPos.x, 0.06, impactPos.z);
  scene.add(shadow);

  // Meteor projectile from sky
  const meteorMesh = new THREE.Mesh(
    new THREE.SphereGeometry(1.1, 10, 10),
    new THREE.MeshStandardMaterial({
      color: 0xff6622,
      emissive: 0x8c2b00,
      emissiveIntensity: 1.8,
    })
  );
  meteorMesh.position.set(impactPos.x + (Math.random() - 0.5) * 3, 38, impactPos.z - 25);
  scene.add(meteorMesh);
  const meteorGlow = new THREE.PointLight(0xff6622, 4, 12);
  meteorMesh.add(meteorGlow);

  projectiles.push({
    kind: 'strike',
    mesh: meteorMesh,
    target,
    strikeTarget: impactPos.clone(),
    speed: 36,
    damage: 85,
    splash: 4.0,
    effects: ['burn', 'knockback'],
    element: 'fire',
    intensity: 1.3,
    spellVfx: {
      intensity: 1.3,
      impactEffect: 'crater',
      trailEffect: 'ember_trail',
      primaryColor: '#ff6622',
      secondaryColor: '#ff2200',
      screenShake: 0.8,
      particleDensity: 1.6,
    },
    glowLight: meteorGlow,
    meteorShadow: shadow,
  });
  return true;
}

function castVines() {
  // Lingering zone that roots enemies
  return castZoneFromConfig({
    archetype: 'zone_control',
    element: 'earth',
    targeting: { mode: 'front_cluster' },
    numbers: { damage: 8, radius: 3.8, durationSec: 6, tickRate: 0.9 },
    effects: ['root', 'slow'],
    vfx: {
      intensity: 0.8,
      shape: 'ring',
      primaryColor: '#4a7a2e',
      secondaryColor: '#2d5a1a',
      ringColor: '#3d6b24',
      trailEffect: 'drip',
      impactEffect: 'spore_burst',
      particleDensity: 1.2,
    },
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
  const trail = vfx.trailEffect || 'spark';
  let geo;
  let size;

  if (trail === 'ember_trail' || trail === 'spark') {
    size = 0.12 + Math.random() * 0.18;
    geo = POOL_GEO.sphereSmall;
  } else if (trail === 'frost_mist' || trail === 'smoke') {
    size = 0.25 + Math.random() * 0.35;
    geo = POOL_GEO.sphereMed;
  } else if (trail === 'lightning_arc') {
    size = 0.08 + Math.random() * 0.12;
    geo = POOL_GEO.cylinder;
  } else if (trail === 'holy_motes' || trail === 'shadow_wisp') {
    size = 0.1 + Math.random() * 0.15;
    geo = POOL_GEO.octahedron;
  } else if (trail === 'drip') {
    size = 0.08 + Math.random() * 0.12;
    geo = POOL_GEO.sphereSmall;
  } else if (trail === 'rune_glyphs') {
    size = 0.12 + Math.random() * 0.14;
    geo = POOL_GEO.ring;
  } else if (trail === 'ember_swirl') {
    size = 0.1 + Math.random() * 0.16;
    geo = POOL_GEO.sphereSmall;
  } else {
    return;
  }

  const mat = new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: trail === 'lightning_arc' ? 1.5 : trail === 'rune_glyphs' ? 1.8 : 0.9,
    transparent: true,
    opacity: 0.85,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.scale.setScalar(size);
  mesh.position.copy(position);
  mesh.position.x += (Math.random() - 0.5) * 0.6;
  mesh.position.y += (Math.random() - 0.5) * 0.4;
  mesh.position.z += (Math.random() - 0.5) * 0.6;
  if (trail === 'lightning_arc') {
    mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
  } else if (trail === 'rune_glyphs') {
    mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
  }
  scene.add(mesh);

  const isDrip = trail === 'drip';
  const isSwirl = trail === 'ember_swirl';
  trailParticles.push({
    mesh,
    life: isDrip ? 0.2 + Math.random() * 0.2 : 0.25 + Math.random() * 0.35,
    velY: isDrip ? -(3 + Math.random() * 4) : isSwirl ? 0.8 + Math.random() * 1.2 : (trail === 'ember_trail' || trail === 'spark') ? 1.5 + Math.random() * 2 : 0.3 + Math.random() * 0.6,
    drift: isSwirl ? (Math.random() - 0.5) * 3.5 : (Math.random() - 0.5) * 1.2,
    fadeRate: isDrip ? 3.5 : trail === 'smoke' || trail === 'frost_mist' ? 1.2 : trail === 'rune_glyphs' ? 3.0 : 2.5,
    spin: trail === 'rune_glyphs' ? 4 + Math.random() * 6 : isSwirl ? 5 + Math.random() * 8 : 0,
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
  } else if (impact === 'crater') {
    // ground depression ring + dust cloud
    const craterRing = new THREE.Mesh(
      new THREE.RingGeometry(0.8, 1.8, 20),
      new THREE.MeshStandardMaterial({
        color: 0x8b7355,
        emissive: secondary,
        emissiveIntensity: 0.6,
        transparent: true,
        opacity: 0.7,
        side: THREE.DoubleSide,
      })
    );
    craterRing.position.copy(position);
    craterRing.position.y = 0.05;
    craterRing.rotation.x = -Math.PI / 2;
    scene.add(craterRing);
    impactFlashes.push({ mesh: craterRing, life: 0.6, velX: 0, velY: 0, velZ: 0, isCrater: true });
    // dust chunks
    const dustCount = Math.floor(6 * density);
    for (let i = 0; i < dustCount; i++) {
      const dSize = 0.15 + Math.random() * 0.25;
      const dust = new THREE.Mesh(
        new THREE.SphereGeometry(dSize, 4, 4),
        new THREE.MeshStandardMaterial({
          color: 0xa0886a,
          emissive: primary,
          emissiveIntensity: 0.3,
          transparent: true,
          opacity: 0.65,
        })
      );
      dust.position.copy(position);
      const angle = (i / dustCount) * Math.PI * 2;
      const speed = 2 + Math.random() * 3;
      scene.add(dust);
      impactFlashes.push({
        mesh: dust,
        life: 0.4 + Math.random() * 0.3,
        velX: Math.cos(angle) * speed,
        velY: 1.5 + Math.random() * 3,
        velZ: Math.sin(angle) * speed,
      });
    }
  } else if (impact === 'geyser') {
    // upward column burst
    const geyserCol = new THREE.Mesh(
      new THREE.CylinderGeometry(0.3, 0.8, 6, 8),
      new THREE.MeshStandardMaterial({
        color: primary,
        emissive: secondary,
        emissiveIntensity: 1.8,
        transparent: true,
        opacity: 0.8,
      })
    );
    geyserCol.position.copy(position);
    geyserCol.position.y = 3;
    scene.add(geyserCol);
    impactFlashes.push({ mesh: geyserCol, life: 0.45, velX: 0, velY: 4, velZ: 0, isGeyser: true });
    // spray droplets
    const sprayCount = Math.floor(5 * density);
    for (let i = 0; i < sprayCount; i++) {
      const dropSize = 0.1 + Math.random() * 0.18;
      const drop = new THREE.Mesh(
        new THREE.SphereGeometry(dropSize, 4, 4),
        new THREE.MeshStandardMaterial({
          color: secondary,
          emissive: primary,
          emissiveIntensity: 1.0,
          transparent: true,
          opacity: 0.75,
        })
      );
      drop.position.copy(position);
      drop.position.y += 4 + Math.random() * 2;
      const angle = Math.random() * Math.PI * 2;
      scene.add(drop);
      impactFlashes.push({
        mesh: drop,
        life: 0.5 + Math.random() * 0.3,
        velX: Math.cos(angle) * (1.5 + Math.random() * 2),
        velY: 3 + Math.random() * 4,
        velZ: Math.sin(angle) * (1.5 + Math.random() * 2),
      });
    }
  } else if (impact === 'spore_burst') {
    // organic expanding cloud
    const sporeCount = Math.floor(7 * density);
    for (let i = 0; i < sporeCount; i++) {
      const sSize = 0.2 + Math.random() * 0.35;
      const spore = new THREE.Mesh(
        new THREE.DodecahedronGeometry(sSize, 0),
        new THREE.MeshStandardMaterial({
          color: i % 2 === 0 ? primary : secondary,
          emissive: primary,
          emissiveIntensity: 0.7,
          transparent: true,
          opacity: 0.7,
        })
      );
      spore.position.copy(position);
      const angle = (i / sporeCount) * Math.PI * 2;
      const speed = 1.5 + Math.random() * 2;
      scene.add(spore);
      impactFlashes.push({
        mesh: spore,
        life: 0.6 + Math.random() * 0.4,
        velX: Math.cos(angle) * speed,
        velY: 0.5 + Math.random() * 1.5,
        velZ: Math.sin(angle) * speed,
        isSpore: true,
        spin: 2 + Math.random() * 4,
      });
    }
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
    if (p.spin) {
      p.mesh.rotation.y += p.spin * dt;
      p.mesh.rotation.z += p.spin * 0.3 * dt;
    }
    p.mesh.material.opacity = Math.max(0, p.mesh.material.opacity - p.fadeRate * dt);
    if (p.life <= 0 || p.mesh.material.opacity <= 0) {
      scene.remove(p.mesh);
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
    if (f.velY !== 0 && !f.isRipple && !f.isVortex && !f.isGeyser) {
      f.velY -= 12 * dt;
    }
    if (f.isRipple) {
      f.mesh.scale.multiplyScalar(1 + dt * 8);
    }
    if (f.isVortex) {
      f.mesh.rotation.y += (f.spin || 6) * dt;
      f.mesh.scale.multiplyScalar(1 + dt * 3);
    }
    if (f.isCrater) {
      f.mesh.scale.multiplyScalar(1 + dt * 4);
    }
    if (f.isGeyser) {
      f.mesh.scale.x *= 1 - dt * 1.5;
      f.mesh.scale.z *= 1 - dt * 1.5;
    }
    if (f.isSpore) {
      f.mesh.rotation.y += (f.spin || 3) * dt;
      f.velX *= 1 - dt * 2;
      f.velZ *= 1 - dt * 2;
      f.mesh.scale.multiplyScalar(1 + dt * 1.5);
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
  let size, geo;
  if (mode === 'spray') {
    size = 0.1 + Math.random() * 0.15;
    geo = POOL_GEO.sphereSmall;
  } else if (mode === 'orbit') {
    size = 0.08 + Math.random() * 0.1;
    geo = POOL_GEO.sphereMed;
  } else if (mode === 'pulse') {
    size = 0.12 + Math.random() * 0.15;
    geo = POOL_GEO.ring;
  } else {
    size = 0.08 + Math.random() * 0.12;
    geo = POOL_GEO.octahedron;
  }
  const mat = new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: mode === 'spray' ? 1.2 : mode === 'pulse' ? 1.5 : 0.8,
    transparent: true,
    opacity: 0.75,
    side: mode === 'pulse' ? THREE.DoubleSide : THREE.FrontSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.scale.setScalar(size);
  mesh.position.copy(position);
  if (mode === 'pulse') {
    mesh.rotation.x = -Math.PI / 2;
  }
  scene.add(mesh);

  if (mode === 'orbit') {
    const angle = Math.random() * Math.PI * 2;
    const orbitRadius = 1.2 + Math.random() * 1.5;
    const life = 0.8 + Math.random() * 0.6;
    zoneParticles.push({
      mesh,
      life,
      velY: 0.4 + Math.random() * 0.6,
      driftX: 0,
      driftZ: 0,
      fadeRate: 1 / life,
      orbit: true,
      orbitAngle: angle,
      orbitRadius,
      orbitSpeed: 3 + Math.random() * 3,
      orbitCenterX: position.x,
      orbitCenterZ: position.z,
    });
  } else if (mode === 'pulse') {
    const life = 0.4 + Math.random() * 0.25;
    zoneParticles.push({
      mesh,
      life,
      velY: 0,
      driftX: 0,
      driftZ: 0,
      fadeRate: 1 / life,
      isPulse: true,
    });
  } else {
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
}

function updateZoneParticles(dt) {
  for (let i = zoneParticles.length - 1; i >= 0; i--) {
    const p = zoneParticles[i];
    p.life -= dt;
    if (p.orbit) {
      p.orbitAngle += p.orbitSpeed * dt;
      p.mesh.position.x = p.orbitCenterX + Math.cos(p.orbitAngle) * p.orbitRadius;
      p.mesh.position.z = p.orbitCenterZ + Math.sin(p.orbitAngle) * p.orbitRadius;
      p.mesh.position.y += p.velY * dt;
    } else if (p.isPulse) {
      p.mesh.scale.multiplyScalar(1 + dt * 10);
    } else {
      p.mesh.position.y += p.velY * dt;
      p.mesh.position.x += p.driftX * dt;
      p.mesh.position.z += p.driftZ * dt;
    }
    p.mesh.material.opacity = Math.max(0, p.life * p.fadeRate);
    if (p.life <= 0) {
      scene.remove(p.mesh);
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
  return new THREE.SphereGeometry(baseRadius, 12, 12);
}

function castProjectileFromConfig(spell, archetype = 'projectile') {
  const target = selectTarget(spell.targeting);
  if (!target) {
    setToast('No target for projectile');
    return false;
  }

  const power = clamp(Number(spell?.vfx?.intensity || 0.85), 0.2, 1.4);
  const shape = ['orb', 'ring', 'wall', 'arc'].includes(spell?.vfx?.shape) ? spell.vfx.shape : 'orb';
  const shapeSize = clamp(Number(spell?.vfx?.size ?? 1), 0.4, 2.2);
  const baseRadius = (archetype === 'aoe_burst' ? 0.62 : 0.5) * shapeSize;
  const elementColor = colorForElement(spell?.element);
  const primaryHex = parseHexColor(spell?.vfx?.primaryColor);
  const secondaryHex = parseHexColor(spell?.vfx?.secondaryColor);
  const mainColor = primaryHex ?? elementColor.base;
  const glowColor = secondaryHex ?? elementColor.emissive;

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
  scene.add(projectileMesh);

  const glowLight = new THREE.PointLight(mainColor, power * 2.5, 6);
  glowLight.position.set(0, 0, 0);
  projectileMesh.add(glowLight);

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
  const target = selectTarget(spell?.targeting || { mode: 'front_cluster' });
  if (!target) {
    setToast('No target for strike');
    return false;
  }

  const damage = clamp(Number(spell?.numbers?.damage || 70), 8, 150);
  const radius = clamp(Number(spell?.numbers?.radius || 3.5), 1, 8);
  const effects = Array.isArray(spell?.effects) ? spell.effects : [];
  const element = spell?.element || 'fire';
  const elementColor = colorForElement(element);
  const primaryHex = parseHexColor(spell?.vfx?.primaryColor);
  const secondaryHex = parseHexColor(spell?.vfx?.secondaryColor);
  const mainColor = primaryHex ?? elementColor.base;
  const glowColor = secondaryHex ?? elementColor.emissive;
  const intensity = clamp(Number(spell?.vfx?.intensity || 1.2), 0.4, 2.0);

  const impactPos = target.mesh.position.clone();
  impactPos.y = 0;

  // Ground shadow warning
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(radius * 0.7, 20),
    new THREE.MeshStandardMaterial({
      color: mainColor,
      emissive: mainColor,
      emissiveIntensity: 0.5,
      transparent: true,
      opacity: 0.3,
      side: THREE.DoubleSide,
    })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(impactPos.x, 0.06, impactPos.z);
  scene.add(shadow);

  // Projectile from the sky — spawn far above and behind (negative Z = away from camera)
  const strikeMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.9 + intensity * 0.3, 10, 10),
    new THREE.MeshStandardMaterial({
      color: mainColor,
      emissive: glowColor,
      emissiveIntensity: 1.8,
    })
  );
  strikeMesh.position.set(
    impactPos.x + (Math.random() - 0.5) * 3,
    38,
    impactPos.z - 25
  );
  scene.add(strikeMesh);

  const strikeGlow = new THREE.PointLight(mainColor, 4, 12);
  strikeMesh.add(strikeGlow);

  // Strike projectiles remember their ground target position so they still land even if the enemy dies
  projectiles.push({
    kind: 'strike',
    mesh: strikeMesh,
    target,
    strikeTarget: impactPos.clone(),
    speed: clamp(Number(spell?.numbers?.speed || 34), 16, 50),
    damage,
    splash: radius,
    effects,
    element,
    intensity,
    spellVfx: spell?.vfx || {
      impactEffect: 'crater',
      trailEffect: 'ember_trail',
      primaryColor: spell?.vfx?.primaryColor || '#ff6622',
      secondaryColor: spell?.vfx?.secondaryColor || '#ff2200',
      screenShake: 0.7,
      particleDensity: 1.5,
    },
    glowLight: strikeGlow,
    meteorShadow: shadow,
  });

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
    if (enemy.rootedFor > 0) {
      enemy.rootedFor = Math.max(0, enemy.rootedFor - dt);
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

    const movementInterrupted = enemy.staggerFor > 0 || enemy.stunnedFor > 0 || enemy.rootedFor > 0;
    const moveScale = movementInterrupted ? 0 : enemy.frozenFor > 0 ? 0.15 : enemy.slowFactor;
    enemy.visual.playbackScale = enemy.hitTimer > 0 ? 1 : moveScale;

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
  playDeath();

  if (slain) {
    GAME.score += enemy.worth;
    GAME.kills += 1;
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
        disposeGroupMeshes(projectile.mesh);
        scene.remove(projectile.mesh);
        projectiles.splice(i, 1);
      }
      continue;
    }

    // Strike projectiles track a fixed ground point — don't remove when target dies
    if (projectile.kind === 'strike') {
      const groundTarget = projectile.strikeTarget;
      const dir = groundTarget.clone().sub(projectile.mesh.position);
      const step = projectile.speed * dt;

      if (dir.lengthSq() <= step * step) {
        projectile.mesh.position.copy(groundTarget);
        explodeProjectile(projectile);
        if (projectile.glowLight) projectile.mesh.remove(projectile.glowLight);
        if (projectile.meteorShadow) {
          scene.remove(projectile.meteorShadow);
          projectile.meteorShadow.geometry.dispose();
          projectile.meteorShadow.material.dispose();
        }
        disposeGroupMeshes(projectile.mesh);
        scene.remove(projectile.mesh);
        projectiles.splice(i, 1);
      } else {
        projectile.mesh.position.add(dir.normalize().multiplyScalar(step));
        if (projectile.spellVfx && projectile.spellVfx.trailEffect !== 'none') {
          spawnTrailParticle(projectile.mesh.position, { vfx: projectile.spellVfx });
        }
      }
      continue;
    }

    if (!projectile.target || projectile.target.dead || !enemies.includes(projectile.target)) {
      if (projectile.meteorShadow) {
        scene.remove(projectile.meteorShadow);
        projectile.meteorShadow.geometry.dispose();
        projectile.meteorShadow.material.dispose();
      }
      disposeGroupMeshes(projectile.mesh);
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
      if (projectile.glowLight) projectile.mesh.remove(projectile.glowLight);
      if (projectile.meteorShadow) {
        scene.remove(projectile.meteorShadow);
        projectile.meteorShadow.geometry.dispose();
        projectile.meteorShadow.material.dispose();
      }
      disposeGroupMeshes(projectile.mesh);
      scene.remove(projectile.mesh);
      projectiles.splice(i, 1);
      continue;
    }

    projectile.mesh.position.add(dir.normalize().multiplyScalar(step));
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
  flashEnemyHit(enemy.visual);
  if (enemy.hp > 0) {
    enemy.hitTimer = 0.35;
    setEnemyAnim(enemy.visual, 'hit');
    playHurt();
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

  if (effects.includes('root')) {
    enemy.rootedFor = Math.max(enemy.rootedFor, 1.6 * intensity + 0.6);
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
      disposeGroupMeshes(wall.mesh);
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
        disposeGroupMeshes(zone.mesh);
        scene.remove(zone.mesh);
      }
      zones.splice(i, 1);
    }
  }
}

function updateResources(dt) {
}

function updateHud() {
  dom.baseHp.textContent = Math.max(0, Math.floor(GAME.baseHp));
  dom.wave.textContent = String(GAME.wave);
  dom.score.textContent = String(GAME.score);
  dom.unlocks.textContent = GAME.unlocks.join(', ');
  if (dom.baseHpBar) dom.baseHpBar.style.width = `${Math.max(0, (GAME.baseHp / 200) * 100)}%`;
}

function updateStats(dt) {
  frameTimes.push(dt);
  if (frameTimes.length > 30) frameTimes.shift();
  statsAccum += dt;
  if (statsAccum < 0.5) return;
  statsAccum = 0;
  const avgDt = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
  const fps = avgDt > 0 ? Math.round(1 / avgDt) : 0;
  dom.statsFps.textContent = String(fps);
  let aliveCount = 0;
  for (const e of enemies) { if (!e.dead) aliveCount++; }
  dom.statsEnemies.textContent = String(aliveCount);
  const info = renderer.info.render;
  dom.statsDraws.textContent = String(info.calls);
  dom.statsTris.textContent = info.triangles > 1000
    ? (info.triangles / 1000).toFixed(1) + 'k'
    : String(info.triangles);
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

// ═══════════════════════════════════════════════════════════════
// DEATH SEQUENCE — THE FALL OF THE FORTRESS
// ═══════════════════════════════════════════════════════════════

const deathState = {
  active: false,
  elapsed: 0,
  phase: 0,          // 0=impact 1=crumble 2=eruption 3=shockwave 4=fade 5=overlay
  shrapnel: [],
  explosions: [],
  cameraStart: null,
  groundChunks: [],
  deathLights: [],
  overlayShown: false,
};

function gameOver() {
  GAME.gameOver = true;
  dom.loopStatus.textContent = 'Loop: Halted';
  dom.loopStatus.classList.remove('status-ok');
  dom.loopStatus.classList.add('status-danger');
  dom.applyStatus.textContent = 'Prompt apply disabled (game over)';

  // Begin cinematic death
  deathState.active = true;
  deathState.elapsed = 0;
  deathState.phase = 0;
  deathState.cameraStart = camera.position.clone();

  // Hide HUD elements during death cinematic
  for (const el of [document.getElementById('hud'), document.getElementById('statusStrip'), document.getElementById('historyPanel'), document.getElementById('promptBar')]) {
    if (el) el.style.transition = 'opacity 1.5s';
    if (el) el.style.opacity = '0';
  }

  // ── Phase 0: Initial massive impact — fortress explodes ──
  spawnFortressExplosion();
}

function spawnFortressExplosion() {
  const center = new THREE.Vector3(0, 5, BASE_Z + 2);

  // Massive flash
  const flash = new THREE.PointLight(0xffaa00, 30, 100);
  flash.position.copy(center);
  scene.add(flash);
  deathState.deathLights.push({ light: flash, decay: 8 });

  // Shrapnel — fortress chunks flying outward
  const shrapnelMat = new THREE.MeshStandardMaterial({ color: 0x3a3535, roughness: 0.8, metalness: 0.2 });
  const fireMat = new THREE.MeshStandardMaterial({
    color: 0xff6600, emissive: 0xff4400, emissiveIntensity: 2.5,
    transparent: true, opacity: 0.9,
  });

  for (let i = 0; i < 60; i++) {
    const size = 0.3 + Math.random() * 2;
    const geo = Math.random() > 0.5
      ? new THREE.BoxGeometry(size, size * 0.7, size * 0.8)
      : new THREE.DodecahedronGeometry(size * 0.5, 0);
    const mat = Math.random() > 0.3 ? shrapnelMat : fireMat;
    const chunk = new THREE.Mesh(geo, mat);
    chunk.position.copy(center).add(new THREE.Vector3(
      (Math.random() - 0.5) * 8,
      Math.random() * 4,
      (Math.random() - 0.5) * 6
    ));
    scene.add(chunk);

    const angle = Math.random() * Math.PI * 2;
    const upForce = 8 + Math.random() * 20;
    const outForce = 5 + Math.random() * 18;
    deathState.shrapnel.push({
      mesh: chunk,
      vx: Math.cos(angle) * outForce,
      vy: upForce,
      vz: Math.sin(angle) * outForce - 5,
      rotSpeed: new THREE.Vector3(
        (Math.random() - 0.5) * 10,
        (Math.random() - 0.5) * 10,
        (Math.random() - 0.5) * 10
      ),
      gravity: 22,
      life: 4 + Math.random() * 3,
    });
  }

  // Fire burst particles
  const burstMat = new THREE.MeshStandardMaterial({
    color: 0xffcc33, emissive: 0xff6600, emissiveIntensity: 4,
    transparent: true, opacity: 1,
  });
  for (let i = 0; i < 40; i++) {
    const p = new THREE.Mesh(new THREE.SphereGeometry(0.15 + Math.random() * 0.3, 5, 4), burstMat.clone());
    p.position.copy(center).add(new THREE.Vector3(
      (Math.random() - 0.5) * 4,
      Math.random() * 3 + 2,
      (Math.random() - 0.5) * 4
    ));
    scene.add(p);
    const a = Math.random() * Math.PI * 2;
    deathState.explosions.push({
      mesh: p,
      vx: Math.cos(a) * (3 + Math.random() * 12),
      vy: 5 + Math.random() * 15,
      vz: Math.sin(a) * (3 + Math.random() * 12),
      life: 0.8 + Math.random() * 1.5,
      maxLife: 0.8 + Math.random() * 1.5,
    });
  }
}

function spawnGroundCollapse() {
  // Ground chunks breaking apart around the fortress
  const chunkMat = new THREE.MeshStandardMaterial({ color: 0x3d2b1f, roughness: 0.9, metalness: 0.05 });
  const lavaBurstMat = new THREE.MeshStandardMaterial({
    color: 0xff4400, emissive: 0xff2200, emissiveIntensity: 3,
    transparent: true, opacity: 0.8,
  });

  for (let i = 0; i < 35; i++) {
    const x = (Math.random() - 0.5) * MAP_WIDTH * 0.8;
    const z = CASTLE_WALL_Z - 5 + (Math.random() - 0.5) * 30;
    const size = 1 + Math.random() * 3;
    const chunk = new THREE.Mesh(
      new THREE.BoxGeometry(size, size * 0.4, size),
      Math.random() > 0.7 ? lavaBurstMat.clone() : chunkMat
    );
    chunk.position.set(x, 0, z);
    chunk.rotation.set(Math.random() * 0.3, Math.random() * 3, Math.random() * 0.3);
    scene.add(chunk);

    deathState.groundChunks.push({
      mesh: chunk,
      vy: 3 + Math.random() * 10,
      vx: (Math.random() - 0.5) * 6,
      vz: (Math.random() - 0.5) * 6,
      rotSpeed: (Math.random() - 0.5) * 5,
      fallDelay: Math.random() * 1.5,
      fallen: false,
    });
  }

  // Secondary explosion lights
  for (let i = 0; i < 6; i++) {
    const light = new THREE.PointLight(0xff4400, 8, 30);
    light.position.set(
      (Math.random() - 0.5) * 30,
      2 + Math.random() * 5,
      CASTLE_WALL_Z + (Math.random() - 0.5) * 20
    );
    scene.add(light);
    deathState.deathLights.push({ light, decay: 3 + Math.random() * 2 });
  }
}

function spawnVolcanicEruption() {
  // Giant eruption from the central volcano
  const center = new THREE.Vector3(0, 40, -140);
  const eruptMat = new THREE.MeshStandardMaterial({
    color: 0xff6600, emissive: 0xff3300, emissiveIntensity: 4,
    transparent: true, opacity: 0.9,
  });

  for (let i = 0; i < 50; i++) {
    const p = new THREE.Mesh(
      new THREE.SphereGeometry(0.4 + Math.random() * 1.2, 5, 4),
      eruptMat.clone()
    );
    p.position.copy(center).add(new THREE.Vector3(
      (Math.random() - 0.5) * 8,
      Math.random() * 5,
      (Math.random() - 0.5) * 8
    ));
    scene.add(p);
    const a = Math.random() * Math.PI * 2;
    deathState.explosions.push({
      mesh: p,
      vx: Math.cos(a) * (2 + Math.random() * 8),
      vy: 15 + Math.random() * 30,
      vz: Math.sin(a) * (2 + Math.random() * 8) + 10,
      life: 2 + Math.random() * 3,
      maxLife: 2 + Math.random() * 3,
    });
  }

  // Volcano flash
  const vFlash = new THREE.PointLight(0xff2200, 40, 200);
  vFlash.position.set(0, 50, -140);
  scene.add(vFlash);
  deathState.deathLights.push({ light: vFlash, decay: 4 });
}

function showDeathOverlay() {
  if (deathState.overlayShown) return;
  deathState.overlayShown = true;

  const overlay = document.createElement('div');
  overlay.id = 'deathOverlay';
  overlay.innerHTML = `
    <div class="death-vignette"></div>
    <div class="death-embers" aria-hidden="true"></div>
    <div class="death-content">
      <div class="death-rune">&#x2620;</div>
      <h1 class="death-title">THE FORTRESS<br/><span class="death-title-accent">HAS FALLEN</span></h1>
      <div class="death-stats">
        <div class="death-stat"><span class="death-stat-value">${GAME.score}</span><span class="death-stat-label">SCORE</span></div>
        <div class="death-stat-divider"></div>
        <div class="death-stat"><span class="death-stat-value">${GAME.wave}</span><span class="death-stat-label">WAVES</span></div>
        <div class="death-stat-divider"></div>
        <div class="death-stat"><span class="death-stat-value">${GAME.kills}</span><span class="death-stat-label">KILLS</span></div>
      </div>
      <button id="deathRestartBtn" class="death-restart" type="button">
        <span class="death-restart-text">RISE AGAIN</span>
        <span class="death-restart-glow"></span>
      </button>
      <div class="death-hint">or press <kbd>R</kbd></div>
    </div>
  `;
  document.body.appendChild(overlay);

  requestAnimationFrame(() => overlay.classList.add('death-visible'));

  document.getElementById('deathRestartBtn').addEventListener('click', () => {
    window.location.reload();
  });
}

function updateDeathSequence(dt) {
  if (!deathState.active) return;
  deathState.elapsed += dt;
  const t = deathState.elapsed;

  // Phase triggers
  if (t > 0.5 && deathState.phase < 1) {
    deathState.phase = 1;
    spawnGroundCollapse();
  }
  if (t > 2.0 && deathState.phase < 2) {
    deathState.phase = 2;
    spawnVolcanicEruption();
  }
  if (t > 4.0 && deathState.phase < 3) {
    deathState.phase = 3;
    // Massive shockwave ring
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1, 3, 32),
      new THREE.MeshStandardMaterial({
        color: 0xff6600, emissive: 0xff4400, emissiveIntensity: 3,
        transparent: true, opacity: 0.8, side: THREE.DoubleSide,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(0, 1, BASE_Z);
    scene.add(ring);
    deathState.shockwaveRing = ring;
  }
  if (t > 5.5 && deathState.phase < 4) {
    deathState.phase = 4;
  }
  if (t > 7.0 && deathState.phase < 5) {
    deathState.phase = 5;
    showDeathOverlay();
  }

  // ── Cinematic camera ──
  const cs = deathState.cameraStart;
  if (t < 1.5) {
    // Dramatic zoom toward fortress + heavy shake
    const z = t / 1.5;
    camera.position.set(
      cs.x + (Math.random() - 0.5) * (2 - z) * 2,
      cs.y - z * 12 + (Math.random() - 0.5) * (2 - z) * 1.5,
      cs.z - z * 15
    );
    camera.lookAt(0, 4, BASE_Z);
  } else if (t < 3.5) {
    // Slow pull back + pan up to see eruption
    const z = (t - 1.5) / 2;
    camera.position.set(
      Math.sin(t * 0.3) * 8,
      cs.y - 12 + z * 20 + (Math.random() - 0.5) * 0.3,
      cs.z - 15 + z * 5
    );
    camera.lookAt(0, 10 + z * 15, -40);
  } else if (t < 6.0) {
    // Orbit the destruction slowly
    const z = (t - 3.5) / 2.5;
    const angle = z * Math.PI * 0.4;
    camera.position.set(
      Math.sin(angle) * 50,
      30 + z * 10,
      20 + Math.cos(angle) * 40
    );
    camera.lookAt(0, 5, -10);
    // Subtle shake
    camera.position.x += (Math.random() - 0.5) * 0.2;
    camera.position.y += (Math.random() - 0.5) * 0.15;
  } else {
    // Final slow drift upward
    const z = Math.min((t - 6) / 3, 1);
    camera.position.set(
      Math.sin(t * 0.15) * 20,
      35 + z * 20,
      30 + z * 10
    );
    camera.lookAt(0, 5, -20);
  }

  // ── Update shrapnel ──
  for (const s of deathState.shrapnel) {
    if (s.life <= 0) continue;
    s.life -= dt;
    s.vy -= s.gravity * dt;
    s.mesh.position.x += s.vx * dt;
    s.mesh.position.y += s.vy * dt;
    s.mesh.position.z += s.vz * dt;
    s.mesh.rotation.x += s.rotSpeed.x * dt;
    s.mesh.rotation.y += s.rotSpeed.y * dt;
    s.mesh.rotation.z += s.rotSpeed.z * dt;
    // Bounce off ground
    if (s.mesh.position.y < 0.2) {
      s.mesh.position.y = 0.2;
      s.vy = Math.abs(s.vy) * 0.3;
      s.vx *= 0.7;
      s.vz *= 0.7;
    }
    if (s.life < 1) {
      s.mesh.material.opacity = Math.max(0, s.life);
      s.mesh.material.transparent = true;
    }
  }

  // ── Update fire particles ──
  for (const e of deathState.explosions) {
    if (e.life <= 0) continue;
    e.life -= dt;
    e.vy -= 15 * dt;
    e.mesh.position.x += e.vx * dt;
    e.mesh.position.y += e.vy * dt;
    e.mesh.position.z += e.vz * dt;
    const lifeRatio = e.life / e.maxLife;
    e.mesh.material.opacity = lifeRatio;
    e.mesh.scale.setScalar(0.5 + (1 - lifeRatio) * 1.5);
    if (e.mesh.position.y < 0.1) {
      e.mesh.position.y = 0.1;
      e.vy = Math.abs(e.vy) * 0.2;
    }
  }

  // ── Update ground chunks ──
  for (const c of deathState.groundChunks) {
    c.fallDelay -= dt;
    if (c.fallDelay > 0) continue;
    if (!c.fallen) {
      c.fallen = true;
      c.mesh.position.y = 0;
    }
    c.vy -= 18 * dt;
    c.mesh.position.x += c.vx * dt;
    c.mesh.position.y += c.vy * dt;
    c.mesh.position.z += c.vz * dt;
    c.mesh.rotation.x += c.rotSpeed * dt;
    if (c.mesh.position.y < -15) {
      c.mesh.visible = false;
    }
  }

  // ── Update death lights (decay) ──
  for (const d of deathState.deathLights) {
    d.light.intensity *= (1 - d.decay * dt * 0.3);
    if (d.light.intensity < 0.01) d.light.intensity = 0;
  }

  // ── Shockwave ring expansion ──
  if (deathState.shockwaveRing) {
    const ring = deathState.shockwaveRing;
    const age = t - 4;
    const scale = 1 + age * 35;
    ring.scale.set(scale, scale, 1);
    ring.material.opacity = Math.max(0, 0.8 - age * 0.4);
    ring.position.y = 1 + age * 2;
  }

  // ── Fog closes in during death ──
  const fogProgress = Math.min(t / 8, 1);
  scene.fog.near = 60 - fogProgress * 40;
  scene.fog.far = 170 - fogProgress * 100;
  scene.fog.color.setHex(lerpColor(0x1a0800, 0x0a0000, fogProgress));

  // ── Tone mapping darkens ──
  renderer.toneMappingExposure = 1.4 - fogProgress * 0.8;

  // ── Ambient light fades to deep red ──
  ambient.intensity = 0.7 - fogProgress * 0.4;
  ambient.color.setHex(lerpColor(0xcc8866, 0x440000, fogProgress));

  // Keep environment animating during death
  updateEnvironment(GAME.elapsed + t, dt);
}

function lerpColor(a, b, t) {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  const rr = ar + (br - ar) * t;
  const gg = ag + (bg - ag) * t;
  const bb2 = ab + (bb - ab) * t;
  return ((rr & 0xff) << 16) | ((gg & 0xff) << 8) | (bb2 & 0xff);
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
    updateEnemies(dt);
    updateProjectiles(dt);
    updateTrailParticles(dt);
    updateImpactFlashes(dt);
    updateScreenShake(dt);
    updateZoneParticles(dt);
    updateEnvironment(GAME.elapsed, dt);
    updateHud();

    if (GAME.baseHp <= 0) {
      gameOver();
    }
  } else {
    updateDeathSequence(dt);
  }

  updateToast(dt);
  renderer.render(scene, camera);
  updateStats(dt);
  requestAnimationFrame(animate);
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

const poolGeoSet = new Set(Object.values(POOL_GEO));

function disposeGroupMeshes(obj) {
  if (obj.isMesh) {
    if (obj.geometry && !poolGeoSet.has(obj.geometry)) {
      obj.geometry.dispose();
    }
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) {
      if (m) m.dispose();
    }
  }
  if (obj.children) {
    for (const child of obj.children) {
      disposeGroupMeshes(child);
    }
  }
}

function isTypingTarget(target) {
  if (!target || typeof target.closest !== 'function') {
    return false;
  }

  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}
