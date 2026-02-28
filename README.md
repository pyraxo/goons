# Prompt Defense 3D (Three.js)

Top-down 3D endless horde prototype where you defend a base by typing free-text prompts that are converted into structured spell configs through an LLM tool call.

## Current gameplay (v1)

- Commander movement: `WASD` near base
- Open command bar: `Enter`
- Submit prompt: `Enter`
- Enemies spawn across `5 lanes`
- Goal: survive as long as possible; base HP reaching 0 ends run
- Spells consume mana and use both global + per-spell cooldowns
- All core spells are available from the start (`fireball`, `wall`, `frost`, `bolt`)

## Dynamic spell engine (v2)

- Frontend sends prompt + combat context to `POST /api/spells/generate`
- Vite server middleware calls the LLM with forced `craft_spell` tool calling
- Server validates archetype/effects/compatibility and normalizes unsafe values
- If LLM output is invalid or unavailable, deterministic fallback generates a safe spell
- Frontend instant-casts and shows `LLM: archetype/effects` or `Fallback cast`

## Spell behavior

- `fireball`: auto-target nearest enemy, explodes with splash damage
- `wall`: spawns in high-pressure lane to stall enemies
- `frost`: freezes all enemies briefly
- `bolt`: chain lightning damages several front enemies

## Run locally

```bash
npm install
npm run dev:backend
npm run dev:frontend
```

Then open the frontend URL (usually `http://localhost:5173`).

You can also run both in one shell:

```bash
npm run dev:all
```

Required env:

```bash
OPENAI_API_KEY=...
# optional
OPENAI_MODEL=gpt-5
SPELL_API_TIMEOUT_MS=10000
SPELL_BACKEND_PORT=8787
SPELL_BACKEND_HOST=127.0.0.1
SPELL_API_DEBUG_FULL_PAYLOAD=1
SPELL_REASONING_EFFORT=minimal
SPELL_API_MAX_OUTPUT_TOKENS=420
SPELL_API_RETRY_MAX_OUTPUT_TOKENS=700
```

## Backend debugability

Backend API runs as a separate process (`server/index.js`) and logs every cast request:

- `[spell-api] llm_cast`: tool call worked and produced a validated spell
- `[spell-api] fallback`: fallback was used; inspect `fallbackReason` and `warnings`
- Per-request lifecycle logs with `requestId`: `request_received`, `request_validated`, `provider_call_start`, `provider_call_done`, `provider_call_error`, `fallback_applied`, `response_ready`
- Full request/response payload preview logging is enabled by default. Set `SPELL_API_DEBUG_FULL_PAYLOAD=0` to disable it.

Health check:

```bash
curl http://localhost:8787/healthz
```

`/healthz` now includes backend telemetry (`providerLatencyP50Ms`, `providerLatencyP95Ms`, `providerLatencyMaxMs`) so you can tune timeout from observed traffic.

## Tests

```bash
npm test
```

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
