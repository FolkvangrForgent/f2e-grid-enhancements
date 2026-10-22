const PHI = Math.PI * (3 - Math.sqrt(5));
const NUDGE = 1e-8;

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

function tokenCenter(token) {
	const center_point = token.document.getCenterPoint()
	if (!token.document.scene.grid.isGridless) {
		center_point.elevation = Math.floor((token.document.elevation / token.document.scene.grid.distance) + NUDGE) * token.document.scene.grid.distance;
	}
	center_point.elevation += token.document.depth / 2 * token.document.scene.grid.distance;
	return center_point;
}

function tokenNormalizedCenter(token) {
	const center = tokenCenter(token);
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
			push({
				x: point.x,
				y: point.y,
				elevation: top
			});
			push({
				x: point.x,
				y: point.y,
				elevation: bottom
			});
			for (const adjacent_offset of token.document.scene.grid.getAdjacentOffsets(offset)) {
				const adjacent_point = token.document.scene.grid.getCenterPoint(adjacent_offset);
				push({
					x: (point.x * 3 + adjacent_point.x) / 4,
					y: (point.y * 3 + adjacent_point.y) / 4,
					elevation: top
				});
				push({
					x: (point.x * 3 + adjacent_point.x) / 4,
					y: (point.y * 3 + adjacent_point.y) / 4,
					elevation: bottom
				});
				push({
					x: (point.x + adjacent_point.x) / 2,
					y: (point.y + adjacent_point.y) / 2,
					elevation: top
				});
				push({
					x: (point.x + adjacent_point.x) / 2,
					y: (point.y + adjacent_point.y) / 2,
					elevation: bottom
				});
			}
			for (const grid_point of token.document.scene.grid.getVertices(offset)) {
				push({
					x: grid_point.x,
					y: grid_point.y,
					elevation: top
				});
				push({
					x: grid_point.x,
					y: grid_point.y,
					elevation: bottom
				});
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

// TODO check for side effects or more efficient ways to do this
function collisionClosest(origin, destination, collision_type, scene) {
	const upwards = origin.elevation <= destination.elevation;
	let wall_collision = null;
	let wall_collision_distance = 1;
	const collision = CONFIG.Canvas.polygonBackends[collision_type].testCollision(origin, destination, {type: collision_type, mode: 'closest'})
	if (collision?._distance < wall_collision_distance) {
		wall_collision_distance = collision?._distance;
		wall_collision = {
			x: origin.x + (destination.x - origin.x) * wall_collision_distance,
			y: origin.y + (destination.y - origin.y) * wall_collision_distance,
			elevation: origin.elevation + (destination.elevation - origin.elevation) * wall_collision_distance,
		};
	}
	let surface_collision = null;
	let surface_collision_elevation = destination.elevation;
	for (const level of scene.levels.keys()) {
		if ( upwards ) {
			let collision = scene.testSurfaceCollision(origin, destination, {type: collision_type, mode: "closest", side: "above", level});
			if (collision?.elevation < surface_collision_elevation) {
				surface_collision_elevation = collision?.elevation;
				surface_collision = collision;
			}
		} else {
			let collision = scene.testSurfaceCollision(origin, destination, {type: collision_type, mode: "closest", side: "below", level});
			if (collision?.elevation > surface_collision_elevation) {
				surface_collision_elevation = collision?.elevation;
				surface_collision = collision;
			}
		}
	}
	if ( !surface_collision ) return wall_collision;
	if ( !wall_collision ) return surface_collision;
	if ( upwards ) {
		return wall_collision.elevation <= surface_collision.elevation ? wall_collision : surface_collision;
	} else {
		return wall_collision.elevation >= surface_collision.elevation ? wall_collision : surface_collision;
	}
}

// TODO check for side effects or more efficient ways to do this
function collisionAny(origin, destination, collision_type, scene) {
	if (CONFIG.Canvas.polygonBackends[collision_type].testCollision(origin, destination, {type: collision_type, mode: 'any'})) {
		return true;
	}
	const upwards = origin.elevation <= destination.elevation;
	for (const level of scene.levels.keys()) {
		if ( upwards ) {
			if (scene.testSurfaceCollision(origin, destination, {type: collision_type, mode: "any", side: "above", level})) {
				return true;
			}
		} else {
			if (scene.testSurfaceCollision(origin, destination, {type: collision_type, mode: "any", side: "below", level})) {
				return true;
			}
		}
	}
	return false;
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
			return CONST.GRID_SNAPPING_MODES.EDGE_MIDPOINT | CONST.GRID_SNAPPING_MODES.CORNER;
		default:
			return wrapped();
	}
}

export function Region_layerFoundry_placeRegion(wrapped, self, data, options = {}) {
	if (data.displayMeasurements && data.highlightMode === 'coverage') {
		// fixup internal cone angle
		for (let shape of data.shapes) {
			if (shape.angle === 90 && shape.type === 'cone') {
				shape.angle = canvas?.grid?.isHexagonal ? game.settings.get('f2e-grid-enhancements', 'hex-cone-template-angle') : canvas?.grid?.isSquare ? game.settings.get('f2e-grid-enhancements', 'square-cone-template-angle') : game.settings.get('f2e-grid-enhancements', 'gridless-cone-template-angle')
			}
		}
		// support rotation with modified pf2e code
		const placement = { aiming: false };
		options.onMove = ({ event, position, preview, shape, snap }) => {
			if (placement.aiming && (shape.type === 'cone' || shape.type === 'line')) {
				const rotation_angle = shape.type === 'cone' ? canvas?.grid?.isHexagonal ? game.settings.get('f2e-grid-enhancements', 'hex-cone-snapping-angle') : canvas?.grid?.isSquare ? game.settings.get('f2e-grid-enhancements', 'square-cone-snapping-angle') : game.settings.get('f2e-grid-enhancements', 'gridless-cone-snapping-angle') : 5;
				const angle = Math.toDegrees(Math.atan2(position.y - shape.y, position.x - shape.x));
				const snapped = event.ctrlKey || event.metaKey || rotation_angle === 0 ? angle : angle.toNearest(rotation_angle);
				shape.updateSource({ rotation: snapped });
				return false;
			}
			if (snap) {
				const { x, y } = canvas.grid.getSnappedPoint(position, { mode: preview.snappingMode });
				position.x = x;
				position.y = y;
			}
			return;
		}
		options.onRotate = ({ event, shape }) => {
			if (shape.type === 'cone' || shape.type === 'line') {
				const rotation_angle = shape.type === 'cone' ? canvas?.grid?.isHexagonal ? game.settings.get('f2e-grid-enhancements', 'hex-cone-snapping-angle') : canvas?.grid?.isSquare ? game.settings.get('f2e-grid-enhancements', 'square-cone-snapping-angle') : game.settings.get('f2e-grid-enhancements', 'gridless-cone-snapping-angle') : 5;
				const step = event.ctrlKey || event.metaKey || rotation_angle === 0 ? 5 : rotation_angle;
				const delta = step * Math.sign(event.deltaY);
				const rotation = shape.rotation + delta;
				shape.updateSource({ rotation: event.ctrlKey || event.metaKey ? rotation : rotation.toNearest(step) });
				return false;
			}
			return;
		};
		options.preConfirm = ({ event, shape }) => {
			const aim = (shape.type === 'cone' || shape.type === 'line') && !event.shiftKey;
			if (!placement.aiming && aim) {
				placement.aiming = true;
				return false;
			}
			return undefined;
		};
		options.preSkip = () => {
			if (placement.aiming) {
				placement.aiming = false;
				return false;
			}
			return undefined;
		};
	}
	return wrapped(data, options);
}

export function Region_layerFoundry__onDragLeftMove(wrapped, self, event) {
	wrapped(event);
	if (event.interactionData.shape?.type === 'circle' && ui.controls.tool?.name === 'point') {
		event.interactionData.shape.updateSource({radius: canvas.dimensions.distance * canvas.dimensions.distancePixels / 2});
		self._updateDragPreview(event);
	} else if (self.templateMode && (event.interactionData.shape?.type === 'line' || event.interactionData.shape?.type === 'cone')) {
		const rotation_angle = event.interactionData.shape.type === 'cone' ? canvas?.grid?.isHexagonal ? game.settings.get('f2e-grid-enhancements', 'hex-cone-snapping-angle') : canvas?.grid?.isSquare ? game.settings.get('f2e-grid-enhancements', 'square-cone-snapping-angle') : game.settings.get('f2e-grid-enhancements', 'gridless-cone-snapping-angle') : 5;
		const rotation = event.interactionData.shape.rotation.toNearest(rotation_angle);
		if (rotation_angle > 0 && rotation !== event.interactionData.shape.rotation) {
			event.interactionData.shape.updateSource({rotation});
			self._updateDragPreview(event);
		}
	}
}

export function Scene_document_canHaveAuras(wrapped, self) {
	if (['', 'ft', 'feet'].includes(self.grid.units.toLowerCase())) {
		return true;
	}
	return false;
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
		let polygon = null;
		if (self.token.document.scene.grid.isHexagonal || self.token.document.scene.grid.isSquare) {
			// convert offsets to edges (removing overlapping)
			const edges = new Map();
			for (const offset of tokenAuraOffsetHelper(self.token, self.radius, false)) {
				const vertices = self.token.document.scene.grid.getVertices(offset);
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
			// walk the edges to create a polygon
			const center_x = self.token.document.x + self.token.mechanicalBounds.width / 2;
			const center_y = self.token.document.y + self.token.mechanicalBounds.height / 2;
			const points = [];
			let edge = remapped_edges.values().next().value;
			while (edge) {
				remapped_edges.delete(edge.s0);
				points.push(edge.p0.x - center_x)
				points.push(edge.p0.y - center_y);
				edge = remapped_edges.get(edge.s1);
			}
			polygon = new PIXI.Polygon(points);
		} else if ([CONST.TOKEN_SHAPES.ELLIPSE_1, CONST.TOKEN_SHAPES.ELLIPSE_2].includes(tokenShape(self.token))) {
			polygon = new foundry.data.EmanationShapeData({
				type: 'emanation',
				base: {
					type: 'ellipse',
					x: 0,
					y: 0,
					radiusX: self.token.document.width / 2 * self.token.document.scene.grid.size,
					radiusY: self.token.document.height / 2 * self.token.document.scene.grid.size,
				},
				radius: self.radius * self.token.document.scene.grid.size / self.token.document.scene.grid.distance,
				gridBased: false
			}).polygons[0];
		} else if ([CONST.TOKEN_SHAPES.RECTANGLE_1, CONST.TOKEN_SHAPES.RECTANGLE_2].includes(tokenShape(self.token))) {
			polygon = new foundry.data.EmanationShapeData({
				type: 'emanation',
				base: {
					type: 'rectangle',
					x: - self.token.document.width * self.token.document.scene.grid.size / 2,
					y: - self.token.document.height * self.token.document.scene.grid.size / 2,
					width: self.token.document.width * self.token.document.scene.grid.size,
					height: self.token.document.height * self.token.document.scene.grid.size,
				},
				radius: self.radius * self.token.document.scene.grid.size / self.token.document.scene.grid.distance,
				gridBased: false
			}).polygons[0];
		} else {
			showBorder = false;
		}
		if (polygon != null) {
			self.border.lineStyle(canvas.grid.thickness, self.appearance.border?.color, self.appearance.border?.alpha).drawShape(polygon);
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
	const collision_types = [];
	if (self.traits.includes('auditory')) {
		collision_types.push('sound');
	}
	if (self.traits.includes('visual')) {
		collision_types.push('sight');
	}
	if (!self.traits.includes('auditory') && !self.traits.includes('visual')) {
		collision_types.push('move');
	}
	// do center point to shell tests for line of effect
	const scene = self.token.object.scene;
	const source_token_center_point = tokenCenter(self.token.object);
	const target_token_center_point = tokenCenter(token.object);
	const target_token_shell_points = tokenShell(token.object);
	for (let index = target_token_shell_points.length - 1; index > 0; index--) {
		const random_index = Math.floor(Math.random() * (index + 1));
		const temporary_value = target_token_shell_points[index];
		target_token_shell_points[index] = target_token_shell_points[random_index];
		target_token_shell_points[random_index] = temporary_value;
	}
	for (const target_token_shell_point of target_token_shell_points) {
		let constrained_target_token_shell_point = target_token_shell_point;
		for (const collision_type of collision_types) {
			const collision = collisionClosest(source_token_center_point, target_token_shell_point, collision_type, scene);
			if (collision !== null) {
				constrained_target_token_shell_point = {
					x: collision.x + (target_token_center_point.x - collision.x) * 0.1,
					y: collision.y + (target_token_center_point.y - collision.y) * 0.1,
					elevation: collision.elevation + (target_token_center_point.elevation - collision.elevation) * 0.1
				};
			}
		}
		for (const collision_type of collision_types) {
			if (!collisionAny(source_token_center_point, constrained_target_token_shell_point, collision_type, scene)) {
				return true;
			}
		}
	}
	return false;
}

export function Token_object_onOppositeSides(wrapped, self, flanker, other, flankee) {
	if (canvas.grid.isGridless && !game.settings.get('f2e-grid-enhancements', 'flanking-gridless-override') || canvas.grid.isHexagonal && !game.settings.get('f2e-grid-enhancements', 'flanking-hex-override') || canvas.grid.isSquare && !game.settings.get('f2e-grid-enhancements', 'flanking-square-override')) {
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
	for (const point of points) {
		let vector_0_x = point.x - flankee_x;
		let vector_0_y = point.y - flankee_y;
		let vector_0_z = point.z - flankee_z;
		const vector_0_magnitude = Math.sqrt(vector_0_x * vector_0_x + vector_0_y * vector_0_y + vector_0_z * vector_0_z);
		vector_0_x = vector_0_x / vector_0_magnitude;
		vector_0_y = vector_0_y / vector_0_magnitude;
		vector_0_z = vector_0_z / vector_0_magnitude;
		let vector_1_x = flanker_x - flankee_x;
		let vector_1_y = flanker_y - flankee_y;
		let vector_1_z = flanker_z - flankee_z;
		const vector_1_magnitude = Math.sqrt(vector_1_x * vector_1_x + vector_1_y * vector_1_y + vector_1_z * vector_1_z);
		vector_1_x = vector_1_x / vector_1_magnitude;
		vector_1_y = vector_1_y / vector_1_magnitude;
		vector_1_z = vector_1_z / vector_1_magnitude;
		if (Math.acos(Math.min(1, Math.max(-1, vector_0_x * vector_1_x + vector_0_y * vector_1_y + vector_0_z * vector_1_z))) >= Math.PI - game.settings.get('f2e-grid-enhancements', 'flanking-angle') / 360 * Math.PI) {
			return true;
		}
	}
	return false;
}

export function Aura_renderer_highlight(wrapped, self) {
	if (self.token.document.scene.grid.isGridless) {
		let aura_base;
		if ([CONST.TOKEN_SHAPES.ELLIPSE_1, CONST.TOKEN_SHAPES.ELLIPSE_2].includes(tokenShape(self.token))) {
			aura_base = {
				type: 'ellipse',
				x: self.token.document.x + self.token.document.width * self.token.document.scene.grid.size / 2,
				y: self.token.document.y + self.token.document.height * self.token.document.scene.grid.size / 2,
				radiusX: self.token.document.width / 2 * self.token.document.scene.grid.size,
				radiusY: self.token.document.height / 2 * self.token.document.scene.grid.size,
				hole: true,
			}
		} else if ([CONST.TOKEN_SHAPES.RECTANGLE_1, CONST.TOKEN_SHAPES.RECTANGLE_2].includes(tokenShape(self.token))) {
			aura_base = {
				type: 'rectangle',
				x: self.token.document.x,
				y: self.token.document.y,
				width: self.token.document.width * self.token.document.scene.grid.size,
				height: self.token.document.height * self.token.document.scene.grid.size,
				hole: true,
			}
		} else {
			return;
		}
		const aura_shape = new foundry.data.EmanationShapeData({
			type: 'emanation',
			base: aura_base,
			radius: self.radius * self.token.document.scene.grid.size / self.token.document.scene.grid.distance,
			gridBased: false
		});
		const layer = canvas.interface.grid.highlightLayers[self.highlightLayer.name];
		if ( !layer ) {
			return;
		}
		layer.beginFill(self.appearance.highlight.color, self.appearance.highlight.alpha);
		layer.drawShape(aura_shape.polygons[0]);
		layer.beginHole();
		layer.drawShape(aura_shape.polygons[1]);
		layer.endHole();
		layer.endFill();
	} else {
		for (const offset of tokenAuraOffsetHelper(self.token, self.radius, true)) {
			const point = self.token.document.scene.grid.getTopLeftPoint(offset);
			canvas.interface.grid.highlightPosition(self.highlightLayer.name, {
				x: point.x,
				y: point.y,
				border: self.appearance.border?.color,
				color: self.appearance.highlight.color,
				alpha: self.appearance.highlight.alpha,
			});
		}
	}
}