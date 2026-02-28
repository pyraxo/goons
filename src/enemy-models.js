import * as THREE from 'three';

const DEFAULT_MANIFEST = [
  {
    kind: 'melee',
    path: '/models/enemies/goblin.glb',
    scale: 1.1,
    yOffset: 0.02,
    castsShadow: true,
  },
  {
    kind: 'ranged',
    path: '/models/enemies/archer_goblin.glb',
    scale: 1.05,
    yOffset: 0.02,
    castsShadow: false,
  },
  {
    kind: 'tank',
    path: '/models/enemies/ogre.glb',
    scale: 1.28,
    yOffset: 0.03,
    castsShadow: true,
  },
];

const VISUAL_STYLE = {
  melee: {
    skinA: '#8da974',
    skinB: '#60794c',
    clothA: '#5a4a3f',
    clothB: '#362d27',
    metal: '#b9c3cf',
    glow: '#f3cf8f',
  },
  ranged: {
    skinA: '#9f8f77',
    skinB: '#6f6151',
    clothA: '#6f7f98',
    clothB: '#48556d',
    metal: '#c3cad6',
    glow: '#89c3ff',
  },
  tank: {
    skinA: '#9f9c83',
    skinB: '#72705e',
    clothA: '#555647',
    clothB: '#303227',
    metal: '#9da5ae',
    glow: '#e7a974',
  },
};

const FALLBACK_LOOK = {
  melee: { size: 1.7, color: 0x6f8062 },
  ranged: { size: 1.45, color: 0x7a4963 },
  tank: { size: 2.4, color: 0x49566f },
};

const registry = new Map();
let loadPromise = null;

export async function loadEnemyModels(scene) {
  void scene;

  if (loadPromise) {
    return loadPromise;
  }

  loadPromise = internalLoadEnemyVisuals();
  return loadPromise;
}

async function internalLoadEnemyVisuals() {
  const manifest = await loadManifest();
  const byKind = new Map(DEFAULT_MANIFEST.map((entry) => [entry.kind, { ...entry }]));

  for (const entry of manifest) {
    if (entry && entry.kind) {
      byKind.set(entry.kind, { ...byKind.get(entry.kind), ...entry });
    }
  }

  for (const [kind, entry] of byKind) {
    registry.set(kind, {
      kind,
      entry,
      texture: createEnemySpriteTexture(kind),
      failed: false,
    });
  }
}

async function loadManifest() {
  try {
    const response = await fetch('/models/enemies/manifest.json', { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const json = await response.json();
    if (!Array.isArray(json)) {
      throw new Error('manifest must be an array');
    }

    return json;
  } catch (error) {
    console.warn('[enemy-models] Failed to load manifest. Using defaults.', error);
    return DEFAULT_MANIFEST;
  }
}

function createEnemySpriteTexture(kind) {
  const style = VISUAL_STYLE[kind] || VISUAL_STYLE.melee;
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return null;
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const bgGlow = ctx.createRadialGradient(256, 318, 35, 256, 318, 190);
  bgGlow.addColorStop(0, rgbaHex(style.glow, 0.26));
  bgGlow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = bgGlow;
  ctx.beginPath();
  ctx.arc(256, 318, 200, 0, Math.PI * 2);
  ctx.fill();

  drawFeetShadow(ctx);
  drawEnemyBody(ctx, kind, style);
  addPaintGrain(ctx, 1300);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;

  return texture;
}

function drawFeetShadow(ctx) {
  const shadow = ctx.createRadialGradient(256, 454, 30, 256, 454, 110);
  shadow.addColorStop(0, 'rgba(0, 0, 0, 0.34)');
  shadow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = shadow;
  ctx.beginPath();
  ctx.ellipse(256, 454, 120, 38, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawEnemyBody(ctx, kind, style) {
  const x = 256;

  drawLegs(ctx, x, kind, style);
  drawTorso(ctx, x, kind, style);
  drawHead(ctx, x, kind, style);

  if (kind === 'ranged') {
    drawBow(ctx, x, style);
  }

  if (kind === 'melee') {
    drawClub(ctx, x, style);
  }

  if (kind === 'tank') {
    drawMace(ctx, x, style);
  }

  drawEyes(ctx, x, kind);
}

function drawLegs(ctx, x, kind, style) {
  const width = kind === 'tank' ? 118 : 78;
  const height = kind === 'tank' ? 114 : 88;
  const y = kind === 'tank' ? 390 : 398;

  const grad = ctx.createLinearGradient(0, y - height * 0.5, 0, y + height * 0.5);
  grad.addColorStop(0, style.clothA);
  grad.addColorStop(1, style.clothB);

  roundedRect(ctx, x - width / 2, y - height / 2, width, height, 18, grad);
}

function drawTorso(ctx, x, kind, style) {
  const width = kind === 'tank' ? 172 : 116;
  const height = kind === 'tank' ? 178 : 136;
  const y = kind === 'tank' ? 286 : 304;

  const torsoGrad = ctx.createLinearGradient(0, y - height * 0.5, 0, y + height * 0.5);
  torsoGrad.addColorStop(0, style.skinA);
  torsoGrad.addColorStop(1, style.skinB);

  roundedRect(ctx, x - width / 2, y - height / 2, width, height, 28, torsoGrad);

  const armorGrad = ctx.createLinearGradient(0, y - 20, 0, y + 58);
  armorGrad.addColorStop(0, rgbaHex(style.metal, 0.55));
  armorGrad.addColorStop(1, rgbaHex(style.metal, 0.15));
  roundedRect(ctx, x - width * 0.28, y - 15, width * 0.56, height * 0.42, 14, armorGrad);
}

function drawHead(ctx, x, kind, style) {
  const w = kind === 'tank' ? 138 : 98;
  const h = kind === 'tank' ? 118 : 86;
  const y = kind === 'tank' ? 185 : 214;

  const grad = ctx.createLinearGradient(0, y - h * 0.6, 0, y + h * 0.6);
  grad.addColorStop(0, brightenHex(style.skinA, 0.18));
  grad.addColorStop(1, style.skinB);

  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.ellipse(x, y, w * 0.5, h * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();

  if (kind === 'melee') {
    drawEar(ctx, x - 52, y - 8, -1, style.skinA);
    drawEar(ctx, x + 52, y - 8, 1, style.skinA);
  }

  if (kind === 'ranged') {
    ctx.fillStyle = rgbaHex(style.clothB, 0.92);
    ctx.beginPath();
    ctx.ellipse(x, y - 12, w * 0.62, h * 0.53, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  if (kind === 'tank') {
    ctx.fillStyle = rgbaHex('#2f2f2f', 0.28);
    ctx.beginPath();
    ctx.ellipse(x, y + 18, w * 0.28, h * 0.18, 0, 0, Math.PI);
    ctx.fill();
  }
}

function drawEar(ctx, x, y, dir, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(0.42 * dir);
  ctx.fillStyle = brightenHex(color, 0.12);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(18 * dir, -6);
  ctx.lineTo(13 * dir, 16);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawEyes(ctx, x, kind) {
  const y = kind === 'tank' ? 185 : 216;
  const dist = kind === 'tank' ? 25 : 18;
  const eyeColor = kind === 'ranged' ? '#90d0ff' : '#f6cf62';

  ctx.fillStyle = eyeColor;
  ctx.beginPath();
  ctx.arc(x - dist, y, 4.2, 0, Math.PI * 2);
  ctx.arc(x + dist, y, 4.2, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = 'rgba(0,0,0,0.36)';
  ctx.beginPath();
  ctx.arc(x - dist + 1, y + 1, 1.8, 0, Math.PI * 2);
  ctx.arc(x + dist + 1, y + 1, 1.8, 0, Math.PI * 2);
  ctx.fill();
}

function drawClub(ctx, x, style) {
  ctx.save();
  ctx.translate(x + 108, 300);
  ctx.rotate(-0.62);
  roundedRect(ctx, -8, -35, 16, 98, 7, '#6d5239');
  roundedRect(ctx, -17, -52, 34, 24, 10, rgbaHex(style.metal, 0.82));
  ctx.restore();
}

function drawBow(ctx, x, style) {
  ctx.save();
  ctx.translate(x + 104, 304);
  ctx.rotate(-0.16);
  ctx.strokeStyle = '#735739';
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.arc(0, 0, 48, -Math.PI * 0.46, Math.PI * 0.46);
  ctx.stroke();

  ctx.strokeStyle = rgbaHex(style.metal, 0.65);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(34, -22);
  ctx.lineTo(34, 22);
  ctx.stroke();
  ctx.restore();
}

function drawMace(ctx, x, style) {
  ctx.save();
  ctx.translate(x + 140, 294);
  ctx.rotate(-0.42);
  roundedRect(ctx, -8, -42, 16, 112, 7, '#53402f');
  ctx.fillStyle = rgbaHex(style.metal, 0.9);
  ctx.beginPath();
  ctx.arc(0, -57, 21, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function addPaintGrain(ctx, points) {
  for (let i = 0; i < points; i += 1) {
    const x = Math.random() * 512;
    const y = Math.random() * 512;
    const alpha = Math.random() * 0.05;
    ctx.fillStyle = `rgba(0,0,0,${alpha})`;
    ctx.fillRect(x, y, 1, 1);
  }
}

function roundedRect(ctx, x, y, width, height, radius, fillStyle) {
  const r = Math.min(radius, width * 0.5, height * 0.5);
  ctx.fillStyle = fillStyle;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fill();
}

function brightenHex(hex, amount) {
  const { r, g, b } = parseHex(hex);
  const blend = (v) => Math.round(v + (255 - v) * amount);
  return `rgb(${blend(r)}, ${blend(g)}, ${blend(b)})`;
}

function rgbaHex(hex, alpha) {
  const { r, g, b } = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function parseHex(hex) {
  const clean = hex.replace('#', '');
  const value = clean.length === 3
    ? clean.split('').map((ch) => ch + ch).join('')
    : clean;

  const int = Number.parseInt(value, 16);
  return {
    r: (int >> 16) & 255,
    g: (int >> 8) & 255,
    b: int & 255,
  };
}

export function spawnEnemyVisual(kind, lane, position) {
  void lane;

  const record = registry.get(kind);
  if (!record || !record.texture || record.failed) {
    return buildFallbackVisual(kind, position);
  }

  const entry = record.entry;
  const baseHeight = (entry.scale || 1) * (kind === 'tank' ? 6.6 : kind === 'ranged' ? 5.2 : 5.7);
  const baseWidth = baseHeight * (kind === 'tank' ? 0.72 : 0.64);

  const material = new THREE.SpriteMaterial({
    map: record.texture,
    transparent: true,
    alphaTest: 0.03,
    depthWrite: false,
    color: new THREE.Color(1, 1, 1),
  });

  const sprite = new THREE.Sprite(material);
  sprite.center.set(0.5, 0);
  sprite.scale.set(baseWidth, baseHeight, 1);
  sprite.position.set(0, entry.yOffset || 0, 0);

  const group = new THREE.Group();
  group.position.copy(position);
  group.add(sprite);

  const shadow = createGroundShadow(baseWidth, entry.castsShadow !== false);
  if (shadow) {
    group.add(shadow);
  }

  return {
    group,
    root: sprite,
    mixer: null,
    actions: {},
    activeAction: null,
    state: 'idle',
    playbackScale: 1,
    isFallback: false,
    _shadow: shadow,
    _anim: {
      t: Math.random() * 3,
      hitLeft: 0,
      dieT: 0,
      baseY: entry.yOffset || 0,
      baseW: baseWidth,
      baseH: baseHeight,
    },
    update(dt) {
      updateSpriteEnemy(this, dt);
    },
  };
}

function createGroundShadow(width, enabled) {
  if (!enabled) {
    return null;
  }

  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(width * 0.34, 14),
    new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
    })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.01;

  return shadow;
}

function updateSpriteEnemy(enemyVisual, dt) {
  const sprite = enemyVisual.root;
  const anim = enemyVisual._anim;

  anim.t += dt * Math.max(0.18, enemyVisual.playbackScale);

  let bob = 0;
  let sway = 0;
  let scaleY = 1;
  let scaleX = 1;

  if (enemyVisual.state === 'run') {
    bob = Math.sin(anim.t * 8.5) * 0.11;
    sway = Math.sin(anim.t * 6.1) * 0.05;
    scaleY = 0.98 + Math.sin(anim.t * 8.5) * 0.04;
    scaleX = 1.01 - Math.sin(anim.t * 8.5) * 0.03;
  } else if (enemyVisual.state === 'hit') {
    anim.hitLeft = Math.max(0, anim.hitLeft - dt);
    bob = 0.04;
    sway = Math.sin(anim.t * 36) * 0.06;
    const pulse = 0.72 + Math.sin(anim.t * 42) * 0.28;
    sprite.material.color.setRGB(1, pulse, pulse);
  } else if (enemyVisual.state === 'die') {
    anim.dieT = Math.min(1, anim.dieT + dt / 0.45);
    bob = -0.1 * anim.dieT;
    sway = anim.dieT * 0.45;
    scaleY = 1 - anim.dieT * 0.62;
    scaleX = 1 + anim.dieT * 0.16;
    sprite.material.opacity = 1 - anim.dieT * 0.45;
  } else {
    bob = Math.sin(anim.t * 2.1) * 0.04;
    sway = Math.sin(anim.t * 1.5) * 0.02;
  }

  if (enemyVisual.state !== 'hit') {
    sprite.material.color.setRGB(1, 1, 1);
  }

  sprite.position.y = anim.baseY + bob;
  sprite.material.rotation = sway;
  sprite.scale.set(anim.baseW * scaleX, anim.baseH * scaleY, 1);

  if (enemyVisual._shadow) {
    const shadowScale = 1 - bob * 0.35;
    enemyVisual._shadow.scale.set(shadowScale, shadowScale, shadowScale);
    enemyVisual._shadow.material.opacity = 0.22 + (1 - anim.dieT) * 0.08;
  }
}

export function setEnemyAnim(enemyVisual, state) {
  enemyVisual.state = state;

  if (enemyVisual.isFallback) {
    return;
  }

  if (state === 'hit') {
    enemyVisual._anim.hitLeft = 0.12;
  }

  if (state === 'die') {
    enemyVisual._anim.dieT = 0;
  }

  if (state === 'run' || state === 'idle') {
    enemyVisual.root.material.opacity = 1;
    enemyVisual.root.material.color.setRGB(1, 1, 1);
  }
}

export function disposeEnemyVisual(enemyVisual) {
  if (enemyVisual.root?.material) {
    enemyVisual.root.material.dispose();
  }

  if (enemyVisual._shadow?.material) {
    enemyVisual._shadow.material.dispose();
  }

  if (enemyVisual._shadow?.geometry) {
    enemyVisual._shadow.geometry.dispose();
  }

  if (enemyVisual.group?.parent) {
    enemyVisual.group.parent.remove(enemyVisual.group);
  }
}

function buildFallbackVisual(kind, position) {
  const look = FALLBACK_LOOK[kind] || FALLBACK_LOOK.melee;
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(look.size, look.size, look.size),
    new THREE.MeshStandardMaterial({ color: look.color, roughness: 0.86 })
  );
  mesh.position.y = look.size / 2;
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const wrapper = new THREE.Group();
  wrapper.position.copy(position);
  wrapper.add(mesh);

  return {
    group: wrapper,
    root: mesh,
    mixer: null,
    actions: {},
    activeAction: null,
    state: 'run',
    playbackScale: 1,
    isFallback: true,
    update() {},
  };
}
