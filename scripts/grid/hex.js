export function Aura_renderer_highlight(wrapped, self) {
	// map for deduplication
	const offsets = new Map();
	// outer offsets to only expand outer points
	let outer_offsets = [];
	// heavily modified logic from getOccupiedGridSpaceOffsets
	const token_document_offsets = [];
	const {i: i0, j: j0} = self.token.document._positionToGridOffset();
	const width = Math.max(Math.round(self.token.document.width * 2) / 2, 0.5);
	const height = Math.max(Math.round(self.token.document.height * 2) / 2, 0.5);
	const tokenHexagonalOffsetsData = foundry.documents.BaseToken._getHexagonalOffsets(width, height, self.token.document.shape, self.token.document.scene.grid.columns);
	const isEven = ((self.token.document.scene.grid.columns ? j0 : i0) % 2 === 0) === self.token.document.scene.grid.even;
	for ( const {i: di, j: dj} of (isEven ? tokenHexagonalOffsetsData.even : tokenHexagonalOffsetsData.odd) ) {
		token_document_offsets.push({i: i0 + di, j: j0 + dj});
	}
	// add occupied offsets
	for (const offset of token_document_offsets) {
		const key = `${offset.i},${offset.j}`;
		if (!offsets.has(key)) {
			offsets.set(key, offset);
			outer_offsets.push(offset);
		}
	}
	// grow offsets
	const steps = Math.round(self.radius / self.token.document.scene.grid.distance);
	for (let step = 0; step < steps && outer_offsets.length; step++) {
		let new_outer_offsets = [];
		for (const outer_offset of outer_offsets) {
			for (const offset of self.token.document.scene.grid.getAdjacentOffsets(outer_offset)) {
				const key = `${offset.i},${offset.j}`;
				if (!offsets.has(key)) {
					offsets.set(key, offset);
					new_outer_offsets.push(offset);
				}
			}
		}
		outer_offsets = new_outer_offsets;
	}
	// remove occupied offsets
	for (const offset of token_document_offsets) {
		offsets.delete(`${offset.i},${offset.j}`);
	}
	// highlight
	for (const offset of offsets.values()) {
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