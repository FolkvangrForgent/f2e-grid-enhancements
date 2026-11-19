// Edges are stored flat: startX, startY, endX, endY, outward unit normal X, Y.
export const EDGE_STRIDE = 6;
export const EDGE_END_X = 2;
export const EDGE_END_Y = 3;
export const EDGE_NORMAL_X = 4;
export const EDGE_NORMAL_Y = 5;

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

// A hole's normals point into it, which is out of its region. Null without area.
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
		// flipped below if the right-hand normal points inward
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

// [minX, minY, maxX, maxY]
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

export function distanceToSegment(x, y, startX, startY, endX, endY) {
	const edgeX = endX - startX;
	const edgeY = endY - startY;
	const lengthSquared = edgeX * edgeX + edgeY * edgeY;
	const fractionAlong = lengthSquared ? Math.clamp(((x - startX) * edgeX + (y - startY) * edgeY) / lengthSquared, 0, 1) : 0;
	return Math.hypot(startX + edgeX * fractionAlong - x, startY + edgeY * fractionAlong - y);
}

// Keeps alpha x + beta y + gamma <= 0 (Sutherland-Hodgman); null when less than a polygon is left.
export function clipToHalfPlane(points, alpha, beta, gamma) {
	const kept = [];
	const vertexCount = points.length / 2;
	for (let index = 0; index < vertexCount; index++) {
		const x = points[index * 2];
		const y = points[index * 2 + 1];
		const nextX = points[((index + 1) % vertexCount) * 2];
		const nextY = points[((index + 1) % vertexCount) * 2 + 1];
		const side = alpha * x + beta * y + gamma;
		const nextSide = alpha * nextX + beta * nextY + gamma;
		if (side <= 0) kept.push(x, y);
		if (side < 0 !== nextSide < 0 && side !== 0 && nextSide !== 0) {
			const t = side / (side - nextSide);
			kept.push(x + (nextX - x) * t, y + (nextY - y) * t);
		}
	}
	return kept.length >= 6 ? kept : null;
}
