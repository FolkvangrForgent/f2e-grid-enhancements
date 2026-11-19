import * as patch from '../helpers/patch.js';
import {levelConnectedIdentifiers} from '../helpers/scene.js';
import * as setting from '../helpers/setting.js';
import {isWasmReady} from '../helpers/wasm.js';
import {firstBlock} from '../raycast/index.js';
import {edgeTypeInclusion} from './collision.js';

function reinitializeVisionOnConnectedLevelWallChanges() {
	// Core only re-initializes vision when a wall changes on the viewed level; on a level that is merely visible it only
	// refreshes. Vision here includes walls from connected levels, so re-initialize it for those too.
	patch.add('CONFIG.Wall.documentClass.prototype._onEdgeChange', (wrapped, wall, level, newEdge, priorEdge, changedTypes) => {
		const result = wrapped(level, newEdge, priorEdge, changedTypes);
		if (setting.get('general.barrier-visualization') && changedTypes.has('sight') && level.isVisible && !level.isView) canvas.perception.update({initializeVision: true});
		return result;
	});
}

// While a token's drag preview has vision, the real token's vision is hidden so only the preview's shows.
function hideRealVisionDuringDragPreview() {
	patch.add('foundry.canvas.groups.CanvasVisibility.prototype.refreshVisibility', (wrapped, visibility, ...args) => {
		if (!setting.get('general.barrier-visualization')) return wrapped(...args);
		const hiddenRealSources = [];
		if (canvas.effects.visionSources) {
			for (const visionSource of canvas.effects.visionSources) {
				if (visionSource.isPreview) {
					const realVisionSource = canvas.effects.visionSources.get(visionSource.sourceId.replace(/\.preview$/, ''));
					if (realVisionSource !== undefined && realVisionSource !== visionSource && !Object.hasOwn(realVisionSource, 'hasActiveLayer')) {
						Object.defineProperty(realVisionSource, 'hasActiveLayer', {value: false, configurable: true});
						hiddenRealSources.push(realVisionSource);
					}
				}
			}
		}
		try {
			return wrapped(...args);
		} finally {
			for (const realVisionSource of hiddenRealSources) {
				delete realVisionSource.hasActiveLayer;
			}
		}
	});
}

function detectThroughRaycast() {
	// Core tests the point against the LOS polygon and the
	// surfaces of the viewer's level, then sweeps the stretch of the ray in the target's level; this casts one raycast
	// instead, so wall heights, levels, region surfaces and darkness sources count all along the ray, as for sound and
	// auras. Every core configuration is handled: one-way walls by edgeDirectionMode (pf2e's hearing uses REVERSED),
	// thresholds by useThreshold, and walls and darkness sources by edgeTypes and priority.
	patch.add('foundry.canvas.perception.DetectionMode._testCollision', (wrapped, DetectionMode, visionSource, test, configOrLos = {}) => {
		if (!isWasmReady()) return wrapped(visionSource, test, configOrLos);
		const los = configOrLos instanceof foundry.canvas.geometry.PointSourcePolygon ? configOrLos : null;
		const config = los?.config ?? configOrLos;
		const {origin, level} = visionSource;
		const destination = test.point;
		// Limited vision angle. Core skips this when given the LOS polygon (its containment test covers the angle); the
		// polygon is not used here, so it is always tested. Points within the external radius are never outside it.
		const {angle = 360, rotation = 0, externalRadius = 0} = config;
		if (angle < 360) {
			const dx = destination.x - origin.x;
			const dy = destination.y - origin.y;
			if (dx * dx + dy * dy > externalRadius * externalRadius) {
				if (angle <= 0) return true;
				const fieldStart = rotation + 90 - angle / 2;
				const pointAngle = Math.toDegrees(Math.atan2(dy, dx));
				if ((((pointAngle - fieldStart) % 360) + 360) % 360 > angle) return true;
			}
		}
		// the viewer's level, the levels it sees, and the target's level
		const activeLevels = levelConnectedIdentifiers(level, true);
		if (activeLevels && test.level) activeLevels.push(test.level.id);
		const type = config.type ?? visionSource.constructor.sourceType;
		// core sets the polygon's priority from the source (DetectionMode.#testCollision); source edges below it don't count
		const priority = config.priority ?? visionSource.priority ?? 0;
		const wallInclusion = edgeTypeInclusion(config.edgeTypes?.wall, -Infinity);
		const sourceInclusion = edgeTypeInclusion(config.edgeTypes?.source, priority);
		const blocker = firstBlock(level?.parent ?? canvas.scene, origin, destination, {
			edgeRestrictionType: type,
			edgeDirectionMode: config.edgeDirectionMode ?? CONST.EDGE_DIRECTION_MODES.NORMAL,
			activeLevels,
			externalRadius,
			radius: config.radius,
			useThreshold: config.useThreshold ?? true,
			sources: sourceInclusion.included,
			priority: sourceInclusion.priority ?? priority,
			hits: {walls: wallInclusion.included}
		});
		return blocker !== null;
	});
}

Hooks.once('init', () => {
	reinitializeVisionOnConnectedLevelWallChanges();
	hideRealVisionDuringDragPreview();
	// not tied to the visualization setting, like sound
	detectThroughRaycast();
});
