// PointSourcePolygon.testCollision serves token movement (Token#constrainMovementPath, Token#checkCollision) and anything
// else asking a polygon backend. Core's defaults are kept: walls count unless the config's edgeTypes leaves them out,
// sources only for sight, light and darkness, at the config's priority, and thresholds only with useThreshold.
import * as patch from '../helpers/patch.js';
import {TYPES} from '../helpers/types.js';
import {isWasmReady} from '../helpers/wasm.js';
import {blocks} from '../raycast/index.js';

// ClockwiseSweepPolygon#_determineEdgeTypes
const TYPES_INCLUDING_SOURCE_EDGES_BY_DEFAULT = new Set(['sight', 'light', 'darkness']);

// As ClockwiseSweepPolygon#_determineEdgeTypes: left out, the type's default; true includes it; false or mode 0 leaves it out.
export function edgeTypeInclusion(entry, fallbackPriority, includedByDefault = true) {
	if (entry === undefined) return includedByDefault ? {included: true, priority: fallbackPriority} : {included: false};
	if (entry === true) return {included: true, priority: fallbackPriority};
	if (!entry) return {included: false};
	const mode = entry.mode ?? 1;
	if (mode === 0) return {included: false};
	// mode 2 includes every edge of the type whatever its priority
	return {included: true, priority: mode === 2 ? -Infinity : (entry.priority ?? fallbackPriority)};
}

// A crossing exactly at tMin is left out, as core does.
function collisionsOf(scene, from, to, config, stop) {
	const {type, tMin = 0, tMax = 1, level} = config;
	const wallInclusion = edgeTypeInclusion(config.edgeTypes?.wall, -Infinity);
	const sourceInclusion = edgeTypeInclusion(config.edgeTypes?.source, config.priority ?? 0, TYPES_INCLUDING_SOURCE_EDGES_BY_DEFAULT.has(type));
	return blocks(scene, from, to, {
		edgeRestrictionType: type,
		edgeDirectionMode: config.edgeDirectionMode ?? CONST.EDGE_DIRECTION_MODES.NORMAL,
		externalRadius: config.externalRadius ?? 0,
		radius: config.radius,
		useThreshold: config.useThreshold ?? false,
		stop,
		level,
		range: {min: tMin, max: tMax},
		hits: {walls: wallInclusion.included},
		sources: sourceInclusion.included,
		priority: sourceInclusion.priority
	}).filter(collision => collision.t > tMin);
}

Hooks.once('init', () => {
	// The modes answer as core's do: any, a boolean; closest, the nearest collision or null; all, every collision, nearest
	// first. Collisions are PolygonVertex points with `_distance` the fraction of the way along, as core gives them. Every
	// type's backend is the same class unless a system replaces one, so each distinct backend is patched once.
	const patchedBackends = new Set();
	for (const type of TYPES) {
		const backend = CONFIG.Canvas.polygonBackends[type];
		if (!backend || patchedBackends.has(backend)) continue;
		patchedBackends.add(backend);
		patch.add(`CONFIG.Canvas.polygonBackends.${type}.testCollision`, (wrapped, polygonClass, origin, destination, config = {}) => {
			const {mode = 'all', type: rayType, level} = config;
			const originElevation = origin.elevation ?? destination.elevation;
			if (!isWasmReady() || !TYPES.includes(rayType) || typeof originElevation !== 'number') return wrapped(origin, destination, config);
			// core measures between whole pixels
			const from = {x: Math.round(origin.x), y: Math.round(origin.y), elevation: originElevation};
			const to = {x: Math.round(destination.x), y: Math.round(destination.y), elevation: destination.elevation ?? originElevation};
			const collisions = collisionsOf(level?.parent ?? canvas.scene, from, to, config, mode !== 'all');
			if (mode === 'any') return collisions.length > 0;
			const vertices = collisions.map(collision => foundry.canvas.geometry.edges.PolygonVertex.fromPoint(collision.point, {distance: collision.t}));
			return mode === 'closest' ? (vertices[0] ?? null) : vertices;
		});
	}
});
