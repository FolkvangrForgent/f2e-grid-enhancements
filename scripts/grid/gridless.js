export function Scene_document_canHaveAuras(wrapped, self) {
	return true;
}

export function Aura_renderer_highlight(wrapped, self) {
	let aura_base;
	if ([CONST.TOKEN_SHAPES.ELLIPSE_1, CONST.TOKEN_SHAPES.ELLIPSE_2].includes(self.token.document.shape)) {
		aura_base = {
			type: "ellipse",
			x: self.token.document.x + self.token.document.width * self.token.document.scene.grid.size / 2,
			y: self.token.document.y + self.token.document.height * self.token.document.scene.grid.size / 2,
			radiusX: self.token.document.width / 2 * self.token.document.scene.grid.size,
			radiusY: self.token.document.height / 2 * self.token.document.scene.grid.size,
		}
	} else if ([CONST.TOKEN_SHAPES.RECTANGLE_1, CONST.TOKEN_SHAPES.RECTANGLE_2].includes(self.token.document.shape)) {
		aura_base = {
			type: "rectangle",
			x: self.token.document.x,
			y: self.token.document.y,
			width: self.token.document.width * self.token.document.scene.grid.size,
			height: self.token.document.height * self.token.document.scene.grid.size,
		}
	} else {
		return;
	}
	const aura_shape = new foundry.data.EmanationShapeData({
		type: "emanation",
		base: aura_base,
		radius: self.radius * self.token.document.scene.grid.size / self.token.document.scene.grid.distance,
		gridBased: false
	});
	const layer = canvas.interface.grid.highlightLayers[self.highlightLayer.name];
	if ( !layer ) {
		return;
	}
	layer.beginFill(self.appearance.highlight.color, self.appearance.highlight.alpha);
	layer.drawShape(aura_shape.polygons[0]).endFill();
}
