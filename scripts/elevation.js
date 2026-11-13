import * as patch from './patch.js';
import * as setting from './setting.js';

function wallSpans(wall) {
	const doc = wall.document ?? wall;
	const flags = doc.flags?.['f2e-grid-enhancements'];
	const levels = [...(doc.levels ?? [])].map(id => canvas.scene?.levels.get(id)).filter(Boolean);
	const read = (key, unset, fallback) => {
		const value = flags?.[`${key}-enabled`] ? flags[`${key}-elevation`] ?? unset : null;
		const text = (typeof value === 'string') ? value.trim() : value;
		const number = ((text ?? '') === '') ? NaN : Number(text);
		return Number.isNaN(number) ? fallback : number;
	};
	const spans = new Map();
	for ( const level of (levels.length ? levels : [null]) ) {
		const top = read('top', Infinity, level?.elevation?.top ?? Infinity);
		const bottom = read('bottom', -Infinity, level?.elevation?.bottom ?? -Infinity);
		if ( top > bottom ) spans.set(`${bottom},${top}`, { bottom, top });
	}
	return [...spans.values()];
}

function wallBlocks(edge, elevation) {
	const doc = edge.object;
	if ( doc?.documentName !== 'Wall' || !Number.isFinite(elevation) ) return true;
	return wallSpans(doc).some(({ top, bottom }) => elevation >= bottom && elevation < top);
}

function connectedLevels(level) {
	return [...(level?.visibility?.levels ?? [])]
		.map(id => (typeof id === 'string') ? canvas.scene.levels.get(id) : id)
		.filter(seen => seen && (seen !== level));
}

function patchSweep() {
	patch.add('foundry.canvas.geometry.ClockwiseSweepPolygon.prototype._identifyEdges', (wrapped, self, ...args) => {
		const result = wrapped(...args);
		try {
			const bounds = self.config?.boundingBox ?? self._defineBoundingBox();
			const collisionTest = edge => self._testEdgeInclusion(edge, self._edgeTypes);
			const knownEdgeIds = new Set([...self.edges].map(edge => edge.id).filter(id => id !== undefined));
			for (const level of connectedLevels(self.level)) {
				const edges = level.edges.getEdges(bounds, {
					includeOuterBounds: !self.useInnerBounds,
					includeInnerBounds: self.useInnerBounds,
					collisionTest
				});
				for (const edge of edges) {
					if (!edge.object || knownEdgeIds.has(edge.id)) continue;
					self.edges.add(edge.clone());
					if (edge.id !== undefined) knownEdgeIds.add(edge.id);
				}
			}
			const elevation = self.origin?.elevation ?? 0;
			if ( Number.isFinite(elevation) ) {
				for ( const edge of [...self.edges] ) {
					if ( !wallBlocks(edge, elevation) ) self.edges.delete(edge);
				}
			}
		} catch (error) {
			console.warn(error);
		}
		return result;
	});
}

function patchThresholdAttenuation() {
	patch.add('foundry.canvas.geometry.PointSourcePolygon.applyThresholdAttenuation', (wrapped, self, polygon) => {
		const { config, origin } = polygon;
		const level = config?.level;
		const levels = [level, ...connectedLevels(level)];
		if ( !config?.useThreshold || levels.length < 2 ) return wrapped(polygon);

		const edges = {
			getEdges: (...args) => new Set(
				levels.flatMap(l => [...l.edges.getEdges(...args)]).filter(edge => wallBlocks(edge, origin?.elevation))
			)
		};
		config.level = new Proxy(level, {
			get: (target, key) => (key === 'edges') ? edges : Reflect.get(target, key, target)
		});
		try {
			return wrapped(polygon);
		} finally {
			config.level = level;
		}
	});
}

function patchDragPreviewVision() {
	patch.add('foundry.canvas.groups.CanvasVisibility.prototype.refreshVisibility', (wrapped, visibility, ...args) => {
		const hiddenVisionSource = [];
		if ( canvas.effects.visionSources ) {
			for ( const visionSource of canvas.effects.visionSources ) {
				if ( visionSource.isPreview ) {
					const realVisionSource = canvas.effects.visionSources.get(visionSource.sourceId.replace(/\.preview$/, ''));
					if (realVisionSource !== undefined && realVisionSource !== visionSource && !Object.hasOwn(realVisionSource, 'hasActiveLayer')) {
						Object.defineProperty(realVisionSource, 'hasActiveLayer', { value: false, configurable: true });
						hiddenVisionSource.push(realVisionSource);
					}
				}
			}
		}
		try {
			return wrapped(...args);
		} finally {
			for ( const realVisionSource of hiddenVisionSource ) {
				delete realVisionSource.hasActiveLayer;
			}
		}
	});
}

function registerRefreshHooks() {
	const refresh = ({ vision, lighting, sounds }) => {
		if ( vision || lighting || sounds ) {
			canvas.perception.update({
				initializeVision: vision,
				initializeLighting: lighting,
				initializeSounds: sounds
			});
		}
	};
	Hooks.on('updateWall', (wall, changes) => {
		if ( foundry.utils.hasProperty(changes, 'flags.f2e-grid-enhancements') ) {
			refresh({
				vision: wall.sight !== CONST.EDGE_SENSE_TYPES.NONE,
				lighting: wall.light !== CONST.EDGE_SENSE_TYPES.NONE,
				sounds: wall.sound !== CONST.EDGE_SENSE_TYPES.NONE
			});
		}
	});
	const isSurface = behavior => behavior.system instanceof foundry.data.regionBehaviors.DefineSurfaceRegionBehaviorType;
	const restricts = (behaviors, sense) => behaviors.some(behavior => behavior.system?.[sense] !== false);
	for ( const name of ['createRegion', 'updateRegion', 'deleteRegion'] ) {
		Hooks.on(name, region => {
			const surfaces = region.behaviors.filter(isSurface);
			refresh({
				vision: restricts(surfaces, 'sight'),
				lighting: restricts(surfaces, 'light'),
				sounds: restricts(surfaces, 'sound')
			});
		});
	}
	for ( const name of ['createRegionBehavior', 'updateRegionBehavior', 'deleteRegionBehavior'] ) {
		Hooks.on(name, behavior => {
			if ( isSurface(behavior) ) {
				refresh({
					vision: true,
					lighting: true,
					sounds: true
				});
			}
		});
	}
	Hooks.on('updateLevel', () => refresh({
		vision: true,
		lighting: true,
		sounds: true
	}));
}

export function initialize() {
	if (setting.get('general.elevation-visualization')) {
		patchSweep();
		patchThresholdAttenuation();
		patchDragPreviewVision();
		registerRefreshHooks();
	}
}