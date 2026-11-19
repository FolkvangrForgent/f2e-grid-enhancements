![](https://img.shields.io/badge/Foundry-v14-informational)
![Latest Release Download Count](https://img.shields.io/github/downloads/FolkvangrForgent/f2e-grid-enhancements/latest/module.zip)
![Forge Installs](https://img.shields.io/badge/dynamic/json?label=Forge%20Installs&query=package.installs&suffix=%25&url=https%3A%2F%2Fforge-vtt.com%2Fapi%2Fbazaar%2Fpackage%2Ff2e-grid-enhancements&colorB=4aa94a)

> **AI Disclaimer** - AI is used for code review and code generation.

# Grid Enhancements

This module adds various features to enhance the functionality of grids in various systems. A full list of features can be found below and in specific system pages. If you are looking for a particular feature or are having an issue please open up an `Issue`! This module also provides an [API](API.md) for macro or other module use.

## General Grid Enhancements

- Settings
    - (GM) New scene default grid type
    - (GM) New scene default level name
    - (GM) New scene default level top elevation
    - (GM) New scene default level bottom elevation
    - (GM) Wall elevation visualization toggle
- Walls
    - Configurable optional wall elevation
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
    - `Optimize Shapes` button
        - Replace the region's shapes with polygons tracing the area they cover
- Lighting
    - Wall elevation support
        - Basic visualization
- Move
    - Wall elevation support
        - Uses modules raycast for determining if a move can be done
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

## Barriers

A barrier is anything this module's raycast treats with a wall's rules, whether it stands upright or lies flat. The raycast decides what a token can see, hear and move through.

- Barrier source
    - Walls
    - Region surfaces
    - Region barriers (`Define Barrier` behavior) at the region's bottom, top and/or sides
- Barrier behavior
    - Retriction
        - None
        - Limited
        - Normal
        - Proximity (with or without threshold attenuation)
        - Reverse proximity (with or without threshold attenuation)
    - Direction
        - One way
        - Two way
- Barrier visualization (with the `Elevation Visualization` setting on)
    - Vision, light, darkness and the sound field are drawn from barriers, matching what the raycast decides
    - Every top/bottom barrier is a floor: at each point the floor shown is the highest one at or below the source, else the source's level floor
    - A floor is lit where a ray from the source reaches it; barriers between them cast shadows on it (shadows inside the lit area are holes, lit areas past a shadow are islands)

## Wall Elevation

This module adds optional support for wall elevation that can be enabled or disabled on a per wall per top/bottom basis. This wall height is ingested by the raycasting API provided by this module and the basic visualization. By default walls that don't have top and bottom elevations set do the following when being raycast against or providing visualization: For each level a wall exists in assume there is a wall that has its top and bottom elevation set to the top and bottom elevation of that level, if there are no levels a wall exists from -Infinity to Infinity.

### Visualization

With the `Elevation Visualization` setting on, vision, lighting, darkness and the sound field on the Sounds layer are drawn from barriers in 3D (see [Barriers](#barriers)) instead of core's flat wall sweep, using the walls of the source's level and the levels it sees. Core's sweep still applies the scene's bounds, the radius, the vision angle and other sources' edges.

## Languages

- English

## AI Tools

- Claude Sonnet 5.5
- Claude Opus 5.5
