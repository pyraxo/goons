# God of Goons (Three.js)

God of Goons is a top-down 3D horde-defense prototype with a prompt-driven sandbox loop.
You still have classic spell casting, while prompts can target broader game layers:

- `ui` (widgets/panels/status affordances)
- `mechanics` (rules/hooks/effects)
- `units` (new entity definitions/roles)
- `actions` (trigger/effect behaviors)

## What changed recently

- Prompt flow now uses `Estimate -> Queue -> Apply` with explicit Gold reservation/commit/refund.
- Prompt artifacts are structured JSON (template `sandbox-v1`) instead of ad-hoc spell mapping.
- Replay history records prompt type mix, artifact counts, and mechanic summaries.
- Enemy visuals now use an animated FBX goblin pipeline with texture-based materials.

## Gameplay baseline

- Move commander with `WASD`
- Open command bar with `Enter`
- Survive lane-based enemy waves and protect base HP
- Cast baseline spells (`fireball`, `wall`, `frost`, `bolt`)
- Manage mana, cooldowns, and Gold for prompt-applied sandbox changes

## Prompt system (current shape)

1. `/api/prompt/estimate` classifies prompt scope and estimates Gold cost/risk.
2. Player confirms apply with a model preset (`fast`, `medium`, `high`).
3. `/api/prompt/execute` returns a validated artifact payload.
4. Prompt processor updates queue state, replay history, and apply status.

## Dynamic spell engine

- Frontend sends combat context to `POST /api/spells/generate`
- Backend performs template alias matching (`server/spell-templates.json`) for terse prompts like `fireball`
- If a template matches, backend appends `templateContext` (`matchedKey`, `matchedAlias`, `expandedIntent`) to the single existing model call
- Matching order is deterministic: exact alias match first, then whole-word/phrase match in longer prompts (longest alias wins, then template order)
- Backend validates and normalizes generated spell configs
- If LLM output is invalid/unavailable, deterministic fallback generates a safe spell
- Frontend casts and shows `LLM: archetype/effects` or `Fallback cast`
- API response `meta` now includes `templateMatch` and `expandedPromptPreview`

## Run locally

```bash
npm install
npm run dev:backend
npm run dev:frontend
```

Open [http://localhost:5173](http://localhost:5173).

You can also run both in one shell:

```bash
npm run dev:all
```

Create `.env`:

```bash
OPENAI_API_KEY=sk-...
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

Backend API runs as a separate process (`server/index.js`) and logs cast requests:

- `[spell-api] llm_cast`: tool call worked and produced a validated spell
- `[spell-api] fallback`: fallback was used; inspect `fallbackReason` and `warnings`
- Request lifecycle logs include `requestId` for traceability

Health check:

```bash
curl http://localhost:8787/healthz
```

## Key files

- `src/main.js`: core game loop, HUD wiring, command/prompt UI, economy, waves
- `src/prompt/costEstimator.js`: prompt type/cost/risk estimation client
- `src/prompt/promptProcessor.js`: queueing, retries, apply history, Gold reservation flow
- `src/prompt/templateDrafts.js`: artifact schema + system/user prompt templates
- `src/runtime/commandSchema.js`: allowed runtime command contracts
- `src/runtime/mechanicRuntime.js`: bounded, telemetry-aware mechanic execution
- `src/enemy-models.js`: enemy visual loading/animation integration
- `docs/architecture/dynamic-sandbox-runtime-plan.md`: forward plan for sandbox hardening

## Enemy visual setup (FBX)

Current defaults use:

- `public/models/enemies/goblin-walk/Walking.fbx`
- `public/models/enemies/goblin-walk/textures/*`

`public/models/enemies/manifest.json` controls per-kind settings:

- `kind`: `melee`, `ranged`, `tank`
- `path`: animated FBX path
- `scale`: per-kind scale
- `yOffset`: vertical offset
- `castsShadow`: shadow toggle

Runtime animation states expected by game logic:

- `idle`
- `run`
- `attack`
- `hit`
- `die`

If a clip is missing (for example no `attack` clip), the loader falls back to compatible clips (usually `run`).

## Tests

```bash
npm run test
```
