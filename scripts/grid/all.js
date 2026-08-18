export function Token_object_distanceTo(wrapped, self, target, opts) {
	// if target is self distance will always be 0
	if (self === target) return 0;
	// calculate the self points
	const selfPoints = []
	for (const offset of self.document.getOccupiedGridSpaceOffsets()) {
		const point = canvas.grid.getCenterPoint(offset);
		selfPoints.push(point);
	}
	// calculate the target points
	let targetPoints = []
	if (target instanceof CONFIG.Token.objectClass) {
		for (const offset of target.document.getOccupiedGridSpaceOffsets()) {
			const point = canvas.grid.getCenterPoint(offset)
			targetPoints.push(point);
		}
	} else {
		// center point (and add elevation until PF2e point is 3D)
		targetPoints.push(canvas.grid.getCenterPoint({x: target.x, y: target.y, elevation: target.document?.elevation ?? self.document.elevation}));
	}
	// filter target points to those that are valid from token center if collision is wanted (custom override for auras on hex)
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
	// return distance clamped to positive values
	return Math.max(0, distance);
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
	if (data.displayMeasurements && data.highlightMode === "coverage") {
		// fixup internal cone angle
		for (let shape of data.shapes) {
			if (shape.angle == 90 && shape.type == "cone") {
				shape.angle = canvas?.grid?.isHexagonal ? game.settings.get('f2e-grid-enhancements', 'hex-cone-template-angle') : canvas?.grid?.isSquare ? game.settings.get('f2e-grid-enhancements', 'square-cone-template-angle') : game.settings.get('f2e-grid-enhancements', 'gridless-cone-template-angle')
			}
		}
		// support rotation with modified pf2e code
		const placement = { aiming: false };
		options.onMove = ({ event, position, preview, shape, snap }) => {
			if (placement.aiming && (shape.type === "cone" || shape.type == "line")) {
				const rotation_angle = shape.type === "cone" ? canvas?.grid?.isHexagonal ? game.settings.get('f2e-grid-enhancements', 'hex-cone-snapping-angle') : canvas?.grid?.isSquare ? game.settings.get('f2e-grid-enhancements', 'square-cone-snapping-angle') : game.settings.get('f2e-grid-enhancements', 'gridless-cone-snapping-angle') : 5;
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
			if (shape.type === "cone" || shape.type == "line") {
				const rotation_angle = shape.type === "cone" ? canvas?.grid?.isHexagonal ? game.settings.get('f2e-grid-enhancements', 'hex-cone-snapping-angle') : canvas?.grid?.isSquare ? game.settings.get('f2e-grid-enhancements', 'square-cone-snapping-angle') : game.settings.get('f2e-grid-enhancements', 'gridless-cone-snapping-angle') : 5;
				const step = event.ctrlKey || event.metaKey ? 5 : rotation_angle;
				const delta = step * Math.sign(event.deltaY);
				const rotation = shape.rotation + delta;
				shape.updateSource({ rotation: event.ctrlKey || event.metaKey ? rotation : rotation.toNearest(step) });
				return false;
			}
			return;
		};
		options.preConfirm = ({ event, shape }) => {
			const aim = (shape.type === "cone" || shape.type == "line") && !event.shiftKey;
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
	if (event.interactionData.shape.type == "circle" && game.activeTool == "point") {
		event.interactionData.shape.updateSource({radius: canvas.dimensions.distance * canvas.dimensions.distancePixels / 2});
		self._updateDragPreview(event);
	} else if (self.templateMode && (event.interactionData.shape.type == "line" || event.interactionData.shape.type == "cone")) {
		const rotation_angle = event.interactionData.shape.type === "cone" ? canvas?.grid?.isHexagonal ? game.settings.get('f2e-grid-enhancements', 'hex-cone-snapping-angle') : canvas?.grid?.isSquare ? game.settings.get('f2e-grid-enhancements', 'square-cone-snapping-angle') : game.settings.get('f2e-grid-enhancements', 'gridless-cone-snapping-angle') : 5;
		const rotation = event.interactionData.shape.rotation.toNearest(rotation_angle);
		if (rotation !== event.interactionData.shape.rotation) {
			event.interactionData.shape.updateSource({rotation});
			self._updateDragPreview(event);
		}
	}
}