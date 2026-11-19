// Each scene's walls, regions and tokens, uploaded to the WebAssembly scene store (wasm/src/store.rs), which the raycast and
// the floor lighting work on. Uploads happen lazily, when something asks for the scene's index after a change: the static
// part (walls, regions, their roofs, barriers and surfaces) on any change to it, the tokens when one moves, and a door's
// state in place when it opens or closes. Documents are numbered per scene; results name them by number (`documents`).
import {signedArea, union} from '../helpers/clipper.js';
import {boundsOfEdges, EDGE_STRIDE, polygonToEdges, regionOutlines} from '../helpers/geometry.js';
import {gridUnitPixels} from '../helpers/grid.js';
import {sceneOf} from '../helpers/scene.js';
import {tokenBottom, tokenShapeData, tokenTop} from '../helpers/token.js';
import {EMPTY_ARRAY, maskOfTypes, TYPES} from '../helpers/types.js';
import {wallHeightOverride, wallHeightRange} from '../helpers/wall.js';
import {callWasm, Encoder, writeInput} from '../helpers/wasm.js';
import {placedElevations, regionBarriers, regionRoof, regionRoofFaces, regionsAttachedTo} from './barriers.js';

// A wall's mask is the type bits it restricts, so a sight ray skips move-only subtrees; region sides and faces are reported
// whatever they block, so they get a bit each. As in store.rs.
const REGION_SIDE_MASK = 1 << 8;
const REGION_FACE_MASK = 1 << 9;
const REGION_SLOPE_MASK = 1 << 10;

const KIND_WALL = 0;
const KIND_REGION_SIDE = 1;
const KIND_REGION_FACE = 2;

// So a ray only touching a box is not lost to rounding.
const BOX_PADDING = 1e-3;
// Runs, so a detailed outline does not flood the tree.
const REGION_SIDE_EDGES_PER_PRIMITIVE = 8;
const MAX_CACHED_RAYCASTS_PER_GENERATION = 4096;
const BARRIER_DIRECTION_CODES = {both: 0, in: 1, out: 2};

// A document only on deleted levels counts like one on none.
const levelIndexesOf = (document, levelIndexById) => {
	if (!document.levels?.size) return EMPTY_ARRAY;
	const levelIndexes = [];
	for (const levelId of document.levels) {
		const levelIndex = levelIndexById.get(levelId);
		if (levelIndex !== undefined) levelIndexes.push(levelIndex);
	}
	return levelIndexes.length ? levelIndexes : EMPTY_ARRAY;
};

const indexesByScene = new WeakMap();

// scope: 'all', 'static' (walls, regions, levels), 'tokens', or 'rays' (only cached raycasts, for a door's state, which is
// set in place).
function invalidate(scene, scope = 'all') {
	const index = indexesByScene.get(scene);
	if (!index) return;
	// the visualizer's floors depend on everything but tokens
	if (scope !== 'tokens') index.generation++;
	if (scope === 'rays') {
		index.rayCache?.clear();
		return;
	}
	if (scope !== 'tokens') index.staticStale = true;
	if (scope !== 'static') index.tokensStale = true;
}

const TOKEN_FIELDS_INDEXED = new Set(['x', 'y', 'elevation', 'width', 'height', 'depth', 'shape', 'level']);
const SCENE_FIELDS_INDEXED = new Set(['grid', 'levels']);
// A door's state is set in the store in place, so opening, closing or locking one needs no upload of the scene.
const WALL_FIELDS_SET_IN_PLACE = new Set(['_id', 'ds']);

function setDoorState(wall) {
	const index = indexesByScene.get(sceneOf(wall));
	const primitive = index?.doorPrimitiveByWall.get(wall);
	if (index && !index.staticStale && primitive !== undefined) callWasm(exports => exports.scene_set_door_open(index.slot, primitive, !!wall.isOpen));
}

function invalidateIndexesOnDocumentChanges() {
	for (const event of ['create', 'update', 'delete']) {
		for (const documentName of ['Wall', 'Region', 'RegionBehavior', 'Level']) {
			Hooks.on(`${event}${documentName}`, (document, changes) => {
				const isDoorChange = event === 'update' && documentName === 'Wall' && Object.keys(changes).every(key => WALL_FIELDS_SET_IN_PLACE.has(key));
				if (isDoorChange) setDoorState(document);
				invalidate(sceneOf(document), isDoorChange ? 'rays' : 'static');
			});
		}
		Hooks.on(`${event}Token`, (token, changes) => {
			// hiding or showing a token makes the regions attached to it inactive or active
			if (event === 'update' && 'hidden' in changes && regionsAttachedTo(token).length) invalidate(sceneOf(token), 'static');
			if (event === 'update' && !Object.keys(changes).some(key => TOKEN_FIELDS_INDEXED.has(key))) return;
			invalidate(sceneOf(token), 'tokens');
		});
	}
	Hooks.on('updateScene', (scene, changes) => {
		if (Object.keys(changes).some(key => SCENE_FIELDS_INDEXED.has(key))) invalidate(scene);
	});
	Hooks.on('deleteScene', scene => {
		const index = indexesByScene.get(scene);
		if (index) callWasm(exports => exports.scene_free(index.slot));
		indexesByScene.delete(scene);
	});
	Hooks.on('canvasReady', () => invalidate(canvas.scene));
}

// Two generations: a lookup in the older moves the entry to the newer, and when the newer fills it becomes the older and the
// oldest go. This bounds it without deleting single entries, which leaves holes a Map's iteration has to step over.
class RayCache {
	newer = new Map();
	older = new Map();

	constructor(entriesPerGeneration) {
		this.entriesPerGeneration = entriesPerGeneration;
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
		if (this.newer.size >= this.entriesPerGeneration) {
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

// Uploads whatever changed. Throws while the WebAssembly module is not loaded.
export function getSceneIndex(scene) {
	let index = indexesByScene.get(scene);
	if (!index) {
		index = {slot: callWasm(exports => exports.scene_create()), staticStale: true, tokensStale: true, generation: 0, documents: [], documentIds: new Map(), staticDocumentCount: 0};
		indexesByScene.set(scene, index);
	}
	if (index.staticStale) {
		uploadStatic(scene, index);
		index.rayCache = new RayCache(MAX_CACHED_RAYCASTS_PER_GENERATION);
		index.staticStale = false;
		index.tokensStale = true;
	}
	if (index.tokensStale) {
		uploadTokens(scene, index);
		index.tokensStale = false;
	}
	return index;
}

function documentId(index, document) {
	let id = index.documentIds.get(document);
	if (id === undefined) {
		id = index.documents.length;
		index.documents.push(document);
		index.documentIds.set(document, id);
	}
	return id;
}

// minX, minY, minZ, maxX, maxY, maxZ, padded
function pushBox(encoder, minX, minY, minZ, maxX, maxY, maxZ) {
	encoder.push(minX - BOX_PADDING, minY - BOX_PADDING, minZ - BOX_PADDING, maxX + BOX_PADDING, maxY + BOX_PADDING, maxZ + BOX_PADDING);
}

// As core places them (Scene#updateSurfaces). types is a bit mask.
function regionSurfaces(region) {
	const DefineSurface = foundry.data.regionBehaviors.DefineSurfaceRegionBehaviorType;
	const surfaces = [];
	if (!region.active) return surfaces;
	for (const behavior of region.behaviors) {
		if (behavior.disabled || !(behavior.system instanceof DefineSurface)) continue;
		const types = maskOfTypes(TYPES.filter(type => behavior.system[type]));
		if (!types) continue;
		const {placement} = behavior.system;
		for (const elevation of placedElevations(region, placement !== 'top', placement !== 'bottom')) surfaces.push({behavior, elevation, types});
	}
	return surfaces;
}

// The layout must match store.rs Scene::upload_static. Tiles are not indexed: a blocking tile needs walls or a region with a
// barrier.
function uploadStatic(scene, index) {
	// a wall has no edge until its scene's edges are set up, which core does only for the viewed scene or when something asks a
	// level for its edges; without this a scene never viewed would have no walls
	scene.initializeEdges();
	index.documents.length = 0;
	index.documentIds.clear();
	index.levels = Array.from(scene.levels, level => ({id: level.id, bottom: level.elevation.bottom, top: level.elevation.top, document: level}));
	index.levelIndexById = new Map(index.levels.map((level, levelIndex) => [level.id, levelIndex]));
	index.pixelsPerUnit = gridUnitPixels(scene.grid);
	index.doorPrimitiveByWall = new Map();
	const upload = {
		index,
		roofs: new Encoder(),
		roofCount: 0,
		barriers: new Encoder(),
		barrierCount: 0,
		primitives: new Encoder(),
		primitiveCount: 0,
		volumes: new Encoder(),
		volumeCount: 0,
		areas: new Encoder(),
		areaCount: 0
	};
	for (const wall of scene.walls) addWall(upload, wall);
	for (const region of scene.regions) addRegion(upload, region);
	// (spread in a literal, not into push, which takes them as arguments and overflows the stack on a large scene)
	const encoded = [
		index.pixelsPerUnit,
		index.levels.length,
		upload.roofCount,
		...upload.roofs.values,
		upload.barrierCount,
		...upload.barriers.values,
		upload.primitiveCount,
		...upload.primitives.values,
		upload.volumeCount,
		...upload.volumes.values,
		upload.areaCount,
		...upload.areas.values
	];
	callWasm(exports => {
		writeInput(exports, encoded);
		exports.scene_upload_static(index.slot);
	});
	index.staticDocumentCount = index.documents.length;
}

function addWall(upload, wall) {
	const {index} = upload;
	const edge = wall.edge;
	if (!edge) return;
	// The senses come from the document, not the edge: core gives an open door's edge no senses and replaces the edge when the
	// door changes, while a door's state is set in place (setDoorState), so the store holds what a door does when closed. The
	// edge still gives the direction and the thresholds (in pixels), which opening a door does not change.
	const senses = TYPES.map(type => wall[type] ?? CONST.EDGE_SENSE_TYPES.NONE);
	const restrictedTypes = senses.reduce((mask, sense, typeIndex) => (sense ? mask | (1 << typeIndex) : mask), 0);
	if (!restrictedTypes) return;
	const limitedTypes = senses.reduce((mask, sense, typeIndex) => (sense === CONST.EDGE_SENSE_TYPES.LIMITED ? mask | (1 << typeIndex) : mask), 0);
	const ownTop = wallHeightOverride(wall, 'top');
	const ownBottom = wallHeightOverride(wall, 'bottom');
	const levelIndexes = levelIndexesOf(wall, index.levelIndexById);
	const allHeightRanges = levelIndexes.length
		? levelIndexes.map(levelIndex => ({levelIndex, ...wallHeightRange(ownBottom, ownTop, index.levels[levelIndex].document)}))
		: [{levelIndex: -1, ...wallHeightRange(ownBottom, ownTop, null)}];
	// a range whose top is at or below its bottom (an override past the level's other end) stands nowhere
	const heightRanges = allHeightRanges.filter(range => range.top > range.bottom);
	if (!heightRanges.length) return;
	const {a, b} = edge;
	const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
	if (wall.isDoor) index.doorPrimitiveByWall.set(wall, upload.primitiveCount);
	const {primitives} = upload;
	primitives.push(KIND_WALL, restrictedTypes);
	pushBox(
		primitives,
		Math.min(a.x, b.x),
		Math.min(a.y, b.y),
		Math.min(...heightRanges.map(range => range.bottom)),
		Math.max(a.x, b.x),
		Math.max(a.y, b.y),
		Math.max(...heightRanges.map(range => range.top))
	);
	primitives.push(documentId(index, wall), wall.isDoor ? 1 : 0, wall.isOpen ? 1 : 0, ...senses, limitedTypes);
	primitives.list(levelIndexes);
	primitives.push(heightRanges.length);
	for (const range of heightRanges) primitives.push(range.levelIndex, range.bottom, range.top);
	primitives.push(a.x, a.y, b.x, b.y, (a.y - b.y) / length, (b.x - a.x) / length, edge.direction ?? 0);
	primitives.push(...TYPES.map(type => edge.threshold?.[type] || 0), edge.threshold?.attenuation ? 1 : 0);
	upload.primitiveCount++;
}

function addRoof(upload, roofedTop) {
	const {roofs} = upload;
	roofs.push(roofedTop.isLowest ? 1 : 0, roofedTop.floor ?? -Infinity, roofedTop.planes.length);
	for (const plane of roofedTop.planes) roofs.push(plane.a, plane.b, plane.c);
	roofs.push(roofedTop.pieces.length);
	for (const piece of roofedTop.pieces) {
		const {minX, minY, maxX, maxY} = piece.bounds;
		roofs.push(piece.plane.a, piece.plane.b, piece.plane.c, minX, minY, maxX, maxY);
		roofs.list(piece.edges);
		roofs.paths(piece.paths);
	}
	return upload.roofCount++;
}

function addBarriers(upload, barriers) {
	return barriers.map(barrier => {
		upload.barriers.push(documentId(upload.index, barrier.behavior), ...TYPES.map(type => barrier.senses[type] ?? 0), ...TYPES.map(type => barrier.thresholds[type] || 0));
		upload.barriers.push(barrier.attenuation ? 1 : 0, BARRIER_DIRECTION_CODES[barrier.direction] ?? 0);
		return upload.barrierCount++;
	});
}

// Its inside, its sides in runs of edges, and its bottom and top faces (a face per piece of a roofed top).
function addRegion(upload, region) {
	const {index, primitives} = upload;
	const bottom = region.elevation.bottom ?? -Infinity;
	const top = region.elevation.top ?? Infinity;
	const topInclusive = region.elevation.topInclusive ? 1 : 0;
	const levelIndexes = levelIndexesOf(region, index.levelIndexById);
	const barriers = regionBarriers(region, index.pixelsPerUnit);
	const barrierIndices = addBarriers(upload, barriers);
	const sideBarrierIndices = top > bottom ? barrierIndices.filter((_, position) => barriers[position].sides) : EMPTY_ARRAY;
	const minX = region.bounds.x;
	const minY = region.bounds.y;
	const maxX = minX + region.bounds.width;
	const maxY = minY + region.bounds.height;
	const outlineEdges = regionOutlines(region)
		.map(({points, isHole}) => polygonToEdges(points, isHole))
		.filter(Boolean);
	const roof = regionRoof(region);
	const roofedTop = regionRoofFaces(region, roof);
	const roofIndex = roofedTop ? addRoof(upload, roofedTop) : -1;
	const regionEdges = Float64Array.from(outlineEdges.flatMap(edges => Array.from(edges)));
	const documentNumber = documentId(index, region);

	if (top > bottom) {
		upload.volumes.push(documentNumber);
		pushBox(upload.volumes, minX, minY, bottom, maxX, maxY, top);
		upload.volumes.push(bottom, top, topInclusive);
		upload.volumes.list(levelIndexes);
		upload.volumes.push(roofIndex);
		upload.volumes.list(regionEdges);
		upload.volumeCount++;
	}

	const numbersPerSideRun = REGION_SIDE_EDGES_PER_PRIMITIVE * EDGE_STRIDE;
	for (const edges of outlineEdges) {
		for (let offset = 0; offset < edges.length; offset += numbersPerSideRun) {
			const run = edges.subarray(offset, offset + numbersPerSideRun);
			const [runMinX, runMinY, runMaxX, runMaxY] = boundsOfEdges(run);
			primitives.push(KIND_REGION_SIDE, REGION_SIDE_MASK);
			pushBox(primitives, runMinX, runMinY, bottom, runMaxX, runMaxY, top);
			primitives.push(documentNumber, bottom, top, topInclusive);
			primitives.list(levelIndexes);
			primitives.list(sideBarrierIndices);
			primitives.push(roofIndex);
			primitives.list(run);
			upload.primitiveCount++;
		}
	}

	// a roof rises from the bottom, so it can top a region with no top
	const surfaces = regionSurfaces(region);
	const topFaceElevation = roofedTop && !Number.isFinite(top) ? Math.max(...roofedTop.pieces.map(piece => piece.high)) : region.elevation.top;
	let isFloorCandidate = false;
	for (const elevation of new Set([topFaceElevation, region.elevation.bottom])) {
		if (!Number.isFinite(elevation)) continue;
		const faceSurfaces = surfaces.filter(surface => surface.elevation === elevation);
		// a flat region's one face takes every placement, as core's surfaces do
		const faceBarrierIndices = barrierIndices.filter((_, position) => {
			const barrier = barriers[position];
			return bottom === top ? barrier.bottom || barrier.top : elevation === bottom ? barrier.bottom : barrier.top;
		});
		if (faceSurfaces.length || faceBarrierIndices.length) isFloorCandidate = true;
		// a flat region's one face is its top; a roofed top is a face per roof piece, each a plane with its own outline
		const isTop = elevation === topFaceElevation;
		const pushFace = (mask, box, plane, isShown, isConvexSolid, edges, paths) => {
			primitives.push(KIND_REGION_FACE, mask);
			pushBox(primitives, ...box);
			primitives.push(documentNumber, elevation, isTop ? 1 : 0, bottom, top, topInclusive);
			primitives.list(levelIndexes);
			primitives.push(faceSurfaces.length);
			for (const surface of faceSurfaces) primitives.push(surface.types, documentId(index, surface.behavior));
			primitives.list(faceBarrierIndices);
			primitives.push(plane ? 1 : 0, plane?.a ?? 0, plane?.b ?? 0, plane?.c ?? 0, isShown ? 1 : 0, isConvexSolid ? 1 : 0);
			primitives.list(edges);
			primitives.paths(paths);
			upload.primitiveCount++;
		};
		if (isTop && roofedTop) {
			for (const piece of roofedTop.pieces) {
				const pieceEdges = Float64Array.from(piece.paths.flatMap(path => Array.from(polygonToEdges(path, signedArea(path) < 0) ?? [])));
				const [pieceMinX, pieceMinY, pieceMaxX, pieceMaxY] = boundsOfEdges(pieceEdges);
				pushFace(REGION_SLOPE_MASK, [pieceMinX, pieceMinY, piece.low, pieceMaxX, pieceMaxY, piece.high], piece.plane, roof.show, roofedTop.isConvexSolid, pieceEdges, piece.paths);
			}
			continue;
		}
		pushFace(REGION_FACE_MASK, [minX, minY, elevation, maxX, maxY, elevation], null, true, false, regionEdges, EMPTY_ARRAY);
	}
	// its area (its outlines united even-odd) for the floor lighting's flat floors
	if (isFloorCandidate) {
		upload.areas.push(documentNumber);
		upload.areas.paths(
			union(
				regionOutlines(region).map(outline => outline.points),
				true
			)
		);
		upload.areaCount++;
	}
}

// Prisms from bottom to top, or ellipsoids. The layout must match store.rs Scene::upload_tokens.
function uploadTokens(scene, index) {
	index.documents.length = index.staticDocumentCount;
	for (const [document, id] of index.documentIds) if (id >= index.staticDocumentCount) index.documentIds.delete(document);
	const tokens = new Encoder();
	let tokenCount = 0;
	for (const token of scene.tokens) {
		const bottom = tokenBottom(token);
		const top = tokenTop(token);
		if (!(top > bottom)) continue;
		const footprint = tokenShapeData(token);
		const header = [documentId(index, token), index.levelIndexById.get(token.level) ?? -1];
		if (footprint.type === 'ellipse') {
			const {x: centerX, y: centerY, radiusX, radiusY} = footprint;
			if (!(radiusX > 0) || !(radiusY > 0)) continue;
			const radiusZ = (top - bottom) / 2;
			tokens.push(...header);
			pushBox(tokens, centerX - radiusX, centerY - radiusY, bottom, centerX + radiusX, centerY + radiusY, top);
			tokens.push(bottom, top, 1, centerX, centerY, bottom + radiusZ, radiusX, radiusY, radiusZ);
		} else {
			let points = footprint.points;
			if (footprint.type === 'rectangle') {
				const {x, y, width, height} = footprint;
				points = [x, y, x + width, y, x + width, y + height, x, y + height];
			}
			const edges = polygonToEdges(points);
			if (!edges) continue;
			const [minX, minY, maxX, maxY] = boundsOfEdges(edges);
			tokens.push(...header);
			pushBox(tokens, minX, minY, bottom, maxX, maxY, top);
			tokens.push(bottom, top, 0);
			tokens.list(edges);
		}
		tokenCount++;
	}
	callWasm(exports => {
		writeInput(exports, [tokenCount, ...tokens.values]);
		exports.scene_upload_tokens(index.slot);
	});
}

Hooks.once('init', invalidateIndexesOnDocumentChanges);
