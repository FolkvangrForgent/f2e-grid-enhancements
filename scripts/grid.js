const PHI = Math.PI * (3 - Math.sqrt(5));
const NUDGE = 1e-8;

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
					if (!validLevel && levels.includes(levelIdentifier)) {
						validLevel = true;
					}
					if (!spans || !resolved) {
						const level = scene.levels.get(levelIdentifier);
						if ( !level ) continue;
						resolved = true;
						if ( (level.elevation.bottom <= maxZ) && (level.elevation.top > minZ) ) {
							spans = true;
							break;
						}
					}
				}
				if ( (!spans || !validLevel) && resolved ) continue;
			}
			const intersection = foundry.utils.lineSegmentIntersection(origin, destination, edge.a, edge.b);
			if ( !intersection || (intersection.t0 <= tMin) || (intersection.t0 > tMax) ) continue;
			intersection.elevation = origin.elevation + (intersection.t0 * dZ);
			if ( dZ && wall.levels?.size ) {
				let spans = false;
				let resolved = false;
				for ( const leveldentifier of wall.levels ) {
					const level = scene.levels.get(leveldentifier);
					if ( !level ) continue;
					resolved = true;
					if ( (level.elevation.bottom <= intersection.elevation) && (level.elevation.top > intersection.elevation) ) {
						spans = true;
						break;
					}
				}
				if ( !spans && resolved ) continue;
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
		// shrink tmax to closest collision
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
		// calulate bounds for optimization
		const bounds = new PIXI.Rectangle(
			origin.x + (dX * tMin),
			origin.y + (dY * tMin),
			dX * (tMax - tMin),
			dY * (tMax - tMin)
		).normalize().pad(1);
		const seen = new Set();
		for ( const level of levels ) {
			for ( const {region, elevation} of scene.getSurfaces({type, level}) ) {
				// cheapest checks first
				if ( side === 'above' ) {
					if ( (elevation < minZ) || (elevation >= maxZ) ) continue;
				} else {
					if ( (elevation <= minZ) || (elevation > maxZ) ) continue;
				}
				const t = (elevation - origin.elevation) / dZ;
				if ( !(t >= tMin && t <= tMax) ) continue;
				if ( !region.bounds.intersects(bounds) ) continue;
				const key = `${region.id}|${elevation}`;
				if ( seen.has(key) ) continue;
				const point = {x: origin.x + (dX * t), y: origin.y + (dY * t), elevation};
				if ( !region.polygonTree.testPoint(point, 0.75) ) continue;
				if ( mode === 'any' ) return true;
				seen.add(key);
				collisions.push({type: 'surface', t, point, document: region});
				// shrink tmax to closest collision
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

function tokenOffsets(token, flat) {
	// heavily modified logic from core getOccupiedGridSpaceOffsets to remove collisions and allow flat offsets without k
	const offsets = [];
	const {i: i_min, j: j_min, k: k_min} = token.document._positionToGridOffset();
	const width = Math.max(Math.round(token.document.width * 2) / 2, 0.5);
	const height = Math.max(Math.round(token.document.height * 2) / 2, 0.5);
	const depth = Math.max(Math.round(token.document.depth * 2) / 2, 0.5);
	const k_max = k_min + Math.ceil(depth);
	if ( token.document.scene.grid.isSquare ) {
		const i_max = i_min + Math.ceil(height);
		const j_max = j_min + Math.ceil(width);
		for ( let i = i_min; i < i_max; i++ ) {
			for ( let j = j_min; j < j_max; j++ ) {
				if (flat) {
					offsets.push({i, j});
				} else {
					for ( let k = k_min; k < k_max; k++ ) {
						offsets.push({i, j, k});
					}
				}
			}
		}
	} else if (token.document.scene.grid.isHexagonal) {
		const {even, odd} = foundry.documents.BaseToken._getHexagonalOffsets(width, height, tokenShape(token), token.document.scene.grid.columns);
		for ( const {i: di, j: dj} of (((token.document.scene.grid.columns ? j_min : i_min) % 2 === 0) === token.document.scene.grid.even ? even : odd)) {
			if (flat) {
				offsets.push({i: i_min + di, j: j_min + dj});
			} else {
				for ( let k = k_min; k < k_max; k++ ) {
					const offset = {i: i_min + di, j: j_min + dj, k};
					offsets.push(offset);
				}
			}
		}
	}
	return offsets;
}


function tokenCenterBottom(token) {
	return token.document.getCenterPoint()
}

function tokenCenterCenter(token) {
	const center_point = token.document.getCenterPoint()
	center_point.elevation += token.document.depth / 2 * token.document.scene.grid.distance;
	return center_point;
}

function tokenCenterTop(token) {
	const center_point = token.document.getCenterPoint()
	center_point.elevation += token.document.depth * token.document.scene.grid.distance;
	return center_point;
}

function tokenNormalizedCenter(token) {
	const center = tokenCenterCenter(token);
	return {x: center.x / token.document.scene.grid.size, y: center.y / token.document.scene.grid.size, z: center.elevation / token.document.scene.grid.distance};
}

function tokenShell(token) {
	if (token.document.scene.grid.isHexagonal) {
		const depth = Math.round(token.document.depth * 2) / 2;
		const bottom = Math.floor((token.document.elevation / token.document.scene.grid.distance) + NUDGE) * token.document.scene.grid.distance;
		// use map to deduplicate points
		const shell_points = new Map();
		const push = (point) => {
			const key = `${Math.round(point.x * 100)}|${Math.round(point.y * 100)}|${Math.round(point.elevation * 100)}`;
			shell_points.set(key, {x: point.x, y: point.y, elevation: point.elevation});
		};
		// generate column points
		const edges = new Map();
		for (const offset of tokenAuraOffsetHelper(token, 0, false)) {
			const vertices = token.document.scene.grid.getVertices(offset);
			for (let index = 0; index < vertices.length; index++) {
				const p0 = vertices[index];
				const s0 = `${Math.round(p0.x * 100)},${Math.round(p0.y * 100)}`;
				const p1 = vertices[(index + 1) % vertices.length];
				const s1 = `${Math.round(p1.x * 100)},${Math.round(p1.y * 100)}`;
				if (edges.delete(`${s1}>${s0}`)) continue;
				edges.set(`${s0}>${s1}`, {p0, p1});
			}
		}
		for (let z = 0; z <= depth; z += 0.5) {
			const elevation = bottom + z * token.document.scene.grid.distance;
			for (const {p0, p1} of edges.values()) {
				push({x: p0.x, y: p0.y, elevation});
				push({x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2, elevation});
			}
		}
		// generate top and bottom points
		const top = bottom + depth * token.document.scene.grid.distance;
		for (const offset of tokenOffsets(token, true)) {
			const point = token.document.scene.grid.getCenterPoint(offset);
			push({x: point.x, y: point.y, top});
			push({x: point.x, y: point.y, bottom});
			for (const adjacent_offset of token.document.scene.grid.getAdjacentOffsets(offset)) {
				const adjacent_point = token.document.scene.grid.getCenterPoint(adjacent_offset);
				push({x: (point.x * 3 + adjacent_point.x) / 4, y: (point.y * 3 + adjacent_point.y) / 4, top});
				push({x: (point.x * 3 + adjacent_point.x) / 4, y: (point.y * 3 + adjacent_point.y) / 4, bottom});
				push({x: (point.x + adjacent_point.x) / 2, y: (point.y + adjacent_point.y) / 2, top});
				push({x: (point.x + adjacent_point.x) / 2, y: (point.y + adjacent_point.y) / 2, bottom});
			}
			for (const grid_point of token.document.scene.grid.getVertices(offset)) {
				push({x: grid_point.x, y: grid_point.y, top});
				push({x: grid_point.x, y: grid_point.y, bottom});
			}
		}
		return Array.from(shell_points.values());
	} else {
		const shell_points = [];
		const width = Math.round(token.document.width * 2) / 2;
		const height = Math.round(token.document.height * 2) / 2;
		const depth = Math.round(token.document.depth * 2) / 2;
		const origin = token.document.scene.grid.getTopLeftPoint({x: token.document.x, y: token.document.y, elevation: token.document.elevation});
		if ([CONST.TOKEN_SHAPES.ELLIPSE_1, CONST.TOKEN_SHAPES.ELLIPSE_2].includes(tokenShape(token))) {
			// fibonacci lattice sphere point spread (using the same number of points that square uses)
			const steps_x = width * 2;
			const steps_y = height * 2;
			const steps_z = depth * 2;
			const count = (steps_x + 1) * (steps_y + 1) * (steps_z + 1) - Math.max(0, steps_x - 1) * Math.max(0, steps_y - 1) * Math.max(0, steps_z - 1);
			const radius_x = width / 2;
			const radius_y = height / 2;
			const radius_z = depth / 2;
			const center_x = origin.x + radius_x * token.document.scene.grid.size;
			const center_y = origin.y + radius_y * token.document.scene.grid.size;
			const center_elevation = origin.elevation + radius_z * token.document.scene.grid.distance;

			for (let index = 0; index < count; index++) {
				const unit_z = 1 - 2 * index / (count - 1);
				const unit_radius = Math.sqrt(Math.max(0, 1 - unit_z * unit_z));
				const theta = index * PHI;
				shell_points.push({
					x: center_x + radius_x * unit_radius * Math.cos(theta) * token.document.scene.grid.size,
					y: center_y + radius_y * unit_radius * Math.sin(theta) * token.document.scene.grid.size,
					elevation: center_elevation + radius_z * unit_z * token.document.scene.grid.distance
				});
			}
		} else if ([CONST.TOKEN_SHAPES.RECTANGLE_1, CONST.TOKEN_SHAPES.RECTANGLE_2].includes(tokenShape(token))) {
			for (let x = 0; x <= width; x += 0.5) {
				for (let y = 0; y <= height; y += 0.5) {
					for (let z = 0; z <= depth; z += 0.5) {
						if (!(z === 0 || z === depth) && !((x === 0 || x === width) || (y === 0 || y === height))) {
							continue;
						}
						shell_points.push({
							x: origin.x + x * token.document.scene.grid.size,
							y: origin.y + y * token.document.scene.grid.size,
							elevation: origin.elevation + z * token.document.scene.grid.distance
						});
					}
				}
			}
		}
		return shell_points;
	}
}

function tokenBounds(token) {
	const scale = token.document.scene.grid.distance / token.document.scene.grid.size;
	return {
		x_min: ( token.document.x - token.document.scene.grid.size ) * scale,
		x_max: ( token.document.x + token.document.width * token.document.scene.grid.size + token.document.scene.grid.size ) * scale,
		y_min: ( token.document.y - token.document.scene.grid.size ) * scale,
		y_max: ( token.document.y + token.document.height * token.document.scene.grid.size + token.document.scene.grid.size ) * scale,
		z_min: token.document.elevation - token.document.scene.grid.distance,
		z_max: token.document.elevation + token.document.depth * token.document.scene.grid.distance + token.document.scene.grid.distance,
	};
}

function tokenShape(token) {
	if (token.document.scene.grid.isHexagonal || token.document.scene.grid.isGridless && ![CONST.TOKEN_SHAPES.TRAPEZOID_1, CONST.TOKEN_SHAPES.TRAPEZOID_2].includes(token.document.shape)) {
		return token.document.shape;
	}
	return CONST.TOKEN_SHAPES.RECTANGLE_1;
}

function tokenPoints(token) {
	if (token.document.scene.grid.isGridless) {
		return tokenShell(token);
	}
	return tokenOffsets(token, false).map((offset) => token.document.scene.grid.getCenterPoint(offset));
}

function tokenAuraOffsetHelper(token, radius, hole) {
	if (token.document.scene.grid.isGridless) {
		return [];
	} else {
		// map to deduplicate
		const offsets = new Map();
		// outer offsets optimization
		let outer_offsets = [];
		// get token offsets
		const token_offsets = tokenOffsets(token, true);
		// add token offsets
		for (const token_offset of token_offsets) {
			const key = `${token_offset.i},${token_offset.j}`;
			if (!offsets.has(key)) {
				offsets.set(key, token_offset);
				outer_offsets.push(token_offset);
			}
		}
		// grow offsets
		const steps = Math.floor(radius / token.document.scene.grid.distance + NUDGE);
		for (let step = 0; step < steps && outer_offsets.length; step++) {
			let new_outer_offsets = [];
			for (const outer_offset of outer_offsets) {
				for (const offset of token.document.scene.grid.getAdjacentOffsets(outer_offset)) {
					const key = `${offset.i},${offset.j}`;
					if (!offsets.has(key)) {
						offsets.set(key, offset);
						new_outer_offsets.push(offset);
					}
				}
			}
			outer_offsets = new_outer_offsets;
		}
		// remove token offsets
		if (hole) {
			for (const token_offset of token_offsets) {
				offsets.delete(`${token_offset.i},${token_offset.j}`);
			}
		}
		// remove square overshoot
		if (token.document.scene.grid.isSquare) {
			for (const offset of offsets.values()) {
				let remove = true;
				for (const token_offset of token_offsets) {
					if (token.scene.grid.measurePath([offset, token_offset]).distance <= radius + NUDGE) {
						remove = false;
						break;
					}
				}
				if (remove) {
					offsets.delete(`${offset.i},${offset.j}`);
				}
			}
		}
		return offsets.values();
	}
}

function tokenAuraOffsetPolygons(token, radius, hole) {
	if (token.document.scene.grid.isGridless) {
		// get the base shape data of the token
		let aura_base;
		if ([CONST.TOKEN_SHAPES.ELLIPSE_1, CONST.TOKEN_SHAPES.ELLIPSE_2].includes(token.document.shape)) {
			aura_base = {
				type: 'ellipse',
				x: token.document.x + token.document.width * token.document.scene.grid.size / 2,
				y: token.document.y + token.document.height * token.document.scene.grid.size / 2,
				radiusX: token.document.width / 2 * token.document.scene.grid.size,
				radiusY: token.document.height / 2 * token.document.scene.grid.size,
				hole
			}
		} else {
			aura_base = {
				type: 'rectangle',
				x: token.document.x,
				y: token.document.y,
				width: token.document.width * token.document.scene.grid.size,
				height: token.document.height * token.document.scene.grid.size,
				hole
			}
		}
		// create the emenation shape of the aura
		const aura_shape = new foundry.data.EmanationShapeData({
			type: 'emanation',
			base: aura_base,
			radius: radius * token.document.scene.grid.size / token.document.scene.grid.distance,
			gridBased: false
		});
		return aura_shape.polygons;
	} else {
		// convert offsets to edges (removing overlapping)
		const edges = new Map();
		for (const offset of tokenAuraOffsetHelper(token, radius, hole)) {
			const vertices = token.document.scene.grid.getVertices(offset);
			for (let index = 0; index < vertices.length; index++) {
				const p0 = vertices[index];
				const s0 = `${Math.round(p0.x * 100)},${Math.round(p0.y * 100)}`;
				const p1 = vertices[(index + 1) % vertices.length];
				const s1 = `${Math.round(p1.x * 100)},${Math.round(p1.y * 100)}`;
				if (edges.delete(`${s1}>${s0}`)) continue;
				edges.set(`${s0}>${s1}`, {p0, s0, s1});
			}
		}
		// sort edges by start after removal
		const remapped_edges = new Map();
		for (const edge of edges.values()) {
			remapped_edges.set(edge.s0, edge);
		}
		// walk the edges to create polygons
		const polygons = [];
		while (remapped_edges.size > 0) {
			const points = [];
			let edge = remapped_edges.values().next().value;
			while (edge) {
				remapped_edges.delete(edge.s0);
				points.push(edge.p0.x, edge.p0.y);
				edge = remapped_edges.get(edge.s1);
			}
			if (points.length >= 6) {
				polygons.push(new PIXI.Polygon(points));
			}
		}
		// order the polygons with the largest first
		polygons.sort((a, b) => b.points.length - a.points.length);
		return polygons;
	}
}

function traitsCollisionTypes(traits) {
	const collision_types = [];
	if (traits.includes('auditory')) {
		collision_types.push('sound');
	}
	if (traits.includes('visual')) {
		collision_types.push('sight');
	}
	if (!traits.includes('auditory') && !traits.includes('visual')) {
		collision_types.push('move');
	}
	return collision_types;
}

export function Token_object_distanceTo(wrapped, self, target, opts) {
	// if target is self distance will always be 0
	if (self === target) return 0;
	// calculate self points
	const self_points = tokenPoints(self);
	// calculate target points
	let target_points = []
	if (target instanceof CONFIG.Token.objectClass) {
		if (self.scene !== target.scene) {
			return Infinity;
		}
		target_points = tokenPoints(target);
	} else {
		target_points = [self.scene.grid.getCenterPoint({x: target.x, y: target.y, elevation: target.elevation ?? self.document.elevation})];
	}
	// determine if we should discount 5 ft after the second diagonal for 10 ft reach on a 5 ft grid
	let discount = false;
	if (game.settings.get('f2e-grid-enhancements', 'reach-exception') && self.scene.grid.isSquare && [CONST.GRID_DIAGONALS.ALTERNATING_1, CONST.GRID_DIAGONALS.ALTERNATING_2].includes(self.scene.grid.diagonals) && opts?.reach === 10 && self.scene.grid.distance === 5 && ['', 'ft', 'feet'].includes(self.scene.grid.units.toLowerCase())) {
		discount = true;
	}
	// calculate distance
	let distance = Infinity;
	for (const self_point of self_points) {
		for (const target_point of target_points) {
			const pathCandidate = self.scene.grid.measurePath([self_point, target_point]);
			if (discount && pathCandidate.segments[0]?.diagonals > 1) {
				pathCandidate.distance -= self.scene.grid.distance;
			}
			if (pathCandidate.distance < distance) {
				distance = pathCandidate.distance;
			}
		}
	}
	// round distance to nearest tenth
	return Math.max(0, Math.round(distance * 10) / 10);
}

export function Token_object__onClickLeft2(wrapped, self, event) {
	const requiresReach = game.pf2e.settings.automation.reachEnforcement.has(self.actor?.isOfType('loot') ? (self.actor.isLoot ? 'loot' : 'merchants') : 'corpses');
	if (!self.document.isSecret && requiresReach && !self.document.isOwner && self.actor?.isLootableBy(game.user)) {
		const inReach = [...new Set([self.layer.controlled, game.user.character?.getActiveTokens(true, false) ?? []].flat())].some(
			(token) =>
				token.actor?.isOwner &&
				token.actor.isOfType('creature', 'party') &&
				token.distanceTo(self) <= token.actor.system.attributes.reach.manipulate,
		);
		if (!inReach) {
			const thisIsCreature = self.actor.isOfType('creature');
			const name = self.document.playersCanSeeName
				? self.document.name
				: game.i18n.localize(`PF2E.Token.Mystified.The${thisIsCreature ? 'Creature' : 'Object'}`);
			ui.notifications.warn('PF2E.Token.OutOfReach', { format: { token: name } });
			return;
		}
	}
	return wrapped(event);
}

export function Region_object_snappingMode(wrapped, self){
	switch (self.areaShape) {
		case 'point':
			return CONST.GRID_SNAPPING_MODES.CENTER;
		case 'emanation':
			return CONST.GRID_SNAPPING_MODES.CENTER | CONST.GRID_SNAPPING_MODES.VERTEX;
		case 'burst':
			return CONST.GRID_SNAPPING_MODES.VERTEX;
		case 'cone':
			return CONST.GRID_SNAPPING_MODES.CENTER | CONST.GRID_SNAPPING_MODES.EDGE_MIDPOINT | CONST.GRID_SNAPPING_MODES.VERTEX;
		case 'line':
			return CONST.GRID_SNAPPING_MODES.EDGE_MIDPOINT | CONST.GRID_SNAPPING_MODES.VERTEX;
		default:
			return wrapped();
	}
}

export function Region_object_getCoveredGridSpaceOffsets(wrapped, self){
	return wrapped();
}

export function Region_layer_placeRegion(wrapped, self, data, options = {}) {
	if (data.highlightMode === 'coverage') {
		const patchedData = data.shapes
			? {
				...data,
				shapes: data.shapes.map((shape) => {
					if (shape.type !== 'cone' || shape.angle !== 90) return shape;
					return {...shape, angle: game.settings.get('f2e-grid-enhancements', `${canvas?.grid?.isHexagonal ? 'hex' : canvas?.grid?.isSquare ? 'square' : 'gridless'}-cone-template-angle`)};
				})
			}: data;
		const patchedOptions = {...options};
		const placement = { aiming: false };
		patchedOptions.onMove = function (...args) {
			const { event, position, preview, shape, snap, document } = args[0];
			if (placement.aiming && (shape.type === 'cone' || shape.type === 'line')) {
				const angle = shape.type === 'cone' ? game.settings.get('f2e-grid-enhancements', `${document.parent.grid.isHexagonal ? 'hex' : document.parent.grid.isSquare ? 'square' : 'gridless'}-cone-snapping-angle`) : 5;
				const rotation = Math.toDegrees(Math.atan2(position.y - shape.y, position.x - shape.x));
				const snapped = event.ctrlKey || event.metaKey || angle === 0 ? rotation : rotation.toNearest(angle);
				shape.updateSource({ rotation: snapped });
				return false;
			}
			if (snap) {
				const { x, y } = document.parent.grid.getSnappedPoint(position, { mode: preview.snappingMode });
				position.x = x;
				position.y = y;
			}
			return typeof options.onMove === 'function' ? options.onMove.apply(this, args) : undefined;
		};
		patchedOptions.onRotate = function (...args) {
			const { event, shape, document } = args[0];
			if (shape.type === 'cone' || shape.type === 'line') {
				const angle = shape.type === 'cone' ? game.settings.get('f2e-grid-enhancements', `${document.parent.grid.isHexagonal ? 'hex' : document.parent.grid.isSquare ? 'square' : 'gridless'}-cone-snapping-angle`) : 5;
				const free = event.ctrlKey || event.metaKey || angle === 0;
				const step = free ? 1 : angle;
				const rotation = shape.rotation + step * Math.sign(event.deltaY);
				shape.updateSource({ rotation: free ? rotation : rotation.toNearest(step) });
				return false;
			}
			return typeof options.onRotate === 'function' ? options.onRotate.apply(this, args) : undefined;
		};
		patchedOptions.preConfirm = function (...args) {
			const { event, shape } = args[0];
			if (!placement.aiming && (shape.type === 'cone' || shape.type === 'line') && !event.shiftKey) {
				placement.aiming = true;
				return false;
			}
			return typeof options.preConfirm === 'function' ? options.preConfirm.apply(this, args) : undefined;
		};
		patchedOptions.preSkip = function (...args) {
			if (placement.aiming) {
				placement.aiming = false;
				return false;
			}
			return typeof options.preSkip === 'function' ? options.preSkip.apply(this, args) : undefined;
		};
		return CONFIG.F2e.functions.placeRegion.call(self, patchedData, patchedOptions);
	}
	return CONFIG.F2e.functions.placeRegion.call(self, data, options);
}

export function Region_layer__onDragLeftMove(wrapped, self, event) {
	CONFIG.F2e.functions._onDragLeftMove.call(self, event)
	if (event.interactionData.shape?.type === 'circle' && ui.controls.tool?.name === 'point') {
		event.interactionData.shape.updateSource({radius: canvas.dimensions.distance * canvas.dimensions.distancePixels / 2});
		self._updateDragPreview(event);
	} else if (self.templateMode && (event.interactionData.shape?.type === 'line' || event.interactionData.shape?.type === 'cone')) {
		const angle = event.interactionData.shape.type === 'cone' ? game.settings.get('f2e-grid-enhancements', `${canvas.scene.grid.isHexagonal ? 'hex' : canvas.scene.grid.isSquare ? 'square' : 'gridless'}-cone-snapping-angle`) : 5;
		const pointer = event.getLocalPosition(self);
		const raw_rotation = Math.toDegrees(Math.atan2(pointer.y - event.interactionData.shape.y, pointer.x - event.interactionData.shape.x));
		const rotation = event.ctrlKey || event.metaKey || angle === 0 ? raw_rotation : raw_rotation.toNearest(angle);
		if (rotation !== event.interactionData.shape.rotation) {
			event.interactionData.shape.updateSource({rotation});
			self._updateDragPreview(event);
		}
	}
}

export function Scene_document_canHaveAuras(wrapped, self) {
	return ['', 'ft', 'feet'].includes(self.grid.units.toLowerCase());
}

export function Aura_renderer_draw(wrapped, self, showBorder) {
	// If the token is GM hidden or if this grid isn't ft, don't render anything
	if (self.token.document.hidden && !self.token.visible) {
		self.border.visible = false;
		return;
	}
	// clear initial border
	if ((self.radius !== self.border_radius || self.token.document.shape !== self.border_shape || self.token.document.width !== self.border_width || self.token.document.height !== self.border_height)) {
		self.border_radius = self.radius
		self.border_shape = self.token.document.shape
		self.border_width = self.token.document.width
		self.border_height = self.token.document.height
		self.border.clear();
	}
	// Create aura border (token base type and polygon type didn't work for some reason)
	if (self.border.geometry.graphicsData.length === 0 && self.appearance.border?.color != null && self.appearance.border?.alpha != null) {
		let polygons = tokenAuraOffsetPolygons(self.token, self.radius, false)
		if (polygons[0] != null) {
			// polygons are in scene space but the border is positioned relative to the token center
			const center_x = self.token.document.x + self.token.mechanicalBounds.width / 2;
			const center_y = self.token.document.y + self.token.mechanicalBounds.height / 2;
			const border_polygon = new PIXI.Polygon(polygons[0].points.map((value, index) => value - (index % 2 === 0 ? center_x : center_y)));
			self.border.lineStyle(self.token.document.scene.grid.thickness, self.appearance.border?.color, self.appearance.border?.alpha).drawShape(border_polygon);
		}
	}
	// shift aura into the correct position here (fixes hover ghost)
	self.x = self.token.mechanicalBounds.width / 2;
	self.y = self.token.mechanicalBounds.height / 2;
	// TODO aura texture support if anything uses that?
	// show or hide border
	self.border.visible = showBorder;
}

export function Aura_token_containsToken(wrapped, self, token) {
	// If either token is hidden or not rendered, return false early
	if (self.token.hidden || token.hidden || !self.token.object || !token.object) {
		return false;
	}
	// If the token is the one emitting the aura, return true early
	if (token === self.token) {
		return true;
	}
	// check lower bounds of distance
	const self_bounds = tokenBounds(self.token.object);
	const token_bounds = tokenBounds(token.object);
	const distance_lower_bound = Math.max(0,
		self_bounds.x_min - token_bounds.x_max, token_bounds.x_min - self_bounds.x_max,
		self_bounds.y_min - token_bounds.y_max, token_bounds.y_min - self_bounds.y_max,
		self_bounds.z_min - token_bounds.z_max, token_bounds.z_min - self_bounds.z_max
	);
	if (distance_lower_bound > self.radius) {
		return false;
	}
	// ensure that token is within range
	if (self.token.object.distanceTo(token.object) > self.radius) {
		return false;
	}
	// decide what collision types to test against
	const collision_types = traitsCollisionTypes(self.traits);
	// create center points bound by surfaces
	const [source_token_usable_center_point_map, target_token_usable_center_point_map] = [self.token.object, token.object].map((token_object) => {
		const center_top_point = tokenCenterTop(token_object);
		const center_bottom_point = tokenCenterBottom(token_object);
		const usable_center_point_map = new Map();
		for (const collision_type of collision_types) {
			const usable_center_point = raycast(self.token.object.scene, center_bottom_point, center_top_point, {side: 'below', mode: 'closest', type: collision_type})?.point ?? {...center_top_point};
			usable_center_point.elevation = (usable_center_point.elevation + center_bottom_point.elevation) / 2;
			usable_center_point_map.set(collision_type, usable_center_point);
		}
		return usable_center_point_map;
	});
	// get shell points and randomize them
	const target_token_shell_points = tokenShell(token.object);
	for (let index = target_token_shell_points.length - 1; index > 0; index--) {
		const random_index = Math.floor(Math.random() * (index + 1));
		const temporary_value = target_token_shell_points[index];
		target_token_shell_points[index] = target_token_shell_points[random_index];
		target_token_shell_points[random_index] = temporary_value;
	}
	// do center point to shell tests for line of effect
	for (const target_token_shell_point of target_token_shell_points) {
		for (const collision_type of collision_types) {
			const target_token_usable_center_point = target_token_usable_center_point_map.get(collision_type);
			const source_token_usable_center_point = source_token_usable_center_point_map.get(collision_type);
			let constrained_target_token_shell_point = target_token_shell_point;
			const collision = raycast(self.token.object.scene, target_token_usable_center_point, constrained_target_token_shell_point, {mode: 'closest', type: collision_type});
			if (collision !== null) {
				constrained_target_token_shell_point = {
					x: collision.point.x + (target_token_usable_center_point.x - collision.point.x) * 0.1,
					y: collision.point.y + (target_token_usable_center_point.y - collision.point.y) * 0.1,
					elevation: collision.point.elevation + (target_token_usable_center_point.elevation - collision.point.elevation) * 0.1
				};
			}
			if (!raycast(self.token.object.scene, source_token_usable_center_point, constrained_target_token_shell_point, {mode: 'any', type: collision_type})) {
				return true;
			}
		}
	}
	return false;
}

export function Token_object_onOppositeSides(wrapped, self, flanker, other, flankee) {
	if (!game.settings.get('f2e-grid-enhancements', `flanking-${flankee.document.scene.grid.isHexagonal ? 'hex' : flankee.document.scene.grid.isSquare ? 'square' : 'gridless'}-override`)) {
		return wrapped(flanker, other, flankee)
	}
	// flanker data
	const {x: flanker_x, y: flanker_y, z: flanker_z} = tokenNormalizedCenter(flanker);
	// other data
	const {x: other_x, y: other_y, z: other_z} = tokenNormalizedCenter(other);
	// flankee data
	const flankee_height = Math.max(flankee.document.height / 2, 0.25);
	const flankee_width = Math.max(flankee.document.width / 2, 0.25);
	const flankee_depth = Math.max(flankee.document.depth / 2, 0.25);
	const {x: flankee_x, y: flankee_y, z: flankee_z} = tokenNormalizedCenter(flankee);
	// derived numbers
	const x0 = flanker_x - flankee_x
	const x1 = other_x - flanker_x
	const y0 = flanker_y - flankee_y
	const y1 = other_y - flanker_y
	const z0 = flanker_z - flankee_z
	const z1 = other_z - flanker_z
	const a2 = flankee_width * flankee_width
	const b2 = flankee_height * flankee_height
	const c2 = flankee_depth * flankee_depth
	// quadratic numbers
	const A = (x1 * x1) / a2 + (y1 * y1) / b2 + (z1 * z1) / c2
	const B = (2 * x0 * x1) / a2 + (2 * y0 * y1) / b2 + (2 * z0 * z1) / c2
	const C = (x0 * x0) / a2 + (y0 * y0) / b2 + (z0 * z0) / c2 - 1
	// the flanker and other are in the same spot, or the line never touches the flankee
	if (A < NUDGE) return false;
	const discriminant = B * B - 4 * A * C;
	if (discriminant < 0) return false;
	// quadratic solutions
	const divider = 1 / (2 * A);
	const root = Math.sqrt(discriminant);
	const t0 = (-B + root) * divider;
	const t1 = (-B - root) * divider;
	// points where the segment from the flanker to the other crosses the flankee
	const points = [];
	for (const t of new Set([t0, t1])) {
		if (t < 0 || t > 1) continue;
		points.push({x: flanker_x + t * x1, y: flanker_y + t * y1, z: flanker_z + t * z1})
	}
	// direction from the flankee to the flanker and the angle threshold are the same for every crossing point
	let vector_1_x = flanker_x - flankee_x;
	let vector_1_y = flanker_y - flankee_y;
	let vector_1_z = flanker_z - flankee_z;
	const vector_1_magnitude = Math.sqrt(vector_1_x * vector_1_x + vector_1_y * vector_1_y + vector_1_z * vector_1_z);
	vector_1_x = vector_1_x / vector_1_magnitude;
	vector_1_y = vector_1_y / vector_1_magnitude;
	vector_1_z = vector_1_z / vector_1_magnitude;
	const flanking_threshold = Math.PI - game.settings.get('f2e-grid-enhancements', 'flanking-angle') / 360 * Math.PI;
	for (const point of points) {
		let vector_0_x = point.x - flankee_x;
		let vector_0_y = point.y - flankee_y;
		let vector_0_z = point.z - flankee_z;
		const vector_0_magnitude = Math.sqrt(vector_0_x * vector_0_x + vector_0_y * vector_0_y + vector_0_z * vector_0_z);
		vector_0_x = vector_0_x / vector_0_magnitude;
		vector_0_y = vector_0_y / vector_0_magnitude;
		vector_0_z = vector_0_z / vector_0_magnitude;
		if (Math.acos(Math.min(1, Math.max(-1, vector_0_x * vector_1_x + vector_0_y * vector_1_y + vector_0_z * vector_1_z))) >= flanking_threshold) {
			return true;
		}
	}
	return false;
}

export function Aura_renderer_highlight(wrapped, self) {
	// ensure layer for highlight exists
	const layer = canvas.interface.grid.highlightLayers[self.highlightLayer.name];
	if ( !layer ) {
		return;
	}
	// get token polygons
	const polygons = tokenAuraOffsetPolygons(self.token, self.radius, true);
	if (polygons.length === 0) {
		return;
	}
	// draw polygons
	if (game.settings.get('f2e-grid-enhancements', 'aura-collisions-highlight')) {
		const token_center = tokenCenterBottom(self.token);
		const collision_radius = self.radius * self.token.document.scene.grid.size / self.token.document.scene.grid.distance + Math.max(self.token.document.width, self.token.document.height) * self.token.document.scene.grid.size;
		// get levels to add wall collisions from
		let levels = [self.token.document.scene.levels.get(self.token.document.level)].filter(item => item !== undefined);
		levels = levels.length ? levels : self.token.document.scene.levels.contents.filter((level) => token_center.elevation >= level.elevation.bottom && token_center.elevation < level.elevation.top);
		levels = levels.length ? levels : [null];
		// create clipper points
		const collision_types_paths = [];
		for (const collision_type of traitsCollisionTypes(self.traits)) {
			let collision_type_paths = null;
			for (const level of levels) {
				const collision_level_paths = [CONFIG.Canvas.polygonBackends[collision_type].create(token_center, {level, type: collision_type, radius: collision_radius, useThreshold: true}).toClipperPoints({scalingFactor: CONST.CLIPPER_SCALING_FACTOR})];
				if (collision_type_paths !== null) {
					const level_clipper = new ClipperLib.Clipper();
					level_clipper.AddPaths(collision_type_paths, ClipperLib.PolyType.ptSubject, true);
					level_clipper.AddPaths(collision_level_paths, ClipperLib.PolyType.ptClip, true);
					const level_intersection = [];
					level_clipper.Execute(ClipperLib.ClipType.ctIntersection, level_intersection, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
					collision_type_paths = level_intersection;
				} else {
					collision_type_paths = collision_level_paths;
					continue;
				}
			}
			collision_types_paths.push(collision_type_paths);
		}
		const collisionPolygonsClipperPoints = collision_types_paths.flat();
		const tokenPolygonsClipperPoints = polygons.map((polygon) => polygon.toClipperPoints({scalingFactor: CONST.CLIPPER_SCALING_FACTOR}));
		// draw visible area
		const visible_clipper_tree = new ClipperLib.PolyTree();
		const visible_clipper = new ClipperLib.Clipper();
		visible_clipper.AddPaths(collisionPolygonsClipperPoints, ClipperLib.PolyType.ptSubject, true);
		visible_clipper.AddPaths(tokenPolygonsClipperPoints, ClipperLib.PolyType.ptClip, true);
		visible_clipper.Execute(ClipperLib.ClipType.ctIntersection, visible_clipper_tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
		layer.beginFill(self.appearance.highlight.color, self.appearance.highlight.alpha);
		foundry.data.PolygonTree.fromClipperPolyTree(visible_clipper_tree).drawShape(layer);
		layer.endFill();
		// draw occluded area
		const occluded_clipper_tree = new ClipperLib.PolyTree();
		const occluded_clipper = new ClipperLib.Clipper();
		occluded_clipper.AddPaths(tokenPolygonsClipperPoints, ClipperLib.PolyType.ptSubject, true);
		occluded_clipper.AddPaths(collisionPolygonsClipperPoints, ClipperLib.PolyType.ptClip, true);
		occluded_clipper.Execute(ClipperLib.ClipType.ctDifference, occluded_clipper_tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
		layer.beginFill(0x000000, self.appearance.highlight.alpha);
		foundry.data.PolygonTree.fromClipperPolyTree(occluded_clipper_tree).drawShape(layer);
		layer.endFill();
		return;
	}
	layer.beginFill(self.appearance.highlight.color, self.appearance.highlight.alpha);
	layer.drawShape(polygons[0]);
	for (const hole of polygons.slice(1)) {
		layer.beginHole();
		layer.drawShape(hole);
		layer.endHole();
	}
	layer.endFill();
}
