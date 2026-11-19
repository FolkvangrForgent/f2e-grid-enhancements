// Bit positions follow core's list order, so "which types does this block" is one integer.
export const TYPES = CONST.EDGE_RESTRICTION_TYPES;

export const bitOfType = type => {
	const typeIndex = TYPES.indexOf(type);
	return typeIndex < 0 ? 0 : 1 << typeIndex;
};
export const maskOfTypes = types => {
	let typeMask = 0;
	for (const type of types ?? []) typeMask |= bitOfType(type);
	return typeMask;
};

export const EMPTY_ARRAY = Object.freeze([]);
