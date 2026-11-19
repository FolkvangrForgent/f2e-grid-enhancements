// Bounding volume hierarchy: a static tree of axis-aligned boxes, built with a binned SAH and walked front to back.
// Boxes are stored flat as minX, minY, minZ, maxX, maxY, maxZ (z is elevation).
const BOX_STRIDE = 6;
const BOX_MAX = 3;
const EMPTY_BOX = Float64Array.of(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity);

// A primitive is a box and a 32-bit mask; each node holds the OR of the masks below it, so a query skips subtrees with
// nothing it wants. Nodes are depth-first (the left child is the next node). Unbounded elevations are real +-Infinity,
// which the slab test handles exactly.

// Grow one box to contain another (each BOX_STRIDE numbers at an offset into a flat array).
function growBox(targetBoxes, targetOffset, sourceBoxes, sourceOffset) {
	for (let axis = 0; axis < 3; axis++) {
		const sourceMin = sourceBoxes[sourceOffset + axis];
		const sourceMax = sourceBoxes[sourceOffset + axis + BOX_MAX];
		if (sourceMin < targetBoxes[targetOffset + axis]) targetBoxes[targetOffset + axis] = sourceMin;
		if (sourceMax > targetBoxes[targetOffset + axis + BOX_MAX]) targetBoxes[targetOffset + axis + BOX_MAX] = sourceMax;
	}
}

// Half a box's surface area: a random ray's chance of hitting it, which splits are costed by.
function halfSurfaceArea(box) {
	const sizeX = box[3] - box[0];
	const sizeY = box[4] - box[1];
	const sizeZ = box[5] - box[2];
	return sizeX * sizeY + sizeX * sizeZ + sizeY * sizeZ;
}

// The slab test: t where a ray enters a box within [tMin, tMax], or Infinity. On an axis the ray does not move along, its
// origin must be inside the box.
function rayBoxEntry(boxes, boxOffset, ray) {
	const {origin, inverseDelta, axes} = ray;
	let entryT = ray.tMin;
	let exitT = ray.tMax;
	for (let axis = 0; axis < 3; axis++) {
		const boxMin = boxes[boxOffset + axis];
		const boxMax = boxes[boxOffset + axis + BOX_MAX];
		if (axes & (1 << axis)) {
			let nearT = (boxMin - origin[axis]) * inverseDelta[axis];
			let farT = (boxMax - origin[axis]) * inverseDelta[axis];
			if (nearT > farT) {
				const swap = nearT;
				nearT = farT;
				farT = swap;
			}
			if (nearT > entryT) entryT = nearT;
			if (farT < exitT) exitT = farT;
			if (entryT > exitT) return Infinity;
		} else if (origin[axis] < boxMin || origin[axis] > boxMax) return Infinity;
	}
	return entryT;
}

export class BVH {
	// Each node is split where the surface-area heuristic estimates a ray costs least. zScale is pixels per elevation unit,
	// so vertical extents compare with horizontal ones.
	constructor(primitiveBoxes, primitiveMasks, {leafSize = 4, zScale = 1, bins = 8} = {}) {
		const primitiveCount = primitiveMasks.length;
		const maxNodes = Math.max(1, 2 * primitiveCount);
		this.primitiveCount = primitiveCount;
		// kept for box queries (visitOverlapping), which test each primitive's own box
		this.primitiveBoxes = primitiveBoxes;
		this.nodeCount = 0;
		// also the most nodes a ray walk can have waiting on its stack
		this.depth = 0;
		this.nodeBoxes = new Float64Array(maxNodes * BOX_STRIDE);
		this.nodeMasks = new Uint32Array(maxNodes);
		this.rightChild = new Int32Array(maxNodes);
		// a leaf owns leafOrder[leafStart, leafStart + leafCount); inner nodes have a leafCount of 0
		this.leafStart = new Int32Array(maxNodes);
		this.leafCount = new Int32Array(maxNodes);
		// primitive indices with each leaf's consecutive, and their masks in the same order
		this.leafOrder = Int32Array.from({length: primitiveCount}, (_, index) => index);
		this.leafMasks = new Uint32Array(primitiveCount);
		if (!primitiveCount) return;
		this.#build(primitiveBoxes, primitiveMasks, Math.max(1, leafSize), zScale, Math.max(2, bins | 0));
		for (let slot = 0; slot < primitiveCount; slot++) this.leafMasks[slot] = primitiveMasks[this.leafOrder[slot]];
	}

	#build(primitiveBoxes, primitiveMasks, leafSize, zScale, binCount) {
		const primitiveCount = primitiveMasks.length;
		const {nodeBoxes, nodeMasks, rightChild, leafStart, leafCount, leafOrder} = this;

		// boxes for costing splits only: elevation in pixels, infinite extents cut a little beyond the finite ones
		let lowestFiniteZ = Infinity;
		let highestFiniteZ = -Infinity;
		for (let zIndex = 2; zIndex < primitiveBoxes.length; zIndex += 3) {
			const z = primitiveBoxes[zIndex];
			if (!Number.isFinite(z)) continue;
			if (z < lowestFiniteZ) lowestFiniteZ = z;
			if (z > highestFiniteZ) highestFiniteZ = z;
		}
		if (lowestFiniteZ > highestFiniteZ) lowestFiniteZ = highestFiniteZ = 0;
		const zMargin = (highestFiniteZ - lowestFiniteZ) / 2 + 1;
		const costBoxes = Float64Array.from(primitiveBoxes);
		const centroids = new Float64Array(primitiveCount * 3);
		for (let primitive = 0; primitive < primitiveCount; primitive++) {
			const boxOffset = primitive * BOX_STRIDE;
			for (let axis = 0; axis < 3; axis++) {
				// an infinite extent has no usable centre
				const centre = (primitiveBoxes[boxOffset + axis] + primitiveBoxes[boxOffset + axis + BOX_MAX]) / 2;
				centroids[primitive * 3 + axis] = Number.isFinite(centre) ? centre : 0;
			}
			const minZ = primitiveBoxes[boxOffset + 2];
			const maxZ = primitiveBoxes[boxOffset + 5];
			costBoxes[boxOffset + 2] = Math.clamp(minZ, lowestFiniteZ - zMargin, highestFiniteZ + zMargin) * zScale;
			costBoxes[boxOffset + 5] = Math.clamp(maxZ, lowestFiniteZ - zMargin, highestFiniteZ + zMargin) * zScale;
		}

		const binSizes = new Int32Array(binCount);
		const binBoxes = new Float64Array(binCount * BOX_STRIDE);
		const countLeftOf = new Int32Array(binCount);
		const areaLeftOf = new Float64Array(binCount);
		const countRightOf = new Int32Array(binCount);
		const areaRightOf = new Float64Array(binCount);
		const runningBox = new Float64Array(BOX_STRIDE);
		const centroidBox = new Float64Array(BOX_STRIDE);
		const binOf = (primitive, axis, binsPerUnit) => {
			return Math.min(((centroids[primitive * 3 + axis] - centroidBox[axis]) * binsPerUnit) | 0, binCount - 1);
		};
		// counts[bin] and areas[bin]: everything from `firstBin` up to and including `bin`
		const accumulateBins = (firstBin, step, counts, areas) => {
			runningBox.set(EMPTY_BOX);
			let runningCount = 0;
			for (let bin = firstBin; bin >= 0 && bin < binCount; bin += step) {
				if (binSizes[bin]) {
					growBox(runningBox, 0, binBoxes, bin * BOX_STRIDE);
					runningCount += binSizes[bin];
				}
				counts[bin] = runningCount;
				areas[bin] = runningCount ? halfSurfaceArea(runningBox) : 0;
			}
		};

		// Bin the centroids per axis, cost each bin boundary as area * count on both sides, and reorder the range so the
		// cheapest split's left side comes first. Returns where the right side starts, or -1 when nothing separates.
		const partition = (rangeStart, rangeEnd) => {
			let bestCost = Infinity;
			let bestAxis = -1;
			let bestBin = -1;
			// only the wider of x and y is tried (they do the same job), and z
			const widerHorizontalAxis = centroidBox[3] - centroidBox[0] >= centroidBox[4] - centroidBox[1] ? 0 : 1;
			for (const axis of [widerHorizontalAxis, 2]) {
				const centroidExtent = centroidBox[axis + BOX_MAX] - centroidBox[axis];
				if (!(centroidExtent > 0)) continue;
				binSizes.fill(0);
				for (let bin = 0; bin < binCount; bin++) binBoxes.set(EMPTY_BOX, bin * BOX_STRIDE);
				for (let slot = rangeStart; slot < rangeEnd; slot++) {
					const primitive = leafOrder[slot];
					const bin = binOf(primitive, axis, binCount / centroidExtent);
					binSizes[bin]++;
					growBox(binBoxes, bin * BOX_STRIDE, costBoxes, primitive * BOX_STRIDE);
				}
				accumulateBins(0, 1, countLeftOf, areaLeftOf);
				accumulateBins(binCount - 1, -1, countRightOf, areaRightOf);
				for (let bin = 0; bin < binCount - 1; bin++) {
					if (!countLeftOf[bin] || !countRightOf[bin + 1]) continue;
					const cost = areaLeftOf[bin] * countLeftOf[bin] + areaRightOf[bin + 1] * countRightOf[bin + 1];
					if (cost < bestCost) {
						bestCost = cost;
						bestAxis = axis;
						bestBin = bin;
					}
				}
			}
			if (bestAxis < 0) return -1;
			const binsPerUnit = binCount / (centroidBox[bestAxis + BOX_MAX] - centroidBox[bestAxis]);
			let leftEnd = rangeStart;
			let rightStart = rangeEnd - 1;
			while (leftEnd <= rightStart) {
				if (binOf(leafOrder[leftEnd], bestAxis, binsPerUnit) <= bestBin) leftEnd++;
				else {
					const swap = leafOrder[leftEnd];
					leafOrder[leftEnd] = leafOrder[rightStart];
					leafOrder[rightStart--] = swap;
				}
			}
			return leftEnd > rangeStart && leftEnd < rangeEnd ? leftEnd : -1;
		};

		const buildNode = (rangeStart, rangeEnd, depth) => {
			const node = this.nodeCount++;
			if (depth > this.depth) this.depth = depth;
			nodeBoxes.set(EMPTY_BOX, node * BOX_STRIDE);
			centroidBox.set(EMPTY_BOX);
			let nodeMask = 0;
			for (let slot = rangeStart; slot < rangeEnd; slot++) {
				const primitive = leafOrder[slot];
				growBox(nodeBoxes, node * BOX_STRIDE, primitiveBoxes, primitive * BOX_STRIDE);
				nodeMask |= primitiveMasks[primitive];
				for (let axis = 0; axis < 3; axis++) {
					const centre = centroids[primitive * 3 + axis];
					if (centre < centroidBox[axis]) centroidBox[axis] = centre;
					if (centre > centroidBox[axis + BOX_MAX]) centroidBox[axis + BOX_MAX] = centre;
				}
			}
			nodeMasks[node] = nodeMask;
			let splitAt = -1;
			if (rangeEnd - rangeStart > leafSize) {
				// coinciding centroids stay a leaf; otherwise with no split found (rounding), the range is halved as it stands
				const centroidsDiffer = Math.max(centroidBox[3] - centroidBox[0], centroidBox[4] - centroidBox[1], centroidBox[5] - centroidBox[2]) > 0;
				splitAt = partition(rangeStart, rangeEnd);
				if (splitAt < 0 && centroidsDiffer) splitAt = (rangeStart + rangeEnd) >> 1;
			}
			if (splitAt < 0) {
				leafStart[node] = rangeStart;
				leafCount[node] = rangeEnd - rangeStart;
				return;
			}
			buildNode(rangeStart, splitAt, depth + 1);
			rightChild[node] = this.nodeCount;
			buildNode(splitAt, rangeEnd, depth + 1);
		};
		buildNode(0, primitiveCount, 0);
	}

	// visit(primitiveIndex) for every primitive whose box contains the point.
	visitContaining(x, y, z, visit, node = 0) {
		const boxes = this.nodeBoxes;
		const boxOffset = node * BOX_STRIDE;
		if (!this.primitiveCount || x < boxes[boxOffset] || y < boxes[boxOffset + 1] || z < boxes[boxOffset + 2] || x > boxes[boxOffset + 3] || y > boxes[boxOffset + 4] || z > boxes[boxOffset + 5])
			return;
		if (this.leafCount[node]) {
			const leafEnd = this.leafStart[node] + this.leafCount[node];
			for (let slot = this.leafStart[node]; slot < leafEnd; slot++) visit(this.leafOrder[slot]);
			return;
		}
		this.visitContaining(x, y, z, visit, node + 1);
		this.visitContaining(x, y, z, visit, this.rightChild[node]);
	}

	// visit(primitiveIndex) for every primitive matching `mask` whose box overlaps the box minX..maxX, minY..maxY, minZ..maxZ.
	visitOverlapping(minX, minY, minZ, maxX, maxY, maxZ, mask, visit) {
		const {nodeBoxes, nodeMasks, rightChild, leafStart, leafCount, leafOrder, leafMasks} = this;
		if (!this.primitiveCount) return;
		const overlaps = node => {
			const offset = node * BOX_STRIDE;
			return !(
				maxX < nodeBoxes[offset] ||
				maxY < nodeBoxes[offset + 1] ||
				maxZ < nodeBoxes[offset + 2] ||
				minX > nodeBoxes[offset + 3] ||
				minY > nodeBoxes[offset + 4] ||
				minZ > nodeBoxes[offset + 5]
			);
		};
		const stack = [0];
		while (stack.length) {
			const node = stack.pop();
			if (!(nodeMasks[node] & mask) || !overlaps(node)) continue;
			if (leafCount[node]) {
				const leafEnd = leafStart[node] + leafCount[node];
				for (let slot = leafStart[node]; slot < leafEnd; slot++) {
					if (!(leafMasks[slot] & mask)) continue;
					const primitive = leafOrder[slot];
					const offset = primitive * BOX_STRIDE;
					const boxes = this.primitiveBoxes;
					if (maxX < boxes[offset] || maxY < boxes[offset + 1] || maxZ < boxes[offset + 2] || minX > boxes[offset + 3] || minY > boxes[offset + 4] || minZ > boxes[offset + 5]) continue;
					visit(primitive);
				}
			} else {
				stack.push(rightChild[node], node + 1);
			}
		}
	}

	// visit(primitiveIndex) for every primitive matching `mask` whose box the ray reaches, nearer first. The ray is {origin,
	// inverseDelta, axes, tMin, tMax, stackNodes, stackEntryTs}; a visitor may lower tMax to cut the walk short.
	visitAlongRay(ray, mask, visit) {
		const {nodeBoxes, nodeMasks, rightChild, leafStart, leafCount, leafOrder, leafMasks} = this;
		if (!(nodeMasks[0] & mask) || rayBoxEntry(nodeBoxes, 0, ray) === Infinity) return;
		if (ray.stackNodes.length < this.depth) {
			ray.stackNodes = new Int32Array(this.depth * 2);
			ray.stackEntryTs = new Float64Array(this.depth * 2);
		}
		const {stackNodes, stackEntryTs} = ray;
		let stackSize = 0;
		let node = 0;
		for (;;) {
			if (leafCount[node]) {
				const leafEnd = leafStart[node] + leafCount[node];
				for (let slot = leafStart[node]; slot < leafEnd; slot++) if (leafMasks[slot] & mask) visit(leafOrder[slot]);
			} else {
				const left = node + 1;
				const right = rightChild[node];
				const leftEntryT = nodeMasks[left] & mask ? rayBoxEntry(nodeBoxes, left * BOX_STRIDE, ray) : Infinity;
				const rightEntryT = nodeMasks[right] & mask ? rayBoxEntry(nodeBoxes, right * BOX_STRIDE, ray) : Infinity;
				if (rightEntryT < leftEntryT) {
					if (leftEntryT !== Infinity) {
						stackNodes[stackSize] = left;
						stackEntryTs[stackSize++] = leftEntryT;
					}
					node = right;
					continue;
				}
				if (leftEntryT !== Infinity) {
					if (rightEntryT !== Infinity) {
						stackNodes[stackSize] = right;
						stackEntryTs[stackSize++] = rightEntryT;
					}
					node = left;
					continue;
				}
			}
			do {
				if (!stackSize) return;
			} while (stackEntryTs[--stackSize] > ray.tMax);
			node = stackNodes[stackSize];
		}
	}
}
