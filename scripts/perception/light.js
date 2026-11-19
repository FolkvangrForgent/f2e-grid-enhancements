// Core's tests for being lit or in darkness (EffectsCanvasGroup#testInsideLight and #testInsideDarkness: light
// perception, vision blinded by darkness, sources suppressing each other, region behaviors suppressed by light or darkness)
// use the source's drawn shape and a flat surface test, which miss wall heights, levels and barriers in 3D. Here the point
// must be within the source's reach in plan (its polygon without walls: radius, angle, other sources' edges) and vertically
// as core has it (a light without priority within its radius, a priority light or darkness at any height), and no barrier
// restricting the source's own type may stand between the source and the point, unless the source ignores walls.
import * as patch from '../helpers/patch.js';
import {isWasmReady} from '../helpers/wasm.js';
import {isBlocked} from '../raycast/index.js';
import {planPolygon} from '../raycast/sources.js';

const ROUNDING_TOLERANCE = 1e-8;

// Sources are left out: the source's polygon without walls is already cut by their edges.
function isBlockedFromSource(source, point, type) {
	const origin = {x: source.data.x, y: source.data.y, elevation: source.data.elevation ?? 0};
	const destination = {x: point.x, y: point.y, elevation: point.elevation ?? origin.elevation};
	return isBlocked(source.level?.parent ?? canvas.scene, origin, destination, {edgeRestrictionType: type, level: source.level, radius: source.radius, sources: false});
}

// Core's priority lights reach every height.
function isInLightReach(source, point) {
	if (!(source.data.priority > 0)) {
		const distanceZ = Math.abs((point.elevation ?? 0) - (source.data.elevation ?? 0)) * canvas.dimensions.distancePixels;
		if (distanceZ > source.data.radius + ROUNDING_TOLERANCE) return false;
	}
	return !!planPolygon(source)?.contains(point.x, point.y);
}

// Any height; a pixel either way counts, as core tests it.
function isInDarknessReach(source, point) {
	const polygon = planPolygon(source);
	if (!polygon) return false;
	for (let dx = -1; dx <= 1; dx++) {
		for (let dy = -1; dy <= 1; dy++) if (polygon.contains(point.x + dx, point.y + dy)) return true;
	}
	return false;
}

Hooks.once('init', () => {
	patch.add('foundry.canvas.sources.PointLightSource.prototype.testPoint', (wrapped, source, point) => {
		if (!isWasmReady()) return wrapped(point);
		if (!source.shape || !isInLightReach(source, point)) return false;
		return source.data.walls === false || !isBlockedFromSource(source, point, 'light');
	});
	patch.add('foundry.canvas.sources.PointDarknessSource.prototype.testPoint', (wrapped, source, point) => {
		if (!isWasmReady()) return wrapped(point);
		if (!source.shape || !isInDarknessReach(source, point)) return false;
		return source.data.walls === false || !isBlockedFromSource(source, point, 'darkness');
	});
});
