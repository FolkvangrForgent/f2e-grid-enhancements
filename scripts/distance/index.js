import {gridCachedPath, gridGridlessCachedPath, gridHexCachedPath, gridSquareCachedPath, gridUnitPixels} from '../helpers/grid.js';
import {tokenCached, tokenDepth, tokenFootprintOffsets, tokenHeight, tokenIsEllipseShape, tokenWidth} from '../helpers/token.js';

// A Token or TokenDocument as its TokenDocument; anything else (a point) as it is.
const asTokenDocument = object => (object?.document?.documentName === 'Token' ? object.document : object);
const isTokenDocument = object => object.documentName === 'Token';

export function distance(grid, objectA, objectZ, discount) {
	objectA = asTokenDocument(objectA);
	objectZ = asTokenDocument(objectZ);
	if (objectA === objectZ) return 0;
	let result = Infinity;
	if (grid.isSquare) {
		result = squareDistance(grid, objectA, objectZ, discount);
	} else if (grid.isHexagonal) {
		result = hexDistance(grid, objectA, objectZ, discount);
	} else if (grid.isGridless) {
		result = gridlessDistance(grid, objectA, objectZ, discount);
	}
	return Number.isFinite(result) ? Math.max(0, Math.round(result * 1e8) / 1e8) : Infinity;
}

function squareDistance(grid, objectA, objectZ, discount) {
	const [volumeA, volumeZ] = [objectA, objectZ].map(object => {
		if (isTokenDocument(object)) {
			const {i, j, k} = object._positionToGridOffset({width: tokenWidth(object), height: tokenHeight(object)});
			return {
				iMin: i,
				iMax: i + Math.ceil(tokenHeight(object)) - 1,
				jMin: j,
				jMax: j + Math.ceil(tokenWidth(object)) - 1,
				kMin: k,
				kMax: k + Math.ceil(tokenDepth(object)) - 1
			};
		} else {
			const {i, j, k} = grid.getOffset(object);
			return {
				iMin: i,
				iMax: i,
				jMin: j,
				jMax: j,
				kMin: k,
				kMax: k
			};
		}
	});
	const iDelta = Math.max(0, volumeZ.iMin - volumeA.iMax, volumeA.iMin - volumeZ.iMax);
	const jDelta = Math.max(0, volumeZ.jMin - volumeA.jMax, volumeA.jMin - volumeZ.jMax);
	const kDelta = Math.max(0, volumeZ.kMin - volumeA.kMax, volumeA.kMin - volumeZ.kMax);
	const path = gridSquareCachedPath(grid, iDelta, jDelta, kDelta);
	return discount ? discount(grid, path) : path.distance;
}

function hexDistance(grid, objectA, objectZ, discount) {
	const [volumeA, volumeZ] = [objectA, objectZ].map(object => {
		if (isTokenDocument(object)) {
			return tokenCached(
				object,
				'hexVolume',
				() => {
					const {k} = object._positionToGridOffset();
					const cubes = tokenFootprintOffsets(object).map(offset => grid.offsetToCube(offset));
					const qValues = cubes.map(cube => cube.q);
					const qMin = Math.min(...qValues);
					const qMax = Math.max(...qValues);
					const rValues = cubes.map(cube => cube.r);
					const rMin = Math.min(...rValues);
					const rMax = Math.max(...rValues);
					const sValues = cubes.map(cube => cube.s);
					const sMin = Math.min(...sValues);
					const sMax = Math.max(...sValues);
					// convex when its cells fill the whole region its q, r and s ranges describe
					let cellsLeftOver = new Set(cubes.map(cube => `${cube.q},${cube.r}`)).size;
					for (let q = qMin; q <= qMax; q++) {
						for (let r = rMin; r <= rMax; r++) {
							const s = -q - r;
							if (s >= sMin && s <= sMax) {
								cellsLeftOver--;
							}
						}
					}
					return {
						qMin,
						qMax,
						rMin,
						rMax,
						sMin,
						sMax,
						kMin: k,
						kMax: k + Math.ceil(tokenDepth(object)) - 1,
						cubes,
						convex: cellsLeftOver === 0
					};
				},
				grid
			);
		} else {
			const cube = grid.getCube(object);
			return {
				qMin: cube.q,
				qMax: cube.q,
				rMin: cube.r,
				rMax: cube.r,
				sMin: cube.s,
				sMax: cube.s,
				kMin: cube.k,
				kMax: cube.k,
				cubes: [cube],
				convex: true
			};
		}
	});
	const planarDeltaLowerBound = Math.max(
		0,
		volumeZ.qMin - volumeA.qMax,
		volumeA.qMin - volumeZ.qMax,
		volumeZ.rMin - volumeA.rMax,
		volumeA.rMin - volumeZ.rMax,
		volumeZ.sMin - volumeA.sMax,
		volumeA.sMin - volumeZ.sMax
	);
	let planarDelta;
	if (volumeA.convex && volumeZ.convex) {
		planarDelta = planarDeltaLowerBound;
	} else {
		planarDelta = Infinity;
		planarSearch: for (const cubeA of volumeA.cubes) {
			for (const cubeZ of volumeZ.cubes) {
				const planarDeltaCandidate = Math.max(Math.abs(cubeA.q - cubeZ.q), Math.abs(cubeA.r - cubeZ.r), Math.abs(cubeA.s - cubeZ.s));
				if (planarDeltaCandidate < planarDelta) {
					planarDelta = planarDeltaCandidate;
					if (planarDelta <= planarDeltaLowerBound) break planarSearch;
				}
			}
		}
	}
	const kDelta = Math.max(0, volumeZ.kMin - volumeA.kMax, volumeA.kMin - volumeZ.kMax);
	const path = gridHexCachedPath(grid, planarDelta, kDelta);
	return discount ? discount(grid, path) : path.distance;
}

function gridlessDistance(grid, objectA, objectZ, discount) {
	const unitsPerPixel = 1 / gridUnitPixels(grid);
	const [volumeA, volumeZ] = [objectA, objectZ].map(object => {
		if (isTokenDocument(object)) {
			return tokenCached(
				object,
				'gridlessVolume',
				() => {
					const origin = grid.getTopLeftPoint({
						x: object.x,
						y: object.y,
						elevation: object.elevation
					});
					const halfWidthInSpaces = tokenWidth(object) / 2;
					const halfHeightInSpaces = tokenHeight(object) / 2;
					const halfDepthInSpaces = tokenDepth(object) / 2;
					let shape = 'box';
					if (tokenIsEllipseShape(object)) {
						if (halfWidthInSpaces === halfHeightInSpaces && halfHeightInSpaces === halfDepthInSpaces) {
							shape = 'sphere';
						} else {
							shape = 'ellipsoid';
						}
					}
					return {
						x: (origin.x + halfWidthInSpaces * grid.size) * unitsPerPixel,
						y: (origin.y + halfHeightInSpaces * grid.size) * unitsPerPixel,
						z: origin.elevation + halfDepthInSpaces * grid.distance,
						xRadius: halfWidthInSpaces * grid.distance,
						yRadius: halfHeightInSpaces * grid.distance,
						zRadius: halfDepthInSpaces * grid.distance,
						shape
					};
				},
				grid
			);
		} else {
			return {
				x: object.x * unitsPerPixel,
				y: object.y * unitsPerPixel,
				z: object.elevation,
				xRadius: 0,
				yRadius: 0,
				zRadius: 0,
				shape: 'box'
			};
		}
	});
	const gap = gridlessGap(grid, volumeA, volumeZ);
	const path = gridGridlessCachedPath(grid, gap.x, gap.y, gap.z);
	return discount ? discount(grid, path) : path.distance;
}

const NO_GAP = Object.freeze({x: 0, y: 0, z: 0});

// The gap between two gridless volumes, as a vector in grid units across it.
function gridlessGap(grid, volumeA, volumeZ) {
	if (volumeA.x === volumeZ.x && volumeA.y === volumeZ.y && volumeA.z === volumeZ.z) {
		return NO_GAP;
	} else if (volumeA.shape === 'ellipsoid' || volumeZ.shape === 'ellipsoid') {
		const signatureA = `${volumeA.x}|${volumeA.y}|${volumeA.z}|${volumeA.xRadius}|${volumeA.yRadius}|${volumeA.zRadius}|${volumeA.shape}`;
		const signatureZ = `${volumeZ.x}|${volumeZ.y}|${volumeZ.z}|${volumeZ.xRadius}|${volumeZ.yRadius}|${volumeZ.zRadius}|${volumeZ.shape}`;
		const key = signatureA < signatureZ ? `${signatureA}#${signatureZ}` : `${signatureZ}#${signatureA}`;
		return gridCachedPath(grid, key, () => gridlessGJKGap(volumeA, volumeZ));
	} else if (volumeA.shape === 'box' && volumeZ.shape === 'box') {
		return {
			x: Math.max(0, Math.abs(volumeA.x - volumeZ.x) - volumeA.xRadius - volumeZ.xRadius),
			y: Math.max(0, Math.abs(volumeA.y - volumeZ.y) - volumeA.yRadius - volumeZ.yRadius),
			z: Math.max(0, Math.abs(volumeA.z - volumeZ.z) - volumeA.zRadius - volumeZ.zRadius)
		};
	} else if (volumeA.shape === 'sphere' && volumeZ.shape === 'sphere') {
		return shortened(sub(volumeZ, volumeA), volumeA.xRadius + volumeZ.xRadius);
	} else if (volumeA.shape === 'sphere' && volumeZ.shape === 'box') {
		return sphereBoxGap(volumeA, volumeZ);
	} else if (volumeA.shape === 'box' && volumeZ.shape === 'sphere') {
		return sphereBoxGap(volumeZ, volumeA);
	}
}

// The gap between a sphere and an axis-aligned box: from the box's nearest point to the centre, less the radius.
function sphereBoxGap(sphere, box) {
	const nearest = {
		x: Math.max(0, Math.abs(sphere.x - box.x) - box.xRadius),
		y: Math.max(0, Math.abs(sphere.y - box.y) - box.yRadius),
		z: Math.max(0, Math.abs(sphere.z - box.z) - box.zRadius)
	};
	return shortened(nearest, sphere.xRadius);
}

// A vector made `by` shorter, in the same direction; no gap if it is no longer than that.
function shortened(vector, by) {
	const length = Math.hypot(vector.x, vector.y, vector.z);
	if (length <= by) return NO_GAP;
	const scale = (length - by) / length;
	return {x: vector.x * scale, y: vector.y * scale, z: vector.z * scale};
}

// Below is the GJK code that AI (Claude Sonnet 5.5) wrote to calculate distances for gridless ellipsoids.

const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const sub = (a, b) => ({x: a.x - b.x, y: a.y - b.y, z: a.z - b.z});
const neg = a => ({x: -a.x, y: -a.y, z: -a.z});
const lengthSquared = a => a.x * a.x + a.y * a.y + a.z * a.z;

// The gap between two convex volumes (the closest point of their difference to the origin), by GJK.
function gridlessGJKGap(volumeA, volumeZ) {
	let direction = sub(volumeZ, volumeA);
	let simplex = [];
	let closest = null;
	let closestLength;
	let closestSquaredLength;
	let squared;
	for (let iteration = 0; iteration < 64; iteration++) {
		const vertex = sub(support(volumeA, direction), support(volumeZ, neg(direction)));
		if (closest) {
			if (closestSquaredLength - dot(closest, vertex) <= 1e-9 * closestLength) break;
		}
		simplex.push(vertex);
		({closest, simplex, squared} = closestOnSimplex(simplex));
		if (squared <= 1e-24 * lengthSquared(vertex)) {
			return NO_GAP;
		} else if (squared === closestSquaredLength) {
			break;
		} else {
			closestSquaredLength = squared;
			closestLength = Math.sqrt(closestSquaredLength);
			direction = neg(closest);
		}
	}
	return closest;
}

function support(volume, direction) {
	if (volume.shape === 'box') {
		return {
			x: volume.x + (direction.x >= 0 ? volume.xRadius : -volume.xRadius),
			y: volume.y + (direction.y >= 0 ? volume.yRadius : -volume.yRadius),
			z: volume.z + (direction.z >= 0 ? volume.zRadius : -volume.zRadius)
		};
	} else {
		const xScaled = volume.xRadius * direction.x;
		const yScaled = volume.yRadius * direction.y;
		const zScaled = volume.zRadius * direction.z;
		const scaledLength = Math.hypot(xScaled, yScaled, zScaled);
		if (scaledLength === 0) {
			return {
				x: volume.x,
				y: volume.y,
				z: volume.z
			};
		} else {
			return {
				x: volume.x + (volume.xRadius * xScaled) / scaledLength,
				y: volume.y + (volume.yRadius * yScaled) / scaledLength,
				z: volume.z + (volume.zRadius * zScaled) / scaledLength
			};
		}
	}
}

// Closest point to the origin on the convex hull of up to 4 points, plus the minimal sub simplex that carries it.
// Tries every subset of the points (a vertex, edge, triangle or tetrahedron); the true closest point lies in
// the interior of exactly one of them, and is found as the nearest subset whose weights are all non-negative.
function closestOnSimplex(points) {
	let nearest = null;
	// each bit of subsetMask selects one point, so this visits every non-empty subset
	for (let subsetMask = 1; subsetMask < 1 << points.length; subsetMask++) {
		const subset = points.filter((vertex, index) => subsetMask & (1 << index));
		const weights = affineWeights(subset);
		// skip degenerate subsets and subsets whose closest point falls outside their hull (negative weight);
		// the small tolerance absorbs rounding for points that sit on a boundary
		if (!weights || weights.some(weight => weight < -1e-12)) continue;
		// rebuild the point from its weights
		const point = {x: 0, y: 0, z: 0};
		subset.forEach((vertex, index) => {
			point.x += weights[index] * vertex.x;
			point.y += weights[index] * vertex.y;
			point.z += weights[index] * vertex.z;
		});
		const squared = lengthSquared(point);
		if (!nearest || squared < nearest.squared - 1e-15) nearest = {squared, closest: point, simplex: subset};
	}
	// a single point subset always has weights [1], so nearest is always set
	return nearest;
}

// Closest point to the origin on the affine hull (unbounded line, plane or space through the points),
// returned as barycentric weights summing to 1, or null if the points are degenerate (e.g. collinear triangle).
// The caller checks that the weights are non-negative, which is what puts the point inside the hull itself.
function affineWeights(points) {
	if (points.length === 1) return [1];
	// the hull is base + sum(edgeWeight_i * edge_i), with edges running from the first point to the others
	const [base, ...others] = points;
	const edges = others.map(point => sub(point, base));
	// minimizing |base + sum(edgeWeight_i * edge_i)|^2 gives the normal equations G edgeWeights = -b, where G holds the
	// dot products of the edges and b the dot products of each edge with base; each matrix row is [G row | -b]
	const matrix = edges.map(edgeI => [...edges.map(edgeJ => dot(edgeI, edgeJ)), -dot(edgeI, base)]);
	const edgeWeights = solveLinearSystem(matrix);
	if (!edgeWeights) return null;
	// the base point takes the remaining weight
	return [1 - edgeWeights.reduce((sum, value) => sum + value, 0), ...edgeWeights];
}

// Solves a square linear system given as an augmented matrix [A | b] by Gauss-Jordan elimination with partial pivoting.
// Returns the solution, or null if A is (nearly) singular. Modifies the matrix.
function solveLinearSystem(matrix) {
	const size = matrix.length;
	// largest diagonal entry, used to make the singularity check relative to the problem's size
	const diagonalScale = Math.max(0, ...matrix.map((row, index) => row[index]));
	for (let column = 0; column < size; column++) {
		// pick the row with the largest entry in this column for numerical stability
		let pivotRow = column;
		for (let row = column + 1; row < size; row++) {
			if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivotRow][column])) pivotRow = row;
		}
		// a near zero pivot means the equations are linearly dependent
		if (Math.abs(matrix[pivotRow][column]) <= 1e-12 * (diagonalScale || 1)) return null;
		[matrix[column], matrix[pivotRow]] = [matrix[pivotRow], matrix[column]];
		// clear this column from every other row, leaving the matrix diagonal at the end
		for (let row = 0; row < size; row++) {
			if (row === column) continue;
			const factor = matrix[row][column] / matrix[column][column];
			for (let entry = column; entry <= size; entry++) matrix[row][entry] -= factor * matrix[column][entry];
		}
	}
	// read off the solution of the diagonal system
	return matrix.map((row, index) => row[size] / row[index]);
}
