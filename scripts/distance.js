// Distance api

export function distance(grid, objectA, objectZ, discount = undefined) {
	if (objectA === objectZ) return 0;
	let result = Infinity;
	if (grid.isSquare) {
		result = squareDistance(grid, objectA, objectZ, discount);
	} else if (grid.isHexagonal) {
		result = hexDistance(grid, objectA, objectZ, discount);
	} else if (grid.isGridless) {
		result = gridlessDistance(grid, objectA, objectZ);
	}
	return Number.isFinite(result) ? Math.max(0, Math.round(result * 1e8) / 1e8) : Infinity;
}

// Caching logic for distances per grid

const gridCostCache = new WeakMap();

function getCostCache(grid) {
	let costCache = gridCostCache.get(grid);
	if (!costCache) {
		costCache = new Map();
		gridCostCache.set(grid, costCache);
	}
	return costCache;
}

function getCost(costCache, key) {
	const cost = costCache.get(key);
	if (cost !== undefined) {
		costCache.delete(key);
		costCache.set(key, cost);
	}
	return cost;
}

function setCost(costCache, key, value) {
	costCache.set(key, value);
	if (costCache.size > 4096) costCache.delete(costCache.keys().next().value);
	return value;
}

// Caching logic for volumes per grid

const volumeCache = new WeakMap();

function getVolume(object, grid, signature) {
	const cached = volumeCache.get(object);
	return cached?.grid === grid && cached.signature === signature ? cached.volume : undefined;
}

function setVolume(object, grid, signature, volume) {
	volumeCache.set(object, {grid, signature, volume});
}

// Square grid distance

function squareDistance(grid, objectA, objectZ, discount) {
	const [volumeA, volumeZ] = [objectA, objectZ].map((object) => {
		if (object instanceof CONFIG.Token.objectClass) {
			const {i, j, k} = object.document._positionToGridOffset();
			return {
				iMin: i, iMax: i + Math.max(Math.round(object.document.height), 1) - 1,
				jMin: j, jMax: j + Math.max(Math.round(object.document.width), 1) - 1,
				kMin: k, kMax: k + Math.max(Math.round(object.document.depth), 1) - 1
			};
		} else {
			const {i, j, k} = grid.getOffset(object);
			return {
				iMin: i, iMax: i,
				jMin: j, jMax: j,
				kMin: k, kMax: k
			};
		}
	});
	const iDelta = Math.max(0, volumeZ.iMin - volumeA.iMax, volumeA.iMin - volumeZ.iMax);
	const jDelta = Math.max(0, volumeZ.jMin - volumeA.jMax, volumeA.jMin - volumeZ.jMax);
	const kDelta = Math.max(0, volumeZ.kMin - volumeA.kMax, volumeA.kMin - volumeZ.kMax);
	const key = `${iDelta},${jDelta},${kDelta}`;
	const costCache = getCostCache(grid);
	let path = getCost(costCache, key);
	if (path === undefined) {
		path = setCost(costCache, key, grid.measurePath([{i: 0, j: 0, k: 0}, {i: iDelta, j: jDelta, k: kDelta}]));
	}
	return discount ? discount(grid, path) : path.distance;
}

// Hex grid distance

function hexDistance(grid, objectA, objectZ, discount) {
	const [volumeA, volumeZ] = [objectA, objectZ].map((object) => {
		if (object instanceof CONFIG.Token.objectClass) {
			const signature = `${object.document.x}|${object.document.y}|${object.document.elevation}|${object.document.width}|${object.document.height}|${object.document.depth}|${object.document.shape}`;
			let volume = getVolume(object, grid, signature);
			if (!volume) {
				const {i, j, k} = object.document._positionToGridOffset();
				const {even, odd} = foundry.documents.BaseToken._getHexagonalOffsets(
					Math.max(Math.round(object.document.width), 1),
					Math.max(Math.round(object.document.height), 1),
					object.document.shape,
					grid.columns
				);
				const offsets = (((grid.columns ? j : i) % 2 === 0) === grid.even) ? even : odd;
				const cubes = offsets.map((offset) => grid.offsetToCube({i: i + offset.i, j: j + offset.j}));
				const qValues = cubes.map((cube) => cube.q);
				const qMin = Math.min(...qValues);
				const qMax = Math.max(...qValues);
				const rValues = cubes.map((cube) => cube.r);
				const rMin = Math.min(...rValues);
				const rMax = Math.max(...rValues);
				const sValues = cubes.map((cube) => cube.s);
				const sMin = Math.min(...sValues);
				const sMax = Math.max(...sValues);
				// convex check by seeing if the real volume fills the volume described by its q, r and s ranges
				let convexity = new Set(cubes.map((cube) => `${cube.q},${cube.r}`)).size;
				for (let q = qMin; q <= qMax; q++) {
					for (let r = rMin; r <= rMax; r++) {
						const s = -q - r;
						if (s >= sMin && s <= sMax) {
							convexity--;
						}
					}
				}
				volume = {
					qMin, qMax,
					rMin, rMax,
					sMin, sMax,
					kMin: k, kMax: k + Math.max(Math.round(object.document.depth), 1) - 1,
					cubes,
					convex: convexity === 0
				};
				setVolume(object, grid, signature, volume);
			}
			return volume;
		} else {
			const cube = grid.getCube(object);
			return {
				qMin: cube.q, qMax: cube.q,
				rMin: cube.r, rMax: cube.r,
				sMin: cube.s, sMax: cube.s,
				kMin: cube.k, kMax: cube.k,
				cubes: [cube],
				convex: true
			};
		}
	});
	const planarDeltaLowerBound = Math.max(0,
		volumeZ.qMin - volumeA.qMax, volumeA.qMin - volumeZ.qMax,
		volumeZ.rMin - volumeA.rMax, volumeA.rMin - volumeZ.rMax,
		volumeZ.sMin - volumeA.sMax, volumeA.sMin - volumeZ.sMax);
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
	const key = `${planarDelta},${kDelta}`;
	const costCache = getCostCache(grid);
	let path = getCost(costCache, key);
	if (path === undefined) {
		path = setCost(costCache, key, grid.measurePath([{q: 0, r: 0, s: 0, k: 0}, {q: planarDelta, r: 0, s: -planarDelta, k: kDelta}]));
	}
	return discount ? discount(grid, path) : path.distance;
}

// Gridless distance

function gridlessDistance(grid, objectA, objectZ) {
	const scale = grid.distance / grid.size;
	const [volumeA, volumeZ] = [objectA, objectZ].map((object) => {
		if (object instanceof CONFIG.Token.objectClass) {
			const signature = `${object.document.x}|${object.document.y}|${object.document.elevation}|${object.document.width}|${object.document.height}|${object.document.depth}|${object.document.shape}`;
			let volume = getVolume(object, grid, signature);
			if (!volume) {
				const origin = grid.getTopLeftPoint({x: object.document.x, y: object.document.y, elevation: object.document.elevation});
				const widthHalfNormalized = Math.max(object.document.width, 0.25) / 2;
				const heightHalfNormalized = Math.max(object.document.height, 0.25) / 2;
				const depthHalfNormalized = Math.max(object.document.depth, 0.25) / 2;
				let shape = "box"
				if ([CONST.TOKEN_SHAPES.ELLIPSE_1, CONST.TOKEN_SHAPES.ELLIPSE_2].includes(object.document.shape)) {
					if (widthHalfNormalized === heightHalfNormalized && heightHalfNormalized === depthHalfNormalized) {
						shape = "sphere"
					} else {
						shape = "ellipsoid"
					}
				}
				volume = {
					x: (origin.x + widthHalfNormalized * grid.size) * scale,
					y: (origin.y + heightHalfNormalized * grid.size) * scale,
					z: origin.elevation + depthHalfNormalized * grid.distance,
					xRadius: widthHalfNormalized * grid.distance,
					yRadius: heightHalfNormalized * grid.distance,
					zRadius: depthHalfNormalized * grid.distance,
					shape,
				};
				setVolume(object, grid, signature, volume);
			}
			return volume;
		} else {
			return {
				x: object.x * scale,
				y: object.y * scale,
				z: object.elevation,
				xRadius: 0,
				yRadius: 0,
				zRadius: 0,
				shape: "box",
			};
		}
	});
	if (volumeA.x === volumeZ.x && volumeA.y === volumeZ.y && volumeA.z === volumeZ.z) {
		return 0;
	} else if (volumeA.shape === "ellipsoid" || volumeZ.shape === "ellipsoid") {
		const signatureA = `${volumeA.x}|${volumeA.y}|${volumeA.z}|${volumeA.xRadius}|${volumeA.yRadius}|${volumeA.zRadius}|${volumeA.shape}`;
		const signatureZ = `${volumeZ.x}|${volumeZ.y}|${volumeZ.z}|${volumeZ.xRadius}|${volumeZ.yRadius}|${volumeZ.zRadius}|${volumeZ.shape}`;
		const key = signatureA < signatureZ ? `${signatureA}#${signatureZ}` : `${signatureZ}#${signatureA}`;
		const costCache = getCostCache(grid);
		let cost = getCost(costCache, key);
		if (cost === undefined) {
			cost = setCost(costCache, key, gridlessGJKDistance(volumeA, volumeZ));
		}
		return cost;
	} else if (volumeA.shape === "box" && volumeZ.shape === "box") {
		const xDelta = Math.max(0, Math.abs(volumeA.x - volumeZ.x) - volumeA.xRadius - volumeZ.xRadius);
		const yDelta = Math.max(0, Math.abs(volumeA.y - volumeZ.y) - volumeA.yRadius - volumeZ.yRadius);
		const zDelta = Math.max(0, Math.abs(volumeA.z - volumeZ.z) - volumeA.zRadius - volumeZ.zRadius);
		return Math.hypot(xDelta, yDelta, zDelta);
	} else if (volumeA.shape === "sphere" && volumeZ.shape === "sphere") {
		const centerDistance = Math.hypot(volumeZ.x - volumeA.x, volumeZ.y - volumeA.y, volumeZ.z - volumeA.z);
		return Math.max(0, centerDistance - volumeA.xRadius - volumeZ.xRadius);
	} else if (volumeA.shape === "sphere" && volumeZ.shape === "box") {
		const xGap = Math.max(0, Math.abs(volumeA.x - volumeZ.x) - volumeZ.xRadius);
		const yGap = Math.max(0, Math.abs(volumeA.y - volumeZ.y) - volumeZ.yRadius);
		const zGap = Math.max(0, Math.abs(volumeA.z - volumeZ.z) - volumeZ.zRadius);
		return Math.max(0, Math.hypot(xGap, yGap, zGap) - volumeA.xRadius);
	} else if (volumeA.shape === "box" && volumeZ.shape === "sphere") {
		const xGap = Math.max(0, Math.abs(volumeZ.x - volumeA.x) - volumeA.xRadius);
		const yGap = Math.max(0, Math.abs(volumeZ.y - volumeA.y) - volumeA.yRadius);
		const zGap = Math.max(0, Math.abs(volumeZ.z - volumeA.z) - volumeA.zRadius);
		return Math.max(0, Math.hypot(xGap, yGap, zGap) - volumeZ.xRadius);
	}
}

// Below is the GJK code that AI (Claude Sonnet 5.5) wrote to calculate distances for gridless ellipsoids.

const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const sub = (a, b) => ({x: a.x - b.x, y: a.y - b.y, z: a.z - b.z});
const neg = (a) => ({x: -a.x, y: -a.y, z: -a.z});
const len = (a) => a.x * a.x + a.y * a.y + a.z * a.z;

function gridlessGJKDistance(volumeA, volumeZ) {
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
		if (squared <= 1e-24 * len(vertex)) {
			return 0;
		} else if (squared == closestSquaredLength) {
			break;
		} else {
			closestSquaredLength = squared;
			closestLength = Math.sqrt(closestSquaredLength);
			direction = neg(closest);
		}
	}
	return Math.hypot(closest.x, closest.y, closest.z);
}

function support(volume, direction) {
	if (volume.shape === "box") {
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
				x: volume.x + volume.xRadius * xScaled / scaledLength,
				y: volume.y + volume.yRadius * yScaled / scaledLength,
				z: volume.z + volume.zRadius * zScaled / scaledLength
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
	for (let subsetMask = 1; subsetMask < (1 << points.length); subsetMask++) {
		const subset = points.filter((vertex, index) => subsetMask & (1 << index));
		const weights = affineWeights(subset);
		// skip degenerate subsets and subsets whose closest point falls outside their hull (negative weight);
		// the small tolerance absorbs rounding for points that sit on a boundary
		if (!weights || weights.some((weight) => weight < -1e-12)) continue;
		// rebuild the point from its weights
		const point = {x: 0, y: 0, z: 0};
		subset.forEach((vertex, index) => {
			point.x += weights[index] * vertex.x;
			point.y += weights[index] * vertex.y;
			point.z += weights[index] * vertex.z;
		});
		const squared = len(point);
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
	const edges = others.map((point) => sub(point, base));
	// minimizing |base + sum(edgeWeight_i * edge_i)|^2 gives the normal equations G edgeWeights = -b, where G holds the
	// dot products of the edges and b the dot products of each edge with base; each matrix row is [G row | -b]
	const matrix = edges.map((edgeI) => [...edges.map((edgeJ) => dot(edgeI, edgeJ)), -dot(edgeI, base)]);
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