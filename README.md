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
- Runtime safety work landed for bounded mechanic execution (`src/runtime/mechanicRuntime.js`) with:
  - per-tick command budget
  - per-mechanic runtime budget
  - auto-disable on errors/budget violations
- Enemy visuals were upgraded to sprite-based 3D billboard enemies with class variants.

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
4. Prompt processor updates queue state, replay history, and apply status.

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

- `src/main.js`: core game loop, HUD wiring, command/prompt UI, economy, waves
- `src/prompt/costEstimator.js`: prompt type/cost/risk estimation client
- `src/prompt/promptProcessor.js`: queueing, retries, apply history, Gold reservation flow
- `src/prompt/templateDrafts.js`: artifact schema + system/user prompt templates
- `src/runtime/commandSchema.js`: allowed runtime command contracts
- `src/runtime/mechanicRuntime.js`: bounded, telemetry-aware mechanic execution
- `src/enemy-models.js`: enemy visual loading/animation integration
- `docs/architecture/dynamic-sandbox-runtime-plan.md`: forward plan for sandbox hardening

## Tests

```bash
npm run test
```
