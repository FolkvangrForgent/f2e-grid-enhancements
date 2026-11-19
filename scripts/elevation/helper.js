// Wall heights: a wall stands from the bottom to the top of each level it is on, unless its own top / bottom elevation
// flags (set in the wall config, see index.js) override them.

// the flag keys of each end's override, and what an enabled override with no value means
const OVERRIDE_FLAGS = {
	top: {enabled: 'top-enabled', elevation: 'top-elevation', unbounded: Infinity},
	bottom: {enabled: 'bottom-enabled', elevation: 'bottom-elevation', unbounded: -Infinity}
};

// A wall's own top or bottom elevation override, or null where it has none. An enabled override with no value is
// unbounded (Infinity for the top, -Infinity for the bottom); a value that is not a number counts as no override.
export function wallHeightOverride(wall, key) {
	const flags = wall.flags?.['f2e-grid-enhancements'];
	const keys = OVERRIDE_FLAGS[key];
	if (!flags?.[keys.enabled]) return null;
	const value = flags[keys.elevation] ?? keys.unbounded;
	const text = typeof value === 'string' ? value.trim() : value;
	const number = (text ?? '') === '' ? NaN : Number(text);
	return Number.isNaN(number) ? null : number;
}

// The bottom and top a wall stands at on a level (null: a wall on no level), from its own overrides or else the level's.
export function wallHeightRange(ownBottom, ownTop, level) {
	return {bottom: ownBottom ?? level?.elevation?.bottom ?? -Infinity, top: ownTop ?? level?.elevation?.top ?? Infinity};
}
