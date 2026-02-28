import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';

const DEFAULT_MANIFEST = [
  {
    kind: 'melee',
    path: '/models/enemies/goblin-walk/Walking.fbx',
    scale: 0.012,
    yOffset: 0,
    castsShadow: true,
  },
  {
    kind: 'ranged',
    path: '/models/enemies/goblin-walk/Walking.fbx',
    scale: 0.011,
    yOffset: 0,
    castsShadow: false,
  },
  {
    kind: 'tank',
    path: '/models/enemies/goblin-walk/Walking.fbx',
    scale: 0.015,
    yOffset: 0,
    castsShadow: true,
  },
];

const FALLBACK_LOOK = {
  melee: { size: 1.7, color: 0x6f8062 },
  ranged: { size: 1.45, color: 0x7a4963 },
  tank: { size: 2.4, color: 0x49566f },
};

const KIND_TINT = {
  melee: 0xffffff,
  ranged: 0xcfdcff,
  tank: 0xe6dfcf,
};

const textureUrls = {
  map: '/models/enemies/goblin-walk/textures/Goblin_Base_color.png',
  normalMap: '/models/enemies/goblin-walk/textures/Goblin_Normal_OpenGL.png',
  roughnessMap: '/models/enemies/goblin-walk/textures/Goblin_Roughness.png',
  metalnessMap: '/models/enemies/goblin-walk/textures/Goblin_Metallic.png',
  aoMap: '/models/enemies/goblin-walk/textures/Goblin_Mixed_AO.png',
};
const meleeAttackClipPath = '/models/enemies/goblin-walk/StandingMeleeAttackDownward.fbx';

const stateAliases = {
  idle: ['idle'],
  run: ['run', 'walk', 'locomotion', 'moving'],
  attack: ['attack', 'strike', 'slash', 'punch', 'run', 'walk'],
  hit: ['hit', 'hurt', 'impact', 'damage'],
  die: ['die', 'death', 'dead', 'knockout'],
};

const registry = new Map();
let loadPromise = null;

export async function loadEnemyModels(scene) {
  void scene;

  if (loadPromise) {
    return loadPromise;
  }

  loadPromise = internalLoadEnemyModels();
  return loadPromise;
}

async function internalLoadEnemyModels() {
  const manifest = await loadManifest();
  const byKind = new Map(DEFAULT_MANIFEST.map((entry) => [entry.kind, { ...entry }]));

  for (const entry of manifest) {
    if (entry && entry.kind) {
      byKind.set(entry.kind, { ...byKind.get(entry.kind), ...entry });
    }
  }

  const texturePack = await loadTexturePack();
  const loader = new FBXLoader();
  const byPath = new Map();
  const meleeAttackClip = await loadOptionalAttackClip(loader, meleeAttackClipPath);

  for (const [kind, entry] of byKind) {
    let shared = byPath.get(entry.path);
    if (!shared) {
      shared = await loadPathTemplate(loader, entry.path, texturePack);
      byPath.set(entry.path, shared);
    }

    const clips = kind === 'melee' ? withAttackClip(shared.clips, meleeAttackClip) : shared.clips;

    registry.set(kind, {
      kind,
      entry,
      failed: shared.failed,
      templateRoot: shared.templateRoot,
      clips,
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

async function loadPathTemplate(loader, path, texturePack) {
  try {
    const root = await loader.loadAsync(path);
    const clips = root.animations || [];

    normalizeRootToGround(root);
    root.updateMatrixWorld(true);
    prepareTemplateMaterials(root, texturePack);

    return {
      failed: false,
      templateRoot: root,
      clips,
    };
  } catch (error) {
    console.warn(`[enemy-models] Could not load ${path}. Falling back to box mesh.`, error);
    return {
      failed: true,
      templateRoot: null,
      clips: [],
    };
  }
}

async function loadOptionalAttackClip(loader, path) {
  try {
    const root = await loader.loadAsync(path);
    const clips = root.animations || [];
    if (!clips.length) {
      console.warn(`[enemy-models] No animations found in ${path}.`);
      return null;
    }

    const clip = clips[0].clone();
    clip.name = 'attack';
    return clip;
  } catch (error) {
    console.warn(`[enemy-models] Optional attack clip missing at ${path}. Falling back to run.`, error);
    return null;
  }
}

function withAttackClip(baseClips, attackClip) {
  if (!attackClip) {
    return baseClips;
  }

  const merged = [...baseClips];
  const attackKey = normalize('attack');
  const index = merged.findIndex((clip) => normalize(clip.name) === attackKey);
  if (index >= 0) {
    merged[index] = attackClip;
  } else {
    merged.push(attackClip);
  }

  return merged;
}

function normalizeRootToGround(root) {
  const box = new THREE.Box3().setFromObject(root);
  if (!Number.isFinite(box.min.y)) {
    return;
  }

  root.position.y += -box.min.y;
}

function prepareTemplateMaterials(root, texturePack) {
  root.traverse((child) => {
    if (!child.isMesh) {
      return;
    }

    child.castShadow = true;
    child.receiveShadow = false;
    child.frustumCulled = true;

    if (child.geometry?.attributes?.uv && !child.geometry.attributes.uv2) {
      child.geometry.setAttribute('uv2', child.geometry.attributes.uv);
    }

    child.material = buildStandardMaterial(texturePack);
  });
}

function buildStandardMaterial(texturePack) {
  const material = new THREE.MeshStandardMaterial({
    map: texturePack.map || null,
    normalMap: texturePack.normalMap || null,
    roughnessMap: texturePack.roughnessMap || null,
    metalnessMap: texturePack.metalnessMap || null,
    aoMap: texturePack.aoMap || null,
    color: 0xffffff,
    roughness: texturePack.roughnessMap ? 1 : 0.82,
    metalness: texturePack.metalnessMap ? 1 : 0.08,
  });

  material.needsUpdate = true;
  return material;
}

async function loadTexturePack() {
  const loader = new THREE.TextureLoader();

  const entries = await Promise.all(
    Object.entries(textureUrls).map(async ([key, url]) => {
      try {
        const texture = await loader.loadAsync(url);
        texture.needsUpdate = true;

        if (key === 'map') {
          texture.colorSpace = THREE.SRGBColorSpace;
        }

        return [key, texture];
      } catch (error) {
        console.warn(`[enemy-models] Missing texture ${url}`, error);
        return [key, null];
      }
    })
  );

  return Object.fromEntries(entries);
}

export function spawnEnemyVisual(kind, lane, position) {
  void lane;

  const record = registry.get(kind);
  if (!record || record.failed || !record.templateRoot) {
    return buildFallbackVisual(kind, position);
  }

  const clone = SkeletonUtils.clone(record.templateRoot);
  clone.traverse((child) => {
    if (!child.isMesh) {
      return;
    }

    child.material = cloneMaterialWithTint(child.material, KIND_TINT[kind] || 0xffffff);
    child.castShadow = Boolean(record.entry.castsShadow);
    child.receiveShadow = false;
  });

  const group = new THREE.Group();
  group.position.copy(position);
  group.scale.setScalar(record.entry.scale || 1);
  clone.position.y += record.entry.yOffset || 0;
  group.add(clone);

  const mixer = record.clips.length ? new THREE.AnimationMixer(clone) : null;
  const actions = mixer ? buildActions(mixer, record.clips) : {};

  return {
    group,
    root: clone,
    mixer,
    actions,
    activeAction: null,
    state: 'idle',
    playbackScale: 1,
    isFallback: false,
    update(dt) {
      if (this.mixer) {
        this.mixer.timeScale = this.playbackScale;
        this.mixer.update(dt);
      }
    },
  };
}

function cloneMaterialWithTint(material, tintHex) {
  const tint = new THREE.Color(tintHex);

  if (Array.isArray(material)) {
    return material.map((entry) => cloneOneMaterial(entry, tint));
  }

  return cloneOneMaterial(material, tint);
}

function cloneOneMaterial(material, tint) {
  if (!material) {
    const fallback = new THREE.MeshStandardMaterial({ color: tint.clone() });
    fallback.userData.enemyInstanceMaterial = true;
    return fallback;
  }

  const cloned = material.clone();
  if (cloned.color) {
    cloned.color.multiply(tint);
  }
  cloned.userData.enemyInstanceMaterial = true;
  return cloned;
}

function buildActions(mixer, clips) {
  const actions = {};
  for (const clip of clips) {
    const sanitized = sanitizeClipForInPlaceMotion(clip);
    const key = normalize(sanitized.name);
    actions[key] = mixer.clipAction(sanitized);
  }

  return actions;
}

function sanitizeClipForInPlaceMotion(clip) {
  const cloned = clip.clone();
  for (const track of cloned.tracks) {
    if (!track.name.endsWith('.position')) {
      continue;
    }

    if (track.getValueSize() !== 3) {
      continue;
    }

    // Remove lateral root-motion drift so gameplay movement controls world translation.
    const values = track.values;
    const baseX = values[0];
    const baseZ = values[2];
    for (let i = 0; i < values.length; i += 3) {
      values[i] = baseX;
      values[i + 2] = baseZ;
    }
  }

  return cloned;
}

function normalize(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function resolveAction(enemyVisual, state) {
  const aliases = stateAliases[state] || [state];

  for (const alias of aliases) {
    const key = normalize(alias);
    if (enemyVisual.actions[key]) {
      return enemyVisual.actions[key];
    }
  }

  // Fallbacks keep combat readable even when some clips are missing.
  if (state === 'run' || state === 'idle' || state === 'attack') {
    const runAction = enemyVisual.actions[normalize('run')] || enemyVisual.actions[normalize('walk')];
    if (runAction) {
      return runAction;
    }
  }

  const keys = Object.keys(enemyVisual.actions);
  if (keys.length) {
    return enemyVisual.actions[keys[0]];
  }

  return null;
}

export function setEnemyAnim(enemyVisual, state) {
  if (enemyVisual.isFallback || !enemyVisual.mixer) {
    enemyVisual.state = state;
    return;
  }

  const next = resolveAction(enemyVisual, state);
  if (!next) {
    enemyVisual.state = state;
    return;
  }

  const prev = enemyVisual.activeAction;
  const oneShot = state === 'hit' || state === 'die';
  const sameState = enemyVisual.state === state;

  // Avoid restarting looping clips (run/attack/idle) every frame.
  if (!oneShot && sameState && prev === next && next.isRunning()) {
    return;
  }

  enemyVisual.state = state;

  next.reset();
  next.enabled = true;
  next.clampWhenFinished = oneShot;
  next.setLoop(oneShot ? THREE.LoopOnce : THREE.LoopRepeat, oneShot ? 1 : Infinity);

  if (prev && prev !== next) {
    next.crossFadeFrom(prev, state === 'hit' ? 0.06 : 0.12, true);
  }

  next.play();
  enemyVisual.activeAction = next;
}

export function disposeEnemyVisual(enemyVisual) {
  if (enemyVisual.mixer) {
    enemyVisual.mixer.stopAllAction();
    if (enemyVisual.root) {
      enemyVisual.mixer.uncacheRoot(enemyVisual.root);
    }
  }

  if (enemyVisual.group) {
    enemyVisual.group.traverse((child) => {
      if (!child.isMesh) {
        return;
      }

      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        if (material?.userData?.enemyInstanceMaterial) {
          material.dispose();
        }
      }
    });
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
