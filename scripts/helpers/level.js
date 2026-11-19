export function levelConnectedIdentifiers(level, include) {
	return level ? [...(include ? [level.id] : []), ...(level.visibility?.levels ?? [])] : undefined;
}
