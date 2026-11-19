# API

```js
const api = game.modules.get('f2e-grid-enhancements').api;
```

## `raycast(scene, origin, destination, [options])`

A 3D raycast backed by a bounding volume hierarchy. It returns every crossing from `origin` to `destination`. Results are sorted from nearest to furthest; with the `stop` option they end at the first blocker.

### Parameters

| Parameter     | Type            | Description            |
| ------------- | --------------- | ---------------------- |
| `scene`       | `Scene`         | Scene to raycast       |
| `origin`      | `ElevatedPoint` | Origin of the ray      |
| `destination` | `ElevatedPoint` | Destination of the ray |
| `options`     | `object`        | Optional settings      |

### Options

`hits` holds what the ray checks and returns, each entry `true` (the default) or `false`, e.g. `hits: {tokens: false}`.
Unknown options are ignored. A missing `origin` or `destination` elevation, or an unknown `edgeRestrictionType`, throws a `TypeError`.

| Option                      | Type                           | Default     | Description                                                                                       |
| --------------------------- | ------------------------------ | ----------- | ------------------------------------------------------------------------------------------------- |

// TODO consider ways to make these suboptions and improve names
| `edgeRestrictionType`       | `CONST.EDGE_RESTRICTION_TYPES` | `'move'`    | Restriction type; decides which hits have `blocking: true`                                        |
| `edgeDirectionMode`         | `CONST.EDGE_DIRECTION_MODES`   | `NORMAL`    | Which way one-way walls and source boundaries block: `NORMAL` as core does, `REVERSED` the other way, `BOTH` either way |
| `elevationBias`             | `'above' \| 'below'`           | `'above'`   | Which side of anything exactly at the ray's elevation the ray is on. Same for both directions     |
| `stop`                      | `boolean`                      | `false`     | Stop at the first blocker (after forgiving the first limited crossing)                            |
| `useThreshold`              | `boolean`                      | `true`      | Apply proximity / reverse proximity thresholds; `false` makes those walls block normally          |
| `externalRadius`            | `number`                       | `0`         | Source external radius in pixels, for proximity thresholds                                        |
| `radius`                    | `number`                       | ray length  | How far the source reaches in pixels, for attenuating thresholds                                  |
| `priority`                  | `number`                       | `-Infinity` | Sources below this priority are ignored (a light's priority counts as its priority - 0.5)         |
| `activeLevels`              | `Iterable<string>`             | all         | Levels the ray is on; walls and regions on other levels are ignored (those on no level always count) |


| `range`                     | `object`                       |             | The tested part of the segment                                                                    |
| `range.min`                 | `number`                       | `0`         | Start of the tested part of the segment: `0` to `1`                                               |
| `range.max`                 | `number`                       | `1`         | End of the tested part of the segment: `0` to `1`                                                 |
| `hits`                      | `object`                       |             | What the ray checks and returns                                                                   |
| `hits.walls`                | `boolean`                      | `true`      | Wall hits                                                                                         |
| `hits.regions`              | `boolean`                      | `true`      | Region outside/inside hits                                                                        |
| `hits.tokens`               | `boolean`                      | `true`      | Token outside/inside hits (tokens never block: check `entering` to know when the ray is in one)  |
| `hits.levels`               | `boolean`                      | `true`      | Level hits                                                                                        |
| `hits.sources`              | `boolean`                      | `true`      | Darkness and priority light source hits (viewed scene only); each source reaches only as far as barriers let it, in 3D as seen from the source |

### Returns

`Hit[]`, nearest first.

Results are cached per scene: wall, region and level hits are kept until a wall, region, region behavior, level or the
scene's grid changes, or a door opens or closes, while token and light/darkness source hits are found afresh on every
call. Wall, region and level hits (with their `point` and `normal`) may be shared between calls, so they are frozen; the
returned array is always new.

#### `Hit`

| Property     | Type                                                     | Description                                                                 |
| ------------ | -------------------------------------------------------- | --------------------------------------------------------------------------- |
| `type`       | `'wall' \| 'region' \| 'token' \| 'level' \| 'attenuation' \| 'darkness' \| 'light'` | What was crossed                              |
| `document`   | `Wall \| Region \| Token \| Level \| AmbientLight \| null`   | The related document (for a source, its placeable's document if any)        |
| `source`     | `PointDarknessSource \| PointLightSource`                 | On darkness and light hits: the source                                      |
| `t`          | `number`                                                 | Position along the whole segment: `0` to `1`                                |
| `point`      | `ElevatedPoint`                                          | Where the crossing is                                                       |
| `normal`     | `{x, y, z}`                                              | Unit normal facing the ray's origin (pixel space)                           |
| `blocking`   | `boolean`                                                | Whether this stops a ray of the requested type                              |
| `limited`    | `boolean`                                                | Limited barrier; the first one is let through (`forgiven: true`)           |
| `entering`   | `boolean`                                                | On region, token, darkness and light hits: crossing inward                  |
| `inside`     | `'origin' \| 'destination'`                               | Extra hit for a region/token containing the tested range's origin (`range.min`) or destination (`range.max`) end |
| `surface`    | `RegionBehavior \| null`                                  | On region faces (and sides with a Define Barrier behavior): the behavior that blocks or limits |
| `attenuated` | `boolean`                                                | On a proximity or reverse proximity barrier with attenuation that let the ray through; an `attenuation` hit follows where the ray runs out |
| `forgiven`   | `boolean`                                                | On the first limited crossing (and limited walls joined to it at that point): let through, so `blocking` is `false` |

Regions can also have this module's `Define Barrier` behavior: barriers at the region's bottom, top and/or sides
with a wall's options for each restriction type (none, limited, normal, proximity, reverse proximity, thresholds and
attenuation, darkness following light) and a one-way direction (into or out of the region, reversed by
`edgeDirectionMode`). Only this raycast uses these barriers; core's own surface checks do not.

### Thresholds

Proximity and reverse proximity barriers (see the README's Barriers section) follow core's rules in 3D. Each is measured from the ray's origin to the
nearest point of what is crossed: a wall's height range, a region face, or a region side. With attenuation, a ray let
through reaches past it by core's attenuated amount (less the nearer the origin is to the threshold distance, never beyond
`radius`), measured as a distance from the origin, so it runs out on a sphere; it is blocked at the crossing when that
reach does not get past it. Crossing several, the ray runs out at the nearest reach.

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
