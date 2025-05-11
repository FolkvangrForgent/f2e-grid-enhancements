![](https://img.shields.io/badge/Foundry-v13-informational)
![Latest Release Download Count](https://img.shields.io/github/downloads/FolkvangrForgent/f2e-grid-enhancements/latest/module.zip)
![Forge Installs](https://img.shields.io/badge/dynamic/json?label=Forge%20Installs&query=package.installs&suffix=%25&url=https%3A%2F%2Fforge-vtt.com%2Fapi%2Fbazaar%2Fpackage%2Ff2e-grid-enhancements&colorB=4aa94a)

# PF2e & SF2e - Grid Enhancements

This module aims to enhance the use of grids while using the PF2e and SF2e system. A full list of features can be found below. If you are looking for a particular feature or are having an issue please open up an `Issue`!

**WARNING** - This module uses a lot of function patching and so it is suggested to run it on the exact version of FoundryVTT and SF2e or PF2e that it is verified on.

## Known issue

Waiting for FVTT 13 Stable 3 to fix https://github.com/foundryvtt/foundryvtt/issues/12761 until then there will be issues using the Custom Template Measurement Controls just after refresh. Just press the buttons a few times and the problem should resolve itself.

## Features

### General Improvements

- Custom Template Measurement Controls for shapes that exist in pf2e rules `square`/`hex`/`point`, `emanation`, `burst`, `cone`, and `line`
- Custom Rendering of Measurment Templates and ruler text to make them cleaner
    - `emanation`, `burst`, and `cone` display ruler text next to the origin of the template and doesn't display destination point
    - `square`/`hex`/`point` does not display ruler text and doesn't display destination point
    - `line` ruler text contains width if it is larger than a grid unit
- Settings
    - (GM) `cone` internal angle can be configured for all grid types

### Hex Improvements

- Template
    - Snapping
        - Origin
            - `hex` snaps to centers
            - `emanation` snaps to centers or vertices
            - `burst` snaps to vertices
            - `cone` snaps to centers or midpoints or vertices
            - `line` doesn't snap
        - Angle
            - `cone` snaps to 30 degree increments when placing
            - `Shift` + `MouseWheel` will rotate placed templates in 30 degree increments
        - Distance
            - `hex` only highlights a single hex
            - `emanation`,`burst`,`cone`, and `line` snap to grid unit increments
    - Highlighting
        - Custom `line` algorithm
            - More accurate than default behavior but not without issues subject to later improvement
        - Improved preview rendering
    - Rendering
        - `line` additionally renders as a line
    - Emulate `gridTemplates` behavior
- Token
    - Custom `distanceTo` function for correct range calculation between tokens

### Gridless Improvements

- Token
    - Custom ellipse shape for token that rotates with the token

### Languages

- English

## Not implemented

### Auras

I am waiting on pf2e system support for extending the aura system. If they still refuse to accept my MR I will look into alternative ways to support auras. At this point it is looking more likely that I will be required to dynamically catch the relevant objects but that's alot of work.

### Flanking

I have no current intention to implement a custom flanking detector for hex or gridless as I don't have a generalized solution in mind yet, although I may work on a more hardcoded solution. It is possible to still use the system flanking detector on non square grids to mixed results. I personally have turned off said automation and instead give PCs a custom feat that adds a `Target is Off Guard` toggle the player can check and given NPCs a custom effect that does the same.

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