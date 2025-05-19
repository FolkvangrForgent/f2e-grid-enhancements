// TODO gridless edge to edge or edge to side options
// TODO Support 3D elipsoid
// export function Token_object_distanceTo(wrapped, self, target, opts) {
// 	return wrapped(target, opts);
// }

function rotated_ellipse(width, height, rotation, grid_size, x, y, ratio) {
	const w = (width / 2) * grid_size;
	const h = (height / 2) * grid_size;
	const r = Math.toRadians(rotation);
	const p = Math.floor((w + h) / 2);
	const n = Math.max(Math.ceil(Math.PI / Math.acos(Math.max(p - 0.25, 0) / p) * ratio), 8);
	const points = new Array(n * 2);
	for (let i = 0; i < n; i++) {
		const a = 2 * Math.PI * (i / n);
		points[i * 2] = (w * Math.cos(a) * Math.cos(r) - h * Math.sin(a) * Math.sin(r)) + w + x;
		points[i * 2 + 1] = (w * Math.cos(a) * Math.sin(r) + h * Math.sin(a) * Math.cos(r)) + h + y;
	}
	return new PIXI.Polygon(points);
}

export function Token_object_getShape(wrapped, self) {
	return rotated_ellipse(self.document.width, self.document.height, self.document.rotation, self.scene.grid.size, 0, 0, 1);
}

// TODO fix? maybe just via hook idk
export function Token_object__refreshRotation(wrapped, self) {
	self._refreshShape();
	wrapped();
}

export function Scene_document_canHaveAuras(wrapped, self) {
	return true;
}

export function Aura_renderer_draw(wrapped, self, showBorder) {}

export function Aura_renderer_highlight(wrapped, self) {
	const aura_radius = (self.radius / self.token.scene.grid.distance) * 2;
	self.token.scene.grid.highlightPosition(self.highlightLayer.name, {
		shape: rotated_ellipse(self.token.document.width + aura_radius, self.token.document.height + aura_radius, self.token.document.rotation, self.token.scene.grid.size, self.token.document.center.x - (self.token.document.width + aura_radius) * self.token.scene.grid.size / 2, self.token.document.center.y - (self.token.document.height + aura_radius) * self.token.scene.grid.size / 2, 1),
		border: self.appearance.border?.color,
		color: self.appearance.highlight.color,
		alpha: self.appearance.highlight.alpha,
	});
}

// TODO Support 3D elipsoid
export function Aura_token_containsToken(wrapped, self, token) {
	// If either token is hidden or not rendered, return false early
	if (self.token.hidden || token.hidden) {
		return false;
	}
	// If the token is the one emitting the aura, return true early
	if (token === self.token) {
		return true;
	}
	// get aura shape (reduced quality)
	const aura_radius = (self.radius / self.token.scene.grid.distance) * 2;
	const aura_rotated_ellipse = rotated_ellipse(self.token.width + aura_radius, self.token.height + aura_radius, self.token.rotation, self.token.scene.grid.size, (token.center.x - self.token.center.x) - (self.token.width + aura_radius) * self.token.scene.grid.size / 2, (token.center.y - self.token.center.y) - (self.token.height + aura_radius) * self.token.scene.grid.size / 2, 0.5);
	// setup polygons to test against
	const polygonBackends = []
	if (self.traits.includes("auditory")) {
		polygonBackends.push(CONFIG.Canvas.polygonBackends.sound.create(self.token.center, {
			type: "sound",
			source: new foundry.canvas.sources.PointSoundSource({object: self.token.object}),
			boundaryShape: [aura_rotated_ellipse.getBounds()]
		}));
	}
	if (self.traits.includes("visual") || !self.traits.includes("auditory") && !self.traits.includes("visual")) {
		polygonBackends.push(CONFIG.Canvas.polygonBackends.sight.create(self.token.center, {
			type: "sight",
			source: new foundry.canvas.sources.PointVisionSource({object: self.token.object}),
			boundaryShape: [aura_rotated_ellipse.getBounds()]
		}));
	}
	if (!self.traits.includes("auditory") && !self.traits.includes("visual")) {
		polygonBackends.push(CONFIG.Canvas.polygonBackends.move.create(self.token.center, {
			type: "move",
			source: new foundry.canvas.sources.PointMovementSource({object: self.token.object}),
			boundaryShape: [aura_rotated_ellipse.getBounds()]
		}));
	}
	// compare token shape points to relative aura shape and polygons
	for (let i = 0; i < token.object.shape.points.length; i += 2) {
		if (aura_rotated_ellipse.contains(token.object.shape.points[i], token.object.shape.points[i+1])) {
			for (const polygonBackend of polygonBackends) {
				if (polygonBackend.contains(token.object.shape.points[i] + token.center.x, token.object.shape.points[i+1] + token.center.y)) {
					return true;
				}
			}
		}
	}
	return false;
}