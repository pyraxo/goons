export const LANE_COUNT = 5;
export const LANE_SPACING = 8;
export const START_Z = -78;
export const BASE_Z = 33;
export const MAP_WIDTH = 52;
export const STARTING_GOLD = 1_000_000;
export const KILL_GOLD_REWARD = 10;
export const CASTLE_WALL_DEPTH = 4;
export const CASTLE_WALL_FRONT_Z = BASE_Z - 18;
export const CASTLE_WALL_Z = CASTLE_WALL_FRONT_Z + CASTLE_WALL_DEPTH * 0.5;
export const COMMANDER_MIN_Z = CASTLE_WALL_FRONT_Z + CASTLE_WALL_DEPTH + 0.35;
export const COMMANDER_MAX_Z = BASE_Z + 4;
export const GOON_ATTACK_INTERVAL_SECONDS = 3;
export const GOON_ATTACK_DAMAGE = 1;

export function createInitialGameState() {
  return {
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
    gameOver: false,
  };
}
