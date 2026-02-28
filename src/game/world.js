import * as THREE from 'three';
import { BASE_Z, CASTLE_WALL_DEPTH, CASTLE_WALL_Z, LANE_COUNT, LANE_SPACING, MAP_WIDTH } from './config.js';

export function laneX(index) {
  return (index - (LANE_COUNT - 1) / 2) * LANE_SPACING;
}

export function buildMap(scene) {
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

export function createCommander() {
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
