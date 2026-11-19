const MAX_CACHED_PATHS_PER_GRID = 4096;
const leastRecentlyUsedPathsByGrid = new WeakMap();

export function gridCachedPath(grid, pathKey, measurePath) {
	let pathsByKey = leastRecentlyUsedPathsByGrid.get(grid);
	if (!pathsByKey) leastRecentlyUsedPathsByGrid.set(grid, (pathsByKey = new Map()));
	let path = pathsByKey.get(pathKey);
	if (path !== undefined) {
		pathsByKey.delete(pathKey);
	} else {
		path = measurePath();
		if (pathsByKey.size >= MAX_CACHED_PATHS_PER_GRID) pathsByKey.delete(pathsByKey.keys().next().value);
	}
	pathsByKey.set(pathKey, path);
	return path;
}

export function gridSquareCachedPath(grid, iDelta, jDelta, kDelta) {
	return gridCachedPath(grid, `${iDelta},${jDelta},${kDelta}`, () =>
		grid.measurePath([
			{i: 0, j: 0, k: 0},
			{i: iDelta, j: jDelta, k: kDelta}
		])
	);
}

export function gridHexCachedPath(grid, hexSteps, kDelta) {
	return gridCachedPath(grid, `${hexSteps},${kDelta}`, () =>
		grid.measurePath([
			{q: 0, r: 0, s: 0, k: 0},
			{q: hexSteps, r: 0, s: -hexSteps, k: kDelta}
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
