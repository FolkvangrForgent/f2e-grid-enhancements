const OVERRIDE_FLAGS = {
	top: {enabled: 'top-enabled', elevation: 'top-elevation', unbounded: Infinity},
	bottom: {enabled: 'bottom-enabled', elevation: 'bottom-elevation', unbounded: -Infinity}
};

// An enabled override left empty is unbounded; one that is not a number counts as no override.
export function wallHeightOverride(wall, end) {
	const flags = wall.flags?.['f2e-grid-enhancements'];
	const flagKeys = OVERRIDE_FLAGS[end];
	if (!flags?.[flagKeys.enabled]) return null;
	const storedValue = flags[flagKeys.elevation] ?? flagKeys.unbounded;
	const trimmedValue = typeof storedValue === 'string' ? storedValue.trim() : storedValue;
	const elevation = (trimmedValue ?? '') === '' ? NaN : Number(trimmedValue);
	return Number.isNaN(elevation) ? null : elevation;
}

export function wallHeightRange(ownBottom, ownTop, level) {
	return {bottom: ownBottom ?? level?.elevation?.bottom ?? -Infinity, top: ownTop ?? level?.elevation?.top ?? Infinity};
}
