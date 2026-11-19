// The grid spaces a token occupies and the points tested for it being in a region are those its movement origin reaches.
// Core tests each against a flat movement sweep from the origin and a surface test; this uses the 3D raycast, as movement does.
import * as patch from '../helpers/patch.js';
import {isWasmReady} from '../helpers/wasm.js';
import {isBlocked} from '../raycast/index.js';

const isReachedFromOrigin = (scene, level, origin, point) => !isBlocked(scene, origin, {x: point.x, y: point.y, elevation: point.elevation ?? origin.elevation}, {edgeRestrictionType: 'move', level});

const isOutsideScene = (scene, origin) => origin.x < 0 || origin.x > scene.dimensions.width || origin.y < 0 || origin.y > scene.dimensions.height;

Hooks.once('init', () => {
	// The spaces the token's shape covers (core's, with no level so it tests none), then those reached: a space is when its
	// center or a point halfway to each corner, at a quarter, half or three quarters of a space up, is, as core samples it.
	// None reached leaves the origin's space; an origin outside the scene, none.
	patch.add('CONFIG.Token.documentClass.prototype.getOccupiedGridSpaceOffsets', (wrapped, token, data = {}) => {
		const scene = token.parent;
		const grid = scene?.grid;
		const level = scene?.levels.get('level' in data ? data.level : token.level);
		if (!isWasmReady() || !grid || grid.isGridless || !level) return wrapped(data);
		const origin = token.getMovementOrigin(data);
		if (isOutsideScene(scene, origin)) return [];
		const sampleOffsets = [{x: 0, y: 0, elevation: grid.distance * 0.5}];
		for (const vertex of grid.getShape()) {
			sampleOffsets.push({x: vertex.x * 0.5, y: vertex.y * 0.5, elevation: grid.distance * 0.25}, {x: vertex.x * 0.5, y: vertex.y * 0.5, elevation: grid.distance * 0.75});
		}
		const reached = wrapped({...data, level: null}).filter(offset => {
			const center = grid.getCenterPoint(offset);
			return sampleOffsets.some(sample => isReachedFromOrigin(scene, level, origin, {x: center.x + sample.x, y: center.y + sample.y, elevation: center.elevation + sample.elevation}));
		});
		return reached.length ? reached : [grid.getOffset(origin)];
	});

	// Filters in place; none reached leaves the origin as the only one.
	patch.add('CONFIG.Token.documentClass.prototype._constrainTestPoints', (wrapped, token, points, data = {}) => {
		const scene = token.parent;
		const level = scene?.levels.get('level' in data ? data.level : token.level);
		if (!isWasmReady() || !level) return wrapped(points, data);
		const origin = token.getMovementOrigin(data);
		const [firstPoint] = points;
		const isOnlyTheOrigin = points.length === 1 && firstPoint.x === origin.x && firstPoint.y === origin.y && (firstPoint.elevation === undefined || firstPoint.elevation === origin.elevation);
		if (isOnlyTheOrigin) return;
		if (isOutsideScene(scene, origin)) {
			points.length = 0;
			points.push(origin);
			return;
		}
		for (let index = points.length - 1; index >= 0; index--) {
			if (isReachedFromOrigin(scene, level, origin, points[index])) continue;
			points[index] = points[points.length - 1];
			points.length--;
		}
		if (!points.length) points.push(origin);
	});
});
