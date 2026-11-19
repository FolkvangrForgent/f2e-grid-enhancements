// How barriers (walls, region surfaces and Define Barrier behaviors) treat a source, shared by the raycast (query.js) and the
// visualizer (visulizer/): thresholds and attenuation in 3D, and how a crossing restricts a source's own type as seen from
// the source.
import {distanceToEdges, distanceToSegment, EDGE_END_X, EDGE_END_Y, EDGE_NORMAL_X, EDGE_NORMAL_Y, EDGE_STRIDE, isPointInsideEdgesToward} from './geometry.js';
import {KIND_REGION_SIDE, KIND_WALL, REGION_FACE_MASK, REGION_SIDE_MASK} from './scene-index.js';
import {bitOfType} from './types.js';

// A ray from a source lies a hair above it (elevationBias 'above'), so heights seen from a source are lowered by this much: one
// level with a wall's bottom meets the wall and one level with its top does not, and a source on a face is above it.
export const ELEVATION_HAIR = 1e-7;

// What a Proximity or Reverse Proximity barrier's threshold does for a source whose origin is `inside` pixels from the
// barrier's nearest point (3D): core's Edge#applyThreshold rule for whether it lets the source through (null if not: it
// restricts as usual), and if so how far from the origin it reaches, in pixels. Without attenuation that is unlimited; with
// it, core's attenuation (PointSourcePolygon's threshold shapes) as a sphere: the source reaches past the barrier by less the
// closer its origin is to the threshold distance, never beyond `radius`.
export function thresholdReach(sense, threshold, attenuation, inside, radius, externalRadius) {
	const isProximity = sense === CONST.EDGE_SENSE_TYPES.PROXIMITY;
	const sourceDistance = isProximity ? Math.max(inside - externalRadius, 0) : inside + externalRadius;
	const isLetThrough = isProximity ? sourceDistance < threshold : sourceDistance > threshold;
	if (!isLetThrough) return null;
	if (!attenuation) return Infinity;
	const outside = radius - inside;
	if (!(outside > 0)) return inside;
	const thresholdProportion = sourceDistance / threshold;
	const proportionInverse = isProximity ? 1 - thresholdProportion : Math.min(1, thresholdProportion - 1);
	const attenuationFactor = (proportionInverse / (2 * (1 - proportionInverse))) * CONFIG.Wall.thresholdAttenuationMultiplier;
	return inside + Math.min(attenuationFactor * threshold, outside);
}

// How a barrier restricting a source's own type at `sense` hides what is behind it from the source: {kind: 'normal' or
// 'limited', reach} (reach Infinity, or the distance from the source beyond which an attenuated barrier hides), or null
// when it lets the source through. `distance()` is from the source to the barrier's nearest point (see thresholdReach).
export function restrictionSeenFrom(sense, threshold, attenuation, distance, radius, externalRadius = 0) {
	const {NONE, LIMITED, PROXIMITY} = CONST.EDGE_SENSE_TYPES;
	if (!sense || sense === NONE) return null;
	if (threshold && sense >= PROXIMITY) {
		const reach = thresholdReach(sense, threshold, attenuation, distance(), radius, externalRadius);
		if (reach === Infinity) return null;
		if (reach !== null) return {kind: 'normal', reach};
	}
	return {kind: sense === LIMITED ? 'limited' : 'normal', reach: Infinity};
}

// How a crossing of some barriers (region/barrier.js) restricts a source's own type, as seen from the source (see
// restrictionSeenFrom): one-way barriers by the way the source crosses them, as core does (edgeDirectionMode NORMAL).
export function barrierRestrictionSeenFrom(barriers, type, entering, distance, radius, externalRadius = 0) {
	let kind = null;
	let reach = Infinity;
	for (const barrier of barriers) {
		if (barrier.direction !== 'both' && (barrier.direction === 'in') !== entering) continue;
		const restriction = restrictionSeenFrom(barrier.senses[type], barrier.thresholds[type], barrier.attenuation, distance, radius, externalRadius);
		if (!restriction) continue;
		if (restriction.reach !== Infinity) reach = Math.min(reach, restriction.reach);
		else if (restriction.kind === 'normal' || kind === null) kind = restriction.kind;
	}
	// a barrier restricting outright wins over one that only attenuates, as for rays (query.js addBarrierHit)
	if (kind) return {kind, reach: Infinity};
	return reach !== Infinity ? {kind: 'normal', reach} : null;
}

// From a point to the nearest point of a wall's height range, in pixels (pixelsPerUnit scales elevation): to the wall in plan,
// and up or down to it when the point is beyond its bottom or top.
export function distanceToWall(wall, {bottom, top}, x, y, elevation, pixelsPerUnit) {
	const vertical = Math.max(0, bottom - elevation, elevation - top) * pixelsPerUnit;
	return Math.hypot(distanceToSegment(x, y, wall.startX, wall.startY, wall.endX, wall.endY), vertical);
}

// From a point to the nearest point of a region face, in pixels: straight up or down when above or below the region, else to
// its outline. (dx, dy) settles a point exactly on the outline (see isPointInsideEdgesToward).
export function distanceToFace(face, x, y, elevation, pixelsPerUnit, dx = 1, dy = 0) {
	const vertical = Math.abs(elevation - face.elevation) * pixelsPerUnit;
	if (isPointInsideEdgesToward(face.edges, x, y, dx, dy)) return vertical;
	return Math.hypot(distanceToEdges(face.edges, x, y), vertical);
}

// From a point to the nearest point of one side of a region (its edge at `offset`), in pixels: to the side in plan, and up or
// down to it when the point is beyond the region's bottom or top.
export function distanceToSide(prism, offset, x, y, elevation, pixelsPerUnit) {
	const edges = prism.edges.subarray(offset, offset + EDGE_STRIDE);
	const vertical = Math.max(0, prism.bottom - elevation, elevation - prism.top) * pixelsPerUnit;
	return Math.hypot(distanceToEdges(edges, x, y), vertical);
}

// Every barrier in a scene index (scene-index.js) that restricts a source's own type, within a box, with its restriction as
// seen from the source ({kind, reach}, see restrictionSeenFrom): what the raycast's source shadows (query.js) and the
// visualizer's floors (visulizer/floors.js) are cut by. Each is {primitive, primitiveIndex, restriction} and either a vertical
// barrier's {ax, ay, bx, by, bottom, top, door} (a wall's height range, or a region side's edge; `door` the wall's document when
// it is a door, which callers read live) or a face's {faceEdges, elevation} (lowered a hair). `source` is {x, y, elevation,
// type, radius, externalRadius, useThreshold (false: thresholds block outright, as core's useThreshold), isOnActiveLevel
// (levelIndexes => whether barriers on those levels count; all by default)}; `bounds` is [minX, minY, minZ, maxX, maxY, maxZ].
export function barriersSeenFrom(index, source, bounds) {
	const {x, y, elevation, type, radius, externalRadius = 0, useThreshold = true, isOnActiveLevel = () => true} = source;
	const pixelsPerUnit = index.pixelsPerUnit;
	const typeBit = bitOfType(type);
	const thresholdOf = threshold => (useThreshold ? threshold : null);
	const barriersOf = barriers => (useThreshold ? barriers : barriers.map(barrier => ({...barrier, thresholds: {}})));
	const seen = [];
	index.bvh.visitOverlapping(...bounds, typeBit | REGION_SIDE_MASK | REGION_FACE_MASK, primitiveIndex => {
		const primitive = index.primitives[primitiveIndex];
		if (primitive.kind === KIND_WALL) {
			const {edge} = primitive;
			if (!edge[type]) return;
			// one-way walls as for a ray from the source
			if (edge.direction && edge.orientPoint({x, y}) === edge.direction) return;
			for (const range of primitive.heightRanges) {
				// a range with its top at or below its bottom stands nowhere
				if (!(range.top > range.bottom) || !isOnActiveLevel([range.levelIndex])) continue;
				const distance = () => distanceToWall(primitive, range, x, y, elevation, pixelsPerUnit);
				const restriction = restrictionSeenFrom(edge[type], thresholdOf(edge.threshold?.[type]), edge.threshold?.attenuation, distance, radius, externalRadius);
				if (!restriction) continue;
				const door = primitive.isDoor ? primitive.document : null;
				seen.push({primitive, primitiveIndex, restriction, ax: primitive.startX, ay: primitive.startY, bx: primitive.endX, by: primitive.endY, bottom: range.bottom, top: range.top, door});
			}
		} else if (primitive.kind === KIND_REGION_SIDE) {
			if (!primitive.barriers?.length || !isOnActiveLevel(primitive.levelIndexes)) return;
			const {edges} = primitive;
			for (let offset = 0; offset < edges.length; offset += EDGE_STRIDE) {
				// outward normals: the source outside the side crosses it going in
				const entering = edges[offset + EDGE_NORMAL_X] * (x - edges[offset]) + edges[offset + EDGE_NORMAL_Y] * (y - edges[offset + 1]) > 0;
				const distance = () => distanceToSide(primitive, offset, x, y, elevation, pixelsPerUnit);
				const restriction = barrierRestrictionSeenFrom(barriersOf(primitive.barriers), type, entering, distance, radius, externalRadius);
				if (!restriction) continue;
				seen.push({
					primitive,
					primitiveIndex,
					restriction,
					ax: edges[offset],
					ay: edges[offset + 1],
					bx: edges[offset + EDGE_END_X],
					by: edges[offset + EDGE_END_Y],
					bottom: primitive.bottom,
					top: primitive.top,
					door: null
				});
			}
		} else {
			if (!isOnActiveLevel(primitive.levelIndexes)) return;
			// core's surfaces restrict their types fully; barriers as for a ray from the source (going in through the top going
			// down, through the bottom going up; a flat region's face goes in going down)
			const faceElevation = primitive.elevation - ELEVATION_HAIR;
			const isGoingDown = elevation > faceElevation;
			const entering = primitive.top > primitive.bottom ? (primitive.elevation === primitive.top) === isGoingDown : isGoingDown;
			const restriction = primitive.surfaces.some(surface => surface.types & typeBit)
				? {kind: 'normal', reach: Infinity}
				: barrierRestrictionSeenFrom(barriersOf(primitive.barriers), type, entering, () => distanceToFace(primitive, x, y, elevation, pixelsPerUnit), radius, externalRadius);
			if (restriction) seen.push({primitive, primitiveIndex, restriction, faceEdges: primitive.edges, elevation: faceElevation});
		}
	});
	return seen;
}
