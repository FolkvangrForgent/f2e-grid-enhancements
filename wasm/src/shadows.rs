//! Shadows on a ray: the stretches of a ray that a flat barrier hides from a point (a light or darkness source), worked out in
//! the plane through the point and the ray. A barrier hides a point P of the ray where it crosses the segment from the source S
//! to P; cut by that plane it is a segment, which, projected from S onto the ray, is a stretch of t. Everything is in (x, y,
//! elevation): projections keep lines and where points lie along them, so elevation needs no scaling.
//!
//! Each stretch has at each end the unit normal (pixel space, facing the ray's origin) of the surface the ray crosses there:
//! the shadow's side (the plane through the source and the barrier edge that casts it), or the barrier itself where the ray
//! passes through it. None where it has none.

use crate::geometry::Plane;

pub type Normal = Option<[f64; 3]>;

#[derive(Clone, Copy, Debug)]
pub struct Stretch {
	pub from: f64,
	pub to: f64,
	pub from_normal: Normal,
	pub to_normal: Normal,
}

/// The plane through the source (s) and the ray (from o, along d), with what projecting onto the ray needs.
pub struct Frame {
	s: [f64; 3],
	o: [f64; 3],
	d: [f64; 3],
	dd: f64,
	n: [f64; 3],
	w: [f64; 3],
	ww: f64,
	/// pixels per elevation unit, for normals
	k: f64,
}

/// None when the source is on the ray's line (it then has no plane, and nothing is hidden but along the line itself).
pub fn shadow_frame(s: [f64; 3], o: [f64; 3], d: [f64; 3], pixels_per_unit: f64) -> Option<Frame> {
	let a = [o[0] - s[0], o[1] - s[1], o[2] - s[2]];
	// the plane's normal, (O - S) × D
	let n = [a[1] * d[2] - a[2] * d[1], a[2] * d[0] - a[0] * d[2], a[0] * d[1] - a[1] * d[0]];
	let dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
	if !(n[0].hypot(n[1]).hypot(n[2]) > 1e-9 * a[0].hypot(a[1]).hypot(a[2]) * dd.sqrt()) {
		return None;
	}
	// w: the part of (O - S) across the ray, so (X - S)·w / (w·w) is 0 at S and 1 on the ray's line
	let along = (a[0] * d[0] + a[1] * d[1] + a[2] * d[2]) / dd;
	let w = [a[0] - along * d[0], a[1] - along * d[1], a[2] - along * d[2]];
	Some(Frame { s, o, d, dd, n, w, ww: w[0] * w[0] + w[1] * w[1] + w[2] * w[2], k: pixels_per_unit })
}

impl Frame {
	/// A vector (pixel space) as a unit normal facing the ray's origin; None for a zero vector.
	fn facing_origin(&self, x: f64, y: f64, z: f64) -> Normal {
		let length = x.hypot(y).hypot(z);
		if length == 0.0 {
			return None;
		}
		let scale = (if x * self.d[0] + y * self.d[1] + z * self.d[2] * self.k > 0.0 { -1.0 } else { 1.0 }) / length;
		Some([x * scale, y * scale, z * scale])
	}

	/// The normal of a shadow's side: the plane through the source and a barrier edge, at a point q of the edge, along e (both in
	/// x, y, elevation). It contains q - S and e, so its normal is their cross product, taken in pixel space.
	fn side_normal(&self, q: [f64; 3], edge: [f64; 3]) -> Normal {
		let a = [q[0] - self.s[0], q[1] - self.s[1], (q[2] - self.s[2]) * self.k];
		let bz = edge[2] * self.k;
		self.facing_origin(a[1] * bz - a[2] * edge[1], a[2] * edge[0] - a[0] * bz, a[0] * edge[1] - a[1] * edge[0])
	}

	/// How far a point of the plane is from S toward the ray's line: 0 at S, 1 on the line.
	fn across(&self, p: [f64; 3]) -> f64 {
		(self.w[0] * (p[0] - self.s[0]) + self.w[1] * (p[1] - self.s[1]) + self.w[2] * (p[2] - self.s[2])) / self.ww
	}

	/// The ray's t where the line from S through a point of the plane (at `across_ray` from S) meets the ray.
	fn projected_t(&self, p: [f64; 3], across_ray: f64) -> f64 {
		let px = self.s[0] + (p[0] - self.s[0]) / across_ray - self.o[0];
		let py = self.s[1] + (p[1] - self.s[1]) / across_ray - self.o[1];
		let pz = self.s[2] + (p[2] - self.s[2]) / across_ray - self.o[2];
		(px * self.d[0] + py * self.d[1] + pz * self.d[2]) / self.dd
	}

	/// The stretch of t a segment of the plane (between q1 and q2) hides, or None: only its part strictly between S and the ray's
	/// line hides anything. q1 and q2 lie on barrier edges along edge1 and edge2; `surface` is the barrier's normal (pixel space),
	/// for an end cut where the segment meets the ray's line (the ray passing through the barrier).
	fn segment_shadow(&self, q1: [f64; 3], edge1: [f64; 3], q2: [f64; 3], edge2: [f64; 3], surface: [f64; 3]) -> Option<Stretch> {
		let across1 = self.across(q1);
		let across2 = self.across(q2);
		// a hair in from S and from the ray's line, so a segment lying along the line (rounded either way) hides nothing
		let (low, high) = (1e-9, 1.0 - 1e-9);
		let (mut from_s, mut to_s) = (0.0, 1.0);
		if across1 == across2 {
			if !(across1 > low && across1 < high) {
				return None;
			}
		} else {
			let at_low = (low - across1) / (across2 - across1);
			let at_high = (high - across1) / (across2 - across1);
			from_s = at_low.min(at_high).max(0.0);
			to_s = at_low.max(at_high).min(1.0);
			if !(from_s < to_s) {
				return None;
			}
		}
		let lerp = |s: f64| [q1[0] + (q2[0] - q1[0]) * s, q1[1] + (q2[1] - q1[1]) * s, q1[2] + (q2[2] - q1[2]) * s];
		let a = lerp(from_s);
		let b = lerp(to_s);
		let t1 = self.projected_t(a, self.across(a));
		let t2 = self.projected_t(b, self.across(b));
		let surface_normal = || self.facing_origin(surface[0], surface[1], surface[2]);
		let normal1 = if from_s > 0.0 { surface_normal() } else { self.side_normal(a, edge1) };
		let normal2 = if to_s < 1.0 { surface_normal() } else { self.side_normal(b, edge2) };
		Some(if t1 < t2 { Stretch { from: t1, to: t2, from_normal: normal1, to_normal: normal2 } } else { Stretch { from: t2, to: t1, from_normal: normal2, to_normal: normal1 } })
	}

	/// The stretch of t a vertical quad hides: from a to b in plan, between bottom and top at a and bottom_b and top_b at b (finite).
	pub fn quad_shadow(&self, ax: f64, ay: f64, bx: f64, by: f64, bottom: f64, top: f64, bottom_b: f64, top_b: f64) -> Option<Stretch> {
		// a convex quad meets the plane in one segment, between the two of its edges that cross it; its corners go around bottom A,
		// bottom B, top B, top A (a sloped region's side has its own bottom and top at B)
		let base_a = self.n[0] * (ax - self.s[0]) + self.n[1] * (ay - self.s[1]);
		let base_b = self.n[0] * (bx - self.s[0]) + self.n[1] * (by - self.s[1]);
		let xs = [ax, bx, bx, ax];
		let ys = [ay, by, by, ay];
		let zs = [bottom, bottom_b, top_b, top];
		// each side's direction: bottom, B's upright, top, A's upright
		let upright = [0.0, 0.0, 1.0];
		let side_edges = [[bx - ax, by - ay, bottom_b - bottom], upright, [bx - ax, by - ay, top_b - top], upright];
		let sides = [base_a + self.n[2] * (bottom - self.s[2]), base_b + self.n[2] * (bottom_b - self.s[2]), base_b + self.n[2] * (top_b - self.s[2]), base_a + self.n[2] * (top - self.s[2])];
		let mut found: Vec<([f64; 3], [f64; 3])> = Vec::with_capacity(4);
		for index in 0..4 {
			let next = (index + 1) & 3;
			let (side1, side2) = (sides[index], sides[next]);
			if side1 == 0.0 && side2 == 0.0 {
				return None;
			}
			let s = if side1 == 0.0 {
				0.0
			} else if (side1 < 0.0) != (side2 < 0.0) && side2 != 0.0 {
				side1 / (side1 - side2)
			} else {
				continue;
			};
			let point = [xs[index] + (xs[next] - xs[index]) * s, ys[index] + (ys[next] - ys[index]) * s, zs[index] + (zs[next] - zs[index]) * s];
			found.push((point, side_edges[index]));
		}
		if found.len() < 2 {
			return None;
		}
		// the first and the last crossing found are the segment's ends
		let (q1, edge1) = found[0];
		let (q2, edge2) = found[found.len() - 1];
		self.segment_shadow(q1, edge1, q2, edge2, [by - ay, ax - bx, 0.0])
	}

	/// The stretches of t a horizontal or sloped polygon hides: its outlines' edges (flat, `stride` f64s each, with the end at
	/// end_x and end_y), holes included (even-odd).
	pub fn face_shadows(&self, edges: &[f64], stride: usize, end_x: usize, end_y: usize, elevation: f64, plane: Option<Plane>) -> Vec<Stretch> {
		// The plane meets the face's plane in a line of the plan: nx (x - sx) + ny (y - sy) + c = 0. A sloped face, z = a + b x + c y,
		// tilts that line: its height substituted in, the line is (nx + nz b) (x - sx) + (ny + nz c) (y - sy) + nz (z(S) - sz).
		let slope_x = plane.map_or(0.0, |plane| plane.b);
		let slope_y = plane.map_or(0.0, |plane| plane.c);
		let height_at = |x: f64, y: f64| plane.map_or(elevation, |plane| plane.height(x, y));
		let nx = self.n[0] + self.n[2] * slope_x;
		let ny = self.n[1] + self.n[2] * slope_y;
		let c = self.n[2] * (height_at(self.s[0], self.s[1]) - self.s[2]);
		if !(nx.hypot(ny) > 0.0) {
			return Vec::new();
		}
		// along that line, by (-ny, nx)
		let mut crossings: Vec<(f64, f64, f64, [f64; 3])> = Vec::new();
		for edge in edges.chunks_exact(stride) {
			let (x1, y1, x2, y2) = (edge[0], edge[1], edge[end_x], edge[end_y]);
			let side1 = nx * (x1 - self.s[0]) + ny * (y1 - self.s[1]) + c;
			let side2 = nx * (x2 - self.s[0]) + ny * (y2 - self.s[1]) + c;
			// half-open, so a vertex on the line counts once
			if (side1 < 0.0) == (side2 < 0.0) {
				continue;
			}
			let s = side1 / (side1 - side2);
			let x = x1 + (x2 - x1) * s;
			let y = y1 + (y2 - y1) * s;
			crossings.push((x, y, -ny * x + nx * y, [x2 - x1, y2 - y1, slope_x * (x2 - x1) + slope_y * (y2 - y1)]));
		}
		// the face's own normal (pixel space), for an end where the ray passes through it
		let surface = if plane.is_some() { [-slope_x * self.k, -slope_y * self.k, 1.0] } else { [0.0, 0.0, 1.0] };
		crossings.sort_by(|first, second| first.2.total_cmp(&second.2));
		let mut shadows = Vec::new();
		for pair in crossings.chunks_exact(2) {
			let (first, second) = (pair[0], pair[1]);
			let q1 = [first.0, first.1, height_at(first.0, first.1)];
			let q2 = [second.0, second.1, height_at(second.0, second.1)];
			if let Some(shadow) = self.segment_shadow(q1, first.3, q2, second.3, surface) {
				shadows.push(shadow);
			}
		}
		shadows
	}
}

/// The source and a stretch of the ray seen from above: anything that hides part of the stretch from the source is within it.
pub struct Triangle {
	pub x0: f64,
	pub y0: f64,
	pub x1: f64,
	pub y1: f64,
	pub x2: f64,
	pub y2: f64,
}

/// Whether a segment of the plan can be in the triangle. True for a triangle too thin to test.
pub fn segment_meets_triangle(ax: f64, ay: f64, bx: f64, by: f64, triangle: &Triangle) -> bool {
	let Triangle { x0, y0, x1, y1, x2, y2 } = *triangle;
	let area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
	if !(area.abs() > 1e-6 * ((x1 - x0).powi(2) + (y1 - y0).powi(2) + (x2 - x0).powi(2) + (y2 - y0).powi(2))) {
		return true;
	}
	let orient = |px: f64, py: f64, qx: f64, qy: f64, rx: f64, ry: f64| (qx - px) * (ry - py) - (qy - py) * (rx - px);
	let is_inside = |px: f64, py: f64| {
		let d0 = orient(x0, y0, x1, y1, px, py);
		let d1 = orient(x1, y1, x2, y2, px, py);
		let d2 = orient(x2, y2, x0, y0, px, py);
		(d0 >= 0.0 && d1 >= 0.0 && d2 >= 0.0) || (d0 <= 0.0 && d1 <= 0.0 && d2 <= 0.0)
	};
	if is_inside(ax, ay) || is_inside(bx, by) {
		return true;
	}
	let crosses = |px: f64, py: f64, qx: f64, qy: f64| {
		let o1 = orient(ax, ay, bx, by, px, py);
		let o2 = orient(ax, ay, bx, by, qx, qy);
		let o3 = orient(px, py, qx, qy, ax, ay);
		let o4 = orient(px, py, qx, qy, bx, by);
		(o1 <= 0.0) != (o2 <= 0.0) && (o3 <= 0.0) != (o4 <= 0.0)
	};
	crosses(x0, y0, x1, y1) || crosses(x1, y1, x2, y2) || crosses(x2, y2, x0, y0)
}

/// The union of some stretches, sorted and merged; each end keeps the normal of the stretch it comes from.
pub fn union_of(mut stretches: Vec<Stretch>) -> Vec<Stretch> {
	stretches.sort_by(|first, second| first.from.total_cmp(&second.from));
	let mut union: Vec<Stretch> = Vec::with_capacity(stretches.len());
	for stretch in stretches {
		match union.last_mut() {
			Some(last) if !(stretch.from > last.to) => {
				if stretch.to > last.to {
					last.to = stretch.to;
					last.to_normal = stretch.to_normal;
				}
			}
			_ => union.push(stretch),
		}
	}
	union
}

// Where each stretch starts and ends, and the normal of the surface at each end (facing the ray's origin). Expected normals
// are worked out by hand: a shadow side is the plane through the source and the barrier edge casting it.
#[cfg(test)]
mod tests {
	use super::*;

	fn assert_close(actual: f64, expected: f64, what: &str) {
		assert!((actual - expected).abs() < 1e-3, "{what}: {actual} is not {expected}");
	}

	fn assert_normal(actual: Normal, expected: [f64; 3], what: &str) {
		let actual = actual.unwrap_or_else(|| panic!("{what}: no normal"));
		let length = expected[0].hypot(expected[1]).hypot(expected[2]);
		for axis in 0..3 {
			assert_close(actual[axis], expected[axis] / length, what);
		}
	}

	fn assert_stretch(stretch: Option<Stretch>, from: f64, to: f64, from_normal: [f64; 3], to_normal: [f64; 3]) {
		let stretch = stretch.expect("a shadow");
		assert_close(stretch.from, from, "from t");
		assert_close(stretch.to, to, "to t");
		assert_normal(stretch.from_normal, from_normal, "from normal");
		assert_normal(stretch.to_normal, to_normal, "to normal");
	}

	#[test]
	fn a_tall_walls_shadow_on_a_ray_beside_it_ends_on_the_planes_through_the_source_and_the_walls_ends() {
		// source at the origin; ray along x = 10 from y = -5 to y = 5; wall at x = 5 from y = -1 to 1
		let frame = shadow_frame([0.0, 0.0, 0.0], [10.0, -5.0, 0.0], [0.0, 10.0, 0.0], 1.0).unwrap();
		assert_stretch(frame.quad_shadow(5.0, -1.0, 5.0, 1.0, -100.0, 100.0, -100.0, 100.0), 0.3, 0.7, [-1.0, -5.0, 0.0], [1.0, -5.0, 0.0]);
	}

	#[test]
	fn where_the_ray_passes_through_the_wall_the_shadow_starts_at_the_wall_itself() {
		// source (3, -10); ray along x = 5 from y = -5 to 5 crosses the wall y = 0 (x 4 to 6) halfway; beyond, the shadow's far
		// side is the plane through the source and the wall's end at (4, 0)
		let frame = shadow_frame([3.0, -10.0, 0.0], [5.0, -5.0, 0.0], [0.0, 10.0, 0.0], 1.0).unwrap();
		assert_stretch(frame.quad_shadow(4.0, 0.0, 6.0, 0.0, -100.0, 100.0, -100.0, 100.0), 0.5, 1.5, [0.0, -1.0, 0.0], [10.0, -1.0, 0.0]);
	}

	#[test]
	fn a_ray_over_a_short_wall_is_not_in_its_shadow() {
		let frame = shadow_frame([0.0, 0.0, 0.0], [10.0, -5.0, 4.0], [0.0, 10.0, 0.0], 1.0).unwrap();
		assert!(frame.quad_shadow(5.0, -1.0, 5.0, 1.0, -100.0, 1.0, -100.0, 1.0).is_none());
	}

	#[test]
	fn below_a_walls_top_the_shadow_side_is_the_plane_through_the_source_and_the_top_edge() {
		// source (0, 0, 10); ray straight down at (10, 0) from elevation 20; wall at x = 5 with its top at 0
		let frame = shadow_frame([0.0, 0.0, 10.0], [10.0, 0.0, 20.0], [0.0, 0.0, -40.0], 1.0).unwrap();
		let stretch = frame.quad_shadow(5.0, -1.0, 5.0, 1.0, -1000.0, 0.0, -1000.0, 0.0).expect("a shadow");
		assert_close(stretch.from, 0.75, "from t");
		assert_normal(stretch.from_normal, [10.0, 0.0, 5.0], "from normal");
	}

	#[test]
	fn a_region_faces_shadow_ends_on_the_planes_through_the_source_and_the_faces_outline() {
		// square face 0..10 at elevation 0; source above its middle at 10; ray along y = 5 at elevation -10 from x = -10 to 20
		let edges = [0.0, 0.0, 10.0, 0.0, 0.0, -1.0, 10.0, 0.0, 10.0, 10.0, 1.0, 0.0, 10.0, 10.0, 0.0, 10.0, 0.0, 1.0, 0.0, 10.0, 0.0, 0.0, -1.0, 0.0];
		let frame = shadow_frame([5.0, 5.0, 10.0], [-10.0, 5.0, -10.0], [30.0, 0.0, 0.0], 1.0).unwrap();
		let shadows = frame.face_shadows(&edges, 6, 2, 3, 0.0, None);
		assert_stretch(shadows.first().copied(), 1.0 / 6.0, 5.0 / 6.0, [-2.0, 0.0, 1.0], [-2.0, 0.0, -1.0]);
	}

	#[test]
	fn a_pixel_space_source_scales_elevation_by_the_grids_pixels_per_unit() {
		// the first case with elevation in units of 20 pixels: a flat scene behaves the same
		let frame = shadow_frame([0.0, 0.0, 0.0], [10.0, -5.0, 0.0], [0.0, 10.0, 0.0], 20.0).unwrap();
		assert_stretch(frame.quad_shadow(5.0, -1.0, 5.0, 1.0, -100.0, 100.0, -100.0, 100.0), 0.3, 0.7, [-1.0, -5.0, 0.0], [1.0, -5.0, 0.0]);
	}

	#[test]
	fn overlapping_shadows_join_keeping_the_normal_of_whichever_supplies_each_end() {
		let label = |value: f64| Some([value, 0.0, 0.0]);
		let stretch = |from: f64, to: f64, from_label: f64, to_label: f64| Stretch { from, to, from_normal: label(from_label), to_normal: label(to_label) };
		let union = union_of(vec![stretch(0.5, 0.7, 1.0, 2.0), stretch(0.1, 0.6, 3.0, 4.0), stretch(0.8, 0.9, 5.0, 6.0)]);
		assert_eq!(union.len(), 2);
		assert_eq!((union[0].from, union[0].to, union[0].from_normal, union[0].to_normal), (0.1, 0.7, label(3.0), label(2.0)));
		assert_eq!((union[1].from, union[1].to, union[1].from_normal, union[1].to_normal), (0.8, 0.9, label(5.0), label(6.0)));
	}
}
