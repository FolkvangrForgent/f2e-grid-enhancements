// 3D raycast over walls, regions, tokens, levels and light/darkness sources, backed by a BVH per scene. API.md documents
// the options and hits.
//
// Exact ties: anything exactly at the ray's elevation is settled by `elevationBias`, the ray lying a hair above it
// ('above') or below it ('below') all along, so A -> B and B -> A agree. An inclusive region top reaches a hair above
// that. A point exactly on an outline is moved a hair along the ray, then a smaller hair to its positive side.
// Crossings exactly at the start of the tested range are left out; those exactly at its end are kept.

import {installHooks} from './scene-index.js';

export {raycast} from './query.js';

Hooks.once('init', installHooks);
