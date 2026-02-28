# Sandbox State Storage

Date: 2026-02-28  
Status: Draft (implementation-backed)

## Requirement

Sandbox execution is in-memory during runtime, with optional persistence to file or Redis when needed.

## Storage Interface

Stores should support:

- `load()`: read current sandbox state
- `save(state)`: persist current sandbox state
- `reset()`: clear to baseline

## Implemented Stores

- In-memory:
  - `/src/runtime/persistence/sandboxStateStore.js`
  - Use for local runtime and fastest iteration.

- File-backed:
  - `/src/runtime/persistence/fileSandboxStateStore.js`
  - Persists JSON snapshots to disk (Node runtime).

- Redis-backed:
  - `/src/runtime/persistence/redisSandboxStateStore.js`
  - Persists snapshots to a Redis key for shared/dev-server state.

## Baseline State

Baseline state tracks:

- `templateVersion`
- `baselineAppliedAt`
- `mechanics`
- `units`
- `actions`
- `ui`

On restart/dev refresh, the sandbox should reset to baseline and clear generated mechanics/UI/unit/action layers.

## Recommended Usage

- Local dev: in-memory store only.
- Shared dev server: Redis store.
- Offline replay/debug snapshots: file store.

## Notes

- Persistence stores keep state metadata; execution safety still comes from runtime primitive and command validation.
- Persisted artifacts should be revalidated before rehydrating into active runtime.
