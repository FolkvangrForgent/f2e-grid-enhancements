import {gridHexCachedPath, gridSquareCachedPath, gridUnitPixels} from './grid.js';

// Per TokenDocument, values worked out from its geometry, by name, for the grid they were worked out on. They are all
// dropped when anything they depend on changes (tokenSignature), so a token index rebuilt after one token moves, or an
// aura tested against the same tokens again, reuses the rest.
const geometryCaches = new WeakMap();

// What a token's geometry depends on.
export function tokenSignature(token) {
	return `${token.x}|${token.y}|${token.elevation}|${token.width}|${token.height}|${token.depth}|${token.shape}`;
}

// A token's cached value for `name` on `grid` (its scene's by default), computed on a miss. Cached values are shared, so
// callers must not change them.
export function tokenCached(token, name, compute, grid = token.scene.grid) {
	const signature = tokenSignature(token);
	let cache = geometryCaches.get(token);
	if (cache?.signature !== signature || cache.grid !== grid) geometryCaches.set(token, (cache = {signature, grid, values: new Map()}));
	let value = cache.values.get(name);
	if (value === undefined) cache.values.set(name, (value = compute()));
	return value;
}

export function tokenWidth(token) {
	token = token.document ?? token;
	if (token.scene.grid.isGridless) return Math.max(token.width, 0.5);
	return token.width < 0.75 ? 0.5 : Math.round(token.width);
}

export function tokenHeight(token) {
	token = token.document ?? token;
	if (token.scene.grid.isGridless) return Math.max(token.height, 0.5);
	return token.height < 0.75 ? 0.5 : Math.round(token.height);
}

export function tokenDepth(token) {
	token = token.document ?? token;
	if (token.scene.grid.isGridless) return Math.max(token.depth, 0.5);
	return token.depth < 0.75 ? 0.5 : Math.round(token.depth);
}

export function tokenBottom(token) {
	token = token.document ?? token;
	return token.scene.grid.isGridless ? token.elevation : token._positionToGridOffset().k * token.scene.grid.distance;
}

export function tokenTop(token) {
	token = token.document ?? token;
	return tokenBottom(token) + tokenDepth(token) * token.scene.grid.distance;
}

export function tokenCenterTop(token) {
	token = token.document ?? token;
	return {...token.getCenterPoint(), elevation: tokenTop(token)};
}

export function tokenCenterMiddle(token) {
	token = token.document ?? token;
	return {...token.getCenterPoint(), elevation: (tokenBottom(token) + tokenTop(token)) / 2};
}

export function tokenCenterBottom(token) {
	token = token.document ?? token;
	return {...token.getCenterPoint(), elevation: tokenBottom(token)};
}

export function tokenShape(token) {
	token = token.document ?? token;
	if (token.scene.grid.isSquare) {
		switch (token.shape) {
			case CONST.TOKEN_SHAPES.ELLIPSE_1:
			case CONST.TOKEN_SHAPES.TRAPEZOID_1:
			case CONST.TOKEN_SHAPES.RECTANGLE_1:
				return CONST.TOKEN_SHAPES.RECTANGLE_1;
			case CONST.TOKEN_SHAPES.ELLIPSE_2:
			case CONST.TOKEN_SHAPES.TRAPEZOID_2:
			case CONST.TOKEN_SHAPES.RECTANGLE_2:
				return CONST.TOKEN_SHAPES.RECTANGLE_2;
		}
	} else if (token.scene.grid.isGridless) {
		switch (token.shape) {
			case CONST.TOKEN_SHAPES.ELLIPSE_1:
				return CONST.TOKEN_SHAPES.ELLIPSE_1;
			case CONST.TOKEN_SHAPES.ELLIPSE_2:
				return CONST.TOKEN_SHAPES.ELLIPSE_2;
			case CONST.TOKEN_SHAPES.TRAPEZOID_1:
			case CONST.TOKEN_SHAPES.RECTANGLE_1:
				return CONST.TOKEN_SHAPES.RECTANGLE_1;
			case CONST.TOKEN_SHAPES.TRAPEZOID_2:
			case CONST.TOKEN_SHAPES.RECTANGLE_2:
				return CONST.TOKEN_SHAPES.RECTANGLE_2;
		}
	} else {
		return token.shape;
	}
}

export function tokenIsEllipseShape(token) {
	const shape = tokenShape(token);
	return shape === CONST.TOKEN_SHAPES.ELLIPSE_1 || shape === CONST.TOKEN_SHAPES.ELLIPSE_2;
}

export function tokenIsRectangleShape(token) {
	const shape = tokenShape(token);
	return shape === CONST.TOKEN_SHAPES.RECTANGLE_1 || shape === CONST.TOKEN_SHAPES.RECTANGLE_2;
}

export function tokenIsTrapezoidShape(token) {
	const shape = tokenShape(token);
	return shape === CONST.TOKEN_SHAPES.TRAPEZOID_1 || shape === CONST.TOKEN_SHAPES.TRAPEZOID_2;
}

export function tokenShapeData(token) {
	token = token.document ?? token;
	return tokenCached(token, 'shapeData', () => computeShapeData(token));
}

function computeShapeData(token) {
	if (!token.scene.grid.isGridless) {
		return {type: 'polygon', points: offsetPolygons(token.scene.grid, tokenFootprintOffsets(token))[0].points};
	}
	const width = tokenWidth(token) * token.scene.grid.size;
	const height = tokenHeight(token) * token.scene.grid.size;
	if (tokenIsEllipseShape(token)) {
		return {type: 'ellipse', x: token.x + width / 2, y: token.y + height / 2, radiusX: width / 2, radiusY: height / 2};
	}
	return {type: 'rectangle', x: token.x, y: token.y, width, height};
}

export function tokenShapeAlternate(token) {
	token = token.document ?? token;
	switch (token.shape) {
		case CONST.TOKEN_SHAPES.ELLIPSE_1:
			return CONST.TOKEN_SHAPES.ELLIPSE_2;
		case CONST.TOKEN_SHAPES.TRAPEZOID_1:
			return CONST.TOKEN_SHAPES.TRAPEZOID_2;
		case CONST.TOKEN_SHAPES.RECTANGLE_1:
			return CONST.TOKEN_SHAPES.RECTANGLE_2;
		case CONST.TOKEN_SHAPES.ELLIPSE_2:
			return CONST.TOKEN_SHAPES.ELLIPSE_1;
		case CONST.TOKEN_SHAPES.TRAPEZOID_2:
			return CONST.TOKEN_SHAPES.TRAPEZOID_1;
		case CONST.TOKEN_SHAPES.RECTANGLE_2:
			return CONST.TOKEN_SHAPES.RECTANGLE_1;
	}
}

export function tokenFootprintOffsets(token) {
	token = token.document ?? token;
	return tokenCached(token, 'footprintOffsets', () => computeFootprintOffsets(token));
}

function computeFootprintOffsets(token) {
	const offsets = [];
	const width = tokenWidth(token);
	const height = tokenHeight(token);
	const {i: minI, j: minJ} = token._positionToGridOffset({width, height});
	if (token.scene.grid.isSquare) {
		const maxI = minI + Math.ceil(height);
		const maxJ = minJ + Math.ceil(width);
		for (let i = minI; i < maxI; i++) {
			for (let j = minJ; j < maxJ; j++) {
				offsets.push({i, j});
			}
		}
	} else if (token.scene.grid.isHexagonal) {
		const {even, odd} = foundry.documents.BaseToken._getHexagonalOffsets(width, height, tokenShape(token), token.scene.grid.columns);
		for (const offset of ((token.scene.grid.columns ? minJ : minI) % 2 === 0) === token.scene.grid.even ? even : odd) {
			offsets.push({i: minI + offset.i, j: minJ + offset.j});
		}
	}
	return offsets;
}

export function tokenVolumeOffsets(token) {
	token = token.document ?? token;
	const {k: minK} = token._positionToGridOffset();
	const maxK = minK + Math.ceil(tokenDepth(token));
	const offsets = [];
	for (const {i, j} of tokenFootprintOffsets(token)) {
		for (let k = minK; k < maxK; k++) {
			offsets.push({i, j, k});
		}
	}
	return offsets;
}

export function tokenPolygons(token) {
	token = token.document ?? token;
	return tokenCached(token, 'polygons', () => computePolygons(token));
}

function computePolygons(token) {
	if (token.scene.grid.isGridless) {
		const base = tokenShapeData(token);
		const ShapeData = base.type === 'ellipse' ? foundry.data.EllipseShapeData : foundry.data.RectangleShapeData;
		return new ShapeData(base).polygons;
	}
	return offsetPolygons(token.scene.grid, tokenFootprintOffsets(token));
}

// TODO review \/ \/ \/

// eee
export function tokenAuraFootprintOffsets(token, radius, hole) {
	token = token.document ?? token;
	const offsets = [];
	for (const {i, j, isOwn} of auraFootprintGaps(token, radius)) {
		if (!hole || !isOwn) offsets.push({i, j});
	}
	return offsets;
}

// The grid spaces within `radius` (grid units) of a token's volume, as {i, j, k}; with `hole`, without the token's own
// spaces. Each is measured like distance: core's measurePath across the gap to the nearest of the token's spaces, so the
// scene's diagonal rule applies up and down too. None on gridless scenes.
export function tokenAuraVolumeOffsets(token, radius, hole) {
	token = token.document ?? token;
	const offsets = [];
	const {k: minK} = token._positionToGridOffset();
	const maxK = minK + Math.ceil(tokenDepth(token)) - 1;
	const layers = Math.floor(radius / token.scene.grid.distance + 1e-9);
	for (const {i, j, gap, isOwn} of auraFootprintGaps(token, radius)) {
		for (let k = minK - layers; k <= maxK + layers; k++) {
			const layerGap = Math.max(minK - k, 0, k - maxK);
			if (isOwn && layerGap === 0) {
				if (!hole) offsets.push({i, j, k});
			} else if (auraGapDistance(token.scene.grid, gap, layerGap) <= radius + 1e-9) {
				offsets.push({i, j, k});
			}
		}
	}
	return offsets;
}

// The grid offsets within `radius` (grid units) of a token's footprint, its own first (`isOwn`), each with its `gap` to
// the nearest of the token's offsets: on square grids the row and column gaps {i, j}, on hex its number of {steps}. None
// on gridless scenes.
function auraFootprintGaps(token, radius) {
	if (!token.scene.grid.isSquare && !token.scene.grid.isHexagonal) return [];
	const tokenOffsets = tokenFootprintOffsets(token);
	const rings = Math.floor(radius / token.scene.grid.distance + 1e-9);
	if (token.scene.grid.isSquare) {
		// The token's offsets are a rectangle, and every diagonal rule grows with the gap along each axis, so an offset's
		// distance is that across its gap to the rectangle, and no offset farther than `rings` along either axis is in range.
		const gaps = tokenOffsets.map(({i, j}) => ({i, j, gap: {i: 0, j: 0}, isOwn: true}));
		const rows = tokenOffsets.map(offset => offset.i);
		const columns = tokenOffsets.map(offset => offset.j);
		const [minI, maxI, minJ, maxJ] = [Math.min(...rows), Math.max(...rows), Math.min(...columns), Math.max(...columns)];
		for (let i = minI - rings; i <= maxI + rings; i++) {
			for (let j = minJ - rings; j <= maxJ + rings; j++) {
				const gap = {i: Math.max(minI - i, 0, i - maxI), j: Math.max(minJ - j, 0, j - maxJ)};
				if (!gap.i && !gap.j) continue;
				if (auraGapDistance(token.scene.grid, gap, 0) <= radius + 1e-9) gaps.push({i, j, gap, isOwn: false});
			}
		}
		return gaps;
	}
	// on hex grids an offset's distance is its number of steps, so the offsets in range are grown a ring at a time
	const gaps = tokenOffsets.map(({i, j}) => ({i, j, gap: {steps: 0}, isOwn: true}));
	const reachedKeys = new Set(tokenOffsets.map(offset => `${offset.i},${offset.j}`));
	let outerRing = tokenOffsets;
	for (let steps = 1; steps <= rings && outerRing.length; steps++) {
		const nextRing = [];
		for (const offset of outerRing) {
			for (const neighbour of token.scene.grid.getAdjacentOffsets(offset)) {
				const key = `${neighbour.i},${neighbour.j}`;
				if (reachedKeys.has(key)) continue;
				reachedKeys.add(key);
				nextRing.push(neighbour);
				gaps.push({i: neighbour.i, j: neighbour.j, gap: {steps}, isOwn: false});
			}
		}
		outerRing = nextRing;
	}
	return gaps;
}

// The distance across one of auraFootprintGaps' gaps and `k` layers.
function auraGapDistance(grid, gap, k) {
	return (grid.isHexagonal ? gridHexCachedPath(grid, gap.steps, k) : gridSquareCachedPath(grid, gap.i, gap.j, k)).distance;
}

export function tokenAuraPolygons(token, radius, hole) {
	token = token.document ?? token;
	if (token.scene.grid.isGridless) {
		return new foundry.data.EmanationShapeData({
			type: 'emanation',
			base: {...tokenShapeData(token), hole},
			radius: radius * gridUnitPixels(token.scene.grid),
			gridBased: false
		}).polygons;
	}
	return offsetPolygons(token.scene.grid, tokenAuraFootprintOffsets(token, radius, hole));
}

// A gridless token's footprint as region shape data: an ellipse for the ellipse shapes, otherwise its rectangle.

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

// Points spread over the surface of a token's volume, for testing whether anything reaches it.
export function tokenSurfacePoints(token) {
	token = token.document ?? token;
	return tokenCached(token, 'surfacePoints', () => computeSurfacePoints(token));
}

function computeSurfacePoints(token) {
	if (token.scene.grid.isHexagonal) {
		// the outline's corners and side midpoints every half space up its column, and on its top and bottom each offset's
		// centre, corners, and the points a quarter and half way to each neighbouring offset's centre
		const depth = tokenDepth(token);
		const bottom = tokenBottom(token);
		const top = tokenTop(token);
		const pointsByKey = new Map();
		const addPoint = (x, y, elevation) => {
			pointsByKey.set(`${Math.round(x * 100)}|${Math.round(y * 100)}|${Math.round(elevation * 100)}`, {
				x,
				y,
				elevation
			});
		};
		const offsets = tokenFootprintOffsets(token);
		const outlines = tokenPolygons(token);
		for (let height = 0; height <= depth; height += 0.5) {
			const elevation = bottom + height * token.scene.grid.distance;
			for (const {points} of outlines) {
				for (let index = 0; index < points.length; index += 2) {
					const next = (index + 2) % points.length;
					addPoint(points[index], points[index + 1], elevation);
					addPoint((points[index] + points[next]) / 2, (points[index + 1] + points[next + 1]) / 2, elevation);
				}
			}
		}
		for (const offset of offsets) {
			const center = token.scene.grid.getCenterPoint(offset);
			addPoint(center.x, center.y, top);
			addPoint(center.x, center.y, bottom);
			for (const neighbour of token.scene.grid.getAdjacentOffsets(offset)) {
				const neighbourCenter = token.scene.grid.getCenterPoint(neighbour);
				const quarterX = (center.x * 3 + neighbourCenter.x) / 4;
				const quarterY = (center.y * 3 + neighbourCenter.y) / 4;
				const halfX = (center.x + neighbourCenter.x) / 2;
				const halfY = (center.y + neighbourCenter.y) / 2;
				addPoint(quarterX, quarterY, top);
				addPoint(quarterX, quarterY, bottom);
				addPoint(halfX, halfY, top);
				addPoint(halfX, halfY, bottom);
			}
			for (const corner of token.scene.grid.getVertices(offset)) {
				addPoint(corner.x, corner.y, top);
				addPoint(corner.x, corner.y, bottom);
			}
		}
		return Array.from(pointsByKey.values());
	}
	// on square grids the token's offsets (a tiny token fills the square under its centre, as in pf2e)
	const isSquare = token.scene.grid.isSquare;
	const width = isSquare ? Math.ceil(tokenWidth(token)) : tokenWidth(token);
	const height = isSquare ? Math.ceil(tokenHeight(token)) : tokenHeight(token);
	const depth = tokenDepth(token);
	const corner = isSquare ? token.scene.grid.getTopLeftPoint(token._positionToGridOffset({width: tokenWidth(token), height: tokenHeight(token)})) : token;
	const topLeft = {x: corner.x, y: corner.y, elevation: tokenBottom(token)};
	const points = [];
	// samples about every half space along each side (exactly every half space on gridded scenes)
	const stepsX = Math.ceil(width * 2);
	const stepsY = Math.ceil(height * 2);
	const stepsZ = Math.ceil(depth * 2);
	if (tokenIsEllipseShape(token)) {
		// a Fibonacci lattice on the ellipsoid, with as many points as the box of the same size gets
		const count = (stepsX + 1) * (stepsY + 1) * (stepsZ + 1) - Math.max(0, stepsX - 1) * Math.max(0, stepsY - 1) * Math.max(0, stepsZ - 1);
		const middleX = topLeft.x + (width / 2) * token.scene.grid.size;
		const middleY = topLeft.y + (height / 2) * token.scene.grid.size;
		const middleElevation = topLeft.elevation + (depth / 2) * token.scene.grid.distance;
		for (let index = 0; index < count; index++) {
			const unitZ = count > 1 ? 1 - (2 * index) / (count - 1) : 0;
			const unitRadius = Math.sqrt(Math.max(0, 1 - unitZ * unitZ));
			const angle = index * GOLDEN_ANGLE;
			points.push({
				x: middleX + (width / 2) * unitRadius * Math.cos(angle) * token.scene.grid.size,
				y: middleY + (height / 2) * unitRadius * Math.sin(angle) * token.scene.grid.size,
				elevation: middleElevation + (depth / 2) * unitZ * token.scene.grid.distance
			});
		}
	} else if (tokenIsRectangleShape(token)) {
		// the samples on the box's faces
		for (let stepX = 0; stepX <= stepsX; stepX++) {
			for (let stepY = 0; stepY <= stepsY; stepY++) {
				for (let stepZ = 0; stepZ <= stepsZ; stepZ++) {
					const isOnFace = stepX === 0 || stepX === stepsX || stepY === 0 || stepY === stepsY || stepZ === 0 || stepZ === stepsZ;
					if (!isOnFace) continue;
					points.push({
						x: topLeft.x + ((stepX * width) / stepsX) * token.scene.grid.size,
						y: topLeft.y + ((stepY * height) / stepsY) * token.scene.grid.size,
						elevation: topLeft.elevation + ((stepZ * depth) / stepsZ) * token.scene.grid.distance
					});
				}
			}
		}
	}
	return points;
}

// The outline of some grid offsets as polygons, the largest first. Each offset adds its sides as directed edges; a
// side shared by two offsets appears once in each direction and cancels, leaving the outline, whose edges are chained into
// closed loops.
function offsetPolygons(grid, offsets) {
	const edges = new Map();
	for (const offset of offsets) {
		const vertices = grid.getVertices(offset);
		for (let index = 0; index < vertices.length; index++) {
			const start = vertices[index];
			const end = vertices[(index + 1) % vertices.length];
			// vertices shared by neighbouring offsets differ by rounding, so they are matched to a hundredth of a pixel
			const startKey = `${Math.round(start.x * 100)},${Math.round(start.y * 100)}`;
			const endKey = `${Math.round(end.x * 100)},${Math.round(end.y * 100)}`;
			if (edges.delete(`${endKey}>${startKey}`)) continue;
			edges.set(`${startKey}>${endKey}`, {start, end, startKey, endKey});
		}
	}
	const edgeByStartKey = new Map();
	for (const edge of edges.values()) edgeByStartKey.set(edge.startKey, edge);
	const polygons = [];
	while (edgeByStartKey.size) {
		const points = [];
		let edge = edgeByStartKey.values().next().value;
		while (edge) {
			edgeByStartKey.delete(edge.startKey);
			points.push(edge.start.x, edge.start.y);
			edge = edgeByStartKey.get(edge.endKey);
		}
		if (points.length >= 6) polygons.push(new PIXI.Polygon(points));
	}
	return polygons.sort((a, b) => b.points.length - a.points.length);
}
