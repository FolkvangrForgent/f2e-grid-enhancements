# API

```js
const api = game.modules.get('f2e-grid-enhancements').api;
```

## `raycastBarriers(scene, origin, destination, [options])`

A 3D raycast over barriers only: walls, core Define Surface behaviors and this module's Define Barrier behaviors. It
returns every barrier crossing from `origin` to `destination` that restricts the requested type, whether or not it
blocks this ray, with the final answer in `blocked`. Results are sorted from nearest to furthest; with the `stop` option
they end at the first blocked hit.

```js
const hits = api.raycastBarriers(scene, origin, destination, {edgeRestrictionType: 'sight', stop: true});
const isBlocked = hits.some(hit => hit.blocked);
```

### Parameters

| Parameter     | Type            | Description            |
| ------------- | --------------- | ---------------------- |
| `scene`       | `Scene`         | Scene to raycast       |
| `origin`      | `ElevatedPoint` | Origin of the ray      |
| `destination` | `ElevatedPoint` | Destination of the ray |
| `options`     | `object`        | Optional settings      |

### Options

Unknown options are ignored. A missing `origin` or `destination` elevation, or an unknown `edgeRestrictionType`, throws a `TypeError`.

| Option                | Type                           | Default    | Description                                                                                       |
| --------------------- | ------------------------------ | ---------- | ------------------------------------------------------------------------------------------------- |
| `edgeRestrictionType` | `CONST.EDGE_RESTRICTION_TYPES` | `'move'`   | Restriction type; decides which barriers are hits and which have `blocked: true`                  |
| `edgeDirectionMode`   | `CONST.EDGE_DIRECTION_MODES`   | `NORMAL`   | Which way one-way barriers block: `NORMAL` as core does, `REVERSED` the other way, `BOTH` either way |
| `elevationBias`       | `'above' \| 'below'`           | `'above'`  | Which side of anything exactly at the ray's elevation the ray is on. Same for both directions     |
| `stop`                | `boolean`                      | `false`    | Stop at the first blocked hit (after letting through the first limited crossing)                  |
| `useThreshold`        | `boolean`                      | `true`     | Apply proximity / reverse proximity thresholds; `false` makes those barriers block normally       |
| `externalRadius`      | `number`                       | `0`        | Source external radius in pixels, for proximity thresholds                                        |
| `radius`              | `number`                       | ray length | How far the source reaches in pixels, for attenuating thresholds                                  |
| `activeLevels`        | `Iterable<string>`             | all        | Levels the ray is on; walls and regions on other levels are ignored (those on no level always count) |
| `range.min`           | `number`                       | `0`        | Start of the tested part of the segment: `0` to `1`                                               |
| `range.max`           | `number`                       | `1`        | End of the tested part of the segment: `0` to `1`                                                 |
| `hits.walls`          | `boolean`                      | `true`     | Include walls                                                                                     |
| `hits.regions`        | `boolean`                      | `true`     | Include region surfaces and barriers                                                              |

### Returns

`BarrierHit[]`, nearest first.

Results are cached per scene until a wall, region, region behavior, level or the scene's grid changes, or a door opens or
closes. Hits (with their `point`, `normal` and `barrier`) may be shared between calls, so they are frozen; the returned
array is always new.

#### `BarrierHit`

| Property            | Type                       | Description                                                                         |
| ------------------- | -------------------------- | ----------------------------------------------------------------------------------- |
| `t`                 | `number`                   | Position along the whole segment: `0` to `1`                                        |
| `point`             | `ElevatedPoint`            | Where the crossing is                                                               |
| `normal`            | `{x, y, z}`                | Unit normal facing the ray's origin, in pixel space (elevation scaled by the grid)  |
| `blocked`           | `boolean`                  | Whether this hit stops the ray, with one-way, limited, threshold and attenuation rules applied |
| `document`          | `WallDocument \| RegionDocument` | The wall or region crossed                                                   |
| `barrier`           | `object`                   | The barrier that decided the hit                                                    |
| `barrier.sense`     | `CONST.EDGE_SENSE_TYPES`   | Its sense for the requested type: `LIMITED`, `NORMAL`, `PROXIMITY` or `DISTANCE` (reverse proximity). Core surfaces are `NORMAL` |
| `barrier.direction` | `'both' \| 'towards' \| 'away'` | `'both'` for a two-way barrier. For a one-way barrier, `'towards'` when the ray crosses it the way it restricts (as core decides it, edgeDirectionMode `NORMAL`) and `'away'` when it crosses the way it lets through; `edgeDirectionMode` decides `blocked`, not this |

Which barrier decides a hit, when a region crossing has several: the first that blocks, else the first that limits, else
the nearest attenuating one, else the first the ray passes without effect.

#### What each crossing returns

| Crossing                                                         | Hits                                                                                      |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Normal barrier                                                   | One, `blocked: true`                                                                      |
| Limited barrier                                                  | One. The first limited crossing has `blocked: false`, later ones `blocked: true`. Limited walls joined at the point the ray passes (a window drawn as two segments) count as one crossing |
| One-way barrier crossed the way it lets through                  | One, `blocked: false`                                                                     |
| Proximity / reverse proximity barrier that lets the ray through  | One, `blocked: false`                                                                     |
| Proximity / reverse proximity barrier that does not              | One, `blocked: true`                                                                      |
| Proximity / reverse proximity barrier that attenuates the ray    | Two: the crossing, `blocked: false`, then where the ray runs out, `blocked: true`, with the same `document` and `barrier`. The ray runs out on a sphere around its origin, so this hit's `normal` points back along the ray. If the reach does not get past the barrier, one hit, `blocked: true` |

Open doors, barriers with no sense for the requested type, and crossings outside a barrier's height range are not hits.
#### Define Barrier

Regions can also have this module's `Define Barrier` behavior: barriers at the region's bottom, top and/or sides
with a wall's options for each restriction type (none, limited, normal, proximity, reverse proximity, thresholds and
attenuation, darkness following light) and a one-way direction (into or out of the region, reversed by
`edgeDirectionMode`). This raycast always uses these barriers. With the `Barrier Visualization` setting off they are
also handed to core: sides as wall edges and tops/bottoms as surfaces (see the README's Barriers section).

A `Define Barrier` can also give its region a roof (`system.roof`): its top shaped as a `manual` or an `auto` roof (`shape`,
or `none`).

- `auto` has a face rising from every edge of the region's outline (its straight skeleton): a pyramid on a square or hexagon,
  hipped ends on a rectangle, valleys where the outline turns in (an L, a cross, a group of hex cells), a cone on a circle;
  a hole gets eaves of its own, the roof falling to it as to the outside (a courtyard). Each ridge end is a hip with a gable below (`lowerGable`, up from the eaves: a vertical gable end) and
  above (`upperGable`, down from the ridge: set back on the hip), each a share of the end's depth in percent, the hip what is
  left between them: both 0 a hip, together 100 or more a gable (a gable on a rectangle, crossing gables on an L, T or
  cross), only lower a jerkinhead, only upper a Dutch gable.
- `manual` has a straight ridge along `direction` (degrees clockwise from east), at `ridge` percent across the box around the
  outline (0 its left side facing the direction, 100 its right), with a face rising to it from each side: a gable at 50, a
  shed at 0 or 100, a saltbox between. `teeth` repeats that across the box: a sawtooth, or a row of gables.

Either rises straight from its eaves at `pitch` (degrees). Vertical steps inside the outline (between teeth, a Dutch gable's set-back wall) are steep faces a pixel
or less wide. The roof's lowest eaves sit at the region's bottom, which it needs; it rises from there, flattened to fit when
the region's top is lower than its ridge (the top can be unbounded). The roof counts for every raycast, its volume (`raycastRegions`) and sides too, and any
core surfaces on its top, so a level ray can cross it; such a hit's `normal` is its face's, not straight up. The bottom stays
flat. When several of a region's barriers give a roof, the first enabled one counts. Roofed tops are not handed to core, whose
surfaces are flat.

#### Thresholds

Proximity and reverse proximity barriers (see the README's Barriers section) follow core's rules in 3D. Each is measured
from the ray's origin to the nearest point of what is crossed: a wall's height range, a region face, or a region side. With attenuation, a ray let
through reaches past it by core's attenuated amount (less the nearer the origin is to the threshold distance, never beyond
`radius`), measured as a distance from the origin, so it runs out on a sphere; it is blocked at the crossing when that
reach does not get past it. Crossing several, the ray runs out at the nearest reach.

## `raycastRegions(scene, origin, destination, [options])` and `raycastTokens(scene, origin, destination, [options])`

Where a 3D ray is inside regions or tokens. Neither blocks anything; region surfaces and barriers are in `raycastBarriers`.
Each returns one span per stretch of the ray inside a region or token, sorted by entry, nearest first.

```js
// tokens between an attacker and a target, for cover
const between = api.raycastTokens(scene, attackerCenter, targetCenter).filter(({document}) => document !== attacker.document && document !== target.document);
// regions the ray passes through, and where
for (const {document, enter, exit} of api.raycastRegions(scene, origin, destination)) console.log(document.name, enter.t, exit.t);
```

### Parameters

| Parameter     | Type            | Description            |
| ------------- | --------------- | ---------------------- |
| `scene`       | `Scene`         | Scene to raycast       |
| `origin`      | `ElevatedPoint` | Origin of the ray      |
| `destination` | `ElevatedPoint` | Destination of the ray |
| `options`     | `object`        | Optional settings      |

### Options

Unknown options are ignored. A missing `origin` or `destination` elevation throws a `TypeError`.

| Option          | Type                                     | Default   | Raycast | Description                                                                                   |
| --------------- | ---------------------------------------- | --------- | ------- | --------------------------------------------------------------------------------------------- |
| `elevationBias` | `'above' \| 'below'`                     | `'above'` | Both    | Which side of anything exactly at the ray's elevation the ray is on. Same for both directions |
| `range.min`     | `number`                                 | `0`       | Both    | Start of the tested part of the segment: `0` to `1`                                           |
| `range.max`     | `number`                                 | `1`       | Both    | End of the tested part of the segment: `0` to `1`                                             |
| `activeLevels`  | `Iterable<string>`                       | all       | Both    | Levels the ray is on; regions and tokens on other levels are ignored (those on no level always count) |

### Returns

`Span[]`, nearest entry first.

`raycastRegions` results are cached per scene until a wall, region, region behavior, level or the scene's grid changes;
its spans (with their ends, points and normals) may be shared between calls, so they are frozen, and the returned array is
always new. `raycastTokens` is cast afresh on every call.

#### `Span`

| Property       | Type                               | Description                                                                         |
| -------------- | ---------------------------------- | ----------------------------------------------------------------------------------- |
| `document`     | `RegionDocument \| TokenDocument`  | The region or token                                                                 |
| `enter`        | `SpanEnd`                          | Where the ray goes in, or the start of the tested range when it starts inside       |
| `exit`         | `SpanEnd`                          | Where the ray comes out, or the end of the tested range when it ends inside         |
| `startsInside` | `boolean`                          | The start of the tested range (`range.min`) is inside                               |
| `endsInside`   | `boolean`                          | The end of the tested range (`range.max`) is inside                                 |

#### `SpanEnd`

| Property | Type              | Description                                                                                 |
| -------- | ----------------- | ------------------------------------------------------------------------------------------- |
| `t`      | `number`          | Position along the whole segment: `0` to `1`                                                |
| `point`  | `ElevatedPoint`   | Where it is                                                                                 |
| `normal` | `{x, y, z} \| null` | Unit normal of the surface crossed, facing the ray's origin, in pixel space; `null` at an end of the tested range inside the volume |

A region or token can have several spans: the ray can leave and re-enter a region with holes or an uneven outline, or a
token with an uneven footprint. A region's overlapping or touching parts (such as one region on several levels) are one
span while any of them holds the ray. A flat region (bottom equal to top) has no inside: crossing it is a span whose
`enter` and `exit` are the same point. A ray only touching a token's ellipsoid is a span whose ends meet.

## `raycastSources(scene, origin, destination, [options])`

Where a 3D ray is inside darkness sources and priority light sources: the sources that restrict something, darkness
restricting `sight` and `light`, and lights with a priority above 0 restricting `darkness`. Like `raycastRegions` and
`raycastTokens` it returns spans and blocks nothing; whether a source's boundary stops a ray is up to the caller (core's
source edges stop a ray going in).

```js
// is the ray stopped by darkness, as core decides it (going in)?
const isBlocked = api.raycastSources(scene, origin, destination, {edgeRestrictionType: 'sight'}).some(span => !span.startsInside);
```

Each source is a sphere of its radius around it (unbounded for an unbounded radius), cut in plan to its polygon (its
angle, and other sources' edges as core cuts it by them) and in 3D to what barriers restricting its own type hide from
it, by the same barrier rules as `raycastBarriers`.

### Parameters

| Parameter     | Type            | Description            |
| ------------- | --------------- | ---------------------- |
| `scene`       | `Scene`         | Scene to raycast       |
| `origin`      | `ElevatedPoint` | Origin of the ray      |
| `destination` | `ElevatedPoint` | Destination of the ray |
| `options`     | `object`        | Optional settings      |

### Options

Unknown options are ignored. A missing `origin` or `destination` elevation, or an unknown `edgeRestrictionType`, throws a `TypeError`.

| Option                | Type                           | Default     | Description                                                                                   |
| --------------------- | ------------------------------ | ----------- | --------------------------------------------------------------------------------------------- |
| `edgeRestrictionType` | `CONST.EDGE_RESTRICTION_TYPES` | `'sight'`   | Restriction type: `sight` and `light` meet darkness sources, `darkness` priority lights, others nothing |
| `priority`            | `number`                       | `-Infinity` | Sources below this priority are left out (a light's priority counts as its priority - 0.5, as it loses to darkness at the same priority) |
| `elevationBias`       | `'above' \| 'below'`           | `'above'`   | Which side of anything exactly at the ray's elevation the ray is on. Same for both directions |
| `range.min`           | `number`                       | `0`         | Start of the tested part of the segment: `0` to `1`                                           |
| `range.max`           | `number`                       | `1`         | End of the tested part of the segment: `0` to `1`                                             |

### Returns

`SourceSpan[]`, nearest entry first, cast afresh on every call.

#### `SourceSpan`

A `Span` (see `raycastRegions`), with:

| Property   | Type                                         | Description                                                                 |
| ---------- | -------------------------------------------- | --------------------------------------------------------------------------- |
| `document` | `AmbientLightDocument \| TokenDocument \| null` | The light or token the source belongs to, if any                        |
| `source`   | `PointDarknessSource \| PointLightSource \| null` | The live source on the viewed scene; `null` on other scenes            |
| `kind`     | `'darkness' \| 'light'`                      | Darkness source or priority light                                           |
| `priority` | `number`                                     | The source's priority                                                       |

Each end's `normal` is that of the surface crossed there: the source's sphere, a side of its polygon, the side of a
shadow (the plane through the source and the barrier edge casting it), the barrier itself where the ray passes through
it, or the sphere an attenuated barrier's reach ends on. It is `null` at an end of the tested range inside the source.

### Scenes

On the viewed scene the sources are core's live ones. Any other scene has no live sources, so they are built from its
ambient lights and token lights as core would build them: hidden lights, lights outside their darkness activation range,
lights with no radius or angle, and burrowing tokens' lights emit nothing; a darkness source inside a light of higher
priority, and a light inside darkness of at least its priority, are suppressed. These differ from core in a few ways:
the darkness level is the scene's own, not as regions adjust it; suppression and cutting by other sources use those
sources' shapes with walls, not as they are cut by further sources; and sources other modules add only on the canvas are
missing. They are cached until an ambient light, token, wall, level, active effect or the scene changes.

## `distance(grid, objectA, objectZ, [discount])`

3D distance between two tokens, two points, or a token and a point, in the grid's units (`grid.distance` per space). A
token is measured from its nearest occupied space, so two adjacent tokens are one space apart whatever their size, and
height counts through the token's `elevation` and `depth`.

```js
const grid = canvas.scene.grid;
api.distance(grid, tokenA, tokenB);                            // token to token
api.distance(grid, tokenA, {x: 1000, y: 800, elevation: 10});  // token to point
api.distance(grid, tokenA.document, tokenB);                   // a TokenDocument works too
```

### Parameters

| Parameter  | Type                                       | Description                                                                 |
| ---------- | ------------------------------------------ | --------------------------------------------------------------------------- |
| `grid`     | `BaseGrid`                                 | The grid to measure on, normally the token's `scene.grid`                    |
| `objectA`  | `Token \| TokenDocument \| ElevatedPoint`   | A token (placeable or document) or a point in pixels                        |
| `objectZ`  | `Token \| TokenDocument \| ElevatedPoint`   | The other end                                                               |
| `discount` | `(grid, path) => number`                   | Optional: replaces the result. `path` is core's `grid.measurePath` result for the gap (`distance`, and on square and hex grids `diagonals`, ...) |

Always give a point an `elevation`: on gridless scenes a point without one measures as `Infinity`.

### Returns

`number`: the distance (never negative, rounded to 8 decimal places), `0` when both arguments are the same token (a `Token` and its own `TokenDocument` count as the same) or point, or
`Infinity` when it cannot be measured.

### How each grid measures

| Grid     | Token volume                                                                                   | Measurement                                                                  |
| -------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Square   | The spaces it covers: `width` × `height` × `depth`, each rounded, at least 1                   | Core's `measurePath` across the space gap, so the scene's diagonal rule applies |
| Hex      | The hexes it covers (core's cells for its shape, at its size rounded to whole spaces) and `depth` spaces up | Fewest hex steps between the nearest hexes, plus the vertical gap, through `measurePath` |
| Gridless | A box, or for the ellipse shapes a sphere or ellipsoid, from its `width`, `height` and `depth`, each at least half a space | Straight-line gap between the two volumes, through `measurePath`            |

The `discount` callback is how the PF2e/SF2e integration applies the 10-foot reach exception: on 5-foot square grids with
alternating diagonals it takes one space off a path with more than one diagonal.

```js
api.distance(grid, tokenA, tokenB, (grid, path) => (path.diagonals > 1 ? path.distance - grid.distance : path.distance));
```
