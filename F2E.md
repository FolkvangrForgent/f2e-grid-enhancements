# Pathfinder2e & Starfinder2e - Grid Enhancements

**WARNING** - This integration uses a lot of function patching and so it may break if FoundryVTT or the systems update.

## Features

### General Improvements

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
- Auras
    - Accurate shape border
    - Accurate shape textures
    - Accurate shape highlight
    - Custom `containsToken` function
        - Supports [Wall Elevation](README.md#wall-elevation)
        - Visual auras are blocked by sight walls
        - Auditory auras are blocked by sound walls
        - Other auras are blocked by movement walls
        - Algorithm overview
            - Determine if a token is in range of the token emitting an aura
            - Generate a shell of points on the token the aura may be affecting, constraining these by barriers
            - Check from the center of the token emitting the aura to shell points around the token, if any do not collide then the aura is applied
    - Only activate on grids with units of `'ft'`, `'feet'`, or `''` (`'meter'` or `'m'` are also supported but grid units are unaffected)
- Compendiums
    - Custom feat and effect for manual toggle if target is off guard
- Regions
    - `cone` internal angle can be configured for all grid types
    - `cone` snapping angle can be configured for all grid types
- Settings
    - (GM) `cone` internal angle can be configured for all grid types
    - (GM) `cone` snapping angle can be configured for all grid types
    - (GM) Default reach exception toggle
    - (GM) Disable auras on defeated creatures
- Tokens
    - Custom `distanceTo` function with support for all shapes and grids
    - Dimension (Width, Height, and Depth) enforcement on creation or resizing
        - Whole numbers or 1/2 for tokens below 3/4 for hex and square maps
        - At least 1/2 for gridless maps

### Hex Improvements

- Auras
    - Support via extending system implementation
- Tokens
    - Reach enforcement support
        - Support via extending system implementation
    - Additional tiny token snap points

### Square Improvements

### Gridless Improvements

- Auras
    - Support via extending system implementation
- Tokens
    - Reach enforcement support
        - Support via extending system implementation

## Not implemented

### Difficult Terrain

I have taken a quick look at difficult terrain but at the point where it can produces unsatisfactory results even on square grids and it was not a simple fix to extend to other grid types I have not worked on it. I am open to suggestions on how to make it work or any MR/PR that is submitted.

### Flanking

This modules provides a compendium with an `Off Guard Toggle (Feat)` and an `Off Guard Toggle (Effect)`. These can be given to Players (feat/effect) and NPCs (effect). Combined with disabling the `Flanking Detection` automation this is a useable way to do flanking.
