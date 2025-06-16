// TODO support 3D hex columns
export function Token_object_distanceTo(wrapped, self, target, opts) {
	// if target is self distance will always be 0
	if (self === target) return 0;
	// calculate the self points
	const selfPoints = []
	for (const offset of self.document.getOccupiedGridSpaceOffsets()) {
		const point = canvas.grid.getCenterPoint({i: offset.i, j: offset.j})
		point.elevation = self.document.elevation
		selfPoints.push(point);
	}
	// calculate the target points
	let targetPoints = []
	if (target instanceof CONFIG.Token.objectClass) {
		for (const offset of target.document.getOccupiedGridSpaceOffsets()) {
			const point = canvas.grid.getCenterPoint({i: offset.i, j: offset.j})
			point.elevation = target.document.elevation
			targetPoints.push(point);
		}
	} else {
		// center point (and add elevation until PF2e point is 3D)
		targetPoints.push(canvas.grid.getCenterPoint({x: target.x, y: target.y, elevation: 0}));
	}
	// filter target points to those that are valid from token center if collision is wanted
	if (opts?.collision_types?.length ?? 0 > 0) {
		targetPoints = targetPoints.filter((targetPoint) => {
			for (const collision_type of opts.collision_types) {
				if (collision_type == "sound") {
					if (!CONFIG.Canvas.polygonBackends.sound.testCollision(self.document.center, targetPoint, {
						type: "sound",
						mode: "any",
						source: new foundry.canvas.sources.PointSoundSource({object: self})
					})) {
						return true;
					}
				}
				if (collision_type == "sight") {
					if (!CONFIG.Canvas.polygonBackends.sight.testCollision(self.document.center, targetPoint, {
						type: "sight",
						mode: "any",
						source: new foundry.canvas.sources.PointVisionSource({object: self})
					})) {
						return true;
					}
				}
				if (collision_type == "move") {
					if (!CONFIG.Canvas.polygonBackends.move.testCollision(self.document.center, targetPoint, {
						type: "move",
						mode: "any",
						source: new foundry.canvas.sources.PointMovementSource({object: self})
					})) {
						return true;
					}
				}
			}
			return false;
		});
	}
	// calculate minimum distance
	let distance = Infinity;
	for (const origin of selfPoints) {
		for (const destination of targetPoints) {
			const distanceCandidate = canvas.grid.measurePath([origin, destination]).distance;
			if (distanceCandidate < distance) {
				distance = distanceCandidate;
			}
		}
	}
	// process reach
	distance -= opts?.reach ?? 0;
	// remove negative distances
	if (distance < 0) {
		distance = 0;
	}
	// return distance
	return distance;
}

export function MeasuredTemplate_object__computeShape(wrapped, self) {
	switch (self.document.t) {
		case 'circle':
			return new PIXI.Polygon(canvas.grid.getCircle({x: 0, y: 0}, self.document.distance));
		case 'cone':
			return new PIXI.Polygon(canvas.grid.getCone({x: 0, y: 0}, self.document.distance, self.document.direction, self.document.angle));
		case 'ray':
			const endpoint = canvas.grid.getTranslatedPoint({x: 0, y: 0}, self.document.direction, self.document.distance);
			return new PIXI.Polygon(0, 0, endpoint.x, endpoint.y);
		default:
			return wrapped();
	}
}

function hexPath(origin, direction, steps) {
	// do as much math at the begining
	const r = Math.toRadians(direction);
	const sin_r = Math.sin(r);
	const cos_r = Math.cos(r);
	const a = -sin_r;
	const b = cos_r;
	const c = sin_r * origin.x - cos_r * origin.y;
	const sqrt_aa_bb = Math.sqrt(a * a + b * b);
	// calculate which grid section the direction points into
	const direction_section = (Math.round((direction - ((canvas.grid.type == CONST.GRID_TYPES.HEXODDQ || canvas.grid.type == CONST.GRID_TYPES.HEXEVENQ) ? 60 : 30)) / 60) + 1) % 6;
	// keep track of hex positions found for each step
	const path = [];
	// calculate initial hex add it to path
	let previous_hex = canvas.grid.getCube({x: origin.x, y: origin.y});
	path.push(previous_hex);
	// iterate for number of steps
	for (let i = 1; i < steps; i++) {
		let hex = undefined;
		let distance = Infinity;
		let candidate_hexs = [];
		// get two candidate hexs based on direction section
		if (direction_section == 0) {
			candidate_hexs = [{q: (previous_hex.q + 1), r: (previous_hex.r - 1), s: (previous_hex.s)},{q: (previous_hex.q + 1), r: (previous_hex.r), s: (previous_hex.s - 1)}];
		} else if (direction_section == 1) {
			candidate_hexs = [{q: (previous_hex.q + 1), r: (previous_hex.r), s: (previous_hex.s - 1)},{q: (previous_hex.q), r: (previous_hex.r + 1), s: (previous_hex.s - 1)}];
		} else if (direction_section == 2) {
			candidate_hexs = [{q: (previous_hex.q), r: (previous_hex.r + 1), s: (previous_hex.s - 1)},{q: (previous_hex.q - 1), r: (previous_hex.r + 1), s: (previous_hex.s)}];
		} else if (direction_section == 3) {
			candidate_hexs = [{q: (previous_hex.q - 1), r: (previous_hex.r + 1), s: (previous_hex.s)},{q: (previous_hex.q - 1), r: (previous_hex.r), s: (previous_hex.s + 1)}];
		} else if (direction_section == 4) {
			candidate_hexs = [{q: (previous_hex.q - 1), r: (previous_hex.r), s: (previous_hex.s + 1)},{q: (previous_hex.q), r: (previous_hex.r - 1), s: (previous_hex.s + 1)}];
		} else if (direction_section == 5) {
			candidate_hexs = [{q: (previous_hex.q), r: (previous_hex.r - 1), s: (previous_hex.s + 1)},{q: (previous_hex.q + 1), r: (previous_hex.r - 1), s: (previous_hex.s)}];
		}
		// check which candidate_hexs is closer to line
		for (const candidate_hex of candidate_hexs) {
			const candidate_point = canvas.grid.getCenterPoint(candidate_hex);
			const point_intersection_distance = Math.abs((a * candidate_point.x + b * candidate_point.y + c) / sqrt_aa_bb)
			if (point_intersection_distance < distance) {
				hex = candidate_hex;
				distance = point_intersection_distance;
			}
		}
		// safety check
		if (distance !== Infinity) {
			path.push(hex);
			previous_hex = hex;
		} else {
			break;
		}
	}
	return path;
}

export function MeasuredTemplate_object__getGridHighlightPositions(wrapped, self) {
	if (self.areaShape === 'line') {
		// calculate how many hexs wide the template is
		const hex_width = Math.round(self.document.width / canvas.dimensions.distance);
		// calculate how many hexs long the template is
		const hex_length = Math.round(self.document.distance / canvas.grid.distance);
		// keep track of positions
		const highlight_positions = [];
		// determine center point of closest hex
		const center_point = canvas.grid.getCenterPoint({x: self.document.x, y: self.document.y});
		// ranges from 0 to 4*pi
		let e = (Math.toRadians(self.document.direction) - Math.atan2((center_point.y - self.document.y), (center_point.x - self.document.x)) + Math.PI);
		while (e > Math.PI) {
			e -= 2 * Math.PI;
		}
		const offset_point = canvas.grid.getTranslatedPoint({x: self.document.x, y: self.document.y}, self.document.direction + ((e < 0) ? (90) : (-90)), Math.floor(hex_width / 2) * canvas.grid.distance);
		const delta_point = canvas.grid.getTranslatedPoint({x: 0, y: 0}, self.document.direction + ((e < 0) ? (-90) : (90)), canvas.grid.distance);
		for (let i = 0; i < hex_width; i++) {
			// canvas.ping({x: (x + i * dx), y: (y + i * dy)});
			for (const hex of hexPath({x: (offset_point.x + i * delta_point.x), y: (offset_point.y + i * delta_point.y)}, self.document.rotation, hex_length)) {
				highlight_positions.push(canvas.grid.getTopLeftPoint(hex));
			}
		}
		return highlight_positions;
	} else {
		return wrapped();
	}
}

export function MeasuredTemplate_layer_getSnappedPoint(wrapped, self, point) {
	return point;
}

export function MeasuredTemplate_object__refreshPosition(wrapped, self) {
	// determine snapping mode
	let snappingMode = 0;
	switch (self.areaShape) {
		case 'point':
			snappingMode = CONST.GRID_SNAPPING_MODES.CENTER;
			break;
		case 'emanation':
			snappingMode = CONST.GRID_SNAPPING_MODES.CENTER | CONST.GRID_SNAPPING_MODES.VERTEX;
			break;
		case 'burst':
			snappingMode = CONST.GRID_SNAPPING_MODES.VERTEX;
			break;
		case 'cone':
			snappingMode = CONST.GRID_SNAPPING_MODES.CENTER | CONST.GRID_SNAPPING_MODES.EDGE_MIDPOINT | CONST.GRID_SNAPPING_MODES.VERTEX;
			break;
		case 'line':
		default:
			break;
	}
	// get snapped position based on snapping mode
	const origin = canvas.grid.getSnappedPoint({x: self.document.x, y: self.document.y}, {mode: snappingMode, resolution: 1});
	// set document to snapped position
	self.document.x = origin.x;
	self.document.y = origin.y;
	// call wrapped function to continue logic
	wrapped();
}

export function MeasuredTemplate_object__refreshShape(wrapped, self) {
	self.ray = new foundry.canvas.geometry.Ray({x: self.document.x, y: self.document.y}, canvas.grid.getTranslatedPoint({x: self.document.x, y: self.document.y}, self.document.direction, self.document.distance));
	self.shape = self._computeShape();
}

export function MeasuredTemplate_layer__onMouseWheel(wrapped, self, event) {
	// try and get a hovered template
	const template = self.hover;
	// determine if there is a template that is not a preview
	if ( !template || template.isPreview ) return;
	// determine the incremental angle of rotation from event data
	const snap = event.shiftKey ? 30 : 15;
	// turn mouse wheel delta into angle delta
	const delta = snap * Math.sign(event.delta);
	// return rotation based on snap
	return template.rotate(template.document.direction + delta, snap);
}

export function MeasuredTemplate_layer__onDragLeftMove(wrapped, self, event) {
	const interaction = event.interactionData;
	// Snap the destination to the grid
	if ( !event.shiftKey ) interaction.destination = self.getSnappedPoint(interaction.destination);
	// Update the preview object direction
	const ray = new foundry.canvas.geometry.Ray(interaction.origin, interaction.destination);
	if (interaction.preview.areaShape == 'cone') {
		const snapAngle = Math.PI / 6;
		interaction.preview.document.direction = Math.normalizeDegrees(Math.toDegrees(Math.floor(ray.angle / snapAngle + 0.5) * snapAngle));
	} else {
		interaction.preview.document.direction = Math.normalizeDegrees(Math.toDegrees(ray.angle));
	}
	if (interaction.preview.areaShape == 'point') {
		interaction.preview.document.distance = canvas.grid.distance / 2;
	} else {
		interaction.preview.document.distance = Math.max(Math.round(canvas.grid.measurePath([interaction.origin, interaction.destination]).distance / canvas.grid.distance) * canvas.grid.distance, canvas.grid.distance);
	}
	interaction.preview.renderFlags.set({refreshShape: true});
}

export function Scene_document_canHaveAuras(wrapped, self) {
	return true;
}

export function Aura_renderer_draw(wrapped, self, showBorder) {}

// TODO support 3D hex columns
export function Aura_token_containsToken(wrapped, self, token) {
	// If either token is hidden or not rendered, return false early
	if (self.token.hidden || token.hidden) {
		return false;
	}
	// If the token is the one emitting the aura, return true early
	if (token === self.token) {
		return true;
	}
	// decide what collision types to test against
	const collision_types = []
	if (self.traits.includes("auditory")) {
		collision_types.push("sound");
	}
	if (self.traits.includes("visual") || !self.traits.includes("auditory") && !self.traits.includes("visual")) {
		collision_types.push("sight");
	}
	if (!self.traits.includes("auditory") && !self.traits.includes("visual")) {
		collision_types.push("move");
	}
	// use custom distance to when checking if token is within aura
	if (self.token.object.distanceTo(token.object, {reach: self.radius, collision_types: collision_types}) == 0) {
		return true;
	}
	return false;
}

export function Aura_renderer_highlight(wrapped, self) {
	if (([CONST.TOKEN_SHAPES.ELLIPSE_1, CONST.TOKEN_SHAPES.ELLIPSE_2].includes(self.token.document.shape)) || ([CONST.TOKEN_SHAPES.TRAPEZOID_1, CONST.TOKEN_SHAPES.TRAPEZOID_2, CONST.TOKEN_SHAPES.RECTANGLE_1, CONST.TOKEN_SHAPES.RECTANGLE_2].includes(self.token.document.shape) && self.token.document.width <= 2 && self.token.document.height <= 2)) {
		const aura_shape = [CONST.TOKEN_SHAPES.ELLIPSE_1, CONST.TOKEN_SHAPES.TRAPEZOID_1, CONST.TOKEN_SHAPES.RECTANGLE_1].includes(self.token.document.shape) ? CONST.TOKEN_SHAPES.ELLIPSE_1 : CONST.TOKEN_SHAPES.ELLIPSE_2;
		const aura_radius = (self.radius / self.token.document.scene.grid.distance);
		const aura_offsets = self.token.document.getOccupiedGridSpaceOffsets({x: self.token.document.x - (self.token.document.scene.grid.columns ? Math.SQRT3 / 2 : 1) * self.token.document.scene.grid.size * aura_radius, y: self.token.document.y - (self.token.document.scene.grid.columns ? 1 : Math.SQRT3 / 2) * self.token.document.scene.grid.size * aura_radius, width: (self.token.document.width < 1 ? 1 : self.token.document.width) + aura_radius * 2, height: (self.token.document.height < 1 ? 1 : self.token.document.height) + aura_radius * 2, shape: aura_shape});
		for (const aura_offset of aura_offsets) {
			const aura_point = self.token.document.scene.grid.getTopLeftPoint(aura_offset)
			self.token.document.scene.grid.highlightPosition(self.highlightLayer.name, {
				x: aura_point.x,
				y: aura_point.y,
				border: self.appearance.border?.color,
				color: self.appearance.highlight.color,
				alpha: self.appearance.highlight.alpha,
			});
		}
	}
}
