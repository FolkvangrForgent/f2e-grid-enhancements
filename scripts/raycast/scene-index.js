// Per-scene index, built on the first raycast and rebuilt when hooks mark it stale.
import {wallHeightOverride, wallHeightRange} from '../elevation/helper.js';
import {gridUnitPixels} from '../helpers/grid.js';
import {tokenBottom, tokenShapeData, tokenTop} from '../helpers/token.js';
import {BVH} from './bvh.js';
import {boundsOfEdges, EDGE_STRIDE, polygonToEdges, regionOutlines} from './geometry.js';
import {EMPTY_ARRAY, maskOfTypes, TYPES} from './types.js';

// Tree masks: a wall's are the type bits it restricts (so a sight ray skips move-only subtrees); region sides and faces,
// reported whatever they block, have a bit each.
export const REGION_SIDE_MASK = 1 << 8;
export const REGION_FACE_MASK = 1 << 9;
export const UNIFORM_MASK = 1;

export const KIND_WALL = 0;
export const KIND_REGION_SIDE = 1;
export const KIND_REGION_FACE = 2;

// Primitive boxes are grown by this much, so a ray only touching one is not lost to rounding.
const BOX_PADDING = 1e-3;
// Region sides go in the tree in runs of this many consecutive edges.
const SIDE_RUN_LENGTH = 8;

// The positions in index.levels of the levels a document is on; deleted levels are left out, so a document only on
// deleted levels counts like one on none.
const levelIndexesOf = (document, levelIndexById) => {
	if (!document.levels?.size) return EMPTY_ARRAY;
	const levelIndexes = [];
	for (const levelId of document.levels) {
		const levelIndex = levelIndexById.get(levelId);
		if (levelIndex !== undefined) levelIndexes.push(levelIndex);
	}
	return levelIndexes.length ? levelIndexes : EMPTY_ARRAY;
};

// Per scene: the static tree (walls, region sides and faces), a region volume tree (for containment), and a token tree,
// rebuilt on its own since tokens move all the time; plus `levels`, which primitives refer to by position.
const sceneIndexes = new WeakMap();

// Mark a scene's index stale: 'all', 'static' (walls, regions, levels), 'tokens', or 'rays' (only the cached raycasts,
// for changes read live, like a door opening).
export function invalidate(scene, what = 'all') {
	const index = sceneIndexes.get(scene);
	if (!index) return;
	// what is worked out from the index and read live parts of it (the visualizer's floors) goes with any change but tokens'
	if (what !== 'tokens') index.generation++;
	if (what === 'rays') {
		index.rayCache?.clear();
		return;
	}
	if (what !== 'tokens') index.staticStale = true;
	if (what !== 'static') index.tokensStale = true;
}

// Token fields that change its volume
const TOKEN_FIELDS_INDEXED = new Set(['x', 'y', 'elevation', 'width', 'height', 'depth', 'shape']);
// Scene fields the index depends on: the grid (token shapes, z scale) and the levels.
const SCENE_FIELDS_INDEXED = new Set(['grid', 'levels']);
// Opening, closing or locking a door needs no rebuild: doors are always indexed and read live.
const WALL_FIELDS_LIVE = new Set(['_id', 'ds']);

// Mark indexes stale when the documents in them change. Call once.
export function installHooks() {
	const sceneOf = document => {
		while (document && !(document instanceof Scene)) document = document.parent;
		return document;
	};
	for (const event of ['create', 'update', 'delete']) {
		for (const documentName of ['Wall', 'Region', 'RegionBehavior', 'Level']) {
			Hooks.on(`${event}${documentName}`, (document, changes) => {
				const isLiveChange = event === 'update' && documentName === 'Wall' && Object.keys(changes).every(key => WALL_FIELDS_LIVE.has(key));
				invalidate(sceneOf(document), isLiveChange ? 'rays' : 'static');
			});
		}
		Hooks.on(`${event}Token`, (token, changes) => {
			if (event === 'update' && !Object.keys(changes).some(key => TOKEN_FIELDS_INDEXED.has(key.split('.')[0]))) return;
			invalidate(sceneOf(token), 'tokens');
		});
	}
	Hooks.on('updateScene', (scene, changes) => {
		if (Object.keys(changes).some(key => SCENE_FIELDS_INDEXED.has(key))) invalidate(scene);
	});
	Hooks.on('canvasReady', () => invalidate(canvas.scene));
}

// Raycasts' cached static hits in two generations: a lookup in the older moves the entry to the newer, and when the newer
// fills it becomes the older and the oldest go. Bounded (up to twice `size`), without deleting single entries, which
// leaves holes a Map's iteration then has to step over.
class RayCache {
	newer = new Map();
	older = new Map();

	constructor(size) {
		this.size = size;
	}

	get(key) {
		let value = this.newer.get(key);
		if (value === undefined) {
			value = this.older.get(key);
			if (value !== undefined) this.set(key, value);
		}
		return value;
	}

	set(key, value) {
		if (this.newer.size >= this.size) {
			this.older = this.newer;
			this.newer = new Map();
		}
		this.newer.set(key, value);
	}

	clear() {
		this.newer.clear();
		this.older.clear();
	}
}

export function getSceneIndex(scene) {
	let index = sceneIndexes.get(scene);
	if (!index) {
		index = {staticStale: true, tokensStale: true, generation: 0};
		sceneIndexes.set(scene, index);
	}
	if (index.staticStale) {
		Object.assign(index, buildStaticIndex(scene));
		// cached raycasts (query.js) are of the static part, so they go with it
		index.rayCache = new RayCache(4096);
		index.staticStale = false;
	}
	if (index.tokensStale) {
		index.tokens = buildTokenIndex(scene);
		index.tokensStale = false;
	}
	return index;
}

class PrimitiveList {
	primitives = [];
	masks = [];
	boxes = [];

	add(primitive, mask, minX, minY, minZ, maxX, maxY, maxZ) {
		this.primitives.push(primitive);
		this.masks.push(mask);
		this.boxes.push(minX - BOX_PADDING, minY - BOX_PADDING, minZ - BOX_PADDING, maxX + BOX_PADDING, maxY + BOX_PADDING, maxZ + BOX_PADDING);
	}

	buildTree(scene) {
		const bvh = new BVH(this.boxes, this.masks, {zScale: gridUnitPixels(scene.grid)});
		return {primitives: this.primitives, bvh};
	}
}

// A region's surfaces as core places them (Scene#updateSurfaces): each enabled Define Surface behavior puts one on the
// bottom, top or both by its `placement` (a flat region's single plane takes every placement); a hidden region has none.
// Returns [{behavior, elevation, types}], the restricted types as a bit mask.
function regionSurfaces(region) {
	const DefineSurface = foundry.data.regionBehaviors.DefineSurfaceRegionBehaviorType;
	const surfaces = [];
	if (region.hidden) return surfaces;
	const {bottom, top} = region.elevation;
	const isFlat = bottom === top;
	for (const behavior of region.behaviors) {
		if (behavior.disabled || !(behavior.system instanceof DefineSurface)) continue;
		const types = maskOfTypes(TYPES.filter(type => behavior.system[type]));
		if (!types) continue;
		const placement = behavior.system.placement;
		if (placement === 'bottom' || placement === 'both' || isFlat) surfaces.push({behavior, elevation: bottom, types});
		if ((placement === 'top' || placement === 'both') && !isFlat) surfaces.push({behavior, elevation: top, types});
	}
	return surfaces;
}

// this module's Define Barrier behavior type (region/barrier.js), kept from when it was a surface behavior so existing
// behaviors still load
export const BARRIER_TYPE = 'f2e-grid-enhancements.surface';

// The region's barriers from this module's Define Barrier behavior (region/barrier.js): where each one is, and what it does
// for every restriction type, as a wall does (darkness as light, thresholds in pixels).
function regionBarriers(region, pixelsPerUnit) {
	if (region.hidden) return EMPTY_ARRAY;
	const barriers = [];
	for (const behavior of region.behaviors) {
		if (behavior.disabled || behavior.type !== BARRIER_TYPE) continue;
		const {bottom, top, sides, light, move, sight, sound, direction, threshold} = behavior.system;
		const toPixels = distance => (distance ? distance * pixelsPerUnit : null);
		barriers.push({
			behavior,
			bottom,
			top,
			sides,
			senses: {light, darkness: light, move, sight, sound},
			thresholds: {light: toPixels(threshold.light), darkness: toPixels(threshold.light), sight: toPixels(threshold.sight), sound: toPixels(threshold.sound)},
			attenuation: threshold.attenuation,
			direction
		});
	}
	return barriers.length ? barriers : EMPTY_ARRAY;
}

// Index everything but tokens. Tiles are not indexed: a blocking tile needs walls or a region with a barrier.
function buildStaticIndex(scene) {
	const staticList = new PrimitiveList();
	const regionVolumeList = new PrimitiveList();
	const levels = Array.from(scene.levels, level => ({
		id: level.id,
		bottom: level.elevation.bottom,
		top: level.elevation.top,
		document: level
	}));
	const levelIndexById = new Map(levels.map((level, levelIndex) => [level.id, levelIndex]));

	for (const wall of scene.walls) {
		const edge = wall.edge;
		if (!edge) continue;
		let restrictedTypes = 0;
		let limitedTypes = 0;
		for (let typeIndex = 0; typeIndex < TYPES.length; typeIndex++) {
			const restriction = edge[TYPES[typeIndex]];
			if (restriction) restrictedTypes |= 1 << typeIndex;
			if (restriction === CONST.EDGE_SENSE_TYPES.LIMITED) limitedTypes |= 1 << typeIndex;
		}
		if (!restrictedTypes) continue;
		// one height range per level the wall is on (its own top and bottom overriding the level's), or one from its own
		// alone on no level
		const ownTop = wallHeightOverride(wall, 'top');
		const ownBottom = wallHeightOverride(wall, 'bottom');
		const levelIndexes = levelIndexesOf(wall, levelIndexById);
		const heightRanges = levelIndexes.map(levelIndex => ({
			levelIndex,
			...wallHeightRange(ownBottom, ownTop, levels[levelIndex].document)
		}));
		if (!heightRanges.length) heightRanges.push({levelIndex: -1, ...wallHeightRange(ownBottom, ownTop, null)});
		const {a, b} = edge;
		const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
		staticList.add(
			{
				kind: KIND_WALL,
				document: wall,
				isDoor: !!wall.isDoor,
				edge,
				limitedTypes,
				levelIndexes,
				heightRanges,
				startX: a.x,
				startY: a.y,
				endX: b.x,
				endY: b.y,
				normalX: (a.y - b.y) / length,
				normalY: (b.x - a.x) / length
			},
			restrictedTypes,
			Math.min(a.x, b.x),
			Math.min(a.y, b.y),
			Math.min(...heightRanges.map(range => range.bottom)),
			Math.max(a.x, b.x),
			Math.max(a.y, b.y),
			Math.max(...heightRanges.map(range => range.top))
		);
	}

	const numbersPerSideRun = SIDE_RUN_LENGTH * EDGE_STRIDE;
	for (const region of scene.regions) {
		const bottom = region.elevation.bottom ?? -Infinity;
		const top = region.elevation.top ?? Infinity;
		const topInclusive = !!region.elevation.topInclusive;
		const levelIndexes = levelIndexesOf(region, levelIndexById);
		const barriers = regionBarriers(region, gridUnitPixels(scene.grid));
		const sideBarriers = top > bottom ? barriers.filter(barrier => barrier.sides) : EMPTY_ARRAY;
		const minX = region.bounds.x;
		const minY = region.bounds.y;
		const maxX = minX + region.bounds.width;
		const maxY = minY + region.bounds.height;

		const outlineEdges = regionOutlines(region)
			.map(({points, isHole}) => polygonToEdges(points, isHole))
			.filter(Boolean);
		// all outlines' edges in one array, for containment and the faces
		const regionEdges = Float64Array.from(outlineEdges.flatMap(edges => Array.from(edges)));

		// a flat region has no inside
		if (top > bottom) {
			regionVolumeList.add({document: region, edges: regionEdges, minX, minY, maxX, maxY, bottom, top, topInclusive, levelIndexes}, UNIFORM_MASK, minX, minY, bottom, maxX, maxY, top);
		}

		// sides, in runs of consecutive edges so a detailed outline does not flood the tree
		for (const edges of outlineEdges) {
			for (let offset = 0; offset < edges.length; offset += numbersPerSideRun) {
				const run = edges.subarray(offset, offset + numbersPerSideRun);
				const [runMinX, runMinY, runMaxX, runMaxY] = boundsOfEdges(run);
				staticList.add(
					{kind: KIND_REGION_SIDE, document: region, edges: run, bottom, top, topInclusive, levelIndexes, barriers: sideBarriers},
					REGION_SIDE_MASK,
					runMinX,
					runMinY,
					bottom,
					runMaxX,
					runMaxY,
					top
				);
			}
		}

		// top and bottom faces (none at an unbounded end)
		const surfaces = regionSurfaces(region);
		for (const elevation of new Set([region.elevation.top, region.elevation.bottom])) {
			if (!Number.isFinite(elevation)) continue;
			const faceSurfaces = surfaces.filter(surface => surface.elevation === elevation);
			// a flat region's one face takes every placement, as core's surfaces do
			const faceBarriers = barriers.filter(barrier => (bottom === top ? barrier.bottom || barrier.top : elevation === bottom ? barrier.bottom : barrier.top));
			staticList.add(
				{
					kind: KIND_REGION_FACE,
					document: region,
					edges: regionEdges,
					elevation,
					bottom,
					top,
					topInclusive,
					levelIndexes,
					surfaces: faceSurfaces,
					barriers: faceBarriers
				},
				REGION_FACE_MASK,
				minX,
				minY,
				elevation,
				maxX,
				maxY,
				elevation
			);
		}
	}

	// pixels per grid unit, for distances in 3D (barrier-rules.js)
	return {...staticList.buildTree(scene), levels, levelIndexById, regionVolumes: regionVolumeList.buildTree(scene), pixelsPerUnit: gridUnitPixels(scene.grid)};
}

// Index tokens as prisms (footprint from bottom to top) or ellipsoids.
function buildTokenIndex(scene) {
	const tokenList = new PrimitiveList();
	for (const token of scene.tokens) {
		const bottom = tokenBottom(token);
		const top = tokenTop(token);
		if (!(top > bottom)) continue;
		const footprint = tokenShapeData(token);
		const primitive = {
			document: token,
			bottom,
			top,
			edges: null,
			ellipsoid: null
		};
		let minX;
		let minY;
		let maxX;
		let maxY;
		if (footprint.type === 'ellipse') {
			const {x: centerX, y: centerY, radiusX, radiusY} = footprint;
			if (!(radiusX > 0) || !(radiusY > 0)) continue;
			const radiusZ = (top - bottom) / 2;
			primitive.ellipsoid = {centerX, centerY, centerZ: bottom + radiusZ, radiusX, radiusY, radiusZ};
			[minX, minY, maxX, maxY] = [centerX - radiusX, centerY - radiusY, centerX + radiusX, centerY + radiusY];
		} else {
			let points = footprint.points;
			if (footprint.type === 'rectangle') {
				const {x, y, width, height} = footprint;
				points = [x, y, x + width, y, x + width, y + height, x, y + height];
			}
			primitive.edges = polygonToEdges(points);
			if (!primitive.edges) continue;
			[minX, minY, maxX, maxY] = boundsOfEdges(primitive.edges);
		}
		tokenList.add(primitive, UNIFORM_MASK, minX, minY, bottom, maxX, maxY, top);
	}
	return tokenList.buildTree(scene);
}
