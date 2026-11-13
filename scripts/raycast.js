// Raycast api

export function raycast(scene, origin, destination, {
	tMin = 0, tMax = 1,  walls = true, surfaces = true,
	type = 'move', mode = 'any', side, levels} = {}
) {
	// clamp t values (tMin, tMax]
	tMin = Math.max(0, tMin);
	tMax = Math.min(1, tMax);
	// ensure t values are valid
	if ( tMin > tMax ) {
		if ( mode === 'closest' ) return null;
		if ( mode === 'any' ) return false;
		return [];
	}
	// calculate deltas
	const dX = destination.x - origin.x;
	const dY = destination.y - origin.y;
	const dZ = destination.elevation - origin.elevation;
	// determine side
	side ??= dZ <= 0 ? 'above' : 'below';
	// calculate min and max for Z
	const minZ = Math.min(origin.elevation, destination.elevation);
	const maxZ = Math.max(origin.elevation, destination.elevation);
	// calculate levels that are in range
	levels ??= scene.levels.filter(level => (level.elevation.top >= minZ) && (level.elevation.bottom <= maxZ)).map(level => level.id);
	// find all collisions
	const collisions = [];
	// walls
	if ( walls && (dX || dY) ) {
		// calculate min and max for X and Y
		const minX = Math.min(origin.x, destination.x);
		const maxX = Math.max(origin.x, destination.x);
		const minY = Math.min(origin.y, destination.y);
		const maxY = Math.max(origin.y, destination.y);
		// forgive first limited wall when any mode
		let limitedForgiven = false;
		// loop through every wall
		for ( const wall of scene.walls ) {
			const flags = wall.flags?.['f2e-grid-enhancements'];
			const top = flags?.['top-enabled'] ? (flags?.['top-elevation'] ?? Infinity) : null;
			const bottom = flags?.['bottom-enabled'] ? (flags?.['bottom-elevation'] ?? -Infinity) : null;
			// cheapest checks first
			if ( wall.isDoor && wall.isOpen ) continue;
			const edge = wall.edge;
			const sense = edge?.[type];
			if ( !sense ) continue;
			if ( ((edge.a.x < minX) && (edge.b.x < minX)) || ((edge.a.x > maxX) && (edge.b.x > maxX)) || ((edge.a.y < minY) && (edge.b.y < minY)) || ((edge.a.y > maxY) && (edge.b.y > maxY)) ) continue;
			if ( wall.levels?.size ) {
				let spans = false;
				let resolved = false;
				let validLevel = false;
				for ( const levelIdentifier of wall.levels ) {
					if ( levels.includes(levelIdentifier) ) {
						validLevel = true;
						break;
					}
				}
				for ( const levelIdentifier of wall.levels ) {
					const level = scene.levels.get(levelIdentifier);
					if ( !level ) continue;
					resolved = true;
					if ( ((bottom ?? level.elevation.bottom) <= maxZ) && ((top ?? level.elevation.top) > minZ) ) {
						spans = true;
						break;
					}
				}
				if ( (!spans || !validLevel) && resolved ) continue;
			}
			const intersection = foundry.utils.lineSegmentIntersection(origin, destination, edge.a, edge.b);
			if ( !intersection || (intersection.t0 <= tMin) || (intersection.t0 > tMax) ) continue;
			intersection.elevation = origin.elevation + (intersection.t0 * dZ);
			if ( wall.levels?.size ) {
				let spans = false;
				let resolved = false;
				for ( const levelIdentifier of wall.levels ) {
					const level = scene.levels.get(levelIdentifier);
					if ( !level ) continue;
					resolved = true;
					if ( ((bottom ?? level.elevation.bottom) <= intersection.elevation) && ((top ?? level.elevation.top) > intersection.elevation) ) {
						spans = true;
						break;
					}
				}
				if ( !spans && resolved ) continue;
			} else {
				if ( ((bottom ?? -Infinity) > intersection.elevation) || ((top ?? Infinity)<= intersection.elevation) ) {
					continue;
				}
			}
			if ( edge.direction && (edge.direction === edge.orientPoint(origin)) ) continue;
			if ( edge.threshold && edge.applyThreshold(type, origin) ) continue;
			if ( mode === 'any' ) {
				if ( sense !== CONST.EDGE_SENSE_TYPES.LIMITED || limitedForgiven ) return true;
				limitedForgiven = true;
			}
			collisions.push({
				limited: sense === CONST.EDGE_SENSE_TYPES.LIMITED,
				type: 'wall',
				document: wall,
				t: intersection.t0,
				point: {
					x: intersection.x,
					y: intersection.y,
					elevation: intersection.elevation
				}});
		}
		// shrink tMax to closest collision
		if ( mode === 'closest' ) {
			let solid = Infinity;
			let limitedFirst = Infinity;
			let limitedSecond = Infinity;
			for ( const hit of collisions ) {
				if ( !hit.limited ) {
					if ( hit.t < solid ) solid = hit.t;
				} else if ( hit.t < limitedFirst ) {
					limitedSecond = limitedFirst;
					limitedFirst = hit.t;
				} else if ( hit.t < limitedSecond ) {
					limitedSecond = hit.t;
				}
			}
			tMax = Math.min(tMax, solid, limitedSecond);
		}
	}
	// surfaces
	if ( surfaces && dZ ) {
		// calculate bounds for optimization
		const bounds = new PIXI.Rectangle(
			origin.x + (dX * tMin),
			origin.y + (dY * tMin),
			dX * (tMax - tMin),
			dY * (tMax - tMin)
		).normalize().pad(1);
		const seen = new Set();
		for ( const level of levels ) {
			for ( const surface of scene.getSurfaces({type, level}) ) {
				const {region, elevation, key} = surface;
				// cheapest checks first
				if ( side === 'above' ) {
					if ( (elevation < minZ) || (elevation >= maxZ) ) continue;
				} else {
					if ( (elevation <= minZ) || (elevation > maxZ) ) continue;
				}
				const t = (elevation - origin.elevation) / dZ;
				if ( !(t >= tMin && t <= tMax) ) continue;
				if ( !region.bounds.intersects(bounds) ) continue;
				if ( seen.has(key) ) continue;
				const point = {x: origin.x + (dX * t), y: origin.y + (dY * t), elevation};
				if ( !region.polygonTree.testPoint(point, 0.75) ) continue;
				if ( mode === 'any' ) return true;
				seen.add(key);
				collisions.push({type: 'surface', t, point, document: region});
				// shrink tMax to closest collision
				if ( mode === 'closest' ) tMax = Math.min(tMax, t);
			}
		}
	}
	// sort collisions and process limited
	collisions.sort((h1, h2) => h1.t - h2.t);
	const blocking = [];
	let limitedSeen = false;
	for ( const hit of collisions ) {
		if ( hit.limited && !limitedSeen ) {
			limitedSeen = true;
			continue;
		}
		blocking.push(hit);
		if ( mode !== 'all' ) break;
	}
	if ( mode === 'closest' ) return blocking[0] ?? null;
	if ( mode === 'any' ) return blocking.length > 0;
	return blocking;
}
