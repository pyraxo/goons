# PLAN.md

## Features removed (from `src/game/engineSystems.js` and `src/game/economy.js`)

These files were deleted as dead code — they were never imported by the live game (`src/main.js`). The ideas below may be worth resurrecting from git history.

### Beam archetype (`castBeamFromConfig` + `updateBeams`)
Channeled beam spell fired from the commander toward enemies, dealing tick damage along a line. Supports width, length, duration, tick rate, and element-based effects. main.js currently has no beam support — AI-generated `beam` archetype spells fall through to projectile.

### DOT tracking (`activeDots` Map + `applyDotToEnemy`)
Damage-over-time system using an ID-keyed Map with proper duration tracking and per-tick damage. Cleaner than main.js's `burningFor`/`burnDps` on enemy objects, and designed to work with the runtime's `combat.apply_dot` primitive.

### Kill combo system (`comboCount` / `comboTimer`)
A 0.5s window combo counter that fires `onKillCombo` runtime hooks. Enables mechanics like "3x combo = bonus gold" via the sandbox primitive system.

### Gold reservation pattern (`economy.js`)
`reserve → commit / refund` flow for async spell generation — deducts gold optimistically when a prompt is submitted, commits on success, refunds on failure. Prevents overspending during concurrent requests.
