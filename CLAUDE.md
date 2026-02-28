# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**God of Goons** (`prompt-defense-3d`) — a top-down 3D horde-defense game built with Three.js where players can dynamically modify gameplay through a prompt-driven sandbox system. The architecture separates a client-side renderer from a server-side game simulation and prompt execution API.

## Commands

```bash
npm run dev           # Run both server (:8787) and client (:5173) in parallel
npm run dev:client    # Vite dev server only (port 5173)
npm run dev:server    # Node.js API server only (port 8787)
npm run build         # Vite production build
npm run test          # Vitest run (all tests, single pass)
npm run test:watch    # Vitest watch mode
npx vitest run path/to/file.test.js   # Run a single test file
```

Requires `.env` with `OPENAI_API_KEY=sk-...` (see `.env.example`).

## Architecture

### Client/Server Split

- **Server** (`server/`): Native Node.js HTTP server on `:8787`. Runs the authoritative game loop, handles prompt execution, artifact validation, spell generation, and state persistence.
- **Client** (`src/`): Three.js renderer + input handler. Polls server for state every 50ms, pushes WASD input every 35ms. No game logic — purely display and input forwarding.
- **Proxy**: Vite proxies `/api/*` to the server (configurable via `API_PROXY_TARGET` env var).

### Core Systems

**Game Session** (`server/game-session.js`): Singleton that owns the game tick loop, enemy spawning, combat, spell casting, and runtime command execution. Exposes `tick()`, `snapshot()`, `castSpellByName()`, `applyArtifact()`, `reset()`.

**Primitive & Mechanic System**: The core safety model. AI-generated mechanics don't execute arbitrary code — they invoke typed **primitives** (e.g. `combat.deal_damage`, `economy.add_gold`) that emit validated **runtime commands**. Each mechanic has resource budgets (`maxCommandsPerTick`, `maxRuntimeMs`). Violations disable the mechanic.

**Prompt Pipeline**: Estimate → Queue → Execute → Apply. Uses Gold reservation/commit/refund to prevent double-spending. Artifacts are structured JSON with a `sandboxPatch` targeting: `ui`, `mechanics`, `units`, `actions`.

**Spell Engine** (`server/spell-engine.js`, `server/spell-api.js`): Tool-calling spell generation with schema validation, normalization, and deterministic fallbacks.

### Key Paths

| Path | Purpose |
|------|---------|
| `server/index.js` | HTTP router — all `/api/*` endpoints |
| `server/game-session.js` | Authoritative game loop + state |
| `server/runtime/` | Mechanic runtime, command schema, artifact compiler, persistence, asset generation |
| `server/prompt/` | Zod contracts for artifact and estimate validation |
| `src/main.js` | Three.js scene setup, input handling, polling loop |
| `src/game/engineSystems.js` | Client-side game systems (rendering sync, combat display) |
| `src/game/config.js` | Game constants (lanes, map dimensions, costs) |
| `src/prompt/templateDrafts.js` | Artifact schema definition + system/user prompt templates |
| `src/prompt/promptProcessor.js` | Client-side prompt queue, retries, apply history |
| `src/runtime/primitives/primitiveCatalog.js` | Available primitive definitions (client reference) |
| `docs/architecture/` | Design docs for primitives contract, sandbox storage, runtime plan |

### API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/game/state` | GET | Game state snapshot |
| `/api/game/input` | POST | Player WASD input |
| `/api/game/cast` | POST | Cast spell by prompt |
| `/api/game/reset` | POST | Reset sandbox to baseline |
| `/api/game/apply-artifact` | POST | Apply prompt artifact |
| `/api/prompt/estimate` | POST | Cost/risk estimate |
| `/api/prompt/execute` | POST | Run prompt execution |
| `/api/spells/generate` | POST | Tool-calling spell generation |
| `/api/assets/generate-glb` | POST | GLB asset generation |

## Code Patterns

- **ES modules** throughout (`"type": "module"` in package.json)
- **Zod v4** for schema validation — `.parse()` throws, `.safeParse()` returns `{ ok, data, error }`
- **Runtime commands**: `{ type: 'category.action', payload: { ...args } }`
- **Primitive invocations**: `{ primitiveId: 'category.action', argsJson: '{"key":"value"}' }`
- **Dynamic arguments** in mechanic hooks: `$enemy.id`, `$comboCount`, `$game.wave`
- **HTTP responses**: `sendJson(res, statusCode, body)` pattern in server routes
- **Artifact template version**: `sandbox-v1`

## Testing

Tests are colocated with source files (`.test.js` suffix). Vitest with Chai-style assertions (`expect`, `describe`, `it`). Test files exist in both `server/` and `src/` directories.

## Adding a New Primitive

1. Add definition in `src/runtime/primitives/primitiveCatalog.js`
2. Add command types in `server/runtime/commandSchema.js` if needed
3. Implement handler in `server/game-session.js` (`applyRuntimeCommand`)
4. Add unit tests
5. Update prompt template in `src/prompt/templateDrafts.js`
6. Update `docs/architecture/primitives-and-mechanics-contract.md`
