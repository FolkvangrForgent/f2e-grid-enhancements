const gridCaches = new WeakMap();
export function gridCachedPath(grid, key, compute) {
	let cache = gridCaches.get(grid);
	if (!cache) gridCaches.set(grid, (cache = new Map()));
	let value = cache.get(key);
	if (value !== undefined) {
		cache.delete(key);
	} else {
		value = compute();
		if (cache.size >= 4096) cache.delete(cache.keys().next().value);
	}
	cache.set(key, value);
	return value;
}

export function gridSquareCachedPath(grid, iDelta, jDelta, kDelta) {
	return gridCachedPath(grid, `${iDelta},${jDelta},${kDelta}`, () =>
		grid.measurePath([
			{i: 0, j: 0, k: 0},
			{i: iDelta, j: jDelta, k: kDelta}
		])
	);
}

export function gridHexCachedPath(grid, pDelta, kDelta) {
	return gridCachedPath(grid, `${pDelta},${kDelta}`, () =>
		grid.measurePath([
			{q: 0, r: 0, s: 0, k: 0},
			{q: pDelta, r: 0, s: -pDelta, k: kDelta}
		])
	);
}

export function gridGridlessCachedPath(grid, xDelta, yDelta, zDelta) {
	const pixelsPerUnit = gridUnitPixels(grid);
	return gridCachedPath(grid, `${xDelta},${yDelta},${zDelta}`, () =>
		grid.measurePath([
			{x: 0, y: 0, elevation: 0},
			{x: xDelta * pixelsPerUnit, y: yDelta * pixelsPerUnit, elevation: zDelta}
		])
	);
}

export function gridString(grid) {
	return grid?.isHexagonal ? 'hex' : grid?.isSquare ? 'square' : 'gridless';
}

export function gridUnitPixels(grid) {
	return grid.size / grid.distance;
}

export function gridIsFeet(grid) {
	return ['', 'ft', 'feet'].includes((grid.units ?? '').toLowerCase());
}

export function gridIsMeter(grid) {
	return ['', 'm', 'meter'].includes((grid.units ?? '').toLowerCase());
}
