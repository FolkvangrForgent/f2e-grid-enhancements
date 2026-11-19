// Define Barrier behaviors (barrier.js) handed to core while the Barrier Visualization setting is off, so core's flat sweep
// and surface checks see them as they do walls and Define Surface behaviors. While the setting is on the visualizer and the
// raycast read the barriers themselves, and nothing is handed to core.
//
// - Sides: each outline edge of the region is a core Edge of type "wall" on every level the region is on, with the barrier's
//   restrictions, thresholds (pixels) and attenuation. One way barriers face as walls do: "in" blocks only from outside the
//   region, "out" only from inside. Core's edges have no height, so a side blocks at every elevation on those levels. Movement
//   is kept, so a side clips move-restricted regions (templates) as a wall does; tokens are still stopped by the raycast.
// - Bottom and top: a core surface (Scene#getSurfaces) at the region's bottom and/or top (a flat region's one face takes
//   every placement, as core's do). A surface either restricts a type or not, from both sides: a barrier restricts the types
//   it blocks outright (Normal, and Proximity and Reverse Proximity, whose thresholds core's surfaces cannot measure);
//   Limited lets one crossing through, so it does not restrict. Movement is left out, since the raycast decides movement
//   whatever the setting, with one-way and threshold rules core's surfaces do not have. Barriers neither occlude, expose
//   nor cull.

import {EDGE_END_X, EDGE_END_Y, EDGE_NORMAL_X, EDGE_NORMAL_Y, EDGE_STRIDE, polygonToEdges, regionOutlines} from '../helpers/geometry.js';
import * as log from '../helpers/log.js';
import * as patch from '../helpers/patch.js';
import {sceneOf} from '../helpers/scene.js';
import * as setting from '../helpers/setting.js';
import {isDefineBarrier, onBarrierRegionChange, placedElevations, regionBarriers, regionRoof} from '../spatial/barriers.js';

const EDGE_ID_PREFIX = 'f2eBarrier';
const TYPES_HANDED_TO_CORE_SURFACES = ['light', 'darkness', 'sight', 'sound'];
const isHandedToCore = () => !setting.get('general.barrier-visualization');

const edgeIdsByScene = new WeakMap();
const surfacesByScene = new WeakMap();

// As Edge#orientPoint gives it.
function sideOfEdge(ax, ay, bx, by, x, y) {
	const orientation = foundry.utils.orient2dFast({x: ax, y: ay}, {x: bx, y: by}, {x, y});
	if (orientation === 0) return CONST.EDGE_DIRECTIONS.BOTH;
	return orientation < 0 ? CONST.EDGE_DIRECTIONS.LEFT : CONST.EDGE_DIRECTIONS.RIGHT;
}

// Core leaves an edge out when the origin is on its `direction` side
// (edgeDirectionMode NORMAL), so "in" faces the inside and "out" the outside.
function barrierEdges(region, barrier) {
	const {senses, thresholds, attenuation, direction} = barrier;
	const {Edge} = foundry.canvas.geometry.edges;
	const threshold = {light: thresholds.light ?? 0, darkness: thresholds.darkness ?? 0, sight: thresholds.sight ?? 0, sound: thresholds.sound ?? 0, attenuation};
	const edges = [];
	let outlineIndex = 0;
	for (const {points, isHole} of regionOutlines(region)) {
		const outline = polygonToEdges(points, isHole);
		outlineIndex++;
		if (!outline) continue;
		for (let offset = 0; offset < outline.length; offset += EDGE_STRIDE) {
			const [ax, ay, bx, by] = [outline[offset], outline[offset + 1], outline[offset + EDGE_END_X], outline[offset + EDGE_END_Y]];
			let edgeDirection = CONST.EDGE_DIRECTIONS.BOTH;
			if (direction !== 'both') {
				// a point a pixel outside the edge's middle, or inside for "in"
				const normalSign = direction === 'in' ? -1 : 1;
				const x = (ax + bx) / 2 + normalSign * outline[offset + EDGE_NORMAL_X];
				const y = (ay + by) / 2 + normalSign * outline[offset + EDGE_NORMAL_Y];
				edgeDirection = sideOfEdge(ax, ay, bx, by, x, y);
			}
			edges.push(
				new Edge(
					{x: ax, y: ay},
					{x: bx, y: by},
					{
						id: `${EDGE_ID_PREFIX}.${barrier.behavior.id}.${outlineIndex}.${offset / EDGE_STRIDE}`,
						object: barrier.behavior,
						type: 'wall',
						direction: edgeDirection,
						...senses,
						threshold
					}
				)
			);
		}
	}
	return edges;
}

function sceneBarrierEdgesWithLevels(scene) {
	const edgesWithLevels = [];
	for (const region of scene.regions) {
		const {bottom, top} = region.elevation;
		// a flat region has no sides
		if (!((top ?? Infinity) > (bottom ?? -Infinity))) continue;
		for (const barrier of regionBarriers(region, scene.dimensions.distancePixels)) {
			if (!barrier.sides || !Object.values(barrier.senses).some(Boolean)) continue;
			const levels = scene.levels.filter(level => region.includedInLevel(level));
			if (!levels.length) continue;
			for (const edge of barrierEdges(region, barrier)) edgesWithLevels.push({edge, levels});
		}
	}
	return edgesWithLevels;
}

// None while the setting is on. Returns whether any were removed or added.
function replaceSceneBarrierEdges(scene) {
	if (!scene.initializedEdges) return false;
	let changed = false;
	for (const id of edgeIdsByScene.get(scene) ?? []) {
		for (const level of scene.levels) changed = level.edges.delete(id) || changed;
	}
	const addedIds = [];
	if (isHandedToCore()) {
		for (const {edge, levels} of sceneBarrierEdgesWithLevels(scene)) {
			for (const level of levels) level.edges.set(edge.id, edge);
			addedIds.push(edge.id);
		}
	}
	edgeIdsByScene.set(scene, addedIds);
	return changed || addedIds.length > 0;
}

// As core's RegionSurface records.
function sceneBarrierSurfaces(scene) {
	const {NORMAL} = CONST.EDGE_SENSE_TYPES;
	const surfaces = [];
	for (const region of scene.regions) {
		const {top} = region.elevation;
		const surfacesByElevation = new Map();
		// core's surfaces are flat: a roofed top is not handed over (the raycast still decides movement, vision and sound by it)
		const roof = regionRoof(region);
		const isSloped = elevation => !!roof && elevation === top;
		for (const barrier of regionBarriers(region, scene.dimensions.distancePixels)) {
			const restricted = TYPES_HANDED_TO_CORE_SURFACES.filter(type => barrier.senses[type] >= NORMAL);
			if (!restricted.length) continue;
			for (const elevation of placedElevations(region, barrier.bottom, barrier.top)) {
				if (!Number.isFinite(elevation) || isSloped(elevation)) continue;
				let surface = surfacesByElevation.get(elevation);
				if (!surface) {
					surface = {
						key: `${region.id},${elevation},${EDGE_ID_PREFIX}`,
						region,
						elevation,
						light: false,
						darkness: false,
						move: false,
						sight: false,
						sound: false,
						occlusion: false,
						exposure: false,
						culling: false
					};
					surfacesByElevation.set(elevation, surface);
				}
				for (const type of restricted) surface[type] = true;
			}
		}
		surfaces.push(...surfacesByElevation.values());
	}
	return surfaces.sort((first, second) => first.elevation - second.elevation);
}

// As core filters its own.
function surfaceMatches(surface, {type, level, occlusion, exposure, culling}) {
	if (level !== undefined && !surface.region.includedInLevel(level)) return false;
	if (type !== undefined && !surface[type]) return false;
	if (occlusion !== undefined && surface.occlusion !== occlusion) return false;
	if (exposure !== undefined && surface.exposure !== exposure) return false;
	if (culling !== undefined && surface.culling !== culling) return false;
	return true;
}

function mergeSortedByElevation(first, second) {
	const merged = [];
	let firstIndex = 0;
	let secondIndex = 0;
	while (firstIndex < first.length || secondIndex < second.length) {
		if (secondIndex >= second.length || (firstIndex < first.length && first[firstIndex].elevation <= second[secondIndex].elevation)) merged.push(first[firstIndex++]);
		else merged.push(second[secondIndex++]);
	}
	return merged;
}

function barrierSurfacesCache(scene) {
	let cache = surfacesByScene.get(scene);
	if (!cache) surfacesByScene.set(scene, (cache = {surfaces: sceneBarrierSurfaces(scene), results: new Map()}));
	return cache;
}

function addBarrierSurfacesToCoreSurfaces() {
	patch.add('foundry.documents.Scene.prototype.getSurfaces', (wrapped, scene, options = {}) => {
		const coreSurfaces = wrapped(options);
		if (!isHandedToCore()) return coreSurfaces;
		const cache = barrierSurfacesCache(scene);
		if (!cache.surfaces.length) return coreSurfaces;
		const {type, level, occlusion, exposure, culling} = options;
		const filterKey = `${type || ''},${!level || typeof level === 'string' ? level || '' : level.id},${occlusion},${exposure},${culling}`;
		let result = cache.results.get(filterKey);
		// core's own list is cached until its surfaces change, which clears this cache too
		if (!result || result.core !== coreSurfaces) {
			const barrierSurfaces = cache.surfaces.filter(surface => surfaceMatches(surface, options));
			result = {core: coreSurfaces, surfaces: barrierSurfaces.length ? Object.freeze(mergeSortedByElevation(coreSurfaces, barrierSurfaces)) : coreSurfaces};
			cache.results.set(filterKey, result);
		}
		return result.surfaces;
	});
	patch.add('foundry.documents.Scene.prototype._invalidateSurfaces', (wrapped, scene, ...args) => {
		surfacesByScene.delete(scene);
		return wrapped(...args);
	});
}

// So a sync knows whether any went away.
const handedSurfaceCountsByScene = new WeakMap();

// Edges exist only once core has set up the scene's edges. Region shape constraints follow edge changes, as they do for walls
// (Wall#_onEdgeChange).
function handBarriersToCore(scene, {refresh = true} = {}) {
	if (!scene) return;
	scene._invalidateSurfaces();
	const edgesChanged = replaceSceneBarrierEdges(scene);
	const hadSurfaces = (handedSurfaceCountsByScene.get(scene) ?? 0) > 0;
	const surfaceCount = isHandedToCore() ? barrierSurfacesCache(scene).surfaces.length : 0;
	handedSurfaceCountsByScene.set(scene, surfaceCount);
	if (!refresh) return;
	if (edgesChanged) {
		for (const level of scene.levels) level.updateRegionShapeConstraints();
		// for what else measures against edges (f2e/: the system's measured areas)
		Hooks.callAll('f2eGridEnhancements.barrierEdgesChanged', scene);
	}
	if (!(edgesChanged || hadSurfaces || surfaceCount) || !canvas?.ready || scene !== canvas.scene) return;
	canvas.perception.update({initializeVision: true, initializeLighting: true, initializeSounds: true, refreshVision: true, refreshLighting: true, refreshSounds: true});
	canvas.tokens.recalculatePlannedMovementPaths();
}

// Several changes at once (a region with its behaviors) are handled once. Each scene leaves the queue before it is synced, so one
// that fails is not retried ahead of the others on every later flush.
const pendingScenes = new Set();
const handPendingScenesToCore = foundry.utils.debounce(() => {
	const scenes = [...pendingScenes];
	pendingScenes.clear();
	for (const scene of scenes) {
		try {
			handBarriersToCore(scene);
		} catch (error) {
			log.error(`could not hand barriers to core for scene ${scene.id}`, error);
		}
	}
}, 0);
const queueScene = scene => {
	if (!scene) return;
	pendingScenes.add(scene);
	handPendingScenesToCore();
};

function resyncOnChanges() {
	// core clears every level's edges and adds its own back; ours go back too
	Hooks.on('initializeEdges', scene => handBarriersToCore(scene, {refresh: false}));
	onBarrierRegionChange(isDefineBarrier, region => queueScene(sceneOf(region)));
	// a grid change moves grid-shaped outlines and changes the pixels a threshold's distance is, without core resetting edges
	Hooks.on('updateScene', (scene, changes) => {
		if ('grid' in changes) queueScene(scene);
	});
}

// For the visualizer setting's onChange: every scene, since core sets up a scene's edges only once and does not redo them on returning to it.
export function syncAllScenes() {
	for (const scene of game.scenes) queueScene(scene);
}

Hooks.once('init', () => {
	addBarrierSurfacesToCoreSurfaces();
	resyncOnChanges();
});
