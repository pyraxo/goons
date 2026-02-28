# Enemy Model Licensing

This directory contains generated prototype enemy models used for local development.
Current runtime enemy rendering uses sprite-based visuals from `src/enemy-models.js`; `.glb` files are optional for future upgrades.

## Included files

- `goblin.glb` (melee prototype)
- `archer_goblin.glb` (ranged prototype)
- `ogre.glb` (tank prototype)

These three files were generated in-project via script and do not include external third-party assets.

## Planned replacement

Replace prototypes with production CC0 low-poly assets when available.
Keep these conventions:

- glTF binary (`.glb`)
- Clip names (case-insensitive aliases are supported): `idle`, `run`, `hit`, `die`
- Origins at feet (`y=0`), forward facing `+Z`

## Attribution guidance

CC0 assets do not require attribution, but add source/license links in this file for traceability.
