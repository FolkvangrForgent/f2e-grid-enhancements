// Movement collision through raycast: barriers (walls with heights, at the elevation the token crosses them, and region
// barriers, core's surfaces and this module's Define Barrier) and levels decide where a token's movement is stopped,
// instead of core's flat sweep. Movement is never drawn, so no sweep polygon is needed for it.
import {levelConnectedIdentifiers} from '../helpers/level.js';
import * as patch from '../helpers/patch.js';
import * as raycast from '../raycast/index.js';

// Register the patches. Called from elevation/index.js in its init hook.
export function initialize() {
	// Collision testing for the move type (Token#constrainMovementPath and Token#checkCollision); other types go to core.
	// The modes answer as core's do: any, a boolean; closest, the nearest collision or null; all, every collision, nearest
	// first. Collisions are PolygonVertex points with `_distance` the fraction of the way along, as core gives them.
	patch.add('CONFIG.Canvas.polygonBackends.move.testCollision', (wrapped, polygonClass, origin, destination, config = {}) => {
		const {mode = 'all', tMin = 0, tMax = 1, type, level} = config;
		const originElevation = origin.elevation ?? destination.elevation;
		if (type !== 'move' || typeof originElevation !== 'number') return wrapped(origin, destination, config);
		// core measures between whole pixels
		const from = {x: Math.round(origin.x), y: Math.round(origin.y), elevation: originElevation};
		const to = {x: Math.round(destination.x), y: Math.round(destination.y), elevation: destination.elevation ?? originElevation};
		const scene = level?.parent ?? canvas.scene;
		const hits = raycast.raycast(scene, from, to, {
			edgeRestrictionType: 'move',
			edgeDirectionMode: config.edgeDirectionMode ?? CONST.EDGE_DIRECTION_MODES.NORMAL,
			externalRadius: config.externalRadius ?? 0,
			stop: mode !== 'all',
			activeLevels: levelConnectedIdentifiers(level, true),
			range: {min: tMin, max: tMax},
			// tokens and levels never stop movement here; core tests its own surfaces separately (with the token's head and feet)
			hits: {tokens: false, levels: false, sources: false}
		});
		// core leaves out a crossing exactly at tMin
		const collisions = hits.filter(hit => hit.blocking && hit.t > tMin);
		if (mode === 'any') return collisions.length > 0;
		const vertices = collisions.map(hit => foundry.canvas.geometry.edges.PolygonVertex.fromPoint(hit.point, {distance: hit.t}));
		return mode === 'closest' ? (vertices[0] ?? null) : vertices;
	});
}
