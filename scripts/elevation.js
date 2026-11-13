import * as patch from './patch.js';
import * as setting from './setting.js';

function wallSpans(wall) {
	const flags = wall.flags?.['f2e-grid-enhancements'];
	const levels = [...(wall.levels ?? wall.document?.levels ?? [])].map(id => canvas.scene?.levels.get(id)).filter(Boolean);
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
			const elevation = self.origin.elevation ?? 0;
			if (Number.isFinite(elevation)) {
				for (const edge of [...self.edges]) {
					if ( edge.object?.documentName !== 'Wall' ) continue;
					let blocks = false;
					for ( const { top, bottom } of wallSpans(edge.object) ) {
						if ( elevation >= bottom && elevation < top) {
							blocks = true;
							break;
						}
					}
					if ( !blocks ) {
						self.edges.delete(edge);
					}
				}
			}
		} catch (error) {}
		return result;
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

export function initialize() {
	if (setting.get('general.elevation-visualization')) {
		patchSweep();
		patchDragPreviewVision();
	}
}
