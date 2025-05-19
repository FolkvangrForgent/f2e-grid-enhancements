export function MeasuredTemplate_object__refreshTemplate(wrapped, self) {
	// calculate ui scale
	const scale = (canvas?.dimensions?.uiScale ?? 1);
	// clear and reuse graphic
	const graphic = self.template.clear();
	// line style
	graphic.lineStyle(self._borderThickness * scale, self.document.borderColor, 0.75).beginFill(0x000000, 0.0);
	// fill color or texture
	if ( self.texture ) {
		graphic.beginTextureFill({texture: self.texture});
	} else {
		graphic.beginFill(0x000000, 0.0);
	}
	// draw the a custom line and point area shapes
	if (self.areaShape === 'line') {
		let shape = self.shape;
		graphic.drawShape(shape);
	} else if (self.areaShape === 'point') {
		if (canvas?.grid?.isSquare) {
			const dimension = self.document.distance * canvas.dimensions.distancePixels;
			graphic.drawShape(new PIXI.Rectangle(-dimension, -dimension, dimension * 2, dimension * 2));
		} else if (canvas?.grid?.isHexagonal) {
			let shape;
			const r = 4 / 7 * canvas.grid.size;
			if ( !canvas.grid.columns ) {
				const x0 = r * (Math.SQRT3 / 2);
				const x1 = -x0;
				const y0 = r;
				const y1 = y0 / 2;
				const y2 = -y1;
				const y3 = -y0;
				shape = [{x: 0, y: y0}, {x: x1, y: y1}, {x: x1, y: y2},
					{x: 0, y: y3}, {x: x0, y: y2}, {x: x0, y: y1}];
			} else {
				const y0 = r * (Math.SQRT3 / 2);
				const y1 = -y0;
				const x0 = r;
				const x1 = x0 / 2;
				const x2 = -x1;
				const x3 = -x0;
				shape = [{x: 0 + x0, y: 0}, {x: x1, y: y0}, {x: x2, y: y0},
					{x: 0 + x3, y: 0}, {x: x2, y: y1}, {x: x1, y: y1}];
			}
			graphic.drawShape(new PIXI.Polygon(shape));
		} else {
			graphic.drawShape(self.shape);
		}
	} else {
		graphic.drawShape(self.shape);
	}
	// draw origin point
	graphic.lineStyle(self._borderThickness * scale, 0x000000).beginFill(0x000000, 0.5).drawCircle(0, 0, 6 * scale).endFill();
	// draw destination point if areaShape is a line
	if (self.areaShape === 'line') {
		graphic.lineStyle(self._borderThickness * scale, 0x000000).beginFill(0x000000, 0.5).drawCircle(self.ray.dx, self.ray.dy, 6 * scale).endFill();
	}
}

export function MeasuredTemplate_object__refreshRulerText(wrapped, self) {
	// get template information
	if ( self.document.t === 'rect' ) {
		return wrapped();
	} else {
		if (self.areaShape == 'point') {
			self.ruler.text = ``;
		} else if (self.areaShape == 'line') {
			self.ruler.text = `${(Math.round(self.document.distance / canvas.grid.distance) * canvas.grid.distance)}${canvas.grid.units}`;
			if (Math.round(self.document.width / canvas.grid.distance) > 1) {
				self.ruler.text += ` x ${(Math.round(self.document.width / canvas.grid.distance) * canvas.grid.distance)}${canvas.grid.units} `;
			}
		} else {
			self.ruler.text = `${(Math.round(self.document.distance / canvas.grid.distance) * canvas.grid.distance)}${canvas.grid.units}`;
		}
	}
	// check where to render ruler text
	if (self.areaShape === 'line') {
		let offset;
		if (canvas?.grid?.isSquare) {
			offset = foundry.canvas.geometry.Ray.fromAngle(self.document.x, self.document.y, Math.toRadians(self.document.direction), (self.document.distance + (canvas.grid.distance / 2)) * canvas.dimensions.distancePixels);
			self.ruler.position.set(self.ray.dx + (-self.ruler.width / 2), self.ray.dy + (self.ruler.height / 2));
		} else {
			offset = new foundry.canvas.geometry.Ray({x: self.document.x, y: self.document.y}, canvas.grid.getTranslatedPoint({x: self.document.x, y: self.document.y}, self.document.direction, self.document.distance + (canvas.grid.distance / 2)));
		}
		self.ruler.position.set(offset.dx + (-self.ruler.width / 2), offset.dy + (self.ruler.height / 2));
	} else {
		const offset = foundry.canvas.geometry.Ray.fromAngle(0, 0, self.ray.angle, 75);
		self.ruler.position.set(offset.dx + (-self.ruler.width / 2), offset.dy + (self.ruler.height / 2));
	}
}

export function MeasuredTemplate_layerFoundry__onDragLeftStart(wrapped, self, event) {
	self.clearPreviewContainer();
	const interaction = event.interactionData;
	// Snap the origin to the grid
	if ( !event.shiftKey ) interaction.origin = self.getSnappedPoint(interaction.origin);
	// Create a pending MeasuredTemplateDocument
	const tool = game.activeTool;
	const previewData = {
		user: game.user.id,
		t: ((tool === 'emanation') || (tool === 'burst') || (tool === 'point')) ? 'circle' : (tool === 'line') ? 'ray' : tool,
		x: interaction.origin.x,
		y: interaction.origin.y,
		sort: Math.max(self.getMaxSort() + 1, 0),
		distance: 1,
		direction: 0,
		fillColor: game.user.color || '#FF0000',
		hidden: event.altKey,
		flags: {
			pf2e: {
				areaShape: tool
			}
		}
	};
	const defaults = CONFIG.MeasuredTemplate.defaults;
	if ( tool === 'cone' ) {
		try {
			if (canvas?.grid?.isGridless) {
				previewData.angle = game.settings.get('f2e-grid-enhancements', 'gridless-cone-template-angle');
			} else if (canvas?.grid?.isHexagonal) {
				previewData.angle = game.settings.get('f2e-grid-enhancements', 'hex-cone-template-angle');
			} else if (canvas?.grid?.isSquare) {
				previewData.angle = game.settings.get('f2e-grid-enhancements', 'square-cone-template-angle');
			} else {
				previewData.angle = defaults.angle;
			}
		} catch {
			previewData.angle = defaults.angle;
		}
	} else if ( tool === 'line' || tool === 'ray' ) {
		previewData.width = (CONFIG.MeasuredTemplate.defaults.width * canvas.dimensions.distance);
	}
	const cls = foundry.utils.getDocumentClass('MeasuredTemplate');
	const doc = new cls(previewData, {parent: canvas.scene});
	// Create a preview MeasuredTemplate object
	const template = new self.constructor.placeableClass(doc);
	doc._object = template;
	interaction.preview = self.preview.addChild(template);
	template.draw();
}

export function MeasuredTemplate_layer__onDragLeftMove(wrapped, self, event) {
	const interaction = event.interactionData;
	// Update the preview object direction
	if (interaction.preview.areaShape == 'point') {
		const ray = new foundry.canvas.geometry.Ray(interaction.origin, interaction.destination);
		interaction.preview.document.direction = Math.normalizeDegrees(Math.toDegrees(ray.angle));
		interaction.preview.document.distance = canvas.grid.distance / 2;
		interaction.preview.renderFlags.set({refreshShape: true});
	} else {
		wrapped(event);
	}
}
