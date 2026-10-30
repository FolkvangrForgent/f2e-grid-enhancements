export function Region_object__getCoveredGridSpaceOffsets(wrapped, self) {
	if (self.document.shapes.length !== 1 || self.document.shapes[0].type !== "line" || self.document.shapes[0].hole) return wrapped();
	// TODO support width
	const radian = Math.toRadians(self.document.shapes[0].rotation);
	const cos = Math.cos(radian);
	const sin = Math.sin(radian);
	// remove floating point noise
	const d_x = Math.abs(cos) < 1e-9 ? 0 : cos;
	const d_y = Math.abs(sin) < 1e-9 ? 0 : sin;
	// direction aware nudge
	const nudge_x = d_x * 1e-3 - d_y * 1e-7;
	const nudge_y = d_y * 1e-3 + d_x * 1e-7;
	// line logic per grid type
	if (self.scene.grid.isSquare) {
		const length = self.document.shapes[0].length / self.scene.grid.size;
		const start_x = self.document.shapes[0].x / self.scene.grid.size;
		const start_y = self.document.shapes[0].y / self.scene.grid.size;
		const d_max = Math.max(Math.abs(d_x), Math.abs(d_y));
		const step_x = d_x / d_max;
		const step_y = d_y / d_max;
		const steps = Math.ceil(length) + 1;
		const insert_corners = self.scene.grid.diagonals === CONST.GRID_DIAGONALS.ILLEGAL || self.scene.grid.diagonals === CONST.GRID_DIAGONALS.RECTILINEAR && game.settings.get('f2e-grid-enhancements', 'line-region-rectilinear-corners');
		// cost tracking
		let cost = 1;
		let diagonals = 0;
		let stop = false;
		// DDA
		let previous_point = null;
		const offsets = [];
		for (let step = 0; step <= steps && !stop; step++) {
			// get point
			const point = {
				x: (start_x + step_x * step) * self.scene.grid.size,
				y: (start_y + step_y * step) * self.scene.grid.size
			}
			// convert to offset
			const offset = self.scene.grid.getOffset({x: point.x + nudge_x, y: point.y + nudge_y});
			// offsets to add for this step
			let path_offsets = [offset];
			// corner adding
			const prev_offset = offsets.at(-1);
			if (insert_corners && prev_offset && prev_offset.i !== offset.i && prev_offset.j !== offset.j) {
				const corner_offset_1 = { i: prev_offset.i, j: offset.j }
				const corner_offset_2 = { i: offset.i, j: prev_offset.j };
				const corner_point_1 = self.scene.grid.getCenterPoint(corner_offset_1);
				const corner_point_2 = self.scene.grid.getCenterPoint(corner_offset_2);
				const corner_distance_1 = Math.hypot(corner_point_1.x - ((previous_point.x + point.x) / 2), corner_point_1.y - ((previous_point.y + point.y) / 2));
				const corner_distance_2 = Math.hypot(corner_point_2.x - ((previous_point.x + point.x) / 2), corner_point_2.y - ((previous_point.y + point.y) / 2));
				if (corner_distance_1 <= corner_distance_2) {
					path_offsets = [corner_offset_1, offset];
				} else {
					path_offsets = [corner_offset_2, offset];
				}
			}
			// add offsets keeping track of length
			for (const path_offset of path_offsets) {
				const last_offset = offsets.at(-1);
				if (last_offset) {
					let step_cost = 1;
					if (last_offset.i !== path_offset.i && last_offset.j !== path_offset.j) {
						switch (self.scene.grid.diagonals) {
							case CONST.GRID_DIAGONALS.EXACT:
								step_cost = Math.SQRT2;
								break;
							case CONST.GRID_DIAGONALS.APPROXIMATE:
								step_cost = 1.5;
								break;
							case CONST.GRID_DIAGONALS.RECTILINEAR:
								step_cost = 2;
								break;
							case CONST.GRID_DIAGONALS.ALTERNATING_1:
								step_cost = (diagonals % 2 === 0 ? 1 : 2);
								break;
							case CONST.GRID_DIAGONALS.ALTERNATING_2:
								step_cost = (diagonals % 2 === 0 ? 2 : 1);
								break;
							case CONST.GRID_DIAGONALS.EQUIDISTANT:
								step_cost = 1;
								break;
							case CONST.GRID_DIAGONALS.ILLEGAL:
								step_cost = Infinity;
								break;
						}
						diagonals++;
					}
					if (cost + step_cost > length + 1e-9) {
						stop = true;
						break;
					}
					cost += step_cost;
				}
				offsets.push(path_offset);
			}
			previous_point = point;
		}
		// check if adding extra straight offsets is valid
		if (game.settings.get('f2e-grid-enhancements', 'line-region-padding')) {
			let d_i = 0;
			let d_j = 0;
			if (Math.abs(d_y) > Math.abs(d_x)) {
				d_i = Math.sign(d_y);
			} else {
				d_j = Math.sign(d_x);
			}
			let end = offsets.at(-1);
			while (cost + 1 <= length + 1e-9) {
				end = { i: end.i + d_i, j: end.j + d_j };
				offsets.push(end);
				cost += 1;
			}
		}
		return offsets;
	} else if (self.scene.grid.isHexagonal) {
		// length is padded due to corner removal
		const length = self.document.shapes[0].length + 2 * self.scene.grid.size;
		const end = {
			x: self.document.shapes[0].x + d_x * length,
			y: self.document.shapes[0].y + d_y * length
		};
		// steps are based on the padded length and oversampled
		// use linear_interpolation to get offsets
		let previous_offset = null;
		const offsets = [];
		const steps = Math.max(1, Math.ceil(2.4 * length / self.scene.grid.size));
		for (let step = 0; step <= steps; step++) {
			const linearInterpolationStep = step / steps;
			// get offset
			const offset = self.scene.grid.getOffset({
				x: self.document.shapes[0].x + (end.x - self.document.shapes[0].x) * linearInterpolationStep + nudge_x,
				y: self.document.shapes[0].y + (end.y - self.document.shapes[0].y) * linearInterpolationStep + nudge_y
			});
			// deduplicate offset
			if (previous_offset && previous_offset.i === offset.i && previous_offset.j === offset.j) {
				continue;
			}
			// remove corners
			const last_last_offset = offsets.at(-2);
			if (last_last_offset && self.scene.grid.getAdjacentOffsets(last_last_offset).some(o => o.i === offset.i && o.j === offset.j)) {
				offsets.pop();
			}
			offsets.push(offset);
			previous_offset = offset;
		}
		// return the correct number of offsets
		return offsets.slice(0, Math.max(1, Math.floor(self.document.shapes[0].length / self.scene.grid.size + 1e-9)));
	} else {
		return wrapped();
	}
}