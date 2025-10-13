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
			snappingMode = CONST.GRID_SNAPPING_MODES.SIDE_MIDPOINT | CONST.GRID_SNAPPING_MODES.CORNER;
			break;
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