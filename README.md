![](https://img.shields.io/badge/Foundry-v14-informational)
![Latest Release Download Count](https://img.shields.io/github/downloads/FolkvangrForgent/f2e-grid-enhancements/latest/module.zip)
![Forge Installs](https://img.shields.io/badge/dynamic/json?label=Forge%20Installs&query=package.installs&suffix=%25&url=https%3A%2F%2Fforge-vtt.com%2Fapi%2Fbazaar%2Fpackage%2Ff2e-grid-enhancements&colorB=4aa94a)

> **AI Disclaimer** - This module was coded by a human but AI was used to review the code for bugs.

# PF2e & SF2e - Grid Enhancements

This module aims to enhance the use of grids while using the PF2e and SF2e systems. A full list of features can be found below. If you are looking for a particular feature or are having an issue please open up an `Issue`!

**WARNING** - This module uses a lot of function patching and so it may break if FoundryVTT or the SF2e or PF2e systems update. This module is currently strictly a FVTT V14 module.

## Features

### General Improvements

- Regions
    - `point` region that is a single grid unit increment
    - `cone` internal angle and template mode snapping angle can be configured
    - `line` in template mode selects a correct number of spaces for non wide lines
- Settings
    - (GM) `cone` internal angle can be configured for all grid types
    - (GM) `cone` snapping angle can be configured for all grid types
    - (GM) New scene default grid type
    - (GM) New scene default level top elevation
    - (GM) New scene default level bottom elevation
    - (GM) Default reach exception toggle
    - (GM) Aura highlight wall collision toggle
    - [experimental] (GM) Flanking logic overrides and related setting
- Areas
    - Snapping
        - Origin
            - `point` snaps to centers
            - `emanation` snaps to centers or vertices
            - `burst` snaps to vertices
            - `cone` snaps to centers or midpoints or vertices
            - `line` snaps to midpoints or vertices
        - Angle
            - `cone` internal angle and snapping angle can be configured
- Tokens
    - Custom `distanceTo` function with support for token depth, all token shapes, and all grid types
        - Rounds results to nearest tenth
    - [experimental] Custom `onOppositeSides` function logic for flanking that allows overriding the default logic to instead compare the intersection angles of center to center lines in 3D with a ellipsoid representation of the flankee
- Auras
    - Only activate on grids with units of `'ft'`, `'feet'`, or `''`
    - Custom aura `containsToken` function
        - Use an algorithm that is often more permissive than the system algorithm
            - Determine if a token is in range of the token emitting an aura
            - Generate a shell of points on the token the aura may be affecting (constraining these by walls of the auras type)
            - Check from the center of the token emitting the aura to shell points around the token if any do not collide then the aura is applied
    - Accurate border shape
    - Accurate highlight
- Compendiums
    - Custom feat and effect for manual toggle if target is off guard

### Hex Improvements

- Tokens
    - Reach enforcement support
- Auras
    - Support via extending system implementation

### Square Improvements

### Gridless Improvements

- Tokens
    - Reach enforcement support
- Auras
    - Support via extending system implementation

### Languages

- English

- Polish

### API

```js
const api = game.modules.get('f2e-grid-enhancements').api;
```

#### `raycast(scene, origin, destination, [options])`

This module exposes a 3D raycasting helper that can do both surface and wall collisions at the same time. In addition walls are constrained to the elevation ranges of the levels they occupy.

##### Parameters

| Parameter     | Type            | Description       |
| ------------- | --------------- | ----------------- |
| `scene`       | `Scene`         | Scene to raycast  |
| `origin`      | `ElevatedPoint` | Start of the ray  |
| `destination` | `ElevatedPoint` | End of the ray    |
| `options`     | `object`        | Optional settings |

##### Options

| Option     | Type               | Default  | Description                                                |
| ---------- | ------------------ | -------- | ---------------------------------------------------------- |
| `type`     | `string`           | `'move'` | Wall restriction type                                      |
| `mode`     | `string`           | `'any'`  | Function return type: `'any'` or `'closest'` or `'all'`    |
| `walls`    | `boolean`          | `true`   | Collide with walls                                         |
| `surfaces` | `boolean`          | `true`   | Collide with surfaces                                      |
| `tMin`     | `number`           | `0`      | Start of the segment to test: `0` to `1`                   |
| `tMax`     | `number`           | `1`      | End of the segment to test: `0` to `1`                     |
| `side`     | `string \| null`   | `null`   | Side of a surface the origin is on: `'above'` or `'below'` |
| `levels`   | `string[] \| null` | `null`   | Level identifiers to restrict collisions to                |

##### Returns

| Mode        | Type                |
| ----------- | ------------------- |
| `'any'`     | `boolean`           |
| `'closest'` | `Collision \| null` |
| `'all'`     | `Collision[]`       |

###### `Collision`

| Property   | Type             | Description                            |
| ---------- | ---------------- | -------------------------------------- |
| `type`     | `string`         | What was hit: `'wall'` or `'surface'`  |
| `document` | `Wall \| Region` | The related wall or region document    |
| `t`        | `number`         | Position along the segment: `0` to `1` |
| `point`    | `ElevatedPoint`  | The point of the collision             |

## Not implemented

### Difficult Terrain

I have taken a quick look at difficult terrain but at the point where it can produces unsatisfactory results even on square grids and it was not a simple fix to extend to other grid types I have not worked on it. I am open to suggestions on how to make it work or any MR/PR that is submitted.

### Flanking

This modules provides a compendium with an `Off Guard Toggle (Feat)` and an `Off Guard Toggle (Effect)`. These can be given to Players (feat/effect) and NPCs (effect). Combined with disabling the `Flanking Detection` automation this is a useable way to do flanking. In addition there is now an experimental flanking logic override, I still don't know if this will produce acceptable results.
