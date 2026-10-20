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
    - Use an algorithm that is often more permissive than the system algorithm
        - Determine if a token is in range of the token emitting an aura
        - Generate a shell of points on the token the aura may be affecting (constraining these by walls of the auras type)
        - Check from the center of the token emitting the aura to shell points around the token if any do not collide then the aura is applied

### Hex Improvements

- Token
    - Reach enforcement support
- Aura
    - Support aura via extending system implementation
        - Trapezoid or Rectangle token shapes larger than 2x2 are not currently supported visually but will otherwise work
    - Custom aura `containsToken` function


### Square Improvements

- Aura
    - Custom aura `containsToken` function
    - More accurate border shape

### Gridless Improvements

- Token
    - Reach enforcement support
- Aura
    - Support aura via extending system implementation
    - Custom aura `containsToken` function
    - More accurate border shape

### Languages

- English

- Polish

## Not implemented

### Difficult Terrain

I have taken a quick look at difficult terrain but at the point where it can produces unsatisfactory results even on square grids and it was not a simple fix to extend to other grid types I have not worked on it. I am open to suggestions on how to make it work or any MR/PR that is submitted.

### Flanking

There is now an experimental flanking logic override. I still don't know if this will produce acceptable results. It is still possible to use a more manual solution by turning off the `Flanking Detection` automation and instead give PCs a custom feat that adds a `Target is Off Guard` toggle the player can check and given NPCs a custom effect that does the same.

#### Feat

Create a new feat, adding the following Rule Elements before adding it to the bonus feat section of all PCs. I highly suggest naming the feat.

##### RollOption
`{"key":"RollOption","domain":"all","option":"off-guard","label":"Target is Off Guard","toggleable":true}`

##### EphemeralEffect
`{"key":"EphemeralEffect","predicate":["off-guard"],"selectors":["strike-attack-roll","spell-attack-roll","strike-damage","attack-spell-damage"],"uuid":"Compendium.pf2e.conditionitems.Item.AJh5ex99aV6VTggg"}`

#### Effect

Create a new effect, adding the following Rule Element. You will have to remember to drop this on each NPC to add the toggle. I highly suggest naming the effect and unchecking the `Show token icon?` button to hide it from appearing.

##### RollOption
`{"key":"RollOption","domain":"all","option":"off-guard","label":"Target is Off Guard","toggleable":true}`

##### EphemeralEffect
`{"key":"EphemeralEffect","predicate":["off-guard"],"selectors":["strike-attack-roll","spell-attack-roll","strike-damage","attack-spell-damage"],"uuid":"Compendium.pf2e.conditionitems.Item.AJh5ex99aV6VTggg"}`
