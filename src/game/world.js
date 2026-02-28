import * as THREE from 'three';
import { BASE_Z, CASTLE_WALL_DEPTH, CASTLE_WALL_Z, LANE_COUNT, LANE_SPACING, MAP_WIDTH } from './config.js';

export function laneX(index) {
  return (index - (LANE_COUNT - 1) / 2) * LANE_SPACING;
}

export function buildMap(scene) {
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(MAP_WIDTH, 150, 32, 64),
    new THREE.MeshStandardMaterial({ color: 0x1a1210, roughness: 0.92, metalness: 0.08 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.z = -8;
  ground.receiveShadow = true;
  const pos = ground.geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const noise = Math.sin(x * 0.7) * Math.cos(y * 0.5) * 0.25
                + Math.sin(x * 2.1 + y * 1.3) * 0.12
                + Math.sin(x * 4.7 - y * 3.2) * 0.06;
    pos.setZ(i, pos.getZ(i) + noise);
  }
  pos.needsUpdate = true;
  ground.geometry.computeVertexNormals();
  scene.add(ground);

  const darkStoneMat = new THREE.MeshStandardMaterial({
    color: 0x1a1a1a, roughness: 0.85, metalness: 0.15,
  });
  const base = new THREE.Mesh(new THREE.BoxGeometry(26, 8, 10), darkStoneMat);
  base.position.set(0, 4.2, BASE_Z + 6);
  base.castShadow = true;
  base.receiveShadow = true;
  scene.add(base);

  const core = new THREE.Mesh(
    new THREE.CylinderGeometry(2.2, 2.4, 5, 8),
    new THREE.MeshStandardMaterial({
      color: 0xff4400, emissive: 0xff2200, emissiveIntensity: 1.2,
      roughness: 0.3, metalness: 0.2,
    })
  );
  core.position.set(0, 4.7, BASE_Z + 0.8);
  core.castShadow = true;
  scene.add(core);

  const wallMat = new THREE.MeshStandardMaterial({
    color: 0x1c1815, roughness: 0.88, metalness: 0.12,
  });
  const castleWall = new THREE.Mesh(
    new THREE.BoxGeometry(MAP_WIDTH - 4.5, 0.5, CASTLE_WALL_DEPTH),
    wallMat
  );
  castleWall.position.set(0, 0.25, CASTLE_WALL_Z);
  castleWall.castShadow = true;
  castleWall.receiveShadow = true;
  scene.add(castleWall);

  const postMat = new THREE.MeshStandardMaterial({ color: 0x2a2220, roughness: 0.85 });
  const postCount = 18;
  for (let i = 0; i < postCount; i += 1) {
    const t = postCount === 1 ? 0.5 : i / (postCount - 1);
    const x = -((MAP_WIDTH - 7) / 2) + t * (MAP_WIDTH - 7);
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.2, 0.4), postMat);
    post.position.set(x, 1.0, CASTLE_WALL_Z - CASTLE_WALL_DEPTH * 0.35);
    post.castShadow = true;
    post.receiveShadow = true;
    scene.add(post);
  }

  const borderMat = new THREE.MeshStandardMaterial({ color: 0x100c0a, roughness: 0.9 });
  const borderLeft = new THREE.Mesh(new THREE.BoxGeometry(2, 3.2, 150), borderMat);
  borderLeft.position.set(-MAP_WIDTH / 2, 1.6, -8);
  borderLeft.receiveShadow = true;
  scene.add(borderLeft);
  const borderRight = borderLeft.clone();
  borderRight.position.x *= -1;
  scene.add(borderRight);
}

export function createCommander() {
  const group = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(1.2, 1.4, 2.2, 8),
    new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.6, metalness: 0.4 })
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

  group.position.set(0, 0, BASE_Z - 5);

  return {
    mesh: group,
    speed: 15,
  };
}
