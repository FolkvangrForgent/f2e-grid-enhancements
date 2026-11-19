// 2D geometry for the index and the query. Polygon edges are stored flat: startX, startY, endX, endY, and the outward
// unit normal.
export const EDGE_STRIDE = 6;
export const EDGE_END_X = 2;
export const EDGE_END_Y = 3;
export const EDGE_NORMAL_X = 4;
export const EDGE_NORMAL_Y = 5;

// A region's outlines, holes included, as flat polygons [x0, y0, x1, y1, ...].
export function regionOutlines(region) {
	const outlines = [];
	const collect = node => {
		const points = node.polygon?.points;
		if (points?.length >= 6) outlines.push({points, isHole: node.isHole});
		for (const child of node.children) collect(child);
	};
	collect(region.polygonTree);
	return outlines;
}

// A flat polygon as edges with outward normals (into a hole, which is out of its region). Null without area.
export function polygonToEdges(points, isHole = false) {
	const vertexCount = points.length >> 1;
	if (vertexCount < 3) return null;
	const edges = new Float64Array(vertexCount * EDGE_STRIDE);
	let edgeCount = 0;
	let doubleArea = 0;
	for (let vertex = 0; vertex < vertexCount; vertex++) {
		const nextVertex = (vertex + 1) % vertexCount;
		const startX = points[2 * vertex];
		const startY = points[2 * vertex + 1];
		const endX = points[2 * nextVertex];
		const endY = points[2 * nextVertex + 1];
		doubleArea += startX * endY - endX * startY;
		const length = Math.hypot(endX - startX, endY - startY);
		if (!length) continue;
		// the normal to the right, flipped below if that points inward
		const offset = edgeCount++ * EDGE_STRIDE;
		edges[offset] = startX;
		edges[offset + 1] = startY;
		edges[offset + EDGE_END_X] = endX;
		edges[offset + EDGE_END_Y] = endY;
		edges[offset + EDGE_NORMAL_X] = (endY - startY) / length;
		edges[offset + EDGE_NORMAL_Y] = (startX - endX) / length;
	}
	if (!doubleArea) return null;
	if (doubleArea < 0 !== isHole) {
		for (let offset = 0; offset < edgeCount * EDGE_STRIDE; offset += EDGE_STRIDE) {
			edges[offset + EDGE_NORMAL_X] *= -1;
			edges[offset + EDGE_NORMAL_Y] *= -1;
		}
	}
	return edges.subarray(0, edgeCount * EDGE_STRIDE);
}

// [minX, minY, maxX, maxY] of some edges.
export function boundsOfEdges(edges) {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (let offset = 0; offset < edges.length; offset += EDGE_STRIDE) {
		minX = Math.min(minX, edges[offset], edges[offset + EDGE_END_X]);
		minY = Math.min(minY, edges[offset + 1], edges[offset + EDGE_END_Y]);
		maxX = Math.max(maxX, edges[offset], edges[offset + EDGE_END_X]);
		maxY = Math.max(maxY, edges[offset + 1], edges[offset + EDGE_END_Y]);
	}
	return [minX, minY, maxX, maxY];
}

// The distance from a point to a segment.
export function distanceToSegment(x, y, startX, startY, endX, endY) {
	const edgeX = endX - startX;
	const edgeY = endY - startY;
	const lengthSquared = edgeX * edgeX + edgeY * edgeY;
	const along = lengthSquared ? Math.clamp(((x - startX) * edgeX + (y - startY) * edgeY) / lengthSquared, 0, 1) : 0;
	return Math.hypot(startX + edgeX * along - x, startY + edgeY * along - y);
}

// The distance from a point to the nearest of some edges.
export function distanceToEdges(edges, x, y) {
	let nearest = Infinity;
	for (let offset = 0; offset < edges.length; offset += EDGE_STRIDE) {
		nearest = Math.min(nearest, distanceToSegment(x, y, edges[offset], edges[offset + 1], edges[offset + EDGE_END_X], edges[offset + EDGE_END_Y]));
	}
	return nearest;
}

// Even-odd point-in-polygon. A point exactly on the outline is moved a hair along the ray (`along` 1) or back (-1), then a
// smaller hair to the ray's positive side, as the crossings settle it. (dx, dy) is the ray's horizontal direction.
export function isPointInsideEdgesToward(edges, x, y, dx, dy, along = 1) {
	const nudgeX = along * dx;
	const nudgeY = along * dy;
	// whether a vertex at exactly y is above the point after both hairs (the positive side is (dy, -dx))
	const vertexAboveAtY = nudgeY < 0 || (nudgeY === 0 && dx > 0);
	let inside = false;
	for (let offset = 0; offset < edges.length; offset += EDGE_STRIDE) {
		const startX = edges[offset];
		const startY = edges[offset + 1];
		const endY = edges[offset + EDGE_END_Y];
		const startAbove = startY > y || (startY === y && vertexAboveAtY);
		const endAbove = endY > y || (endY === y && vertexAboveAtY);
		if (startAbove === endAbove) continue;
		const edgeX = edges[offset + EDGE_END_X] - startX;
		const edgeY = endY - startY;
		let side = edgeX * (y - startY) - (x - startX) * edgeY;
		if (side === 0) side = edgeX * nudgeY - nudgeX * edgeY;
		if (side === 0) side = -(edgeX * dx + edgeY * dy);
		if (side * edgeY > 0) inside = !inside;
	}
	return inside;
}

// Set by crossingT: which side of the ray's line each end of the crossed segment is on (0: on it). Read right after.
export let crossedSegmentStartSide = 0;
export let crossedSegmentEndSide = 0;

// Whether the last crossingT went through an end of the crossed segment (a polygon corner), and whether that crossing
// counts: through a corner only the edge whose other end is on the ray's positive side does, so a polygon is crossed once
// there, and a graze is an entry and an exit or nothing.
export const isCornerCrossing = () => crossedSegmentStartSide === 0 || crossedSegmentEndSide === 0;
export const isCountedCrossing = () => !isCornerCrossing() || crossedSegmentStartSide + crossedSegmentEndSide > 0;

// t along A-B where it crosses C-D, or NaN: foundry.utils.lineSegmentIntersection's tests (an endpoint touch crosses, a
// collinear pair does not) without allocating.
export function crossingT(ax, ay, bx, by, cx, cy, dx, dy) {
	const sideOfC = (ay - cy) * (bx - cx) - (ax - cx) * (by - cy);
	const sideOfD = (ay - dy) * (bx - dx) - (ax - dx) * (by - dy);
	if ((!sideOfC && !sideOfD) || sideOfC * sideOfD > 0) return NaN;
	const sideOfA = (cy - ay) * (dx - ax) - (cx - ax) * (dy - ay);
	const sideOfB = (cy - by) * (dx - bx) - (cx - bx) * (dy - by);
	if (sideOfA * sideOfB > 0) return NaN;
	crossedSegmentStartSide = sideOfC;
	crossedSegmentEndSide = sideOfD;
	return ((dx - cx) * (ay - cy) - (dy - cy) * (ax - cx)) / ((dy - cy) * (bx - ax) - (dx - cx) * (by - ay));
}
