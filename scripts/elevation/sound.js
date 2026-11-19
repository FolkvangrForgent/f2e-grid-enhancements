// Sound through raycast: walls with heights, levels and region surfaces decide whether a listener hears a sound and
// whether it is muffled, instead of core's flat sweep polygon and single-level surface test.
import {levelConnectedIdentifiers} from '../helpers/level.js';
import * as patch from '../helpers/patch.js';
import * as raycast from '../raycast/index.js';

// Whether something blocks sound between a sound source and a point. The ray starts at the source, so proximity walls are
// judged from the source, as core's sound polygon does. Only the source's level and the levels visible from it count.
function isSoundBlocked(source, point) {
	const level = source.level;
	const activeLevels = levelConnectedIdentifiers(level, true);
	const hits = raycast.raycast(level?.parent ?? canvas.scene, source.origin, point, {
		edgeRestrictionType: 'sound',
		stop: true,
		activeLevels,
		radius: source.data.radius,
		hits: {tokens: false, levels: false}
	});
	return hits.some(hit => hit.blocking);
}

// Register the patches. Called from elevation/index.js in its init hook.
export function initialize() {
	// Is a point inside the sound source? Used by core's getVolumeMultiplier to decide audibility. Replaces the sweep
	// polygon containment and the surface collision test of BaseEffectSource#testPoint.
	patch.add('foundry.canvas.sources.PointSoundSource.prototype.testPoint', (wrapped, source, point) => {
		if (!source.shape) return false;
		const {elevation, radius} = source.data;
		const distanceZ = Math.abs((point.elevation ?? 0) - elevation) * canvas.dimensions.distancePixels;
		if (distanceZ > radius + 1e-8) return false;
		// the shape is the plain radius circle (see _createShapes below); radius 0 when disabled or suppressed
		if (!source.shape.contains(point.x, point.y)) return false;
		if (!source.data.walls) return true;
		return !isSoundBlocked(source, point);
	});

	// A sound source's shape is only a radius circle: audibility and muffling come from the raycast, so the sweep polygon
	// core would compute on every initialization (moves, wall and door changes, darkness changes) is not needed.
	patch.add('foundry.canvas.sources.PointSoundSource.prototype._createShapes', (wrapped, source) => {
		source._deleteEdges();
		const radius = source.data.disabled || source.suppressed ? 0 : source.radius;
		source.shape = new PIXI.Circle(source.origin.x, source.origin.y, radius);
	});

	// The sound's field on the Sounds layer still shows core's wall-clipped area. The sweep for it is computed only when
	// the field is drawn, which core does only while the Sounds layer is active (on activation and on re-initialization).
	patch.add('CONFIG.AmbientSound.objectClass.prototype._refreshField', (wrapped, sound) => {
		const source = sound.source;
		if (!source?.shape || !sound.layer?.active) {
			sound.field.clear();
			return;
		}
		const circle = source.shape;
		source.shape = source._getPolygonBackend().create(source.origin, source._getPolygonConfiguration());
		try {
			return wrapped();
		} finally {
			source.shape = circle;
		}
	});

	// Is an audible sound muffled? Core only muffles sounds that are not constrained by walls (`walls: false`), using the
	// sweep polygon and a surface test on the viewed level; this uses the same raycast as audibility.
	patch.add('foundry.canvas.layers.SoundsLayer.prototype._configurePlayback', (wrapped, layer, config) => {
		const {source, walls, listener} = config;
		const isExact = listener && listener.x === source.x && listener.y === source.y && listener.elevation === source.elevation;
		if (!listener || walls || isExact) return wrapped(config);
		config.muffled = isSoundBlocked(source, listener);
	});
}
