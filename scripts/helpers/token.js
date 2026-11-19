import {gridSquareCachedPath, gridUnitPixels} from './grid.js';

// Dropped whenever tokenSignature changes, so a token index rebuilt after one token moves, or an aura tested against
// the same tokens again, reuses every other token's values.
const geometryCachesByToken = new WeakMap();
const ROUNDING_TOLERANCE = 1e-9;

const asTokenDocument = tokenOrPlaceable => tokenOrPlaceable.document ?? tokenOrPlaceable;

function tokenSignature(token) {
	return `${token.x}|${token.y}|${token.elevation}|${token.width}|${token.height}|${token.depth}|${token.shape}`;
}

// Cached values are shared: callers must not change them.
export function tokenCached(token, valueName, computeValue, grid = token.scene.grid) {
	const signature = tokenSignature(token);
	let cache = geometryCachesByToken.get(token);
	if (cache?.signature !== signature || cache.grid !== grid) geometryCachesByToken.set(token, (cache = {signature, grid, values: new Map()}));
	let value = cache.values.get(valueName);
	if (value === undefined) cache.values.set(valueName, (value = computeValue()));
	return value;
}

const TINY_SIZE = 0.5;
const LARGEST_SIZE_ROUNDED_TO_TINY = 0.75;

function tokenSizeInSpaces(tokenOrPlaceable, dimension) {
	const token = asTokenDocument(tokenOrPlaceable);
	const size = token[dimension];
	if (token.scene.grid.isGridless) return Math.max(size, TINY_SIZE);
	return size < LARGEST_SIZE_ROUNDED_TO_TINY ? TINY_SIZE : Math.round(size);
}

export const tokenWidth = token => tokenSizeInSpaces(token, 'width');
export const tokenHeight = token => tokenSizeInSpaces(token, 'height');
export const tokenDepth = token => tokenSizeInSpaces(token, 'depth');

export function tokenBottom(tokenOrPlaceable) {
	const token = asTokenDocument(tokenOrPlaceable);
	return token.scene.grid.isGridless ? token.elevation : token._positionToGridOffset().k * token.scene.grid.distance;
}

export function tokenTop(tokenOrPlaceable) {
	const token = asTokenDocument(tokenOrPlaceable);
	return tokenBottom(token) + tokenDepth(token) * token.scene.grid.distance;
}

export function tokenCenterTop(tokenOrPlaceable) {
	const token = asTokenDocument(tokenOrPlaceable);
	return {...token.getCenterPoint(), elevation: tokenTop(token)};
}

export function tokenCenterMiddle(tokenOrPlaceable) {
	const token = asTokenDocument(tokenOrPlaceable);
	return {...token.getCenterPoint(), elevation: (tokenBottom(token) + tokenTop(token)) / 2};
}

export function tokenCenterBottom(tokenOrPlaceable) {
	const token = asTokenDocument(tokenOrPlaceable);
	return {...token.getCenterPoint(), elevation: tokenBottom(token)};
}

const {ELLIPSE_1, ELLIPSE_2, TRAPEZOID_1, TRAPEZOID_2, RECTANGLE_1, RECTANGLE_2} = CONST.TOKEN_SHAPES;
// Square grids draw every shape as a rectangle; gridless ones draw a trapezoid as a rectangle.
const SQUARE_GRID_SHAPES = {[ELLIPSE_1]: RECTANGLE_1, [TRAPEZOID_1]: RECTANGLE_1, [RECTANGLE_1]: RECTANGLE_1, [ELLIPSE_2]: RECTANGLE_2, [TRAPEZOID_2]: RECTANGLE_2, [RECTANGLE_2]: RECTANGLE_2};
const GRIDLESS_SHAPES = {[ELLIPSE_1]: ELLIPSE_1, [ELLIPSE_2]: ELLIPSE_2, [TRAPEZOID_1]: RECTANGLE_1, [RECTANGLE_1]: RECTANGLE_1, [TRAPEZOID_2]: RECTANGLE_2, [RECTANGLE_2]: RECTANGLE_2};

function tokenShape(tokenOrPlaceable) {
	const token = asTokenDocument(tokenOrPlaceable);
	const {grid} = token.scene;
	if (grid.isSquare) return SQUARE_GRID_SHAPES[token.shape];
	if (grid.isGridless) return GRIDLESS_SHAPES[token.shape];
	return token.shape;
}

export function tokenIsEllipseShape(token) {
	const shape = tokenShape(token);
	return shape === ELLIPSE_1 || shape === ELLIPSE_2;
}

function tokenIsRectangleShape(token) {
	const shape = tokenShape(token);
	return shape === RECTANGLE_1 || shape === RECTANGLE_2;
}

export function tokenShapeData(tokenOrPlaceable) {
	const token = asTokenDocument(tokenOrPlaceable);
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

const ALTERNATE_SHAPES = {[ELLIPSE_1]: ELLIPSE_2, [ELLIPSE_2]: ELLIPSE_1, [TRAPEZOID_1]: TRAPEZOID_2, [TRAPEZOID_2]: TRAPEZOID_1, [RECTANGLE_1]: RECTANGLE_2, [RECTANGLE_2]: RECTANGLE_1};

export const tokenShapeAlternate = tokenOrPlaceable => ALTERNATE_SHAPES[asTokenDocument(tokenOrPlaceable).shape];

export function tokenFootprintOffsets(tokenOrPlaceable) {
	const token = asTokenDocument(tokenOrPlaceable);
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

function tokenPolygons(tokenOrPlaceable) {
	const token = asTokenDocument(tokenOrPlaceable);
	return tokenCached(token, 'polygons', () => computePolygons(token));
}

function computePolygons(token) {
	if (token.scene.grid.isGridless) {
		const shapeData = tokenShapeData(token);
		const ShapeData = shapeData.type === 'ellipse' ? foundry.data.EllipseShapeData : foundry.data.RectangleShapeData;
		return new ShapeData(shapeData).polygons;
	}
	return offsetPolygons(token.scene.grid, tokenFootprintOffsets(token));
}

function tokenAuraFootprintOffsets(token, radius, hole) {
	const offsets = auraOffsetsInRange(token, radius);
	return (hole ? offsets.filter(offset => !offset.isOwn) : offsets).map(({i, j}) => ({i, j}));
}

// Measured like distance: core's measurePath across the gap to the nearest of the token's offsets. Empty on gridless scenes.
function auraOffsetsInRange(token, radius) {
	const grid = token.scene.grid;
	if (!grid.isSquare && !grid.isHexagonal) return [];
	const tokenOffsets = tokenFootprintOffsets(token);
	const inRange = tokenOffsets.map(({i, j}) => ({i, j, isOwn: true}));
	const ringsInRange = Math.floor(radius / grid.distance + ROUNDING_TOLERANCE);
	if (grid.isSquare) {
		// The token's offsets are a rectangle, and every diagonal rule grows with the gap along each axis, so an offset's
		// distance is that across its gap to the rectangle, and no offset farther than `ringsInRange` along either axis is in range.
		const rows = tokenOffsets.map(offset => offset.i);
		const columns = tokenOffsets.map(offset => offset.j);
		const [minI, maxI, minJ, maxJ] = [Math.min(...rows), Math.max(...rows), Math.min(...columns), Math.max(...columns)];
		for (let i = minI - ringsInRange; i <= maxI + ringsInRange; i++) {
			for (let j = minJ - ringsInRange; j <= maxJ + ringsInRange; j++) {
				const gapI = Math.max(minI - i, 0, i - maxI);
				const gapJ = Math.max(minJ - j, 0, j - maxJ);
				if (!gapI && !gapJ) continue;
				if (gridSquareCachedPath(grid, gapI, gapJ, 0).distance <= radius + ROUNDING_TOLERANCE) inRange.push({i, j, isOwn: false});
			}
		}
		return inRange;
	}
	// on hex grids an offset's distance is its number of steps, so the offsets in range are grown a ring at a time
	const reachedKeys = new Set(tokenOffsets.map(offset => `${offset.i},${offset.j}`));
	let outerRing = tokenOffsets;
	for (let steps = 1; steps <= ringsInRange && outerRing.length; steps++) {
		const nextRing = [];
		for (const offset of outerRing) {
			for (const neighbour of grid.getAdjacentOffsets(offset)) {
				const key = `${neighbour.i},${neighbour.j}`;
				if (reachedKeys.has(key)) continue;
				reachedKeys.add(key);
				nextRing.push(neighbour);
				inRange.push({i: neighbour.i, j: neighbour.j, isOwn: false});
			}
		}
		outerRing = nextRing;
	}
	return inRange;
}

export function tokenAuraPolygons(tokenOrPlaceable, radius, hole) {
	const token = asTokenDocument(tokenOrPlaceable);
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

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export function tokenSurfacePoints(tokenOrPlaceable) {
	const token = asTokenDocument(tokenOrPlaceable);
	return tokenCached(token, 'surfacePoints', () => computeSurfacePoints(token));
}

function computeSurfacePoints(token) {
	return token.scene.grid.isHexagonal ? hexSurfacePoints(token) : boxOrEllipsoidSurfacePoints(token);
}

function hexSurfacePoints(token) {
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

// On square grids the box of the token's offsets (a tiny token fills the square under its centre, as in pf2e); on gridless
// scenes its own box or ellipsoid.
function boxOrEllipsoidSurfacePoints(token) {
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
		const latticePointCount = (stepsX + 1) * (stepsY + 1) * (stepsZ + 1) - Math.max(0, stepsX - 1) * Math.max(0, stepsY - 1) * Math.max(0, stepsZ - 1);
		const middleX = topLeft.x + (width / 2) * token.scene.grid.size;
		const middleY = topLeft.y + (height / 2) * token.scene.grid.size;
		const middleElevation = topLeft.elevation + (depth / 2) * token.scene.grid.distance;
		for (let index = 0; index < latticePointCount; index++) {
			const unitZ = latticePointCount > 1 ? 1 - (2 * index) / (latticePointCount - 1) : 0;
			const unitRadius = Math.sqrt(Math.max(0, 1 - unitZ * unitZ));
			const angle = index * GOLDEN_ANGLE;
			points.push({
				x: middleX + (width / 2) * unitRadius * Math.cos(angle) * token.scene.grid.size,
				y: middleY + (height / 2) * unitRadius * Math.sin(angle) * token.scene.grid.size,
				elevation: middleElevation + (depth / 2) * unitZ * token.scene.grid.distance
			});
		}
	} else if (tokenIsRectangleShape(token)) {
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
	const unmatchedEdges = new Map();
	for (const offset of offsets) {
		const vertices = grid.getVertices(offset);
		for (let index = 0; index < vertices.length; index++) {
			const start = vertices[index];
			const end = vertices[(index + 1) % vertices.length];
			// vertices shared by neighbouring offsets differ by rounding, so they are matched to a hundredth of a pixel
			const startKey = `${Math.round(start.x * 100)},${Math.round(start.y * 100)}`;
			const endKey = `${Math.round(end.x * 100)},${Math.round(end.y * 100)}`;
			if (unmatchedEdges.delete(`${endKey}>${startKey}`)) continue;
			unmatchedEdges.set(`${startKey}>${endKey}`, {start, end, startKey, endKey});
		}
	}
	const edgeByStartKey = new Map();
	for (const edge of unmatchedEdges.values()) edgeByStartKey.set(edge.startKey, edge);
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
	return polygons.sort((first, second) => second.points.length - first.points.length);
}
