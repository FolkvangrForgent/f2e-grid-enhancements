# CLAUDE.md

Foundry VTT **v14** module (`f2e-grid-enhancements`): 3D barriers (walls + regions with height), a 3D raycast that replaces
core's flat wall checks, a WebAssembly floor-lighting visualizer, grid-aware 3D distance, and PF2e/SF2e integration.
Plain ES modules, no bundler, no TypeScript. Requires `lib-wrapper`. Feature docs: `README.md`, `F2E.md`; public API: `API.md`.

## Workspace

Sibling folders in `../` that this module is developed against:

| Path | What |
| --- | --- |
| `../f2e-grid-enhancements-tests/` | Tests (separate repo). Run module inside Foundry's real client code in Node |
| `../FoundryVTT-Node-14.371/` | Foundry v14 build 371 source: **the API reference** (see below) |
| `../pf2e/` | PF2e/SF2e system source (TypeScript, `src/`) |

## Commands

```sh
npm run lint            # biome check --write: fixes what it can (CI runs `biome ci` on PRs)
npm run build:module    # build/ : packs + wasm + scripts + languages + module.json (needs Rust + wasm32-unknown-unknown)
npm run build:packs     # compendiums only
npm run link            # symlink build/ into Foundry's Data/modules; no arg → prompts (Tab-completes, ~ ok), default is the platform's Foundry data folder; --force replaces an installed copy
npm run clean

# tests (in ../f2e-grid-enhancements-tests)
npm test                                  # unit always; simulation skipped without Foundry beside it
npm test -- simulation/barriers.test.mjs  # one file
npm test -- --require-foundry

# wasm profiling (in wasm/)
cargo run --release --example bench --features profile -- <input>
```

Release: publishing a GitHub release runs `.github/workflows/main.yml`, which fills `#{VERSION}#` etc. in `module.json`
and attaches `module.zip`. Don't hand-edit those placeholders.

## Layout and layering

`scripts/main.js` imports every feature, builds the frozen API on `init`, and lazily imports `f2e/` for pf2e/sf2e.
A file may only import from its own layer or layers above it:

1. `helpers/`: BVH, geometry, Clipper, restriction-type bitmasks (`types.js`), grid/token/wall/scene-and-level helpers, `patch.js`, `setting.js`, `log.js`
2. `spatial/`: cached per-scene BVH of walls/regions/tokens (`index.js`), Define Barrier model (`barriers.js`), roofs/straight skeleton, barrier rules (`rules.js`)
3. `raycast/`: `index.js` is the public raycasts plus `blocks`/`isBlocked` ("is it stopped") for features; `query.js` walks the ray; `crossings.js` and `cross-sources.js` hold the crossing kinds
4. Features: `perception/` (collision, footprint, light, sound, vision, `visualizer.js`, `floors.js`), `region/` (incl. `barrier.js`, `barrier-core.js`), `wall.js`, `scene.js`, `token.js`, `distance.js`, `f2e/`

Each feature folder registers its own hooks and patches on import. General settings live in `scripts/setting.js`;
PF2e/SF2e settings in `scripts/f2e/index.js`. The Rust crate in `wasm/` (`f2e_floors.wasm`) is loaded by
`perception/floors.js`, on the main thread or in `floors-worker.js`. If it fails to load, core's sweep is used.

## Conventions

- **Patching:** always go through `helpers/patch.js`. Never call `libWrapper` directly.
  - `patch.add('dotted.global.path', (wrapped, self, ...args) => ...)`: note `self` is passed explicitly (not `this`). If the wrapper throws, it logs and falls back to `wrapped(...args)`.
  - `patch.method(object, name, label, fn)`: for prototypes no global path reaches (e.g. PF2e's unexported aura classes).
  - `patch.defer(cb)`: run after `libWrapper.Ready`.
  - Prefer `CONFIG.X.documentClass.prototype` / `CONFIG.X.objectClass.prototype` targets when the system may subclass, and `foundry.canvas.…` paths for core-only classes.
- **Settings:** `helpers/setting.js` `register(key, type, opts)` (world scope, i18n keys `f2e-grid-enhancements.setting.<key>.name|hint`), `get(key)` is cached and invalidated on change.
- **Flags/IDs:** namespace `f2e-grid-enhancements`; region behavior type `f2e-grid-enhancements.barrier`; custom hook `f2eGridEnhancements.barrierEdgesChanged`. Wall height overrides are flags `top-enabled`/`top-elevation`/`bottom-enabled`/`bottom-elevation` (`helpers/wall.js`).
- **i18n:** all user text in `languages/en.json`.
- **Style (Biome):** tabs, line width 200, single quotes, semicolons, no trailing commas, `x => …` (no parens for one arg), `{a}` (no bracket spacing). Allowed globals are listed in `biome.json`; add there if you use a new one.
- **Naming and comments:** names say what a thing is (`replaceInstalledCopy`, `distanceToBarrier`, `MAX_CACHED_RAYCASTS_PER_GENERATION`), not `b`, `cut`, `1e-9`. Comments only explain what a name cannot: why (core quirks, rounding, algorithm choices), contracts (units, null cases, frozen results) and cross-file layouts. No comments restating the code. Short math names (`t`, `dx`, quadratic `a`/`b`/`c`) are fine where they are the math.
- **Docs:** user-visible behavior changes go in `README.md`/`F2E.md`; API changes in `API.md` (keep tables exact: options, defaults, return shapes, caching/freezing).
- API results from cached raycasts are **frozen and shared**; return new arrays, never mutate hits.
- `review.md` is the author's manual review checklist. Don't tick items.

## Testing notes

- `unit/` imports module code as `@module/scripts/...` and always runs.
- `simulation/` uses `harness/world.mjs` (`api`, `createScene(data)`, `id`, `point`, `settled()`), with real Foundry documents, an in-memory server, and a libWrapper stand-in (`libWrapper.failures` lists patch targets that don't exist: check it when adding patches).
- The simulation has **no canvas** (no live sources, nothing drawn), one GM user, and **no system active** (PF2e code is not exercised).
- Logged errors fail the test file.

---

# Foundry VTT v14 API reference

**Read the actual source; don't rely on memory.** Most training data/docs are v11–v13, and v14 changed a lot (levels,
per-level edges, surfaces, templates→regions, edge constants). Root: `../FoundryVTT-Node-14.371/`.

- `client/`: browser code (`canvas/`, `documents/`, `data/`, `applications/`, `config.mjs` = `CONFIG`, `hooks.mjs` = documented hook signatures)
- `common/`: shared (`constants.mjs` = `CONST`, `documents/` = Base* schemas, `grid/`, `data/fields.mjs`, `utils/`)
- Global namespace mirrors folders: `foundry.canvas.geometry.ClockwiseSweepPolygon` → `client/canvas/geometry/clockwise-sweep.mjs`
- Deprecations: `grep -rn "since: 14" client common` gives what was renamed in v14 (shims removed in v15/16)

## What changed in v14 (relevant here)

- **Levels.** `Scene#levels` (embedded `Level` documents, `common/documents/level.mjs`, `client/documents/level.mjs`).
  `Level.elevation = {bottom, top}` (ExtendedNumberField: `null`/missing means ∓Infinity, so use `?? -Infinity` / `?? Infinity`).
  `Level.visibility.levels` = set of other level IDs visible from it. `canvas.level` = viewed level. `Scene#initialLevel`.
  Scene background/foreground/foregroundElevation moved to Level.
- **Level membership.** Walls, Regions, etc. have `levels` (SceneLevelsSetField). `doc.includedInLevel(levelOrId)` is true when
  `levels` is empty (on all levels). Tokens have a single `level` ID.
- **Edges are per level.** `Level#edges` is a `CanvasEdges` (`client/canvas/geometry/edges/edges.mjs`). `canvas.edges` = `canvas.level.edges`.
  `Scene#initializeEdges()` (once; fires `initializeEdges(scene)` hook), and `Scene#initializedEdges`.
  `WallDocument#initializeEdge()` adds/removes its edge on each included level and calls `_onEdgeChange(level, newEdge, priorEdge, changedTypes)`.
  `CanvasEdges#initialize/refresh` are deprecated.
- **Edge** (`edges/edge.mjs`): `new Edge(a, b, {id, object, type, direction, light, darkness, move, sight, sound, threshold, priority})`.
  Has `darkness` as its own restriction type; `type` defaults to `"wall"`.
- **Constants** (`common/constants.mjs`): `EDGE_RESTRICTION_TYPES = ["light","darkness","sight","sound","move"]` (the module's bitmask order);
  `EDGE_SENSE_TYPES {NONE:0, LIMITED:10, NORMAL:20, PROXIMITY:30, DISTANCE:40}` (DISTANCE = reverse proximity);
  `EDGE_DIRECTIONS {BOTH, LEFT, RIGHT}`; `EDGE_DIRECTION_MODES {NORMAL, REVERSED, BOTH}`.
  `WALL_SENSE_TYPES`/`WALL_DIRECTIONS` are deprecated proxies; `PointSourcePolygon.WALL_DIRECTION_MODES` and
  `ClockwiseSweepPolygon#wallDirectionMode` are now `edgeDirectionMode`. Polygon config `edgeOptions` is now `edgeTypes`, and `edgeTypes.light|darkness` are now `edgeTypes.source`.
- **Surfaces.** Core `defineSurface` region behavior (`client/data/region-behaviors/define-surface.mjs`: `placement` bottom|top|both, booleans
  light/move/sight/sound/occlusion/exposure/culling). `Scene#getSurfaces({type, level, occlusion, exposure, culling})` gives a frozen, cached
  list sorted by elevation; `Scene#_invalidateSurfaces()`; `Scene#testSurfaceCollision(origin, dest, {type, mode, side, tMin, tMax, level})`
  (`client/documents/scene.mjs` ~L744–900). Polygons carry `surfaceExposure`.
- **MeasuredTemplate is gone**, merged into Region. Shapes are `foundry.data.*ShapeData` (`RectangleShapeData`, `EllipseShapeData`,
  `EmanationShapeData`, `ConeShapeData`, `LineShapeData`, `CircleShapeData`). `RegionDocument#shapes` (not `regionShapes`).
  `CONFIG.Region.templateModeConfig.shapeTypes`. `canvas.regions.placeRegion(data, {...})` (`client/canvas/layers/regions.mjs:715`).
- **Region document** (`common/documents/region.mjs`, `client/documents/region.mjs`): `elevation {bottom, top, topInclusive}`, `levels`,
  `restriction {enabled, type, priority}`, `attachment.token`, `behaviors`. Getters `polygons`, `polygonTree`, `clipperPaths`, `triangulation`,
  `bounds`. `testPoint(point)`, `static _testElevation`, `segmentizeMovementPath`, `updateShapeConstraints`.
  Since 14.371, `region.active` is false when the region is hidden **or attached to a hidden token** (or a clone); core's surfaces and
  region events use `active`, not `hidden`. Hiding a token fires no region update, only `updateToken`. Don't rely on
  `token.attachments.regions`: core misses regions created along with their scene (use `regionsAttachedTo` in spatial/barriers.js).
- **Token document**: `x, y, elevation, width, height, depth, shape (CONST.TOKEN_SHAPES ELLIPSE_1/2, TRAPEZOID_1/2, RECTANGLE_1/2), level`.
  `BaseToken.MOVEMENT_FIELDS` includes depth, shape and level. Methods: `getSnappedPosition`, `getSize`, `getCenterPoint`,
  `static _getHexagonalOffsets(w, h, shape, columns)` (`common/documents/token.mjs`); `getOccupiedGridSpaceOffsets` (`client/documents/token.mjs:1413`),
  `_constrainTestPoints(points, data)` (:3571). `Token#checkCollision(dest, {origin, type, mode})` (`client/canvas/placeables/token.mjs:2806`).
  `Token#getMovementAdjustedPoint` is deprecated. The `moveToken` hook's movement has no `state` (14.371): it is stopped when
  `movement.constrained` and completed when `movement.pending.waypoints` is empty, as core works it out.
- **Wall document** (`common/documents/wall.mjs`): `c, levels, light, move, sight, sound, dir, door, ds, threshold {light, sight, sound, attenuation}`.
  **No elevation in core**: this module adds it via flags.

## Polygons, sources, perception

| API | File | Notes |
| --- | --- | --- |
| `PointSourcePolygon` | `client/canvas/geometry/shapes/source-polygon.mjs` | `static create(origin, config)`, `initialize`, `compute`/`_compute`, `applyConstraint`, `contains`, `clone`, `static testCollision(origin, dest, {mode:"any"\|"all"\|"closest", tMin, tMax, ...config})`, `static applyThresholdAttenuation(polygon)`. `config.level` defaults to `canvas.level`; `origin.elevation` defaults to source then `level.elevation.base` |
| `ClockwiseSweepPolygon` | `client/canvas/geometry/clockwise-sweep.mjs` | `_compute`, `_determineEdgeTypes(type, priority, config)`, `_testEdgeInclusion`, `_testCollision(ray, mode, dest, tMin, tMax)` |
| Polygon config typedefs | `client/canvas/geometry/_types.mjs` | `PointSourcePolygonConfig` (type, level, angle, radius, externalRadius, rotation, useThreshold, source, boundaryShapes, surfaceExposure), `ClockwiseSweepPolygonConfig` (+ edgeDirectionMode, priority, edgeTypes) |
| `CONFIG.Canvas.polygonBackends` | `client/config.mjs:771` | `{sight, light, darkness, sound, move}`: all `ClockwiseSweepPolygon` |
| `PolygonMesher` | `client/canvas/geometry/shapes/polygon-mesher.mjs` | `triangulate` |
| `PolygonVertex` | `client/canvas/geometry/edges/vertex.mjs` | `fromPoint` |
| Sources | `client/canvas/sources/` | `PointEffectSourceMixin` (`point-effect-source.mjs`: `_createShapes`, `_updateGeometry`, `_createEdges`), `PointLightSource`, `PointDarknessSource`, `PointSoundSource`, `PointVisionSource`, `GlobalLightSource`; `testPoint(point)` |
| `DetectionMode` | `client/canvas/perception/detection-mode.mjs` | `static _testCollision(visionSource, test, configOrLos)` (:211), `_testPoint` |
| `CanvasVisibility` | `client/canvas/groups/visibility.mjs` | `refreshVisibility` (:502) |
| `SoundsLayer` | `client/canvas/layers/sounds.mjs` | `_configurePlayback(config)` (:275) |
| `AmbientSound` | `client/canvas/placeables/sound.mjs` | `_refreshField` (:223) |
| `Region` placeable | `client/canvas/placeables/region.mjs` | `_draw` (:280), `_refreshBorder` (:497) |
| Region behaviors | `client/data/region-behaviors/` | subclass `foundry.data.regionBehaviors.RegionBehaviorType` (`base.mjs`); register via `CONFIG.RegionBehavior.dataModels/typeIcons/typeLabels/typeHints` (see `scripts/region/barrier.js`) |

## Grids (`common/grid/`)

`BaseGrid` (`base.mjs`), `SquareGrid`, `HexagonalGrid`, `GridlessGrid`. `isGridless/isSquare/isHexagonal`, `getOffset`, `getOffsetRange`,
`getAdjacentOffsets`, `testAdjacency`, `getTopLeftPoint`, `getCenterPoint`, `getShape`, `getVertices`, `getSnappedPoint(point, {mode})`,
`measurePath(waypoints, opts)` → `{waypoints, segments, distance, cost, spaces, diagonals, euclidean}`, `getDirectPath`,
`getCircle/getCone/getLine/getRectangle/getEllipse/getRing`. `CONST.GRID_TYPES` (GRIDLESS 0, SQUARE 1, HEXODDR/HEXEVENR/HEXODDQ/HEXEVENQ 2–5),
`CONST.GRID_DIAGONALS` (ALTERNATING_1 = 5-10-5), `CONST.GRID_SNAPPING_MODES` (bit flags).

## Hooks used

See `client/hooks.mjs` for signatures. Used here: `init`, `i18nInit`, `canvasReady`, `libWrapper.Ready`, `initializeEdges`,
`preCreateScene`, `updateScene`, `updateWall`, `preCreateToken`, `moveToken`, `refreshToken`, `updateActor`, `updateCombatant`,
`create/deleteActiveEffect`, `render{Wall,Scene,Region,RegionBehavior,Settings}Config`, `closeRegionBehaviorConfig`, `renderTokenHUD`,
`getSceneControlButtons`, `activate/deactivateRegionLayer`.

## Finding things

```sh
F=../FoundryVTT-Node-14.371
grep -rnE "^(export )?(default )?class Name\b" $F/client $F/common --include=*.mjs   # where a class lives
grep -nE "^\s+(static |async |get )?methodName\(" <file>                           # a method signature
grep -rn "Hooks.callAll(\"hookName\"" $F/client                                     # where a hook fires
```

When adding a `patch.add` target, confirm the dotted path resolves in v14 source (and in the tests: `libWrapper.failures`).

# PF2e / SF2e integration (`scripts/f2e/`)

Entry `index.js` `initialize()`. It patches `CONFIG.Token.documentClass/objectClass`, `CONFIG.Region.objectClass`,
`CONFIG.Canvas.layers.regions.layerClass`, `CONFIG.Scene.documentClass.prototype.canHaveAuras`.
Relevant system source in `../pf2e/src/module/`:

- Auras: `canvas/token/aura/renderer.ts` (`AuraRenderer`: `draw`, `highlight`, `repositionTexture`) and `scene/token-document/aura/index.ts`
  (`TokenAura#containsToken`). These are not exported, so prototypes are captured from the first token with an aura (`refreshToken` hook) and wrapped with `patch.method`.
- `canvas/token/object.ts:534`: `TokenPF2e#distanceTo(target, {reach})` (replaced with module's 3D `distance`, with reach-exception discount).
- `canvas/region.ts` (`get snappingMode`) and `canvas/layer/region.ts` (`placeRegion` override): template snapping and placement.
- `scene/region-document/document.ts` (`isMeasuredArea`, `clearCoverage`), `scene/wall-document/document.ts` (`onEdgeChange` coverage redo).
- Auras only apply on grids with units `ft`/`feet`/`''` (also `m`/`meter`). Settings keys are prefixed `f2e.` and per grid type via `helpers/grid.js` `gridString`.
- Compendium source `packs/f2e/off-guard-toggle/` is compiled once per system; `<system>` in the JSON is replaced with `pf2e`/`sf2e`.
