export function sceneOf(documentOrScene) {
	let ancestor = documentOrScene;
	while (ancestor && !(ancestor instanceof Scene)) ancestor = ancestor.parent;
	return ancestor;
}

// A level and the levels it sees (core's level visibility).
export function levelConnectedIdentifiers(level, includeOwnId) {
	return level ? [...(includeOwnId ? [level.id] : []), ...(level.visibility?.levels ?? [])] : undefined;
}

// Null unless there are several levels, none overlapping and each starting where the one below it ends.
export function sequentialLevels(scene) {
	const levels = [...scene.levels].sort((first, second) => (first.elevation.bottom ?? -Infinity) - (second.elevation.bottom ?? -Infinity));
	if (levels.length < 2) return null;
	for (let index = 0; index < levels.length; index++) {
		const bottom = levels[index].elevation.bottom ?? -Infinity;
		const top = levels[index].elevation.top ?? Infinity;
		if (!(top > bottom)) return null;
		if (index && bottom !== (levels[index - 1].elevation.top ?? Infinity)) return null;
	}
	return levels;
}

// For stacked levels (sequentialLevels). Bottoms are inclusive, tops exclusive except the highest level's. Below the lowest
// level's bottom is the lowest level; above the highest level's top is the highest.
export function levelAtElevation(levels, elevation) {
	const containing = levels.find(
		(level, index) => elevation >= (level.elevation.bottom ?? -Infinity) && (elevation < (level.elevation.top ?? Infinity) || (index === levels.length - 1 && elevation <= level.elevation.top))
	);
	if (containing) return containing;
	const lowest = levels[0];
	return elevation < (lowest.elevation.bottom ?? -Infinity) ? lowest : levels.at(-1);
}
