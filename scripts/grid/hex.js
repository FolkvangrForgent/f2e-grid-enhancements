export function Scene_document_canHaveAuras(wrapped, self) {
	return true;
}

export function Aura_renderer_draw(wrapped, self, showBorder) {
	self.border.visible = false;
}

export function Aura_renderer_highlight(wrapped, self) {
	if (([CONST.TOKEN_SHAPES.ELLIPSE_1, CONST.TOKEN_SHAPES.ELLIPSE_2].includes(self.token.document.shape)) || ([CONST.TOKEN_SHAPES.TRAPEZOID_1, CONST.TOKEN_SHAPES.TRAPEZOID_2, CONST.TOKEN_SHAPES.RECTANGLE_1, CONST.TOKEN_SHAPES.RECTANGLE_2].includes(self.token.document.shape) && self.token.document.width <= 2 && self.token.document.height <= 2)) {
		const aura_shape = [CONST.TOKEN_SHAPES.ELLIPSE_1, CONST.TOKEN_SHAPES.TRAPEZOID_1, CONST.TOKEN_SHAPES.RECTANGLE_1].includes(self.token.document.shape) ? CONST.TOKEN_SHAPES.ELLIPSE_1 : CONST.TOKEN_SHAPES.ELLIPSE_2;
		const aura_radius = (self.radius / self.token.document.scene.grid.distance);
		const aura_offsets = self.token.document.getOccupiedGridSpaceOffsets({x: self.token.document.x - (self.token.document.scene.grid.columns ? Math.SQRT3 / 2 : 1) * self.token.document.scene.grid.size * aura_radius, y: self.token.document.y - (self.token.document.scene.grid.columns ? 1 : Math.SQRT3 / 2) * self.token.document.scene.grid.size * aura_radius, width: (self.token.document.width < 1 ? 1 : self.token.document.width) + aura_radius * 2, height: (self.token.document.height < 1 ? 1 : self.token.document.height) + aura_radius * 2, shape: aura_shape});
		for (const aura_offset of aura_offsets) {
			const aura_point = self.token.document.scene.grid.getTopLeftPoint(aura_offset)
			canvas.interface.grid.highlightPosition(self.highlightLayer.name, {
				x: aura_point.x,
				y: aura_point.y,
				border: self.appearance.border?.color,
				color: self.appearance.highlight.color,
				alpha: self.appearance.highlight.alpha,
			});
		}
	} else if ([CONST.TOKEN_SHAPES.TRAPEZOID_1, CONST.TOKEN_SHAPES.TRAPEZOID_2, CONST.TOKEN_SHAPES.RECTANGLE_1, CONST.TOKEN_SHAPES.RECTANGLE_2].includes(self.token.document.shape)) {
		// TODO support all hex shapes visually
	}
}
