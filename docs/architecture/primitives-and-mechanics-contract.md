# Primitives And Mechanics Artifact Contract

Date: 2026-02-28  
Status: Draft (implementation-backed)

## Purpose

Define how prompt-generated mechanics are represented, validated, and executed so the game can stay highly dynamic without executing arbitrary code.

## Core Principle

Mechanics do not directly mutate the engine.  
Mechanics invoke typed `primitives`, and primitives emit validated runtime commands.

## Primitive Contract

A primitive definition has:

- `id`: stable unique identifier (example: `combat.apply_dot`)
- `version`: integer version for migration and compatibility
- `description`: short behavior intent
- `allowedEvents`: hook events where the primitive can run
- `args`: typed argument schema (`number`, `integer`, `string`, `object`)
- `requiredArgs`: required argument names
- `emitCommands({ args, context })`: converts primitive invocation to runtime commands

Current implementation:

- Catalog: `/src/runtime/primitives/primitiveCatalog.js`
- Registry + validation: `/src/runtime/primitives/primitiveRegistry.js`
- Runtime command schema: `/src/runtime/commandSchema.js`

## Mechanics Artifact Contract

Each mechanic artifact must include:

- `id`
- `name`
- `description`
- `lifecycle`: `persistent | timed | wave`
- `hooks`: array of hook definitions
- `limits`: bounded runtime limits

Hook definition:

- `event`: one of `onTick | onEnemySpawn | onEnemyDeath | onKillCombo | onWaveStart`
- `intervalSeconds` (optional, for `onTick`)
- `maxInvocationsPerTick` (optional override)
- `invocations`: array of primitive invocations

Primitive invocation:

- `primitiveId`
- `argsJson` (JSON string that decodes to an args object; validated against primitive schema)
- Legacy fallback: `args` object is still accepted in code for backward compatibility.

Dynamic argument references are supported with `$path` syntax:

- `$enemy.id`
- `$comboCount`
- `$game.wave`

Limits:

- `maxCommandsPerTick`
- `maxInvocationsPerTick`
- `maxRuntimeMs`

Current implementation:

- Artifact validator/compiler: `/src/runtime/mechanicsArtifact.js`
- Runtime execution engine: `/src/runtime/mechanicRuntime.js`

## Execution Pipeline

1. Prompt model returns artifact JSON.
2. Artifact mechanic entries are validated against primitive registry.
3. Valid mechanics are compiled into runtime handlers.
4. Runtime handlers emit commands only through command schema.
5. Runtime enforces command count and time budgets.
6. On error or budget violation, mechanic is disabled.

## Adding New Primitives (AI-Friendly Workflow)

1. Add definition in `/src/runtime/primitives/primitiveCatalog.js`.
2. If new command types are needed, add them in `/src/runtime/commandSchema.js`.
3. Implement command handling in `/src/game/engineSystems.js` (`applyRuntimeCommand`).
4. Add unit tests:
   - `/src/runtime/primitives/primitiveRegistry.test.js`
   - `/src/runtime/commandSchema.test.js` (if command schema changed)
   - `/src/runtime/mechanicsArtifact.test.js` (artifact invocation path)
5. Update prompt template constraints in `/src/prompt/templateDrafts.js` so the model can use the new primitive.
6. Update this architecture doc with primitive intent and constraints.

## Guardrails

- Primitive invocations with unknown IDs are rejected.
- Invocations with unknown args or invalid types are rejected.
- Commands outside allowed runtime schema are rejected.
- Hook/event mismatch (primitive used on disallowed event) is rejected.
- Per-mechanic runtime budget and command cap are enforced.

## Notes On Dynamic Scope

This model supports very dynamic mechanics while remaining bounded:

- New behavior can be composed from primitives without changing engine source each prompt.
- If a prompt needs behavior that primitives cannot express, add a new primitive once, then let future prompts compose it.
