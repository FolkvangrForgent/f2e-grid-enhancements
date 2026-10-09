function closest_surface_wall_collision(origin, destination, opts) {
	if (!(opts?.collision_types?.length > 0)) {
		return null;
	}
	const upwards = origin.elevation <= destination.elevation;
	let wall_collision = null;
	let wall_collision_distance = 1;
	for (const collision_type of opts?.collision_types ?? []) {
		const collision = CONFIG.Canvas.polygonBackends[collision_type].testCollision(origin, destination, {mode: 'closest'})
		if (collision?._distance < wall_collision_distance) {
			wall_collision_distance = collision?._distance;
			wall_collision = {
				x: origin.x + (destination.x - origin.x) * wall_collision_distance,
				y: origin.y + (destination.y - origin.y) * wall_collision_distance,
				elevation: origin.elevation + (destination.elevation - origin.elevation) * wall_collision_distance,
			};
		}
	}
	let surface_collision = null;
	let surface_collision_elevation;
	if ( upwards ) {
		surface_collision_elevation = destination.elevation;
	} else {
		surface_collision_elevation = origin.elevation;
	}
	for (const collision_type of opts?.collision_types ?? []) {
		for (const level of canvas.scene.levels.keys()) {
			if ( upwards ) {
				let collision = canvas.scene.testSurfaceCollision(origin, destination, {type: collision_type, mode: "closest", side: "above", level});
				if (collision?.elevation < surface_collision_elevation) {
					surface_collision_elevation = collision?.elevation;
					surface_collision = collision;
				}
			} else {
				let collision = canvas.scene.testSurfaceCollision(origin, destination, {type: collision_type, mode: "closest", side: "below", level});
				if (collision?.elevation > surface_collision_elevation) {
					surface_collision_elevation = collision?.elevation;
					surface_collision = collision;
				}
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

function token_points(token, opts) {
	const center_point = token.getCenterPoint();
	center_point.elevation = token.document.elevation + token.document.depth / 2
	const points = []
	if (canvas.grid.isGridless) {
		// logic for shell points on supported shape otherwise center point
		if ([CONST.TOKEN_SHAPES.ELLIPSE_1, CONST.TOKEN_SHAPES.ELLIPSE_2].includes(token.document.shape)) {
			const width = Math.round(token.document.width) / 2;
			const height = Math.round(token.document.height) / 2;
			const depth = Math.round(token.document.depth) / 2;
			const resolution = Math.max(4, Math.round(Math.sqrt(((width + height + depth) / 3) * 4) + 2))
			for (let polar = 0; polar <= 1; polar += 1 / resolution) {
				for (let azimuth = 0; azimuth <= 2; azimuth += 1 / resolution) {
					points.push({
						x: token.document.x + (width + width * Math.sin(polar * Math.PI) * Math.cos(azimuth * Math.PI)) * token.document.scene.grid.size,
						y: token.document.y + (height + height * Math.sin(polar * Math.PI) * Math.sin(azimuth * Math.PI)) * token.document.scene.grid.size,
						elevation: token.document.elevation + (depth + depth * Math.cos(polar * Math.PI)) * token.document.scene.grid.size
					});
				}
			}
		} else if ([CONST.TOKEN_SHAPES.RECTANGLE_1, CONST.TOKEN_SHAPES.RECTANGLE_2].includes(token.document.shape)) {
			const width = Math.round(token.document.width * 2) / 2;
			const height = Math.round(token.document.height * 2) / 2;
			const depth = Math.round(token.document.depth * 2) / 2;
			for (let x = 0; x <= width; x += 0.5) {
				for (let y = 0; y <= height; y += 0.5) {
					for (let z = 0; z <= depth; z += 0.5) {
						if (!(z === 0 || z === depth) && !((x === 0 || x === width) || (y === 0 || y === height))) {
							continue;
						}
						points.push({
							x: token.document.x + x * token.document.scene.grid.size,
							y: token.document.y + y * token.document.scene.grid.size,
							elevation: token.document.elevation + z * token.document.scene.grid.distance
						});
					}
				}
			}
		} else {
			points.push(center_point);
		}
	} else {
		// TODO getOccupiedGridSpaceOffsets is contrained by "move" :\ create custom copy without this constraint and open fvtt issue ticket for flag to override
		for (const offset of token.document.getOccupiedGridSpaceOffsets()) {
			const point = canvas.grid.getCenterPoint(offset);
			points.push(point);
		}
	}
	return points.filter((point) => {
		if (canvas.grid.isGridless || closest_surface_wall_collision(center_point, point, opts) === null) {
			return true;
		}
		return false;
	}).map((point) => {
		if (canvas.grid.isGridless) {
			const collision = closest_surface_wall_collision(center_point, point, opts);
			if (collision !== null) {
				return {
					x: collision.x + (center_point.x - collision.x) * 0.1,
					y: collision.y + (center_point.y - collision.y) * 0.1,
					elevation: collision.elevation + (center_point.elevation - collision.elevation) * 0.1
				};
			}
		}
		return point;
	});
}

export function Token_object_distanceTo(wrapped, self, target, opts) {
	// if target is self distance will always be 0
	if (self === target) return 0;
	// calculate the self points
	const selfPoints = token_points(self, opts);
	// calculate the target points
	let targetPoints = []
	if (target instanceof CONFIG.Token.objectClass) {
		targetPoints = token_points(target, opts);
	} else {
		targetPoints = [canvas.grid.getCenterPoint({x: target.x, y: target.y, elevation: target?.elevation ?? self.document.elevation})];
	}
	// calculate minimum distance
	let candidates = [];
	for (const origin of selfPoints) {
		for (const destination of targetPoints) {
			const pathCandidate = canvas.grid.measurePath([origin, destination]);
			// discount 5 ft after the second diagonal for 10 ft reach on a 5 ft grid.
			if (game.settings.get('f2e-grid-enhancements', 'reach-exception') && canvas.grid.isSquare && [CONST.GRID_DIAGONALS.ALTERNATING_1, CONST.GRID_DIAGONALS.ALTERNATING_2].includes(canvas.grid.diagonals)
				&& opts?.reach === 10 && pathCandidate.segments[0].diagonals > 1 && canvas.grid.distance === 5 && canvas.grid.units === 'ft') {
				pathCandidate.distance -= canvas.grid.distance;
			}
			// aura radius check here to skip some collision checks
			if (opts?.aura_radius ?? Infinity >= pathCandidate.distance) {
				candidates.push({
					origin: origin,
					destination: destination,
					distance: pathCandidate.distance
				});
			}
		}
	}
	candidates.sort((a, b) => a.distance - b.distance);
	for (const candidate of candidates) {
		if (opts?.collision_types === undefined || closest_surface_wall_collision(candidate.origin, candidate.destination, opts) === null) {
			return Math.max(0, Math.round(candidate.distance * 10) / 10);
		}
	}
	return Infinity;
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
				: _loc(`PF2E.Token.Mystified.The${thisIsCreature ? 'Creature' : 'Object'}`);
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
			return 0;
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
				const snapped = event.ctrlKey || event.metaKey || canvas?.grid?.isGridless ? angle : angle.toNearest(rotation_angle);
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
				const step = event.ctrlKey || event.metaKey ? 5 : rotation_angle;
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
	if (event.interactionData.shape.type === 'circle' && game.activeTool === 'point') {
		event.interactionData.shape.updateSource({radius: canvas.dimensions.distance * canvas.dimensions.distancePixels / 2});
		self._updateDragPreview(event);
	} else if (self.templateMode && (event.interactionData.shape.type === 'line' || event.interactionData.shape.type === 'cone')) {
		const rotation_angle = event.interactionData.shape.type === 'cone' ? canvas?.grid?.isHexagonal ? game.settings.get('f2e-grid-enhancements', 'hex-cone-snapping-angle') : canvas?.grid?.isSquare ? game.settings.get('f2e-grid-enhancements', 'square-cone-snapping-angle') : game.settings.get('f2e-grid-enhancements', 'gridless-cone-snapping-angle') : 5;
		const rotation = event.interactionData.shape.rotation.toNearest(rotation_angle);
		if (rotation !== event.interactionData.shape.rotation) {
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
	// clear inital border
	if (self.border.geometry.graphicsData.length > 0 && (self.token.document.shape !== self.border_shape || self.token.document.width !== self.border_width || self.token.document.height !== self.border_height)) {
		self.border_shape = self.token.document.shape
		self.border_width = self.token.document.width
		self.border_height = self.token.document.height
		self.border.clear();
	}
	// Create aura border (token base type and polygon type didn't work for some reason)
	if (self.border.geometry.graphicsData.length === 0) {
		if ([CONST.TOKEN_SHAPES.ELLIPSE_1, CONST.TOKEN_SHAPES.ELLIPSE_2].includes(self.token.document.shape)) {
			const aura_shape = new foundry.data.EmanationShapeData({
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
			});
			if (self.appearance.border?.color !== null && self.appearance.border?.alpha !== null) {
				self.border.lineStyle(canvas.grid.thickness * 2, self.appearance.border?.color, self.appearance.border?.alpha).drawShape(aura_shape.polygons[0]);
			}
		} else if ([CONST.TOKEN_SHAPES.RECTANGLE_1, CONST.TOKEN_SHAPES.RECTANGLE_2].includes(self.token.document.shape)) {
			const aura_shape = new foundry.data.EmanationShapeData({
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
			});
			if (self.appearance.border?.color !== null && self.appearance.border?.alpha !== null) {
				self.border.lineStyle(canvas.grid.thickness, self.appearance.border?.color, self.appearance.border?.alpha).drawShape(aura_shape.polygons[0]);
			}
		} else {
			// TODO support hex grid with polygons shape?
			return;
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
	// decide what collision types to test against quick survey and I think using || when visual and auditory is set is RAI but could be convinced to make that optional
	const collisions = [];
	if (self.traits.includes('auditory')) {
		collisions.push('sound');
	}
	if (self.traits.includes('visual')) {
		collisions.push('sight');
	}
	if (!self.traits.includes('auditory') && !self.traits.includes('visual')) {
		collisions.push('move');
	}
	// use custom distance to when checking if token is within aura
	if (self.token.object.distanceTo(token.object, {collision_types: collisions, aura_radius: self.radius / 5 * self.token.scene.grid.distance}) !== Infinity) {
		return true;
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
	const flanker_z = flanker.document.elevation + flanker.document.depth / 2
	// other data
	const other_x = other.document.center.x / other.document.scene.grid.size
	const other_y = other.document.center.y / other.document.scene.grid.size
	const other_z = other.document.elevation + other.document.depth / 2
	// flankee
	const flankee_height = flankee.document.height / 2
	const flankee_width = flankee.document.width / 2
	const flankee_depth = flankee.document.depth / 2
	const flankee_x = flankee.document.center.x / flankee.document.scene.grid.size
	const flankee_y = flankee.document.center.y / flankee.document.scene.grid.size
	const flankee_z = flankee.document.elevation + flankee_depth
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
	if (t0 !== NaN) {
		points.push({x: flanker_x + t0 * x1, y: flanker_y + t0 * y1, z: flanker_z + t0 * z1})
	}
	if (t1 !== NaN && t0 !== t1) {
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
