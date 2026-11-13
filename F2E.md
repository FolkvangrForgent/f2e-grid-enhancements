# Pathfinder2e & Starfinder2e - Grid Enhancements

**WARNING** - This intergration uses a lot of function patching and so it may break if FoundryVTT or the systems update.

## Features

### General Improvements

- Regions
    - `point` region that is a single grid unit increment
    - `cone` internal angle and template mode snapping angle can be configured
    - `line` in template mode selects a correct number of spaces for non wide lines
- Settings
    - (GM) `cone` internal angle can be configured for all grid types
    - (GM) `cone` snapping angle can be configured for all grid types
    - (GM) Default reach exception toggle
    - (GM) Aura highlight wall collision toggle
    - (GM) Disable auras on defeated creatures
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
    - [experimental] Custom `onOppositeSides` function logic for flanking that allows overriding the default logic to instead compare the intersection angles of center to center lines in 3D with a ellipsoid representation of the flankee
- Auras
    - Only activate on grids with units of `'ft'`, `'feet'`, or `''`
    - Custom aura `containsToken` function
        - Supports [Wall Elevation](README.md)
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
    - Additional tiny token snap points
- Auras
    - Support via extending system implementation

### Square Improvements

### Gridless Improvements

- Tokens
    - Reach enforcement support
- Auras
    - Support via extending system implementation

## Not implemented

### Difficult Terrain

I have taken a quick look at difficult terrain but at the point where it can produces unsatisfactory results even on square grids and it was not a simple fix to extend to other grid types I have not worked on it. I am open to suggestions on how to make it work or any MR/PR that is submitted.

### Flanking

This modules provides a compendium with an `Off Guard Toggle (Feat)` and an `Off Guard Toggle (Effect)`. These can be given to Players (feat/effect) and NPCs (effect). Combined with disabling the `Flanking Detection` automation this is a useable way to do flanking. In addition there is now an experimental flanking logic override, I still don't know if this will produce acceptable results.
