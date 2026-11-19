//! Shared by the raycast and the floor lighting's gathering: edge arrays (flat: startX, startY, endX, endY, outward unit normal
//! X, Y), how a barrier treats a source (thresholds, one-way barriers), distances to barriers, and roof heights.

use crate::geometry::{Plane, distance_to_segment};
use crate::store::{Barrier, BarrierDirection, Roof, SENSE_LIMITED, SENSE_NONE, SENSE_PROXIMITY};

pub const EDGE_STRIDE: usize = 6;
pub const EDGE_END_X: usize = 2;
pub const EDGE_END_Y: usize = 3;
pub const EDGE_NORMAL_X: usize = 4;
pub const EDGE_NORMAL_Y: usize = 5;

/// A ray from a source lies a hair above it (elevationBias 'above'), so heights seen from a source are lowered by this much:
/// one level with a wall's bottom meets the wall and one level with its top does not, and a source on a face is above it.
pub const ELEVATION_HAIR: f64 = 1e-7;

/// Where a ray A-B crosses a segment C-D, with which side of the ray's line each end of the segment is on (0: on it).
pub struct Crossing {
	pub t: f64,
	pub start_side: f64,
	pub end_side: f64,
}

impl Crossing {
	/// Through an end of the segment (a polygon corner).
	pub fn is_corner(&self) -> bool {
		self.start_side == 0.0 || self.end_side == 0.0
	}

	/// Through a corner only the edge whose other end is on the ray's positive side counts, so a polygon is crossed once there,
	/// and a graze is an entry and an exit or nothing.
	pub fn is_counted(&self) -> bool {
		!self.is_corner() || self.start_side + self.end_side > 0.0
	}
}

/// t along A-B, or None: foundry.utils.lineSegmentIntersection's tests (an endpoint touch crosses, a collinear pair does not).
pub fn crossing(ax: f64, ay: f64, bx: f64, by: f64, cx: f64, cy: f64, dx: f64, dy: f64) -> Option<Crossing> {
	let side_c = (ay - cy) * (bx - cx) - (ax - cx) * (by - cy);
	let side_d = (ay - dy) * (bx - dx) - (ax - dx) * (by - dy);
	if (side_c == 0.0 && side_d == 0.0) || side_c * side_d > 0.0 {
		return None;
	}
	let side_a = (cy - ay) * (dx - ax) - (cx - ax) * (dy - ay);
	let side_b = (cy - by) * (dx - bx) - (cx - bx) * (dy - by);
	if side_a * side_b > 0.0 {
		return None;
	}
	let t = ((dx - cx) * (ay - cy) - (dy - cy) * (ax - cx)) / ((dy - cy) * (bx - ax) - (dx - cx) * (by - ay));
	Some(Crossing { t, start_side: side_c, end_side: side_d })
}

/// Even-odd. A point exactly on the outline is moved a hair along the ray (nudge 1) or back (-1), then a smaller hair to the
/// ray's positive side, as the crossings settle it. (dx, dy) is the ray's horizontal direction.
pub fn is_point_inside_edges_toward(edges: &[f64], x: f64, y: f64, dx: f64, dy: f64, nudge: f64) -> bool {
	let nudge_x = nudge * dx;
	let nudge_y = nudge * dy;
	// whether a vertex at exactly y is above the point after both hairs (the positive side is (dy, -dx))
	let vertex_above_at_y = nudge_y < 0.0 || (nudge_y == 0.0 && dx > 0.0);
	let mut inside = false;
	for edge in edges.chunks_exact(EDGE_STRIDE) {
		let (start_x, start_y, end_y) = (edge[0], edge[1], edge[EDGE_END_Y]);
		let start_above = start_y > y || (start_y == y && vertex_above_at_y);
		let end_above = end_y > y || (end_y == y && vertex_above_at_y);
		if start_above == end_above {
			continue;
		}
		let edge_x = edge[EDGE_END_X] - start_x;
		let edge_y = end_y - start_y;
		let mut side = edge_x * (y - start_y) - (x - start_x) * edge_y;
		if side == 0.0 {
			side = edge_x * nudge_y - nudge_x * edge_y;
		}
		if side == 0.0 {
			side = -(edge_x * dx + edge_y * dy);
		}
		if side * edge_y > 0.0 {
			inside = !inside;
		}
	}
	inside
}

pub fn distance_to_edges(edges: &[f64], x: f64, y: f64) -> f64 {
	edges.chunks_exact(EDGE_STRIDE).map(|edge| distance_to_segment(x, y, edge[0], edge[1], edge[EDGE_END_X], edge[EDGE_END_Y])).fold(f64::INFINITY, f64::min)
}

/// Core's Edge#applyThreshold decides whether the barrier lets the source through (None: it restricts as usual). Attenuation is
/// core's (PointSourcePolygon's threshold shapes) as a sphere: the source reaches past the barrier by less the closer its origin
/// is to the threshold distance, never beyond `radius`.
pub fn threshold_reach(sense: u8, threshold: f64, attenuation: bool, distance_to_barrier: f64, radius: f64, external_radius: f64, attenuation_multiplier: f64) -> Option<f64> {
	let is_proximity = sense == SENSE_PROXIMITY;
	let source_distance = if is_proximity { (distance_to_barrier - external_radius).max(0.0) } else { distance_to_barrier + external_radius };
	let is_let_through = if is_proximity { source_distance < threshold } else { source_distance > threshold };
	if !is_let_through {
		return None;
	}
	if !attenuation {
		return Some(f64::INFINITY);
	}
	let radius_beyond_barrier = radius - distance_to_barrier;
	if !(radius_beyond_barrier > 0.0) {
		return Some(distance_to_barrier);
	}
	let threshold_proportion = source_distance / threshold;
	let proportion_inverse = if is_proximity { 1.0 - threshold_proportion } else { (threshold_proportion - 1.0).min(1.0) };
	let attenuation_factor = (proportion_inverse / (2.0 * (1.0 - proportion_inverse))) * attenuation_multiplier;
	Some(distance_to_barrier + (attenuation_factor * threshold).min(radius_beyond_barrier))
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum RestrictionKind {
	Normal,
	Limited,
}

/// How a barrier restricts what a source sees: reach is Infinity, or how far from the source an attenuated barrier starts hiding.
#[derive(Clone, Copy, Debug)]
pub struct Restriction {
	pub kind: RestrictionKind,
	pub reach: f64,
}

pub const OUTRIGHT: Restriction = Restriction { kind: RestrictionKind::Normal, reach: f64::INFINITY };

pub struct SourceSight {
	pub radius: f64,
	pub external_radius: f64,
	pub attenuation_multiplier: f64,
	/// false makes thresholds block outright, as core's useThreshold
	pub use_threshold: bool,
}

/// None when it lets the source through. distance_to_barrier is lazy because most barriers never need it.
pub fn restriction_seen_from(sense: u8, threshold: f64, attenuation: bool, distance_to_barrier: &mut impl FnMut() -> f64, sight: &SourceSight) -> Option<Restriction> {
	if sense == SENSE_NONE {
		return None;
	}
	if sight.use_threshold && threshold != 0.0 && sense >= SENSE_PROXIMITY {
		match threshold_reach(sense, threshold, attenuation, distance_to_barrier(), sight.radius, sight.external_radius, sight.attenuation_multiplier) {
			Some(reach) if reach == f64::INFINITY => return None,
			Some(reach) => return Some(Restriction { kind: RestrictionKind::Normal, reach }),
			None => {}
		}
	}
	Some(Restriction { kind: if sense == SENSE_LIMITED { RestrictionKind::Limited } else { RestrictionKind::Normal }, reach: f64::INFINITY })
}

/// One-way barriers apply by the way the source crosses them, as core does (edgeDirectionMode NORMAL).
pub fn barrier_restriction_seen_from(barriers: &[usize], pool: &[Barrier], type_index: usize, is_entering: bool, distance_to_barrier: &mut impl FnMut() -> f64, sight: &SourceSight) -> Option<Restriction> {
	let mut kind = None;
	let mut reach = f64::INFINITY;
	for &index in barriers {
		let barrier = &pool[index];
		if barrier.direction != BarrierDirection::Both && (barrier.direction == BarrierDirection::In) != is_entering {
			continue;
		}
		let Some(restriction) = restriction_seen_from(barrier.senses[type_index], barrier.thresholds[type_index], barrier.attenuation, distance_to_barrier, sight) else { continue };
		if restriction.reach != f64::INFINITY {
			reach = reach.min(restriction.reach);
		} else if restriction.kind == RestrictionKind::Normal || kind.is_none() {
			kind = Some(restriction.kind);
		}
	}
	// a barrier restricting outright wins over one that only attenuates, as for rays
	if let Some(kind) = kind {
		return Some(Restriction { kind, reach: f64::INFINITY });
	}
	(reach != f64::INFINITY).then_some(Restriction { kind: RestrictionKind::Normal, reach })
}

pub fn distance_to_wall(start: [f64; 2], end: [f64; 2], bottom: f64, top: f64, x: f64, y: f64, elevation: f64, pixels_per_unit: f64) -> f64 {
	let vertical_gap = (bottom - elevation).max(elevation - top).max(0.0) * pixels_per_unit;
	distance_to_segment(x, y, start[0], start[1], end[0], end[1]).hypot(vertical_gap)
}

/// (dx, dy) settles a point exactly on the outline (see is_point_inside_edges_toward).
pub fn distance_to_face(edges: &[f64], elevation_of_face: f64, plane: Option<Plane>, x: f64, y: f64, elevation: f64, pixels_per_unit: f64, dx: f64, dy: f64) -> f64 {
	if let Some(plane) = plane {
		return distance_to_sloped_face(edges, plane, x, y, elevation, pixels_per_unit, dx, dy);
	}
	let vertical_gap = (elevation - elevation_of_face).abs() * pixels_per_unit;
	if is_point_inside_edges_toward(edges, x, y, dx, dy, 1.0) {
		return vertical_gap;
	}
	distance_to_edges(edges, x, y).hypot(vertical_gap)
}

/// Straight to the plane when the foot of that lies within the outline, else to the nearest outline edge lifted onto the plane.
fn distance_to_sloped_face(edges: &[f64], plane: Plane, x: f64, y: f64, elevation: f64, pixels_per_unit: f64, dx: f64, dy: f64) -> f64 {
	// the plane as Z - k (a + b x + c y) = 0, its gradient (-k b, -k c, 1)
	let gradient_x = -pixels_per_unit * plane.b;
	let gradient_y = -pixels_per_unit * plane.c;
	let height_above_plane = (elevation - plane.height(x, y)) * pixels_per_unit;
	let gradient_squared = gradient_x * gradient_x + gradient_y * gradient_y + 1.0;
	let foot_x = x - (height_above_plane / gradient_squared) * gradient_x;
	let foot_y = y - (height_above_plane / gradient_squared) * gradient_y;
	if is_point_inside_edges_toward(edges, foot_x, foot_y, dx, dy, 1.0) {
		return height_above_plane.abs() / gradient_squared.sqrt();
	}
	let z = elevation * pixels_per_unit;
	let mut nearest = f64::INFINITY;
	for edge in edges.chunks_exact(EDGE_STRIDE) {
		let (start_x, start_y) = (edge[0], edge[1]);
		let start_z = plane.height(start_x, start_y) * pixels_per_unit;
		let delta_x = edge[EDGE_END_X] - start_x;
		let delta_y = edge[EDGE_END_Y] - start_y;
		let delta_z = plane.height(edge[EDGE_END_X], edge[EDGE_END_Y]) * pixels_per_unit - start_z;
		let length_squared = delta_x * delta_x + delta_y * delta_y + delta_z * delta_z;
		let along = if length_squared != 0.0 { (((x - start_x) * delta_x + (y - start_y) * delta_y + (z - start_z) * delta_z) / length_squared).clamp(0.0, 1.0) } else { 0.0 };
		let distance = (start_x + delta_x * along - x).hypot(start_y + delta_y * along - y).hypot(start_z + delta_z * along - z);
		nearest = nearest.min(distance);
	}
	nearest
}

/// One edge of a region's side (its EDGE_STRIDE f64s), standing from bottom to top, or up to its roof at the point of the edge
/// nearest in plan.
pub fn distance_to_side(edge: &[f64], bottom: f64, top: f64, roof: Option<&Roof>, x: f64, y: f64, elevation: f64, pixels_per_unit: f64) -> f64 {
	let mut top = top;
	if let Some(roof) = roof {
		let delta_x = edge[EDGE_END_X] - edge[0];
		let delta_y = edge[EDGE_END_Y] - edge[1];
		let length_squared = delta_x * delta_x + delta_y * delta_y;
		let along = if length_squared != 0.0 { (((x - edge[0]) * delta_x + (y - edge[1]) * delta_y) / length_squared).clamp(0.0, 1.0) } else { 0.0 };
		top = roof_height(roof, edge[0] + delta_x * along, edge[1] + delta_y * along);
	}
	let vertical_gap = (bottom - elevation).max(elevation - top).max(0.0) * pixels_per_unit;
	distance_to_edges(edge, x, y).hypot(vertical_gap)
}

// An off-axis direction, so the inside test's ray does not run along a grid-aligned edge.
const UNALIGNED_RAY_Y: f64 = 0.37;

/// On or beyond the outline, the nearest piece.
fn piece_at(roof: &Roof, x: f64, y: f64) -> usize {
	let is_inside = |index: usize| {
		let piece = &roof.pieces[index];
		let [min_x, min_y, max_x, max_y] = piece.bounds;
		x >= min_x && x <= max_x && y >= min_y && y <= max_y && is_point_inside_edges_toward(&piece.edges, x, y, 1.0, UNALIGNED_RAY_Y, 1.0)
	};
	let last = roof.last_piece.get();
	if last < roof.pieces.len() && is_inside(last) {
		return last;
	}
	for index in 0..roof.pieces.len() {
		if index != last && is_inside(index) {
			roof.last_piece.set(index);
			return index;
		}
	}
	let mut nearest = 0;
	let mut nearest_distance = f64::INFINITY;
	for (index, piece) in roof.pieces.iter().enumerate() {
		for path in &piece.paths {
			let count = path.len();
			for at in (0..count).step_by(2) {
				let next = (at + 2) % count;
				let distance = distance_to_segment(x, y, path[at], path[at + 1], path[next], path[next + 1]);
				if distance < nearest_distance {
					nearest = index;
					nearest_distance = distance;
				}
			}
		}
	}
	nearest
}

/// A convex roof is the lowest of its planes, never below its floor (the eave strip's height, where it has one).
pub fn roof_height(roof: &Roof, x: f64, y: f64) -> f64 {
	if !roof.is_lowest {
		return roof.pieces[piece_at(roof, x, y)].plane.height(x, y);
	}
	let height = roof.planes.iter().map(|plane| plane.height(x, y)).fold(f64::INFINITY, f64::min);
	height.max(roof.floor)
}

/// Fractions along the segment where it passes under a ridge, hip or valley line, so one face is the roof between each pair.
pub fn roof_bends(roof: &Roof, ax: f64, ay: f64, bx: f64, by: f64) -> Vec<f64> {
	if roof.is_lowest {
		// Along the segment each plane's height is a line in the fraction (its height at the start, and how much it rises by the
		// end). The roof is the lowest of them: from the one lowest at the start (the one falling fastest on a tie), walk on to the
		// first that runs under it, and so on to the end. Only a falling one can, so each step looks at every plane once.
		let lines: Vec<(f64, f64)> = roof
			.planes
			.iter()
			.map(|plane| {
				let start = plane.height(ax, ay);
				(start, plane.height(bx, by) - start)
			})
			.collect();
		let mut current = lines[0];
		for &line in &lines {
			if line.0 < current.0 || (line.0 == current.0 && line.1 < current.1) {
				current = line;
			}
		}
		let mut bends = vec![0.0];
		// where the plane that is the roof meets the floor (an eave strip's height), between `from` and `to`, the roof bends too
		let meet_floor = |line: (f64, f64), from: f64, to: f64, bends: &mut Vec<f64>| {
			if !(roof.floor > f64::NEG_INFINITY) || line.1 == 0.0 {
				return;
			}
			let crossing = (roof.floor - line.0) / line.1;
			if crossing > from + 1e-12 && crossing < to - 1e-12 {
				bends.push(crossing);
			}
		};
		let mut fraction = 0.0;
		loop {
			let mut next: Option<(f64, f64)> = None;
			let mut next_fraction = 1.0;
			for &line in &lines {
				if !(line.1 < current.1) {
					continue;
				}
				let crossing = (line.0 - current.0) / (current.1 - line.1);
				if crossing <= fraction + 1e-12 || crossing > next_fraction + 1e-12 {
					continue;
				}
				// of those crossing at one point, the one falling fastest takes over
				if next.is_none() || crossing < next_fraction - 1e-12 || line.1 < next.unwrap().1 {
					next = Some(line);
					next_fraction = crossing.min(next_fraction);
				}
			}
			match next {
				Some(line) if next_fraction < 1.0 => {
					meet_floor(current, fraction, next_fraction, &mut bends);
					bends.push(next_fraction);
					current = line;
					fraction = next_fraction;
				}
				_ => {
					meet_floor(current, fraction, 1.0, &mut bends);
					break;
				}
			}
		}
		bends.push(1.0);
		return bends;
	}
	// where it crosses a piece's outline (not running along it)
	let mut fractions = vec![0.0, 1.0];
	let (segment_x, segment_y) = (bx - ax, by - ay);
	for piece in &roof.pieces {
		for path in &piece.paths {
			let count = path.len();
			for at in (0..count).step_by(2) {
				let next = (at + 2) % count;
				let (edge_x, edge_y) = (path[next] - path[at], path[next + 1] - path[at + 1]);
				let denominator = segment_x * edge_y - segment_y * edge_x;
				if denominator.abs() < 1e-12 * segment_x.hypot(segment_y) * edge_x.hypot(edge_y) {
					continue;
				}
				let fraction = ((path[at] - ax) * edge_y - (path[at + 1] - ay) * edge_x) / denominator;
				let along_piece = ((path[at] - ax) * segment_y - (path[at + 1] - ay) * segment_x) / denominator;
				if fraction > 1e-9 && fraction < 1.0 - 1e-9 && (0.0..=1.0).contains(&along_piece) {
					fractions.push(fraction);
				}
			}
		}
	}
	fractions.sort_by(f64::total_cmp);
	fractions
}
