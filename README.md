![](https://img.shields.io/badge/Foundry-v14-informational)
![Latest Release Download Count](https://img.shields.io/github/downloads/FolkvangrForgent/f2e-grid-enhancements/latest/module.zip)
![Forge Installs](https://img.shields.io/badge/dynamic/json?label=Forge%20Installs&query=package.installs&suffix=%25&url=https%3A%2F%2Fforge-vtt.com%2Fapi%2Fbazaar%2Fpackage%2Ff2e-grid-enhancements&colorB=4aa94a)

> **AI Disclaimer** - AI is used to review the code for bugs. This module was mostly coded by a human (`gridlessGJKDistance` and it's functions were written by AI for girdless ellipsoid distance support).

# FolkvangrForgent - Grid Enhancements

This module adds various features to enhance the functionality of grids in various systems. A full list of features can be found below and in specific system pages. If you are looking for a particular feature or are having an issue please open up an `Issue`! This module also provides an [API](API.md) for macro or other module use.

## General Grid Enhancements

- Settings
    - (GM) New scene default grid type
    - (GM) New scene default level name
    - (GM) New scene default level top elevation
    - (GM) New scene default level bottom elevation
- Walls
    - Configurable optional wall elevation (See details below)

## Specific Grid Enhancements

- [Pathfinder2e (PF2e)](F2E.md)
- [Starfinder2e (SF2e)](F2E.md)

## Languages

- English

## Wall Elevation

This module adds optional support for wall elevation that can be enabled or disabled on a per wall per top/bottom basis. This wall height is ingested by the raycasting API provided by this module. By default walls that don't have top and bottom elevations set do the following when being raycast against: For each level a wall exists in assume there is a wall that has it's top and bottom elevation set to the top and bottom elevation of that level, if there are no levels a wall exists from -Infinity to Infinity.
