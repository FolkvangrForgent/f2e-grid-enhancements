//! A path is flat: [x0, y0, x1, y1, ...]; in a list of paths, outlines have a positive signed area and holes a
//! negative one.

use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::float::scale::FixedScaleFloatOverlay;
use i_overlay::float::single::SingleFloatOverlay;

pub type Path = Vec<f64>;

/// z = a + b x + c y: elevation over the plan (x, y in pixels).
#[derive(Clone, Copy, Debug)]
pub struct Plane {
	pub a: f64,
	pub b: f64,
	pub c: f64,
}

impl Plane {
	pub fn height(&self, x: f64, y: f64) -> f64 {
		self.a + self.b * x + self.c * y
	}
}

#[derive(Clone, Copy, Debug)]
pub struct Box2 {
	pub min_x: f64,
	pub min_y: f64,
	pub max_x: f64,
	pub max_y: f64,
}

pub fn signed_area(path: &[f64]) -> f64 {
	let count = path.len();
	let mut area = 0.0;
	let mut index = 0;
	while index < count {
		let next = (index + 2) % count;
		area += path[index] * path[next + 1] - path[next] * path[index + 1];
		index += 2;
	}
	area / 2.0
}

/// The same path, reversed if needed so its signed area has the sign `winding` (1 or -1).
pub fn with_winding(path: &[f64], winding: f64) -> Path {
	let area = signed_area(path);
	if area != 0.0 && area.signum() == winding {
		return path.to_vec();
	}
	let mut reversed = Vec::with_capacity(path.len());
	let mut index = path.len();
	while index >= 2 {
		index -= 2;
		reversed.push(path[index]);
		reversed.push(path[index + 1]);
	}
	reversed
}

pub fn distance_to_segment(x: f64, y: f64, sx: f64, sy: f64, ex: f64, ey: f64) -> f64 {
	let (edge_x, edge_y) = (ex - sx, ey - sy);
	let length_squared = edge_x * edge_x + edge_y * edge_y;
	let along = if length_squared > 0.0 { (((x - sx) * edge_x + (y - sy) * edge_y) / length_squared).clamp(0.0, 1.0) } else { 0.0 };
	(sx + edge_x * along - x).hypot(sy + edge_y * along - y)
}

/// The box around some flat paths, grown by `padding`.
pub fn bounding_box<'a>(paths: impl IntoIterator<Item = &'a Path>, padding: f64) -> Box2 {
	let mut bounds = Box2 { min_x: f64::INFINITY, min_y: f64::INFINITY, max_x: f64::NEG_INFINITY, max_y: f64::NEG_INFINITY };
	for path in paths {
		for point in path.as_chunks::<2>().0 {
			bounds.min_x = bounds.min_x.min(point[0]);
			bounds.max_x = bounds.max_x.max(point[0]);
			bounds.min_y = bounds.min_y.min(point[1]);
			bounds.max_y = bounds.max_y.max(point[1]);
		}
	}
	Box2 { min_x: bounds.min_x - padding, min_y: bounds.min_y - padding, max_x: bounds.max_x + padding, max_y: bounds.max_y + padding }
}

/// A circle as a flat path, with about one vertex every few pixels, as core approximates circles.
pub fn circle_path(x: f64, y: f64, radius: f64) -> Path {
	let count = ((std::f64::consts::TAU * radius / 4.0).ceil() as usize).clamp(32, 512);
	let mut path = Vec::with_capacity(count * 2);
	for index in 0..count {
		let angle = std::f64::consts::TAU * index as f64 / count as f64;
		path.push(x + radius * angle.cos());
		path.push(y + radius * angle.sin());
	}
	path
}

pub fn path_from_box(bounds: &Box2) -> Path {
	vec![bounds.min_x, bounds.min_y, bounds.max_x, bounds.min_y, bounds.max_x, bounds.max_y, bounds.min_x, bounds.max_y]
}

pub fn is_finite_path(path: &[f64]) -> bool {
	path.len() >= 6 && path.iter().all(|value| value.is_finite())
}

/// The part of a convex flat polygon where alpha x + beta y + gamma <= 0 (Sutherland-Hodgman, one side); None when less than a
/// polygon is left.
pub fn clip_to_half_plane(points: &[f64], alpha: f64, beta: f64, gamma: f64) -> Option<Path> {
	let count = points.len() / 2;
	let mut kept = Vec::with_capacity(points.len() + 4);
	for index in 0..count {
		let (x, y) = (points[index * 2], points[index * 2 + 1]);
		let next = (index + 1) % count;
		let (next_x, next_y) = (points[next * 2], points[next * 2 + 1]);
		let side = alpha * x + beta * y + gamma;
		let next_side = alpha * next_x + beta * next_y + gamma;
		if side <= 0.0 {
			kept.push(x);
			kept.push(y);
		}
		if (side < 0.0) != (next_side < 0.0) && side != 0.0 && next_side != 0.0 {
			let t = side / (side - next_side);
			kept.push(x + (next_x - x) * t);
			kept.push(y + (next_y - y) * t);
		}
	}
	if kept.len() >= 6 { Some(kept) } else { None }
}

/// A path clipped to a box (Sutherland-Hodgman), keeping its orientation, or None when nothing is left.
pub fn clip_to_box(flat: &[f64], bounds: &Box2) -> Option<Path> {
	let mut points: Vec<(f64, f64)> = flat.as_chunks::<2>().0.iter().map(|point| (point[0], point[1])).collect();
	// (axis is x, direction, bound)
	let sides = [(true, 1.0, bounds.min_x), (true, -1.0, bounds.max_x), (false, 1.0, bounds.min_y), (false, -1.0, bounds.max_y)];
	for (is_x, direction, bound) in sides {
		let value = |point: (f64, f64)| if is_x { point.0 } else { point.1 };
		let is_inside = |point: (f64, f64)| direction * (value(point) - bound) >= 0.0;
		let crossing = |from: (f64, f64), to: (f64, f64)| {
			let t = (bound - value(from)) / (value(to) - value(from));
			if is_x { (bound, from.1 + t * (to.1 - from.1)) } else { (from.0 + t * (to.0 - from.0), bound) }
		};
		let mut kept = Vec::with_capacity(points.len() + 4);
		for index in 0..points.len() {
			let current = points[index];
			let previous = points[(index + points.len() - 1) % points.len()];
			if is_inside(current) {
				if !is_inside(previous) {
					kept.push(crossing(previous, current));
				}
				kept.push(current);
			} else if is_inside(previous) {
				kept.push(crossing(previous, current));
			}
		}
		points = kept;
		if points.len() < 3 {
			return None;
		}
	}
	let result: Path = points.iter().flat_map(|&(x, y)| [x, y]).collect();
	if signed_area(&result).abs() >= 1e-3 { Some(result) } else { None }
}

/// The floor a segment shades, seen from (ox, oy): the part of each ray past it scaled from `near` to `far` times its distance,
/// clipped to `bounds`, or None.
pub fn segment_shadow(ox: f64, oy: f64, ax: f64, ay: f64, bx: f64, by: f64, near: f64, far: f64, bounds: &Box2) -> Option<Path> {
	if !(far - near > 1e-9) {
		return None;
	}
	let scale = |x: f64, y: f64, factor: f64| [ox + (x - ox) * factor, oy + (y - oy) * factor];
	let quad: Path = [scale(ax, ay, near), scale(bx, by, near), scale(bx, by, far), scale(ax, ay, far)].concat();
	if !is_finite_path(&quad) || signed_area(&quad).abs() < 1e-3 {
		return None;
	}
	clip_to_box(&with_winding(&quad, 1.0), bounds)
}

/// Directions from a point: {center, half} (radians), or None when they surround it.
#[derive(Clone, Copy, Debug)]
pub struct Directions {
	pub center: f64,
	pub half: f64,
}

pub fn directions_to(sx: f64, sy: f64, points: &[f64]) -> Option<Directions> {
	let center = (points[1] - sy).atan2(points[0] - sx);
	let (mut low, mut high) = (0.0f64, 0.0f64);
	for point in points.as_chunks::<2>().0 {
		let (dx, dy) = (point[0] - sx, point[1] - sy);
		if dx.abs() + dy.abs() < 1e-9 {
			return None;
		}
		let mut turn = dy.atan2(dx) - center;
		turn -= std::f64::consts::TAU * (turn / std::f64::consts::TAU).round();
		low = low.min(turn);
		high = high.max(turn);
	}
	if high - low >= std::f64::consts::PI - 1e-9 {
		return None;
	}
	Some(Directions { center: center + (low + high) / 2.0, half: (high - low) / 2.0 })
}

pub fn directions_meet(first: Option<Directions>, second: Option<Directions>) -> bool {
	let (Some(first), Some(second)) = (first, second) else { return true };
	let mut apart = first.center - second.center;
	apart -= std::f64::consts::TAU * (apart / std::f64::consts::TAU).round();
	apart.abs() <= first.half + second.half + 1e-9
}

/// Where the line alpha x + beta y + gamma = 0 runs inside `paths`, as segments [ax, ay, bx, by, ...].
pub fn line_inside(paths: &[Path], alpha: f64, beta: f64, gamma: f64) -> Vec<f64> {
	let length = alpha.hypot(beta);
	if length == 0.0 {
		return Vec::new();
	}
	let (ux, uy) = (-beta / length, alpha / length);
	let (ox, oy) = ((-alpha * gamma) / (length * length), (-beta * gamma) / (length * length));
	let mut crossings = Vec::new();
	for path in paths {
		let count = path.len();
		let mut index = 0;
		while index < count {
			let next = (index + 2) % count;
			let here = alpha * path[index] + beta * path[index + 1] + gamma;
			let there = alpha * path[next] + beta * path[next + 1] + gamma;
			if (here < 0.0) != (there < 0.0) {
				let t = here / (here - there);
				let (x, y) = (path[index] + (path[next] - path[index]) * t, path[index + 1] + (path[next + 1] - path[index + 1]) * t);
				crossings.push((x - ox) * ux + (y - oy) * uy);
			}
			index += 2;
		}
	}
	crossings.sort_by(|a, b| a.total_cmp(b));
	let mut segments = Vec::new();
	let mut index = 0;
	while index + 1 < crossings.len() {
		let (from, to) = (crossings[index], crossings[index + 1]);
		segments.extend_from_slice(&[ox + ux * from, oy + uy * from, ox + ux * to, oy + uy * to]);
		index += 2;
	}
	segments
}

/// The parts of `paths` where 0 <= alpha x + beta y + gamma <= limit, cut in floating point.
pub fn cut_to_slab(paths: &[Path], alpha: f64, beta: f64, gamma: f64, limit: f64) -> Vec<Path> {
	paths
		.iter()
		.filter_map(|path| clip_to_half_plane(path, -alpha, -beta, -gamma).and_then(|above| clip_to_half_plane(&above, alpha, beta, gamma - limit)))
		.collect()
}

/// Even-odd point-in-polygon over paths' edges, a point exactly on an outline moved a hair along (dx, dy), as
/// isPointInsideEdgesToward (along 1).
pub fn is_point_inside_toward(paths: &[Path], x: f64, y: f64, dx: f64, dy: f64) -> bool {
	let (nudge_x, nudge_y) = (dx, dy);
	let vertex_above_at_y = nudge_y < 0.0 || (nudge_y == 0.0 && dx > 0.0);
	let mut inside = false;
	for path in paths {
		let count = path.len();
		let mut index = 0;
		while index < count {
			let next = (index + 2) % count;
			let (start_x, start_y, end_x, end_y) = (path[index], path[index + 1], path[next], path[next + 1]);
			index += 2;
			if start_x == end_x && start_y == end_y {
				continue;
			}
			let start_above = start_y > y || (start_y == y && vertex_above_at_y);
			let end_above = end_y > y || (end_y == y && vertex_above_at_y);
			if start_above == end_above {
				continue;
			}
			let (edge_x, edge_y) = (end_x - start_x, end_y - start_y);
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
	}
	inside
}

// ---- boolean operations (i_overlay, non-zero unless said) ----

fn contours(paths: &[Path]) -> Vec<Vec<[f64; 2]>> {
	paths.iter().filter(|path| is_finite_path(path)).map(|path| path.as_chunks::<2>().0.iter().map(|point| [point[0], point[1]]).collect()).collect()
}

fn flatten(shapes: Vec<Vec<Vec<[f64; 2]>>>) -> Vec<Path> {
	let mut paths = Vec::new();
	for shape in shapes {
		for contour in shape {
			if contour.len() >= 3 {
				paths.push(contour.iter().flat_map(|point| [point[0], point[1]]).collect());
			}
		}
	}
	paths
}

fn overlay(subject: &[Path], clip: &[Path], rule: OverlayRule, fill: FillRule) -> Vec<Path> {
	let subject = contours(subject);
	let clip = contours(clip);
	if subject.is_empty() && clip.is_empty() {
		return Vec::new();
	}
	crate::profile::timed("  i_overlay boolean op", || flatten(subject.overlay(&clip, rule, fill)))
}

/// The union of some paths with every point snapped to a grid of 1 / `scale` pixels, so edges that nearly coincide (neighbouring
/// floors' lit parts, worked out apart) become one and leave no hairline between them.
pub fn union_snapped(paths: &[Path], scale: f64) -> Vec<Path> {
	let subject = contours(paths);
	if subject.is_empty() {
		return Vec::new();
	}
	let empty: Vec<Vec<[f64; 2]>> = Vec::new();
	match crate::profile::timed("  i_overlay boolean op (snapped)", || subject.overlay_with_fixed_scale(&empty, OverlayRule::Subject, FillRule::NonZero, scale)) {
		Ok(shapes) => flatten(shapes),
		Err(_) => union(paths),
	}
}

pub fn union(paths: &[Path]) -> Vec<Path> {
	overlay(paths, &[], OverlayRule::Subject, FillRule::NonZero)
}

/// The union of several areas, each read on its own (its holes cut only its own outlines). Concatenating them under one fill
/// rule instead would let a hole in one area cancel an overlapping outline of another, leaving that spot uncovered.
pub fn union_of_areas<'a>(areas: impl IntoIterator<Item = &'a [Path]>) -> Vec<Path> {
	let mut united: Vec<Path> = Vec::new();
	for area in areas {
		united = if united.is_empty() { area.to_vec() } else { overlay(&united, area, OverlayRule::Union, FillRule::NonZero) };
	}
	united
}

pub fn intersection(subject: &[Path], clip: &[Path]) -> Vec<Path> {
	if subject.is_empty() || clip.is_empty() {
		return Vec::new();
	}
	overlay(subject, clip, OverlayRule::Intersect, FillRule::NonZero)
}

pub fn difference(subject: &[Path], clip: &[Path]) -> Vec<Path> {
	if clip.is_empty() {
		return subject.to_vec();
	}
	overlay(subject, clip, OverlayRule::Difference, FillRule::NonZero)
}

/// The part of `paths` where alpha x + beta y + gamma >= 0, or the whole when alpha and beta are 0.
pub fn on_side_of(paths: &[Path], alpha: f64, beta: f64, gamma: f64) -> Vec<Path> {
	if alpha == 0.0 && beta == 0.0 {
		return if gamma >= 0.0 { paths.to_vec() } else { Vec::new() };
	}
	let bounds = bounding_box(paths.iter(), 1.0);
	let corners = path_from_box(&bounds);
	let sides: Vec<f64> = corners.as_chunks::<2>().0.iter().map(|point| alpha * point[0] + beta * point[1] + gamma).collect();
	if sides.iter().all(|&side| side >= 0.0) {
		return paths.to_vec();
	}
	if sides.iter().all(|&side| side < 0.0) {
		return Vec::new();
	}
	match clip_to_half_plane(&corners, -alpha, -beta, -gamma) {
		Some(side) => intersection(paths, &[side]),
		None => Vec::new(),
	}
}

/// Where at least two of some areas overlap, within `bounds`.
pub fn covered_twice(areas: &[Vec<Path>], bounds: &Box2) -> Vec<Path> {
	let grown_box = Box2 { min_x: bounds.min_x - 1.0, min_y: bounds.min_y - 1.0, max_x: bounds.max_x + 1.0, max_y: bounds.max_y + 1.0 };
	let mut all: Vec<Path> = areas.iter().flatten().cloned().collect();
	all.push(with_winding(&path_from_box(&grown_box), -1.0));
	overlay(&all, &[], OverlayRule::Subject, FillRule::Positive)
}

/// How far every floor's lit part is grown, in pixels, so neighbouring ones overlap (grown_direct).
pub const CUT_GROW: f64 = 0.05;

/// Paths grown by CUT_GROW directly: every corner of every outline moved out along its bisector, so each edge moves out by that
/// much (holes, wound the other way, shrink alike), a sharp corner's move limited to twice it. Nothing is united: where an edge
/// is shorter than the growth the result can overlap itself by a hair, which a later non-zero union settles.
pub fn grown_direct(paths: &[Path]) -> Vec<Path> {
	paths
		.iter()
		.filter_map(|path| {
			let count = path.len() / 2;
			if count < 3 {
				return None;
			}
			let mut normals = Vec::with_capacity(count * 2);
			for index in 0..count {
				let next = (index + 1) % count;
				let (dx, dy) = (path[next * 2] - path[index * 2], path[next * 2 + 1] - path[index * 2 + 1]);
				let length = dx.hypot(dy);
				normals.push(if length > 0.0 { dy / length } else { f64::NAN });
				normals.push(if length > 0.0 { -dx / length } else { f64::NAN });
			}
			let mut moved = Vec::with_capacity(path.len());
			for index in 0..count {
				let mut previous = (index + count - 1) % count;
				while normals[previous * 2].is_nan() && previous != index {
					previous = (previous + count - 1) % count;
				}
				let mut next = index;
				while normals[next * 2].is_nan() && next != previous {
					next = (next + 1) % count;
				}
				let (ax, ay, bx, by) = (normals[previous * 2], normals[previous * 2 + 1], normals[next * 2], normals[next * 2 + 1]);
				let (x, y) = (path[index * 2], path[index * 2 + 1]);
				if ax.is_nan() || bx.is_nan() {
					moved.extend_from_slice(&[x, y]);
					continue;
				}
				let along = 1.0 + ax * bx + ay * by;
				let (mut mx, mut my) = if along > 1e-12 { ((ax + bx) / along, (ay + by) / along) } else { (ax, ay) };
				let length = mx.hypot(my);
				if length > 2.0 {
					mx *= 2.0 / length;
					my *= 2.0 / length;
				}
				moved.extend_from_slice(&[x + mx * CUT_GROW, y + my * CUT_GROW]);
			}
			Some(moved)
		})
		.collect()
}
