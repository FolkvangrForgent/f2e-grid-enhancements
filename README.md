![](https://img.shields.io/badge/Foundry-v14-informational)
![Latest Release Download Count](https://img.shields.io/github/downloads/FolkvangrForgent/f2e-grid-enhancements/latest/module.zip)
![Forge Installs](https://img.shields.io/badge/dynamic/json?label=Forge%20Installs&query=package.installs&suffix=%25&url=https%3A%2F%2Fforge-vtt.com%2Fapi%2Fbazaar%2Fpackage%2Ff2e-grid-enhancements&colorB=4aa94a)

> **AI Disclaimer** - AI is used for code review and code generation.

# Grid Enhancements

This module adds various features to enhance the functionality of grids in various systems. A full list of features can be found below and in specific system pages. If you are looking for a particular feature or are having an issue please open up an `Issue`! This module also provides an [API](API.md) for macro or other module use.

## Barriers

The highlight of this module is the support for what I am calling barriers. Barriers are an abstraction of walls into 3D space; Allowing directional normal, limited, proximity, and reverse proximity restrictions. Walls and Regions' `Define Surface` are natively accepted as sources for barriers. A new region behavior `Define Barrier` is also added to give more advanced way to add barriers.

### Walls

This module adds optional support for wall elevation that can be enabled or disabled on a per wall per top/bottom basis (the wall config's Top and Bottom, each with a checkbox turning it on). This is added to be an alternative to the level based workflow that core seems to be pushing.

A wall is assumed to exist as a barrier spanning each level it exists in or every level if levels is empty. Below is how configuration affects a wall ():
| Configured  | Bottom                                    | Top                                   |
| ----------- | ----------------------------------------- | ------------------------------------- |
| Neither     | Level's bottom (-Infinity without levels) | Level's top (Infinity without levels) |
| Only top    | Level's bottom (-Infinity without levels) | Configured top                        |
| Only bottom | Configured bottom                         | Level's top (Infinity without levels) |
| Both        | Configured bottom                         | Configured top                        |

An elevation that is enabled but left empty is treated as Infinity for the top and -Infinity for the bottom.

With both configured, the bottom may not be above the top (as for a region's elevation; equal is allowed). A single configured elevation may pass the level's other end, such as a top of 5 on a level from 10 to 20: on that level the wall has no height and is left out, while it still stands on its other levels. A wall with no height on every level is not a barrier at all.

### Regions

To support all restriction types this module adds a new region behavior, `Define Barrier`. In its basic mode it creates barriers on the region's top, bottom and/or side surfaces (Placement), each restriction type set as on a wall (normal, limited, proximity, reverse proximity, with thresholds and attenuation), and an optional one-way direction (blocking only going into or only going out of the region).

Its Advanced Options give the region a roof: its top becomes sloped faces, Manual (a ridge along a direction: gables, sheds, saltboxes, sawtooth) or Auto (following the outline: hips, gables, cones, valleys). The roof's sides and any core surfaces on its top follow it. See `Define Barrier` under [Regions](#general-grid-enhancements) below for every option.

### Functionality

Barriers are read by the module's raycast (`raycastBarriers` in the [API](API.md)), which walks a 3D segment through a cached index of the scene's walls, regions and tokens and reports every barrier it crosses with what it does to the ray. That raycast replaces core's flat wall checks wherever something needs to know whether a ray gets through:

- Movement: whether a move can be made, which grid spaces a token occupies, and which of its points count for entering regions
- Collision testing: `Token#checkCollision` and anything asking core's polygon backends, for every restriction type
- Vision: whether a token can be seen
- Lighting: whether a point is lit or in darkness (light perception, darkness blinding vision, sources suppressing each other, region behaviors suppressed by light or darkness)
- Sound: whether a sound can be heard

Because every one of these asks the same raycast, a barrier treats movement, sight, light and sound the same way it is drawn.

### Visualization

With the `Barrier Visualization` setting on, vision, lighting, darkness and the sound field on the Sounds layer are drawn from barriers in 3D instead of core's flat wall sweep, using the walls of the source's level and the levels it sees. Core's sweep still applies the scene's bounds, the radius, the vision angle and other sources' edges.

- Every top/bottom barrier is a floor (a roof's faces sloped): at each point the floor shown is the highest one at or below the source, else the lowest bottom of the source's level and the levels it sees. Levels are not floors themselves: an upper floor needs a region with a bottom barrier (or a core `Define Surface`) where it is solid, and elsewhere a source sees down to the levels below, their walls casting shadows there
- A floor on a level the source's level does not see (not in its level visibility) is never lit, though it still hides what is beneath it: the shape is drawn over the source's level and the levels it sees, so a token that climbs past its ceiling into an unseen level before it changes level does not reveal its own level's map
- A floor is lit where a ray from the source reaches it; barriers between them cast shadows on it (shadows inside the lit area are holes, lit areas past a shadow are islands)
- The floor lighting is compiled to WebAssembly from Rust (`wasm/`) and runs in a few Web Workers, off the main thread: while a source moves, it keeps its last shape until the new one is ready, a frame or two later. If the WebAssembly cannot load, sources are drawn with core's flat sweep

With the setting off, barriers still apply through the raycast, and are handed to core as far as it can show them:

- Region barrier sides are added to core as wall edges on the region's levels, with their restrictions, thresholds, attenuation and direction (no height, as core's edges have none)
- Region barrier tops/bottoms are added to core as surfaces for light, darkness, sight and sound; core's surfaces only block, so normal, proximity and reverse proximity block outright from both sides and limited does not block
- Token movement always goes through the raycast, so barriers stop tokens with all their rules either way; barrier sides that restrict movement also clip move-restricted regions (such as templates) as walls do, at every elevation

## General Grid Enhancements

- Settings
    - (GM) New scene default grid type
    - (GM) New scene default level name
    - (GM) New scene default level top elevation
    - (GM) New scene default level bottom elevation
- Scenes (options on the Levels tab of Scene Config)
    - `Change Levels by Elevation`: a token whose movement ends at an elevation within another level moves to that level (below the lowest level to the lowest, above the highest to the highest), while the levels stack with no gaps or overlaps
    - `Absolute Elevations`: elevations show and are entered as stored (token and placeable HUDs, tooltips, ruler labels), instead of relative to the viewed level's bottom
- Tokens
    - HUD button to switch between the two variants of a shape

- Regions
    - `Draw Grid Spaces` from core equivelent on gridless scenes
    - `Create Shapes from Controlled Tiles` button
        - Creates polygon shape from the tiles opaque area (or the rotated rectangle if threshold is 0)
        - Opens a window where settings can be changed to get the perfered results
    - `Define Barrier` behavior
        - Allows setting barriers on top bottom and side of a region
            - These can be configured simillarly to core wall options
                - limited, proximity, reverse proximity, thresholds, attenuation and a one-way direction
        - Can give the region a roof (Advanced Options): None, Manual or Auto, with a pitch in degrees
            - Auto follows the region's outline: a face rises from every edge, so squares and hexagons get pyramids, rectangles hipped ends, circles cones, and L shapes, crosses or groups of hex cells valleys where the outline turns in
                - Each ridge end is a hip with two optional gables, each a share of the end's depth: Lower Gable (up from the eaves, a vertical gable end) and Upper Gable (down from the ridge, set back on the hip). Both 0% is a hip; together 100% or more a gable (a classic gable on a rectangle, crossing gables on an L, T or cross); only lower a jerkinhead (half-hip); only upper a Dutch gable; both, a gable end, a band of hip and a set-back gable. Where faces meet at a point (pyramid, cone) the end stays a hip
            - Manual has a straight ridge along its direction, at a ridge position across the region (facing the direction, 0% is the left side and 100% the right), with a face rising to it from each side at the same pitch: 50% is a gable, 0% or 100% a shed, anything between a saltbox (the longer face's eave sits lower)
                - Teeth repeats that across the region: a sawtooth with the ridge at 0% or 100%, a row of gables at 50%
            - Vertical steps inside the region (between sawtooth teeth, a Dutch gable's set-back wall) are steep faces a pixel wide, so nothing slips through them
            - The roof's eaves sit at the region's bottom and it rises from there at the Pitch (on Manual, the longer face's eave; a saltbox's other one sits higher). The region's top can be left empty; a top lower than the ridge flattens the roof to fit
            - On the Regions layer a roofed region shows its roof plan at half opacity (faces shaded by the way they slope, with ridge, hip and valley lines); the behavior's window shows the roof's eave and ridge heights
            - Show Roof (on by default): off, the roof is left out of what sources show where it is the floor they see, so it stays unexplored; from under it the inside shows as usual
            - The raycast uses the roof exactly; the visualizer draws light and vision on the roof's faces, and with the visualizer off roofs are not handed to core (its surfaces are flat)
    - `Optimize Shapes` button
        - Replace the region's shapes with polygons tracing the area they cover
- Lighting
    - Wall elevation support
        - Uses modules raycast for determining if a point is lit or in darkness (light perception, darkness blinding vision, sources suppressing each other, region behaviors suppressed by light or darkness)
        - Basic visualization
- Move
    - Wall elevation support
        - Uses modules raycast for determining if a move can be done
        - Uses modules raycast for which grid spaces a token occupies and which of its points count for entering regions
- Collision testing (`Token#checkCollision` and anything asking core's polygon backends)
    - Uses modules raycast for every restriction type, with darkness and priority light sources for sight, light and darkness
- Sound
    - Wall elevation support
        - Uses modules raycast for determining if a sound can be heard
        - Basic visualization
- Vision
    - Wall elevation support
        - Uses modules raycast for determining if a token can be seen
        - Basic visualization

## Specific Grid Enhancements

- [Pathfinder2e (PF2e)](F2E.md)
- [Starfinder2e (SF2e)](F2E.md)

## Architecture

`scripts/main.js` imports every feature and builds the API. A file only imports from its own layer or the layers above it in this table:

| Layer | Folder | What it holds |
| --- | --- | --- |
| Helpers | `helpers/` | General utilities: the BVH, polygon and edge geometry, Clipper boolean operations, restriction-type bits, grid, token and wall-height helpers, libWrapper patching and setting access. |
| Spatial | `spatial/` | A cached per-scene BVH of walls, regions and tokens (`index.js`), what a Define Barrier behavior is (`barriers.js`) and how barriers treat a source (`rules.js`). |
| Raycast | `raycast/` | The barrier, region, token and source raycasts over the scene index (see [API.md](API.md)): the public raycasts and where a ray is stopped for the features (`index.js`), and the walk along a ray (`query.js`) with its kinds of crossing (`crossings.js`, `cross-sources.js`). |
| Features | `perception/`, `region/`, `wall.js`, `scene.js`, `token.js`, `distance.js`, `f2e/` | What players and GMs see: movement and collision testing, token footprints, sound, vision, and being lit or in darkness through the raycast, and the barrier visualizer (`perception/`), the Define Barrier behavior, the wall height form, region tools, scene defaults, the token shape button, grid distance, and PF2e/SF2e support. |

The barrier visualizer's floor lighting is the Rust crate in `wasm/`, compiled to WebAssembly: `perception/floors.js` gathers the floors and barriers seen from a source and hands them to the module, on the main thread or in its workers (`floors-worker.js`). `npm run build:module` compiles it, which needs [Rust](https://rustup.rs) with the `wasm32-unknown-unknown` target (`rustup target add wasm32-unknown-unknown`). `cargo run --release --example bench --features profile -- <input>` in `wasm/` replays a captured input natively and times each step.

Each feature file or folder registers its own hooks and patches when imported. The exception is `f2e/`, which `main.js` imports only for PF2e and SF2e and starts with `initialize()`. The general settings are all in `scripts/setting.js`; the PF2e/SF2e settings are in `scripts/f2e/index.js`.

## Testing

The tests are kept in a separate repository, `f2e-grid-enhancements-tests`, placed beside this one. They run the module inside Foundry's real client code in Node; see that repository's README.

## Languages

- English

## AI Tools

- Claude Sonnet 5.5
- Claude Opus 5.5
