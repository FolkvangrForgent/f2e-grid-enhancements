// Shadows on a ray: the stretches of a ray that a flat barrier hides from a point (a light or darkness source), worked out
// in the plane through the point and the ray. A barrier hides a point P of the ray where it crosses the segment from the
// source S to P; cut by that plane it is a segment, which, projected from S onto the ray, is a stretch of t. Everything is
// in (x, y, elevation): projections keep lines and where points lie along them, so elevation needs no scaling.

// The plane through the source (sx, sy, sz) and the ray (from o, along d), with what projecting onto the ray needs; null
// when the source is on the ray's line (it then has no plane, and nothing is hidden but along the line itself).
export function shadowFrame(sx, sy, sz, ox, oy, oz, dx, dy, dz) {
	const ax = ox - sx;
	const ay = oy - sy;
	const az = oz - sz;
	// the plane's normal, (O - S) x D
	const nx = ay * dz - az * dy;
	const ny = az * dx - ax * dz;
	const nz = ax * dy - ay * dx;
	const dd = dx * dx + dy * dy + dz * dz;
	if (!(Math.hypot(nx, ny, nz) > 1e-9 * Math.hypot(ax, ay, az) * Math.sqrt(dd))) return null;
	// w: the part of (O - S) across the ray, so (X - S)·w / (w·w) is 0 at S and 1 on the ray's line
	const along = (ax * dx + ay * dy + az * dz) / dd;
	const wx = ax - along * dx;
	const wy = ay - along * dy;
	const wz = az - along * dz;
	return {sx, sy, sz, ox, oy, oz, dx, dy, dz, dd, nx, ny, nz, wx, wy, wz, ww: wx * wx + wy * wy + wz * wz};
}

// How far a point of the plane is from S toward the ray's line: 0 at S, 1 on the line.
const across = (frame, x, y, z) => (frame.wx * (x - frame.sx) + frame.wy * (y - frame.sy) + frame.wz * (z - frame.sz)) / frame.ww;

// The ray's t where the line from S through a point of the plane (at `acrossRay` from S) meets the ray.
function projectedT(frame, x, y, z, acrossRay) {
	const px = frame.sx + (x - frame.sx) / acrossRay - frame.ox;
	const py = frame.sy + (y - frame.sy) / acrossRay - frame.oy;
	const pz = frame.sz + (z - frame.sz) / acrossRay - frame.oz;
	return (px * frame.dx + py * frame.dy + pz * frame.dz) / frame.dd;
}

// The stretch of t a segment of the plane (between the points q1 and q2) hides, or null: only its part strictly between
// S and the ray's line hides anything.
function segmentShadow(frame, x1, y1, z1, x2, y2, z2) {
	const across1 = across(frame, x1, y1, z1);
	const across2 = across(frame, x2, y2, z2);
	// a hair in from S and from the ray's line, so a segment lying along the line (rounded either way) hides nothing
	const low = 1e-9;
	const high = 1 - 1e-9;
	let fromS = 0;
	let toS = 1;
	if (across1 === across2) {
		if (!(across1 > low && across1 < high)) return null;
	} else {
		// where along the segment `across` is `low` and `high`, kept to the part between them
		const atLow = (low - across1) / (across2 - across1);
		const atOne = (high - across1) / (across2 - across1);
		fromS = Math.max(0, Math.min(atLow, atOne));
		toS = Math.min(1, Math.max(atLow, atOne));
		if (!(fromS < toS)) return null;
	}
	const ax = x1 + (x2 - x1) * fromS;
	const ay = y1 + (y2 - y1) * fromS;
	const az = z1 + (z2 - z1) * fromS;
	const bx = x1 + (x2 - x1) * toS;
	const by = y1 + (y2 - y1) * toS;
	const bz = z1 + (z2 - z1) * toS;
	const t1 = projectedT(frame, ax, ay, az, across(frame, ax, ay, az));
	const t2 = projectedT(frame, bx, by, bz, across(frame, bx, by, bz));
	return t1 < t2 ? [t1, t2] : [t2, t1];
}

// The stretch of t a vertical quad hides: from (ax, ay) to (bx, by), between the elevations bottom and top (finite).
export function quadShadow(frame, ax, ay, bx, by, bottom, top) {
	// a convex quad meets the plane in one segment, between the two of its edges that cross it; its corners go around
	// bottom A, bottom B, top B, top A
	const baseA = frame.nx * (ax - frame.sx) + frame.ny * (ay - frame.sy);
	const baseB = frame.nx * (bx - frame.sx) + frame.ny * (by - frame.sy);
	const bottomSide = frame.nz * (bottom - frame.sz);
	const topSide = frame.nz * (top - frame.sz);
	const xs = [ax, bx, bx, ax];
	const ys = [ay, by, by, ay];
	const zs = [bottom, bottom, top, top];
	const sides = [baseA + bottomSide, baseB + bottomSide, baseB + topSide, baseA + topSide];
	let found = 0;
	let x1 = 0;
	let y1 = 0;
	let z1 = 0;
	let x2 = 0;
	let y2 = 0;
	let z2 = 0;
	for (let index = 0; index < 4; index++) {
		const next = (index + 1) & 3;
		const side1 = sides[index];
		const side2 = sides[next];
		if (side1 === 0 && side2 === 0) return null;
		let s;
		if (side1 === 0) s = 0;
		else if (side1 < 0 !== side2 < 0 && side2 !== 0) s = side1 / (side1 - side2);
		else continue;
		const x = xs[index] + (xs[next] - xs[index]) * s;
		const y = ys[index] + (ys[next] - ys[index]) * s;
		const z = zs[index] + (zs[next] - zs[index]) * s;
		if (found === 0) {
			x1 = x;
			y1 = y;
			z1 = z;
		} else {
			x2 = x;
			y2 = y;
			z2 = z;
		}
		found++;
	}
	return found < 2 ? null : segmentShadow(frame, x1, y1, z1, x2, y2, z2);
}

// Whether a segment of the plan can be in a triangle of the plan (the source and the ray's stretch, seen from above):
// anything that hides part of the stretch from the source is within it. True for a triangle too thin to test.
export function segmentMeetsTriangle(ax, ay, bx, by, triangle) {
	const {x0, y0, x1, y1, x2, y2} = triangle;
	const area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
	if (!(Math.abs(area) > 1e-6 * ((x1 - x0) ** 2 + (y1 - y0) ** 2 + (x2 - x0) ** 2 + (y2 - y0) ** 2))) return true;
	const orient = (px, py, qx, qy, rx, ry) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
	const isInside = (px, py) => {
		const d0 = orient(x0, y0, x1, y1, px, py);
		const d1 = orient(x1, y1, x2, y2, px, py);
		const d2 = orient(x2, y2, x0, y0, px, py);
		return (d0 >= 0 && d1 >= 0 && d2 >= 0) || (d0 <= 0 && d1 <= 0 && d2 <= 0);
	};
	if (isInside(ax, ay) || isInside(bx, by)) return true;
	const crosses = (px, py, qx, qy) => {
		const o1 = orient(ax, ay, bx, by, px, py);
		const o2 = orient(ax, ay, bx, by, qx, qy);
		const o3 = orient(px, py, qx, qy, ax, ay);
		const o4 = orient(px, py, qx, qy, bx, by);
		return o1 <= 0 !== o2 <= 0 && o3 <= 0 !== o4 <= 0;
	};
	return crosses(x0, y0, x1, y1) || crosses(x1, y1, x2, y2) || crosses(x2, y2, x0, y0);
}

// The stretches of t a horizontal polygon hides: its outlines' edges (flat as minX, minY, maxX... per EDGE_STRIDE, see
// geometry.js) at an elevation, holes included (even-odd).
export function faceShadows(frame, edges, stride, endXOffset, endYOffset, elevation) {
	// the plane meets the face's plane in a line of the plan: nx (x - sx) + ny (y - sy) + c = 0
	const c = frame.nz * (elevation - frame.sz);
	if (!(Math.hypot(frame.nx, frame.ny) > 0)) return [];
	// along that line, by (-ny, nx)
	const crossings = [];
	for (let offset = 0; offset < edges.length; offset += stride) {
		const x1 = edges[offset];
		const y1 = edges[offset + 1];
		const x2 = edges[offset + endXOffset];
		const y2 = edges[offset + endYOffset];
		const side1 = frame.nx * (x1 - frame.sx) + frame.ny * (y1 - frame.sy) + c;
		const side2 = frame.nx * (x2 - frame.sx) + frame.ny * (y2 - frame.sy) + c;
		// half-open, so a vertex on the line counts once
		if (side1 < 0 === side2 < 0) continue;
		const s = side1 / (side1 - side2);
		const x = x1 + (x2 - x1) * s;
		const y = y1 + (y2 - y1) * s;
		crossings.push({x, y, along: -frame.ny * x + frame.nx * y});
	}
	crossings.sort((first, second) => first.along - second.along);
	const shadows = [];
	for (let index = 0; index + 1 < crossings.length; index += 2) {
		const first = crossings[index];
		const second = crossings[index + 1];
		const shadow = segmentShadow(frame, first.x, first.y, elevation, second.x, second.y, elevation);
		if (shadow) shadows.push(shadow);
	}
	return shadows;
}

// The union of some stretches, sorted and merged.
export function unionOf(stretches) {
	if (stretches.length < 2) return stretches[0] ? [stretches[0]] : [];
	const sorted = stretches.filter(Boolean).sort((first, second) => first[0] - second[0]);
	const union = [];
	for (const [from, to] of sorted) {
		const last = union[union.length - 1];
		if (last && from <= last[1]) last[1] = Math.max(last[1], to);
		else union.push([from, to]);
	}
	return union;
}
