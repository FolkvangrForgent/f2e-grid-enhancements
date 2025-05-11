// TODO gridless edge to edge or edge to side options
// TODO Support 3D elipsoid
// export function Token_object_distanceTo(wrapped, self, target, opts) {
// 	return wrapped(target, opts);
// }

export function Token_object_getShape(wrapped, self) {
	const w = (self.document.width / 2) * canvas.grid.size;
	const h = (self.document.height / 2) * canvas.grid.size;
	const r = Math.toRadians(self.document.rotation);
	const p = Math.floor((w + h) / 2);
	const n = Math.max(Math.ceil(Math.PI / Math.acos(Math.max(p - 0.25, 0) / p)), 4);
	const points = new Array(n * 2);
	for (let i = 0; i < n; i++) {
		const a = 2 * Math.PI * (i / n);
		points[i * 2] = (w * Math.cos(a) * Math.cos(r) - h * Math.sin(a) * Math.sin(r)) + w;
		points[i * 2 + 1] = (w * Math.cos(a) * Math.sin(r) + h * Math.sin(a) * Math.cos(r)) + h;
	}
	return new PIXI.Polygon(points);
}

export function Token_object__refreshRotation(wrapped, self) {
	self.shape = self.getShape();
	self._refreshBorder();
	wrapped();
}