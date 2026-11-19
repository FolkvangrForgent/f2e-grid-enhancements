import * as patch from '../helpers/patch.js';
import {isWasmReady} from '../helpers/wasm.js';
import {isBlocked} from '../raycast/index.js';

const ROUNDING_TOLERANCE = 1e-8;

// The ray starts at the source, so proximity walls are judged from it, as core's sound polygon does.
const isSoundBlocked = (source, point) => isBlocked(source.level?.parent ?? canvas.scene, source.origin, point, {edgeRestrictionType: 'sound', level: source.level, radius: source.data.radius});

Hooks.once('init', () => {
	// Decides audibility in core's getVolumeMultiplier.
	patch.add('foundry.canvas.sources.PointSoundSource.prototype.testPoint', (wrapped, source, point) => {
		if (!isWasmReady()) return wrapped(point);
		if (!source.shape) return false;
		const {elevation, radius} = source.data;
		const distanceZ = Math.abs((point.elevation ?? 0) - elevation) * canvas.dimensions.distancePixels;
		if (distanceZ > radius + ROUNDING_TOLERANCE) return false;
		// the shape is the plain radius circle (see _createShapes below); radius 0 when disabled or suppressed
		if (!source.shape.contains(point.x, point.y)) return false;
		if (!source.data.walls) return true;
		return !isSoundBlocked(source, point);
	});

	// A sound source's shape is only a radius circle: audibility and muffling come from the raycast, so the sweep polygon
	// core would compute on every initialization (moves, wall and door changes, darkness changes) is not needed.
	patch.add('foundry.canvas.sources.PointSoundSource.prototype._createShapes', (wrapped, source) => {
		if (!isWasmReady()) return wrapped();
		source._deleteEdges();
		const radius = source.data.disabled || source.suppressed ? 0 : source.radius;
		source.shape = new PIXI.Circle(source.origin.x, source.origin.y, radius);
	});

	// The sound's field on the Sounds layer still shows core's wall-clipped area. The sweep for it is computed only when
	// the field is drawn, which core does only while the Sounds layer is active (on activation and on re-initialization).
	patch.add('CONFIG.AmbientSound.objectClass.prototype._refreshField', (wrapped, sound) => {
		const source = sound.source;
		if (!isWasmReady()) return wrapped();
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

	// Core only muffles sounds not constrained by walls, using the sweep polygon and a surface test on the viewed level.
	patch.add('foundry.canvas.layers.SoundsLayer.prototype._configurePlayback', (wrapped, layer, config) => {
		const {source, walls, listener} = config;
		const isListenerAtSource = listener && listener.x === source.x && listener.y === source.y && listener.elevation === source.elevation;
		if (!isWasmReady() || !listener || walls || isListenerAtSource) return wrapped(config);
		config.muffled = isSoundBlocked(source, listener);
	});
});
