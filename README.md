# Prompt Defense 3D (Three.js)

Top-down 3D endless horde prototype where you defend a base by typing free-text prompts that map to spells.

## Current gameplay (v1)

- Commander movement: `WASD` near base
- Open command bar: `Enter`
- Submit prompt: `Enter`
- Enemies spawn across `5 lanes`
- Goal: survive as long as possible; base HP reaching 0 ends run
- Spells consume mana and use both global + per-spell cooldowns
- Spell unlock progression:
  - Start: `fireball`, `wall`
  - Wave 3: `frost`
  - Wave 6: `bolt`

## Free-text prompts

Prompt parser uses:
1. Exact match (`fireball`)
2. Word containment (`cast fireball now`)
3. Fuzzy best-match (small typos)

Examples:
- `fireball`
- `spawn wall`
- `freez all` -> likely `frost`

## Spell behavior

- `fireball`: auto-target nearest enemy, explodes with splash damage
- `wall`: spawns in high-pressure lane to stall enemies
- `frost`: freezes all enemies briefly
- `bolt`: chain lightning damages several front enemies

## Run locally

```bash
npm install
npm run dev
```

Then open the local Vite URL (usually `http://localhost:5173`).

## Tune quickly

Main constants and logic are in `src/main.js`:
- Map/lane config (`LANE_COUNT`, spacing, base location)
- Resource economy (`maxMana`, regen, spell costs)
- Spawn pressure and difficulty scaling
- Unlock thresholds and spell definitions

## Enemy visual style

Enemy rendering now uses 3D billboard sprites (character sprites in world space) through `src/enemy-models.js`.
This keeps the top-down 3D gameplay but gives a more painterly/realistic look than low-poly meshes.

## How to tune enemy visuals

Sprite visual integration lives in `src/enemy-models.js` and reads scale/offset/shadow config from `public/models/enemies/manifest.json`.

Required manifest fields (array entries):
- `kind`: `melee`, `ranged`, or `tank`
- `path`: reserved for future external assets
- `scale`: numeric model scale multiplier
- `yOffset`: vertical offset after load
- `castsShadow`: boolean shadow toggle

Runtime animation states used by the sprite animator:
- `idle`
- `run`
- `hit`
- `die`

Model orientation and origin conventions:
- Keep feet at `y=0` in bind pose
- Face forward on `+Z`
- Use low-poly budgets (target laptop 60 FPS): ~4k tris goblin/archer, ~7k tris ogre

Licensing notes:
- Keep source/license details in `public/models/enemies/LICENSES.md`
- Included `.glb` files are generated prototypes and currently optional in sprite mode
