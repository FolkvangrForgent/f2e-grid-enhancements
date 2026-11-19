// What a source reaches, drawn on the floors: every top or bottom barrier (a region face with a core surface or a Define Barrier
// on it) is a floor, and at each point of the map the floor shown is the highest one at or below the source, else the base
// floor (the bottom of the source's level, or the source's own height when the level has none or the source is below it).
// A floor point is lit when a ray from the source to it gets through, by the raycast's barrier rules (raycast/barrier-rules.js):
// every barrier between the source and the floor, walls with their heights, region sides and faces, casts its shadow on it,
// projected from the source. Floors themselves cast shadows on the floors below them.
import {gridUnitPixels} from '../helpers/grid.js';
import {levelConnectedIdentifiers} from '../helpers/level.js';
import {barriersSeenFrom, ELEVATION_HAIR as HAIR} from '../raycast/barrier-rules.js';
import {distanceToSegment, regionOutlines} from '../raycast/geometry.js';
import {getSceneIndex, REGION_FACE_MASK} from '../raycast/scene-index.js';
import {circlePath, clipToBox, coveredTwice, difference, grown, intersection, overlapTest, pathFromBox, scaledPath, segmentShadow, union, withWinding} from './shape.js';
import {visibilityPolygons} from './visibility.js';

// A region's area as flat paths (outlines positive, holes negative), worked out once per shape of the region.
const regionAreas = new WeakMap();
function regionArea(region) {
	let area = regionAreas.get(region.polygonTree);
	if (!area)
		regionAreas.set(
			region.polygonTree,
			(area = union(
				regionOutlines(region).map(outline => outline.points),
				true
			))
		);
	return area;
}

// Lit floor areas already worked out, by everything they depend on, while the scene's index stays the same (its generation
// moves on with any wall, door, region or level change): core makes every light's shape again whenever lighting is refreshed,
// most of them unchanged. Kept to the most recent CACHE_SIZE.
const CACHE_SIZE = 256;
const cachedByScene = new WeakMap();

// The lit floor area of a source, as flat paths (non-zero), within `box` ({minX, minY, maxX, maxY}). `source` is {scene,
// origin: {x, y, elevation}, type (the restriction type), level, radius, externalRadius, useThreshold}.
export function litFloorPaths(source, box) {
	const {scene, origin, type, level, radius = Infinity, externalRadius = 0, useThreshold = true} = source;
	const index = getSceneIndex(scene);
	let cache = cachedByScene.get(scene);
	if (cache?.generation !== index.generation) cachedByScene.set(scene, (cache = {generation: index.generation, paths: new Map()}));
	const key = [origin.x, origin.y, origin.elevation ?? 0, type, level?.id, radius, externalRadius, useThreshold, box.minX, box.minY, box.maxX, box.maxY].join('|');
	let paths = cache.paths.get(key);
	if (!paths) {
		paths = computeLitFloorPaths(index, source, box);
		if (cache.paths.size >= CACHE_SIZE) cache.paths.delete(cache.paths.keys().next().value);
		cache.paths.set(key, paths);
	}
	return paths;
}

function computeLitFloorPaths(index, {scene, origin, type, level, radius = Infinity, externalRadius = 0, useThreshold = true}, box) {
	const pixelsPerUnit = gridUnitPixels(scene.grid);
	const {x: sx, y: sy} = origin;
	const sz = origin.elevation ?? 0;

	// the source's level and the levels it sees, as for the raycast's rays; documents on no level always count
	const levelIds = levelConnectedIdentifiers(level, true);
	const activeLevels = levelIds ? new Set(levelIds.map(id => index.levelIndexById.get(id)).filter(levelIndex => levelIndex !== undefined)) : null;
	const isOnActiveLevel = levelIndexes => !activeLevels || !levelIndexes.length || levelIndexes.some(levelIndex => levelIndex < 0 || activeLevels.has(levelIndex));

	const levelBottom = level?.elevation?.bottom;
	const baseElevation = Number.isFinite(levelBottom) && levelBottom <= sz ? levelBottom : sz;

	// Every point of the box is within this of the source, so no shadow needs to reach further; nor past the radius (core's sweep
	// keeps the shape within it, a radius of 0 being none).
	const boxReach = Math.hypot(Math.max(sx - box.minX, box.maxX - sx), Math.max(sy - box.minY, box.maxY - sy));
	const farthest = (radius > 0 ? Math.min(boxReach, radius) : boxReach) + 1;
	const boxPath = pathFromBox(box);

	// the floors at or below the source, by height
	const floorsByHeight = new Map();
	index.bvh.visitOverlapping(box.minX, box.minY, baseElevation, box.maxX, box.maxY, sz + HAIR, REGION_FACE_MASK, primitiveIndex => {
		const face = index.primitives[primitiveIndex];
		if ((!face.surfaces.length && !face.barriers.length) || !isOnActiveLevel(face.levelIndexes)) return;
		if (face.elevation < baseElevation || face.elevation - HAIR > sz) return;
		if (!floorsByHeight.has(face.elevation)) floorsByHeight.set(face.elevation, new Set());
		floorsByHeight.get(face.elevation).add(face.document);
	});

	// Every barrier that can shade a floor between the base floor and the source, with its restriction as seen from the source,
	// gathered once for all floors: vertical ones (a wall's height range or a region side's edge; open doors let it through) and
	// horizontal ones below the source (a region's face).
	const seen = barriersSeenFrom(index, {x: sx, y: sy, elevation: sz, type, radius, externalRadius, useThreshold, isOnActiveLevel}, [
		box.minX,
		box.minY,
		Math.min(baseElevation, sz - 1),
		box.maxX,
		box.maxY,
		sz + HAIR
	]);
	const verticals = seen.filter(barrier => !barrier.faceEdges && !barrier.door?.isOpen);
	const horizontals = seen.filter(barrier => barrier.faceEdges && barrier.elevation < sz);

	// Floors often see the same barriers rising to the source (walls standing on the lowest floor): their visibility polygons
	// are made once, by the segments that go into them.
	const polygonsBySegments = new Map();

	// The lit part of the floor at height h where it is shown (`shown`, flat paths). Every barrier casts its shadow there, by its
	// restriction as seen from the source: hidden where a normal shadow or two limited ones fall, an attenuated barrier hiding
	// only beyond its reach. Most shadows are of barriers rising to the source's height or above, each hiding everything beyond
	// where it starts: together they leave a visibility polygon around the source (visibility.js), much cheaper than uniting
	// them. The rest (barriers below the source, attenuated or limited ones, and horizontal ones) are cut out of that, those not
	// touching `shown` left out (seen from high up, most walls stand under higher floors). Grown a hair, so neighbouring floors
	// overlap instead of meeting along a seam that rounding can open into a hairline shadow.
	const litOn = (h, shown) => {
		const touchesShown = overlapTest(shown);
		const drop = sz - h;
		const isEyeLevel = drop <= HAIR;
		const factorAt = z => drop / (sz - z);
		// an attenuated barrier lets the source through within its reach: a sphere, which meets this floor in a circle
		const reachOnFloor = reach => Math.sqrt(Math.max(0, reach * reach - (drop * pixelsPerUnit) ** 2));
		const normal = [];
		const limited = [];
		// the starts of the shadows that hide everything beyond them, as segments [ax, ay, bx, by, ...]: of normal barriers, and of
		// limited ones (two of which hide)
		const normalSegments = [];
		const limitedSegments = [];
		// and of attenuated ones, which only hide beyond their reach on this floor: [{segment, reach}]
		const attenuatedSegments = [];
		const addShadow = (paths, {kind, reach}) => {
			let shadow = paths.filter(Boolean);
			if (!shadow.length || !touchesShown(shadow)) return;
			if (reach !== Infinity) {
				const radiusOnFloor = reachOnFloor(reach);
				if (radiusOnFloor > 0) shadow = difference(shadow, [circlePath(sx, sy, radiusOnFloor)]);
			}
			if (kind === 'limited') limited.push(shadow);
			else normal.push(...shadow);
		};
		// The shadow of a vertical barrier (a wall's height range or a region side) from (ax, ay) to (bx, by), restricting as
		// `restriction`: on a floor below the source, the floor seen past its part between the floor and the source; at eye level, the
		// classic wedge behind it where it stands at the source's height.
		const addVerticalShadow = ({ax, ay, bx, by, bottom, top, restriction}) => {
			bottom -= HAIR;
			top -= HAIR;
			const maxFactor = farthest / Math.max(distanceToSegment(sx, sy, ax, ay, bx, by), 1);
			let near;
			let far;
			if (isEyeLevel) {
				if (!(bottom <= sz && top > sz)) return;
				near = 1;
				far = Infinity;
			} else {
				const low = Math.max(bottom, h);
				const high = Math.min(top, sz);
				if (!(high > low)) return;
				near = bottom <= h ? 1 : factorAt(low);
				far = top >= sz ? Infinity : factorAt(high);
			}
			if (!(near < maxFactor)) return;
			// rising to the source's height, a barrier without attenuation hides everything beyond where its shadow starts (a limited one
			// together with another)
			if (far === Infinity) {
				const segment = [sx + (ax - sx) * near, sy + (ay - sy) * near, sx + (bx - sx) * near, sy + (by - sy) * near];
				if (restriction.reach !== Infinity) attenuatedSegments.push({segment, reach: reachOnFloor(restriction.reach)});
				else (restriction.kind === 'limited' ? limitedSegments : normalSegments).push(...segment);
				return;
			}
			addShadow([segmentShadow(sx, sy, ax, ay, bx, by, near, Math.min(far, maxFactor), box)], restriction);
		};

		for (const vertical of verticals) addVerticalShadow(vertical);
		// a horizontal barrier between the floor and the source shades the floor with its region scaled from the source
		if (!isEyeLevel) {
			for (const {primitive, elevation, restriction} of horizontals) {
				if (!(elevation > h)) continue;
				const factor = Math.min(factorAt(elevation), farthest);
				addShadow(
					regionArea(primitive.document).map(path => clipToBox(scaledPath(path, sx, sy, factor), box)),
					restriction
				);
			}
		}

		const segmentsKey = `${normalSegments}|${limitedSegments}|${attenuatedSegments.map(({segment, reach}) => `${segment},${reach}`)}`;
		let polygons = polygonsBySegments.get(segmentsKey);
		if (!polygons) polygonsBySegments.set(segmentsKey, (polygons = visibilityPolygons(sx, sy, normalSegments, limitedSegments, box, attenuatedSegments)));
		const visible = [withWinding(polygons.visible, 1)];
		// two limited shadows overlapping block, as two limited walls do, and one falling beyond the first limited segment (behind
		// one already): where at least two of those overlap
		if (limited.length) {
			const beyondFirstLimited = limitedSegments.length ? difference(visible, [withWinding(polygons.beforeLimited, 1)]) : [];
			normal.push(...coveredTwice([...limited, beyondFirstLimited], box));
		}
		const within = normal.length ? intersection(union(normal), visible) : [];
		const hidden = within.length ? grown(within) : [];
		return grown(difference(intersection(shown, visible), hidden));
	};

	// From the highest floor down: each floor shows where no higher floor (at or below the source) already does; the base floor
	// shows everywhere else.
	const lit = [];
	let claimed = [];
	for (const height of [...floorsByHeight.keys()].sort((first, second) => second - first)) {
		const area = union([...floorsByHeight.get(height)].flatMap(regionArea));
		const shown = claimed.length ? difference(area, claimed) : area;
		claimed = union([...claimed, ...area]);
		if (shown.length) lit.push(...litOn(height, shown));
	}
	const baseShown = claimed.length ? difference([boxPath], claimed) : [boxPath];
	if (baseShown.length) lit.push(...litOn(baseElevation, baseShown));
	return union(lit);
}
