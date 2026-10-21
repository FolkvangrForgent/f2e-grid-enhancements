// yet another function I have to copy and modify from foundryvtt core
function getOccupiedGridSpaceOffsets(self, flat=false) {
	const offsets = [];
	const grid = self.parent?.grid ?? foundry.documents.BaseScene.defaultGrid;
	// Get the top-left grid offset
	const {i: i0, j: j0, k: k0} = self._positionToGridOffset();
	// Round width and height to nearest multiple of 0.5
	const width = Math.max(Math.round(self.width * 2) / 2, 0.5);
	const height = Math.max(Math.round(self.height * 2) / 2, 0.5);
	const depth = Math.max(Math.round(self.depth * 2) / 2, 0.5);
	const k1 = k0 + Math.ceil(depth);
	// Square grid
	if ( grid.isSquare ) {
		const i1 = i0 + Math.ceil(height);
		const j1 = j0 + Math.ceil(width);
		for ( let i = i0; i < i1; i++ ) {
			for ( let j = j0; j < j1; j++ ) {
				if (flat) {
					offsets.push({i, j, k: 0});
				} else {
					for ( let k = k0; k < k1; k++ ) {
						const offset = {i, j, k};
						offsets.push(offset);
					}
				}
			}
		}
	}
	// Hexagonal grid
	else if (grid.isHexagonal) {
		const {even: offsetsEven, odd: offsetsOdd} = foundry.documents.BaseToken._getHexagonalOffsets(width, height, self.shape, grid.columns);
		const isEven = ((grid.columns ? j0 : i0) % 2 === 0) === grid.even;
		for ( const {i: di, j: dj} of (isEven ? offsetsEven : offsetsOdd) ) {
			if (flat) {
				offsets.push({i: i0 + di, j: j0 + dj, k: 0});
			} else {
				for ( let k = k0; k < k1; k++ ) {
					const offset = {i: i0 + di, j: j0 + dj, k};
					offsets.push(offset);
				}
			}
		}
	}
	return offsets;
}

function generate_center_point(token_object) {
	// get center point and add elevation to make a ElevatedPoint that is in the exact center of the token
	const center_point = token_object.getCenterPoint();
	center_point.elevation = token_object.document.elevation + token_object.document.depth / 2 * token_object.document.scene.grid.distance;
	return center_point;
}

function generate_shell_points(token_object, high_resolution=false) {
	if (canvas.grid.isGridless) {
		const shell_points = [];
		const resolution = high_resolution ? 4 : 2;
		let width = Math.round(token_object.document.width * resolution) / resolution;
		let height = Math.round(token_object.document.height * resolution) / resolution;
		let depth = Math.round(token_object.document.depth * resolution) / resolution;
		if ([CONST.TOKEN_SHAPES.ELLIPSE_1, CONST.TOKEN_SHAPES.ELLIPSE_2].includes(token_object.document.shape)) {
			width = width / 2;
			height = height / 2;
			depth = depth / 2;
			// TODO check this generates a similar number of point to rectangle and adjust key resolution points 2 and high resolution
			const shell_resolution = 1 / Math.max(4, Math.round(Math.sqrt(((width + height + depth) / 3) * 2 * resolution) + 2));
			for (let polar = 0; polar <= 1; polar += shell_resolution) {
				for (let azimuth = 0; azimuth <= 2; azimuth += shell_resolution) {
					shell_points.push({
						x: token_object.document.x + (width + width * Math.sin(polar * Math.PI) * Math.cos(azimuth * Math.PI)) * token_object.document.scene.grid.size,
						y: token_object.document.y + (height + height * Math.sin(polar * Math.PI) * Math.sin(azimuth * Math.PI)) * token_object.document.scene.grid.size,
						elevation: token_object.document.elevation + (depth + depth * Math.cos(polar * Math.PI)) * token_object.document.scene.grid.distance
					});
				}
			}
		} else if ([CONST.TOKEN_SHAPES.RECTANGLE_1, CONST.TOKEN_SHAPES.RECTANGLE_2].includes(token_object.document.shape)) {
			const shell_resolution = 1 / resolution;
			for (let x = 0; x <= width; x += shell_resolution) {
				for (let y = 0; y <= height; y += shell_resolution) {
					for (let z = 0; z <= depth; z += shell_resolution) {
						if (!(z === 0 || z === depth) && !((x === 0 || x === width) || (y === 0 || y === height))) {
							continue;
						}
						shell_points.push({
							x: token_object.document.x + x * token_object.document.scene.grid.size,
							y: token_object.document.y + y * token_object.document.scene.grid.size,
							elevation: token_object.document.elevation + z * token_object.document.scene.grid.distance
						});
					}
				}
			}
		}
		return shell_points;
	} else if (canvas.grid.isSquare) {
		const shell_points = [];
		if ([CONST.TOKEN_SHAPES.RECTANGLE_1, CONST.TOKEN_SHAPES.RECTANGLE_2].includes(token_object.document.shape)) {
			const width = Math.round(token_object.document.width * 2) / 2;
			const height = Math.round(token_object.document.height * 2) / 2;
			const depth = Math.round(token_object.document.depth * 2) / 2;
			for (let x = 0; x <= width; x += 0.5) {
				for (let y = 0; y <= height; y += 0.5) {
					for (let z = 0; z <= depth; z += 0.5) {
						if (!(z === 0 || z === depth) && !((x === 0 || x === width) || (y === 0 || y === height))) {
							continue;
						}
						shell_points.push({
							x: token_object.document.x + x * token_object.document.scene.grid.size,
							y: token_object.document.y + y * token_object.document.scene.grid.size,
							elevation: token_object.document.elevation + z * token_object.document.scene.grid.distance
						});
					}
				}
			}
		}
		return shell_points;
	} else if (canvas.grid.isHexagonal) {
		// use map to deduplicate
		const shell_points = new Map();
		const push = (point) => {
			const key = `${Math.round(point.x * 100)}|${Math.round(point.y * 100)}|${Math.round(point.elevation * 100)}`;
			shell_points.set(key, {x: point.x, y: point.y, elevation: point.elevation});
		};
		// generate column of shape using getShape
		const token_shape = token_object.getShape();
		const depth = Math.round(token_object.document.depth * 2) / 2;
		for (let z = 0; z <= depth; z += 0.5) {
			const elevation = token_object.document.elevation + z * token_object.document.scene.grid.distance;
			let first_point = null;
			let previous_point = null;
			for (let index = 0; index < token_shape.points.length; index += 2) {
				const point = {
					x: token_shape.points[index] + token_object.x,
					y: token_shape.points[index + 1] + token_object.y,
					elevation: elevation
				};
				push(point);
				if (first_point === null) first_point = point;
				if (previous_point !== null) {
					push({
						x: (point.x + previous_point.x) / 2,
						y: (point.y + previous_point.y) / 2,
						elevation: elevation
					});
				}
				previous_point = point;
			}
			if (previous_point !== null && first_point !== null) {
				push({x: (previous_point.x + first_point.x) / 2, y: (previous_point.y + first_point.y) / 2, elevation});
			}
		}
		const top = token_object.document.elevation + depth * token_object.document.scene.grid.distance;
		const bottom = token_object.document.elevation;
		for (const offset of getOccupiedGridSpaceOffsets(token_object.document, true)) {
			const point = canvas.grid.getCenterPoint(offset);
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
			for (const adjacent_offset of canvas.grid.getAdjacentOffsets(offset)) {
				if (offset.k === adjacent_offset.k) {
					const adjacent_point = canvas.grid.getCenterPoint(adjacent_offset);
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
			}
			for (const grid_point of canvas.grid.getVertices(offset)) {
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
	}
	return [];
}

// TODO check for side effects or more efficient ways to do this
function closest_surface_wall_collision(origin, destination, collision_type, scene) {
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
	let surface_collision_elevation;
	if ( upwards ) {
		surface_collision_elevation = destination.elevation;
	} else {
		surface_collision_elevation = origin.elevation;
	}
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
function any_surface_wall_collision(origin, destination, collision_type, scene) {
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

function constrain_shell_point(shell_point, center_point, collision_types, scene) {
	for (const collision_type of collision_types) {
		const collision = closest_surface_wall_collision(center_point, shell_point, collision_type, scene);
		if (collision !== null) {
			return {
				x: collision.x + (center_point.x - collision.x) * 0.1,
				y: collision.y + (center_point.y - collision.y) * 0.1,
				elevation: collision.elevation + (center_point.elevation - collision.elevation) * 0.1
			};
		}
	}
	return shell_point;
}

function randomize_shell_points(shell_points) {
	for (let index = shell_points.length - 1; index > 0; index--) {
		const random_index = Math.floor(Math.random() * (index + 1));
		const temporary_value = shell_points[index];
		shell_points[index] = shell_points[random_index];
		shell_points[random_index] = temporary_value;
	}
	return shell_points;
}

function token_points(token_object) {
	if (canvas.grid.isGridless) {
		return  generate_shell_points(token_object, true);
	}
	return getOccupiedGridSpaceOffsets(token_object.document).map((offset) => {return token_object.scene.grid.getCenterPoint(offset)});
}

export function Token_object_distanceTo(wrapped, self, target, opts) {
	// if target is self distance will always be 0
	if (self === target) return 0;
	// calculate self points
	const self_points = token_points(self, opts);
	// calculate target points
	let target_points = []
	if (target instanceof CONFIG.Token.objectClass) {
		target_points = token_points(target, opts);
	} else {
		const target_point = canvas.grid.getCenterPoint({x: target.x, y: target.y})
		target_points = [{x: target_point.x, y: target_point.y, elevation: target?.elevation ?? self.document.elevation}];
	}
	// determine if we should discount 5 ft after the second diagonal for 10 ft reach on a 5 ft grid
	let discount = false;
	if (game.settings.get('f2e-grid-enhancements', 'reach-exception') && canvas.grid.isSquare && [CONST.GRID_DIAGONALS.ALTERNATING_1, CONST.GRID_DIAGONALS.ALTERNATING_2].includes(canvas.grid.diagonals) && opts?.reach === 10  && canvas.grid.distance === 5 && canvas.grid.units === 'ft') {
		discount = true;
	}
	// calculate distance
	let distance = Infinity;
	for (const self_point of self_points) {
		for (const target_point of target_points) {
			const pathCandidate = canvas.grid.measurePath([self_point, target_point]);
			if (discount && pathCandidate.segments[0].diagonals > 1) {
				pathCandidate.distance -= canvas.grid.distance;
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
	if (!self.document.isSecret && requiresReach &&  !self.document.isOwner && self.actor?.isLootableBy(game.user)) {
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
				const step = event.ctrlKey || event.metaKey  || rotation_angle === 0 ? 5 : rotation_angle;
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
	if (self.grid.units === 'ft') {
		return true;
	}
	return false;
}

export function Aura_renderer_draw(wrapped, self, showBorder) {
	// If the token is GM hidden, don't render anything
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
		if ([CONST.TOKEN_SHAPES.ELLIPSE_1, CONST.TOKEN_SHAPES.ELLIPSE_2].includes(self.token.document.shape)) {
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
		} else if ([CONST.TOKEN_SHAPES.RECTANGLE_1, CONST.TOKEN_SHAPES.RECTANGLE_2].includes(self.token.document.shape)) {
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
			// TODO support hex grid with polygons shape?
			return;
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
	const source_token_center_point = generate_center_point(self.token.object);
	const target_token_center_point = generate_center_point(token.object);
	const target_token_shell_points = generate_shell_points(token.object);
	for (const target_token_shell_point of randomize_shell_points(target_token_shell_points)) {
		for (const collision_type of collision_types) {
			if (!any_surface_wall_collision(source_token_center_point, constrain_shell_point(target_token_shell_point, target_token_center_point, collision_types, scene), collision_type, scene)) {
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
	const flanker_x = flanker.document.center.x / flanker.document.scene.grid.size
	const flanker_y = flanker.document.center.y / flanker.document.scene.grid.size
	const flanker_z = flanker.document.elevation / flanker.document.scene.grid.distance + flanker.document.depth / 2
	// other data
	const other_x = other.document.center.x / other.document.scene.grid.size
	const other_y = other.document.center.y / other.document.scene.grid.size
	const other_z = other.document.elevation / other.document.scene.grid.distance  + other.document.depth / 2
	// flankee
	const flankee_height = flankee.document.height / 2
	const flankee_width = flankee.document.width / 2
	const flankee_depth = flankee.document.depth / 2
	const flankee_x = flankee.document.center.x / flankee.document.scene.grid.size
	const flankee_y = flankee.document.center.y / flankee.document.scene.grid.size
	const flankee_z = flankee.document.elevation / flankee.document.scene.grid.distance + flankee_depth
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
	// quadratic solutions
	const t0 = (-B + Math.sqrt(B * B - 4 * A * C)) / (2 * A)
	const t1 = (-B - Math.sqrt(B * B - 4 * A * C)) / (2 * A)
	// points
	const points = [];
	if (Number.isNaN(t0)) {
		points.push({x: flanker_x + t0 * x1, y: flanker_y + t0 * y1, z: flanker_z + t0 * z1})
	}
	if (Number.isNaN(t1) && t0 !== t1) {
		points.push({x: flanker_x + t1 * x1, y: flanker_y + t1 * y1, z: flanker_z + t1 * z1})
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
		if (Math.acos(vector_0_x * vector_1_x + vector_0_y * vector_1_y + vector_0_z * vector_1_z) >= Math.PI - game.settings.get('f2e-grid-enhancements', 'flanking-angle') / 360 * Math.PI) {
			return true;
		}
	}
	return false;
}
