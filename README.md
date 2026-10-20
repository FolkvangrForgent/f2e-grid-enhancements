![](https://img.shields.io/badge/Foundry-v14-informational)
![Latest Release Download Count](https://img.shields.io/github/downloads/FolkvangrForgent/f2e-grid-enhancements/latest/module.zip)
![Forge Installs](https://img.shields.io/badge/dynamic/json?label=Forge%20Installs&query=package.installs&suffix=%25&url=https%3A%2F%2Fforge-vtt.com%2Fapi%2Fbazaar%2Fpackage%2Ff2e-grid-enhancements&colorB=4aa94a)

# PF2e & SF2e - Grid Enhancements

This module aims to enhance the use of grids while using the PF2e and SF2e systems. A full list of features can be found below. If you are looking for a particular feature or are having an issue please open up an `Issue`!

**WARNING** - This module uses a lot of function patching and so it may break if FoundryVTT or the SF2e or PF2e systems update. This module is currently strictly a FVTT V14 module.

## Features

### General Improvements

- Scene Region
    - `point` region that is a single grid unit increment
    - `cone` internal angle and template mode snapping angle can be configured
- Settings
    - (GM) `cone` internal angle can be configured for all default grid types
    - (GM) `cone` snapping angle can be configured for all default grid types
    - (GM) Default new grid type
    - (GM) Disable default reach exception
    - [experimental] (GM) Flanking logic overrides and related setting
- Chat Template
    - Snapping
        - Origin
            - `point` snaps to centers
            - `emanation` snaps to centers or vertices
            - `burst` snaps to vertices
            - `cone` snaps to centers or midpoints or vertices
            - `line` snaps to midpoints or vertices
        - Angle
            - `cone` internal angle and snapping angle can be configured
- Token
    - Custom `distanceTo` function with support for token depth, all token shapes, and all default grid types
        - Rounds results to nearest tenth
    - [experimental] Custom `onOppositeSides` function logic for flanking that allows overriding the default logic to instead compare the intersection angles of center to center lines in 3D with a ellipsoid representation of the flankee
- Aura
    - Only activate on grids with units of 'ft'
    - Custom aura `containsToken` function
    - Use an algorithm that is often more permissive than the system algorithm
        - Determine if a token is in range of the token emitting an aura
        - Generate a shell of points on the token the aura may be affecting (constraining these by walls of the auras type)
        - Check from the center of the token emitting the aura to shell points around the token if any do not collide then the aura is applied
- Compendium
    - Custom feat and effect for manual toggle if target is off guard

### Hex Improvements

- Token
    - Reach enforcement support
- Aura
    - Support aura via extending system implementation
        - Trapezoid or Rectangle token shapes larger than 2x2 are not currently supported visually but will otherwise work


### Square Improvements

- Aura
    - More accurate border shape

### Gridless Improvements

- Token
    - Reach enforcement support
- Aura
    - Support aura via extending system implementation
    - More accurate border shape

### Languages

- English

- Polish

## Not implemented

### Difficult Terrain

I have taken a quick look at difficult terrain but at the point where it can produces unsatisfactory results even on square grids and it was not a simple fix to extend to other grid types I have not worked on it. I am open to suggestions on how to make it work or any MR/PR that is submitted.

### Flanking

This modules provides a compendium with an `Off Guard Toggle (Feat)` and an `Off Guard Toggle (Effect)`. These can be given to Players (feat/effect) and NPCs (effect). Combined with disabling the `Flanking Detection` automation this is a useable way to do flanking. In addition there is now an experimental flanking logic override, I still don't know if this will produce acceptable results.