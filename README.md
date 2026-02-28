# God of Goons (Three.js)

God of Goons is a top-down 3D horde-defense prototype with a prompt-driven sandbox loop.
You still have classic spell casting, but prompts now target broader game layers:

- `ui` (widgets/panels/status affordances)
- `mechanics` (rules/hooks/effects)
- `units` (new entity definitions/roles)
- `actions` (trigger/effect behaviors)

## What changed recently

- Prompt flow now uses `Estimate -> Queue -> Apply` with explicit Gold reservation/commit/refund.
- Prompt artifacts are structured JSON (template `sandbox-v1`) instead of only ad-hoc spell mapping.
- Replay history now records prompt type mix, artifact counts, and mechanic summaries.
- Added one-click `Reset Sandbox` to clear generated layers, queue/history, and restore baseline state.
- Runtime safety work landed for bounded mechanic execution (`src/runtime/mechanicRuntime.js`) with:
  - per-tick command budget
  - per-mechanic runtime budget
  - auto-disable on errors/budget violations
- Added agentic apply workflow (`src/runtime/agenticApplyWorkflow.js`) that validates mechanics, activates runtime hooks, persists sandbox state, and triggers asset generation.
- Added GLB asset generation endpoint (`/api/assets/generate-glb`) that writes generated placeholders to `public/models/generated/*`.
- Added spellcraft tool-calling endpoint (`/api/spells/generate`) that drafts spell configs through function-calling (`craft_spell`) with deterministic fallback when model output is invalid/incomplete.
- Enemy visuals now use an animated FBX goblin pipeline (Mixamo walk) with texture-based materials.

## Gameplay baseline

- Move commander with `WASD`
- Open command bar with `Enter`
- Survive lane-based enemy waves and protect base HP
- Cast baseline spells (`fireball`, `wall`, later `frost`, `bolt`)
- Manage mana, cooldowns, and Gold for prompt-applied sandbox changes

## Prompt system (current shape)

1. `/api/prompt/estimate` classifies prompt scope and estimates Gold cost/risk.
2. Player confirms apply with a model preset (`fast`, `medium`, `high`).
3. `/api/prompt/execute` returns a validated artifact payload:
   - `summary`
   - `classifiedTypes`
   - `sandboxPatch` (`ui`, `mechanics`, `units`, `actions`, `resetToBaselineFirst`)
   - `observability`
4. Prompt processor updates queue state, replay history, and apply status, then calls the sandbox apply workflow.
5. Sandbox apply workflow compiles/activates mechanics, persists applied branches, and optionally writes generated GLB assets.

## Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

Create `.env`:

```bash
OPENAI_API_KEY=sk-...
```

## Key files

- `src/main.js`: app bootstrap + orchestration (scene, UI wiring, runtime/apply hooks, reset flow)
- `src/game/config.js`: gameplay constants and initial state
- `src/game/economy.js`: Gold reservation/commit/refund store
- `src/game/engineSystems.js`: combat, waves, spawning, spell casting, runtime command application
- `server/spell-engine.js`: spell schema, balancing, normalization, deterministic fallback logic
- `server/spell-api.js`: tool-calling orchestration and telemetry for `/api/spells/generate`
- `src/game/world.js`: map + commander construction helpers
- `src/prompt/costEstimator.js`: prompt type/cost/risk estimation client
- `src/prompt/promptProcessor.js`: queueing, retries, apply history, Gold reservation flow
- `src/prompt/templateDrafts.js`: artifact schema + system/user prompt templates
- `src/prompt/artifactContract.js`: strict artifact output parser/validator (Zod)
- `src/prompt/estimateContract.js`: strict estimate output parser/validator (Zod)
- `src/runtime/commandSchema.js`: allowed runtime command contracts
- `src/runtime/mechanicRuntime.js`: bounded, telemetry-aware mechanic execution
- `src/runtime/agenticApplyWorkflow.js`: compile/apply/persist orchestration for sandbox artifacts
- `src/runtime/assets/glbAssetAgent.js`: derives GLB jobs and calls generation endpoint
- `src/runtime/persistence/sandboxStateStore.js`: in-memory baseline + persistence interface
- `src/enemy-models.js`: enemy visual loading/animation integration
- `docs/architecture/dynamic-sandbox-runtime-plan.md`: forward plan for sandbox hardening
- `docs/architecture/primitives-and-mechanics-contract.md`: mechanic primitive contract + execution model
- `docs/architecture/sandbox-state-storage.md`: persistence model for sandbox state

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
