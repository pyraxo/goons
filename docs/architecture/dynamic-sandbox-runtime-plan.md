# Dynamic Sandbox Runtime Plan

Date: 2026-02-28
Status: Draft

## Goal

Support highly dynamic prompt-generated mechanics and UI while keeping the game safe, deterministic, and resettable on restart.

## Core Model

1. Prompt -> structured artifacts (`ui`, `mechanics`, `units`, `actions`)
2. Validator checks schema, budgets, and capability usage
3. Runtime sandbox executes mechanic logic via hooks and bounded effects
4. Host engine applies validated commands transactionally
5. Restart/refresh clears all generated artifacts back to baseline

## Two Sandbox Layers

## Runtime Sandbox (live game mods)

- Recommended: Web Worker runtime with capability-limited API
- Generated logic cannot access DOM, `window`, Three.js internals, or network
- Generated logic can only emit typed commands the host engine understands

Example command families:
- `combat.applyDot`
- `combat.chainSpread`
- `economy.addMultiplier`
- `units.spawn`
- `ui.mountWidget`

## Build Sandbox (self-editing source)

- Optional: isolated CI worker (Docker if needed, not required for runtime mechanics)
- Agent can propose source patch + tests + build output
- Human approval required before merge/deploy

## Mechanic IR (Intermediate Representation)

Mechanics are compiled to a typed IR rather than arbitrary JavaScript.

Required fields:
- `id`
- `name`
- `lifecycle` (`persistent`, `timed`, `wave`)
- `hooks` (`onTick`, `onEnemySpawn`, `onEnemyDeath`, `onKillCombo`, etc.)
- `effects` (typed effect objects)
- `limits` (caps, cooldowns, max stacks, max spreads)
- `costTier`

## Hook Runtime

- Hook execution budget per frame (time + command count)
- Deterministic ordering by priority + mechanic id
- Transactional apply: if mechanic errors, disable that mechanic and rollback current frame patch
- Telemetry for each mechanic:
  - tick time
  - commands emitted
  - errors
  - economy delta

## Economy and Risk Policy

Pricing = base by type + complexity multipliers + risk multiplier + mode gating.

Suggested policy:
- Normal mode: unbounded/cheat mechanics rejected or priced at unreachable tier
- Chaos mode: unbounded mechanics allowed behind explicit toggle + warning

Initial ranges from reference examples:
- Plague DoT spread: ~100k
- Combo gold multiplier + UI: 100k-500k
- Remote-controlled car: ~20k
- Basic car unit: ~10
- Infinite nukes forever: 10T (normal mode unreachable)

## Restart Semantics

On every restart/dev refresh:
- Clear mechanic registry
- Clear generated UI registry
- Clear generated unit/action definitions
- Reinitialize baseline state only

## Implementation Phases

1. Runtime interfaces
- Add `MechanicRuntime` and `CommandBus` modules
- Add typed command validator

2. IR + validator
- Define IR schema
- Add compile/validate step for generated mechanics

3. Host integration
- Wire hook dispatch into game loop
- Add per-mechanic telemetry panel/log output

4. Economy/risk engine
- Add explicit pricing function by capability and limits
- Add policy gating (`normal` vs `chaos`)

5. Build sandbox workflow
- Add offline code-edit pipeline for missing primitives
- Require test/build pass + manual approval

## Immediate Next Tasks

1. Add explicit policy gate (`normal` vs `chaos`) in artifact validation to block unbounded mechanics in normal mode.
2. Expand command handlers for `units.spawn` and `ui.mountWidget` to produce visible gameplay effects.
3. Add per-mechanic telemetry panel in HUD (ticks, errors, command count, disable reason).
4. Add artifact rehydrate path from Redis/file stores with full revalidation before register.
