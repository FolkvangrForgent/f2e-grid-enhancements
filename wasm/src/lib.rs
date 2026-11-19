//! The barrier visualizer's floor lighting. JavaScript (scripts/perception/floors.js) gathers the floors (where each is shown) and the barriers seen from the source, writes
//! them into the input buffer (see `Reader` for the layout; scripts/perception/floors.js writes it), and reads the
//! lit paths back from the output buffer.

// `!(a > b)` also holds when a value is NaN; and the geometry helpers take many numbers
#![allow(clippy::neg_cmp_op_on_partial_ord, clippy::too_many_arguments)]

// talc's allocator for single-threaded WebAssembly (each worker has its own module, so its own heap)
#[cfg(all(target_family = "wasm", not(target_feature = "atomics")))]
#[global_allocator]
static ALLOCATOR: talc::wasm::WasmDynamicTalc = talc::wasm::new_wasm_dynamic_allocator();

pub mod bvh;
pub mod gather;
pub mod geometry;
pub mod profile;
pub mod raycast;
pub mod reader;
pub mod rules;
pub mod shadows;
pub mod sources;
pub mod store;
mod visibility;

use geometry::*;
use std::cell::RefCell;
use std::collections::HashMap;
use profile::timed;
use reader::Reader;
use store::{INPUT, OUTPUT};
use visibility::{Polygons, visibility_polygons};

/// A ray from a source lies a hair above it (spatial/rules.js ELEVATION_HAIR).
const HAIR: f64 = 1e-7;
/// How near a barrier is taken to be at the nearest (pixels), for how far its shadow must reach.
const NEAREST: f64 = 1e-3;
/// How far each strip of the base floor reaches into its neighbours, in pixels (light_task).
const STRIP_OVERLAP: f64 = 0.1;
/// The grid the united lit area is snapped to: a quarter of a pixel (see lit_floors_part's final union).
pub const SNAP_SCALE: f64 = 4.0;

struct Vertical {
	ax: f64,
	ay: f64,
	bx: f64,
	by: f64,
	bottom: f64,
	top: f64,
	bottom_b: f64,
	top_b: f64,
	limited: bool,
	document: f64,
	/// how far from the source an attenuated barrier lets it through (pixels); infinite when it restricts outright
	reach: f64,
}

struct Horizontal {
	limited: bool,
	document: f64,
	reach: f64,
	/// a sloped face's plane, lowered a hair (rules.js barriersSeenFrom); None for a flat face
	plane: Option<Plane>,
	/// a flat face's elevation, lowered a hair
	elevation: f64,
	/// its primitive's box in the scene index
	bounds: Box2,
	/// a sloped face's paths, or a flat face's region area
	paths: Vec<Path>,
}

/// A floor at or below the source (flat ones by height, each roof face on its own), with where it is a floor.
struct Floor {
	plane: Plane,
	area: Vec<Path>,
	bounds: Box2,
	/// a roof face's region, or -1 for a flat floor (the faces of one roof never overlap)
	document: f64,
	/// whether it is lit (a roof not shown, or seen only through its own face that blocks the source, is not)
	is_lit: bool,
	/// the region whose faces and sides are passed over (a convex roof's face seen from above its plane), or -1
	own_solid: f64,
}

// The floor lighting's input buffer (read with reader::Reader), laid out as flat f64s:
// - sx, sy, sz, box minX, minY, maxX, maxY, farthest, pixels per grid unit
// - vertical count, then each: ax, ay, bx, by, bottom, top, bottomB, topB, limited (0 / 1), document, reach
// - horizontal count, then each: limited, document, reach, sloped (0 / 1), a, b, c, elevation, bounds minX, minY, maxX, maxY, paths
// - base elevation
// - flat floor count, then each: height, the paths of its regions' areas (united here)
// - roof face count, then each: a, b, c, document, lit (0 / 1), convex solid (0 / 1), paths
//
// Paths are a count, then each path's point count and its coordinates.
struct Scene {
	sx: f64,
	sy: f64,
	sz: f64,
	bounds: Box2,
	farthest: f64,
	pixels_per_unit: f64,
	verticals: Vec<Vertical>,
	horizontals: Vec<Horizontal>,
	// directions from the source, worked out once for all floors
	vertical_directions: RefCell<Vec<Option<Option<Directions>>>>,
	horizontal_directions: RefCell<Vec<Option<Option<Directions>>>>,
	// visibility polygons by the segments they are made of
	polygons: RefCell<HashMap<Vec<u64>, std::rc::Rc<Polygons>>>,
}

impl Scene {
	fn vertical_directions(&self, index: usize) -> Option<Directions> {
		*self.vertical_directions.borrow_mut()[index].get_or_insert_with(|| {
			let vertical = &self.verticals[index];
			directions_to(self.sx, self.sy, &[vertical.ax, vertical.ay, vertical.bx, vertical.by])
		})
	}

	fn horizontal_directions(&self, index: usize) -> Option<Directions> {
		*self.horizontal_directions.borrow_mut()[index].get_or_insert_with(|| {
			let corners = path_from_box(&bounding_box(self.horizontals[index].paths.iter(), 0.0));
			directions_to(self.sx, self.sy, &corners)
		})
	}
}

enum Kind {
	Normal,
	Limited,
}

/// The area where a sphere about the source (radius `reach`, pixels) meets the plane z = a + b x + c y, as a path (an ellipse; a
/// circle on a flat floor), or None where it misses the plane. `drop` is the source's height above the plane.
fn reach_on_plane(sx: f64, sy: f64, drop: f64, plane: Plane, pixels_per_unit: f64, reach: f64) -> Option<Path> {
	let slope = plane.b.hypot(plane.c) * pixels_per_unit;
	let squared = reach * reach - (drop * pixels_per_unit).powi(2) / (1.0 + slope * slope);
	if !(squared > 0.0) {
		return None;
	}
	let across = squared.sqrt();
	let along = across / (1.0 + slope * slope).sqrt();
	if slope == 0.0 {
		return Some(circle_path(sx, sy, across));
	}
	let length = plane.b.hypot(plane.c);
	let (ux, uy) = (plane.b / length, plane.c / length);
	let shift = (pixels_per_unit * slope * drop) / (1.0 + slope * slope);
	let (cx, cy) = (sx + ux * shift, sy + uy * shift);
	let count = ((std::f64::consts::TAU * across / 4.0).ceil() as usize).clamp(32, 512);
	let mut path = Vec::with_capacity(count * 2);
	for index in 0..count {
		let angle = std::f64::consts::TAU * index as f64 / count as f64;
		let (u, v) = (along * angle.cos(), across * angle.sin());
		path.push(cx + ux * u - uy * v);
		path.push(cy + uy * u + ux * v);
	}
	Some(path)
}

/// The lit part of a floor where it is shown.
fn lit_on(scene: &Scene, plane: Plane, shown: &[Path], own_solid: f64) -> Vec<Path> {
	let (sx, sy, sz, bounds, farthest, pixels_per_unit) = (scene.sx, scene.sy, scene.sz, scene.bounds, scene.farthest, scene.pixels_per_unit);
	let shown_box = bounding_box(shown.iter(), 1.0);
	let is_flat = plane.b == 0.0 && plane.c == 0.0;
	let shown_reach = ((shown_box.min_x - sx).abs().max((shown_box.max_x - sx).abs())).hypot((shown_box.min_y - sy).abs().max((shown_box.max_y - sy).abs()));
	let shown_directions = if is_flat { None } else { directions_to(sx, sy, &path_from_box(&shown_box)) };
	let between = Box2 { min_x: sx.min(shown_box.min_x), min_y: sy.min(shown_box.min_y), max_x: sx.max(shown_box.max_x), max_y: sy.max(shown_box.max_y) };
	let box_overlaps = |o: &Box2| !(o.max_x < between.min_x || o.min_x > between.max_x || o.max_y < between.min_y || o.min_y > between.max_y);
	let floor_height = plane.a;
	let drop = sz - plane.height(sx, sy);
	let is_eye_level = drop.abs() <= HAIR;
	let side = if drop < 0.0 { -1.0 } else { 1.0 };
	let depth = drop.abs();
	let factor_at = |z: f64| drop / (sz - z);
	// an attenuated barrier lets the source through within its reach: a sphere, which meets this floor in a circle
	let reach_on_floor = |reach: f64| (reach * reach - (drop * pixels_per_unit).powi(2)).max(0.0).sqrt();

	// Hole-free shadows (walls' quads) are safe to concatenate; one with holes (a floor's scaled region) is united on its own,
	// or a hole of it would cancel another shadow overlapping it.
	let mut normal: Vec<Path> = Vec::new();
	let mut normal_with_holes: Vec<Vec<Path>> = Vec::new();
	let mut limited: Vec<Vec<Path>> = Vec::new();
	let mut normal_segments: Vec<f64> = Vec::new();
	let mut limited_segments: Vec<f64> = Vec::new();
	// and of attenuated ones, which only hide beyond their reach on this floor: [ax, ay, bx, by, reach, ...]
	let mut attenuated_segments: Vec<f64> = Vec::new();
	let mut pending: Vec<(Vec<Path>, Kind, f64)> = Vec::new();
	let add_shadow = |pending: &mut Vec<(Vec<Path>, Kind, f64)>, paths: Vec<Option<Path>>, kind: Kind, reach: f64| {
		let shadow: Vec<Path> = paths.into_iter().flatten().collect();
		if !shadow.is_empty() {
			pending.push((shadow, kind, reach));
		}
	};
	let kind_of = |is_limited: bool| if is_limited { Kind::Limited } else { Kind::Normal };

	for (index, vertical) in scene.verticals.iter().enumerate() {
		if vertical.document == own_solid {
			continue;
		}
		if !box_overlaps(&Box2 { min_x: vertical.ax.min(vertical.bx), min_y: vertical.ay.min(vertical.by), max_x: vertical.ax.max(vertical.bx), max_y: vertical.ay.max(vertical.by) }) {
			continue;
		}
		let (ax, ay, bx, by) = (vertical.ax, vertical.ay, vertical.bx, vertical.by);
		let segments_of: &mut Vec<f64> = if vertical.limited { &mut limited_segments } else { &mut normal_segments };
		let is_sloped = !is_flat || vertical.bottom_b != vertical.bottom || vertical.top_b != vertical.top;
		if is_sloped {
			let distance = distance_to_segment(sx, sy, ax, ay, bx, by);
			if distance > shown_reach {
				continue;
			}
			let toward = if is_eye_level { 1.0 } else { side };
			let (height_at_a, height_at_b) = (plane.height(ax, ay), plane.height(bx, by));
			let bottom_at_a = toward * (vertical.bottom - HAIR - height_at_a);
			let top_at_a = toward * (vertical.top - HAIR - height_at_a);
			let bottom_at_b = toward * (vertical.bottom_b - HAIR - height_at_b);
			let top_at_b = toward * (vertical.top_b - HAIR - height_at_b);
			let ends = [bottom_at_a, top_at_a, bottom_at_b, top_at_b];
			if !is_eye_level && (ends.iter().cloned().fold(f64::NEG_INFINITY, f64::max) <= 0.0 || ends.iter().cloned().fold(f64::INFINITY, f64::min) >= depth) {
				continue;
			}
			if !directions_meet(shown_directions, scene.vertical_directions(index)) {
				continue;
			}
			let max_factor = farthest / distance.max(NEAREST);
			if is_eye_level {
				let (mut from, mut to) = (0.0f64, 1.0f64);
				let mut keep = |at_a: f64, at_b: f64, is_below: bool| {
					let (start_ok, end_ok) = if is_below { (at_a <= drop, at_b <= drop) } else { (at_a > drop, at_b > drop) };
					if start_ok && end_ok {
						return;
					}
					if !start_ok && !end_ok {
						from = 1.0;
						to = 0.0;
						return;
					}
					let crossing = if at_a.is_finite() && at_b.is_finite() {
						(drop - at_a) / (at_b - at_a)
					} else if start_ok {
						1.0
					} else {
						0.0
					};
					if start_ok { to = to.min(crossing) } else { from = from.max(crossing) }
				};
				keep(bottom_at_a, bottom_at_b, true);
				keep(top_at_a, top_at_b, false);
				if !(to > from) {
					continue;
				}
				let (from_x, from_y, to_x, to_y) = (ax + (bx - ax) * from, ay + (by - ay) * from, ax + (bx - ax) * to, ay + (by - ay) * to);
				if vertical.reach.is_infinite() {
					segments_of.extend_from_slice(&[from_x, from_y, to_x, to_y]);
				} else {
					add_shadow(&mut pending, vec![segment_shadow(sx, sy, from_x, from_y, to_x, to_y, 1.0, max_factor, &bounds)], kind_of(vertical.limited), vertical.reach);
				}
				continue;
			}
			let far_d = depth * (1.0 - 1.0 / max_factor);
			let (mut below, mut beyond) = (-2.0f64, far_d + 2.0);
			for d in ends {
				if !d.is_finite() {
					continue;
				}
				below = below.min(d - 1.0);
				beyond = beyond.max(d + 1.0);
			}
			let clamp = |d: f64| if d.is_finite() { d } else if d > 0.0 { beyond } else { below };
			let mut corners = vec![0.0, clamp(bottom_at_a), 1.0, clamp(bottom_at_b), 1.0, clamp(top_at_b), 0.0, clamp(top_at_a)];
			let mut cut_away = false;
			for (bound, sign) in [(0.0, 1.0), (far_d, -1.0)] {
				let mut kept = Vec::with_capacity(corners.len() + 4);
				let count = corners.len();
				let mut index = 0;
				while index < count {
					let next = (index + 2) % count;
					let (s, d, next_s, next_d) = (corners[index], corners[index + 1], corners[next], corners[next + 1]);
					let inside = sign * (d - bound) >= 0.0;
					if inside {
						kept.push(s);
						kept.push(d);
					}
					if inside != (sign * (next_d - bound) >= 0.0) {
						kept.push(s + ((next_s - s) * (bound - d)) / (next_d - d));
						kept.push(bound);
					}
					index += 2;
				}
				corners = kept;
				if corners.len() < 6 {
					cut_away = true;
					break;
				}
			}
			if cut_away {
				continue;
			}
			let mut projected = Vec::with_capacity(corners.len());
			for corner in corners.as_chunks::<2>().0 {
				let (s, d) = (corner[0], corner[1]);
				let factor = depth / (depth - d);
				projected.push(sx + (ax + (bx - ax) * s - sx) * factor);
				projected.push(sy + (ay + (by - ay) * s - sy) * factor);
			}
			if bottom_at_a.max(top_at_a) >= depth && bottom_at_b.max(top_at_b) >= depth && vertical.reach.is_infinite() {
				// its near side: the edges not at the far bound nor along its ends
				let count = corners.len();
				let mut index = 0;
				while index < count {
					let next = (index + 2) % count;
					let (s, d, next_s, next_d) = (corners[index], corners[index + 1], corners[next], corners[next + 1]);
					if !((d == far_d && next_d == far_d) || (s == next_s && (s == 0.0 || s == 1.0))) {
						segments_of.extend_from_slice(&[projected[index], projected[index + 1], projected[next], projected[next + 1]]);
					}
					index += 2;
				}
				continue;
			}
			let projected_box = bounding_box([&projected], 0.0);
			if projected_box.max_x < shown_box.min_x || projected_box.min_x > shown_box.max_x || projected_box.max_y < shown_box.min_y || projected_box.min_y > shown_box.max_y {
				continue;
			}
			add_shadow(&mut pending, vec![clip_to_box(&with_winding(&projected, 1.0), &bounds)], kind_of(vertical.limited), vertical.reach);
		} else {
			let (bottom, top) = (vertical.bottom - HAIR, vertical.top - HAIR);
			let max_factor = farthest / distance_to_segment(sx, sy, ax, ay, bx, by).max(NEAREST);
			let (near, far);
			if is_eye_level {
				if !(bottom <= sz && top > sz) {
					continue;
				}
				near = 1.0;
				far = f64::INFINITY;
			} else {
				let (low, high) = (bottom.max(floor_height), top.min(sz));
				if !(high > low) {
					continue;
				}
				near = if bottom <= floor_height { 1.0 } else { factor_at(low) };
				far = if top >= sz { f64::INFINITY } else { factor_at(high) };
			}
			if !(near < max_factor) {
				continue;
			}
			if far == f64::INFINITY {
				let segment = [sx + (ax - sx) * near, sy + (ay - sy) * near, sx + (bx - sx) * near, sy + (by - sy) * near];
				if vertical.reach.is_infinite() {
					segments_of.extend_from_slice(&segment);
				} else {
					attenuated_segments.extend_from_slice(&segment);
					attenuated_segments.push(reach_on_floor(vertical.reach));
				}
				continue;
			}
			let reach = far.min(max_factor);
			let xs = [sx + (ax - sx) * near, sx + (bx - sx) * near, sx + (ax - sx) * reach, sx + (bx - sx) * reach];
			let ys = [sy + (ay - sy) * near, sy + (by - sy) * near, sy + (ay - sy) * reach, sy + (by - sy) * reach];
			let (min_x, max_x) = (xs.iter().cloned().fold(f64::INFINITY, f64::min), xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max));
			let (min_y, max_y) = (ys.iter().cloned().fold(f64::INFINITY, f64::min), ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max));
			if max_x < shown_box.min_x || min_x > shown_box.max_x || max_y < shown_box.min_y || min_y > shown_box.max_y {
				continue;
			}
			add_shadow(&mut pending, vec![segment_shadow(sx, sy, ax, ay, bx, by, near, reach, &bounds)], kind_of(vertical.limited), vertical.reach);
		}
	}

	if is_eye_level {
		// a face standing across the source's rays where it meets the plane through the source hides everything beyond that line
		for (index, horizontal) in scene.horizontals.iter().enumerate() {
			if (is_flat && horizontal.plane.is_none()) || horizontal.document == own_solid || !box_overlaps(&horizontal.bounds) || !directions_meet(shown_directions, scene.horizontal_directions(index)) {
				continue;
			}
			let face = horizontal.plane.unwrap_or(Plane { a: horizontal.elevation, b: 0.0, c: 0.0 });
			let segments = line_inside(&horizontal.paths, face.b - plane.b, face.c - plane.c, face.a - plane.a - drop);
			if horizontal.reach.is_infinite() {
				if horizontal.limited { limited_segments.extend_from_slice(&segments) } else { normal_segments.extend_from_slice(&segments) }
				continue;
			}
			for segment in segments.as_chunks::<4>().0 {
				let [ax, ay, bx, by] = *segment;
				let max_factor = farthest / distance_to_segment(sx, sy, ax, ay, bx, by).max(NEAREST);
				add_shadow(&mut pending, vec![segment_shadow(sx, sy, ax, ay, bx, by, 1.0, max_factor, &bounds)], kind_of(horizontal.limited), horizontal.reach);
			}
		}
	} else {
		// a horizontal barrier between the floor and the source shades the floor with its region scaled from the source
		for (index, horizontal) in scene.horizontals.iter().enumerate() {
			if horizontal.document == own_solid || !box_overlaps(&horizontal.bounds) {
				continue;
			}
			if is_flat && horizontal.plane.is_none() {
				if !(horizontal.elevation > floor_height && horizontal.elevation < sz) {
					continue;
				}
				let factor = factor_at(horizontal.elevation).min(farthest);
				let scaled: Vec<Option<Path>> = horizontal
					.paths
					.iter()
					.map(|path| {
						let scaled: Path = path.as_chunks::<2>().0.iter().flat_map(|point| [sx + (point[0] - sx) * factor, sy + (point[1] - sy) * factor]).collect();
						clip_to_box(&scaled, &bounds)
					})
					.collect();
				add_shadow(&mut pending, scaled, kind_of(horizontal.limited), horizontal.reach);
				continue;
			}
			if !directions_meet(shown_directions, scene.horizontal_directions(index)) {
				continue;
			}
			let face = horizontal.plane.unwrap_or(Plane { a: horizontal.elevation, b: 0.0, c: 0.0 });
			let face_below_source = sz - face.height(sx, sy);
			if face_below_source.abs() <= (2.0 * HAIR).max(depth / farthest) && is_point_inside_toward(&horizontal.paths, sx, sy, 1.0, 0.37) {
				let toward = if face_below_source >= 0.0 { 1.0 } else { -1.0 };
				let part = on_side_of(&[path_from_box(&bounds)], toward * (face.b - plane.b), toward * (face.c - plane.c), toward * (face.a - plane.a));
				add_shadow(&mut pending, part.into_iter().map(Some).collect(), kind_of(horizontal.limited), horizontal.reach);
				continue;
			}
			let (alpha, beta, gamma) = (side * (face.b - plane.b), side * (face.c - plane.c), side * (face.a - plane.a));
			let far_d = depth * (1.0 - 1.0 / farthest);
			let part = cut_to_slab(&horizontal.paths, alpha, beta, gamma, far_d);
			if part.is_empty() {
				continue;
			}
			let turned_over = depth < alpha * sx + beta * sy + gamma;
			let projected: Vec<Option<Path>> = part
				.iter()
				.map(|path| {
					let on_floor: Path = path
						.as_chunks::<2>().0.iter()
						.flat_map(|point| {
							let factor = depth / (depth - (alpha * point[0] + beta * point[1] + gamma).max(0.0));
							[sx + (point[0] - sx) * factor, sy + (point[1] - sy) * factor]
						})
						.collect();
					let on_floor = if turned_over { with_winding(&on_floor, -signed_area(&on_floor).signum()) } else { on_floor };
					clip_to_box(&on_floor, &bounds)
				})
				.collect();
			add_shadow(&mut pending, projected, kind_of(horizontal.limited), horizontal.reach);
		}
	}

	// nothing stands between the floor and the source: all of it within the box is lit
	if normal_segments.is_empty() && limited_segments.is_empty() && attenuated_segments.is_empty() && pending.is_empty() {
		let unshaded: Vec<Path> = shown.iter().filter_map(|path| clip_to_box(path, &bounds)).collect();
		return grown_direct(&unshaded);
	}
	let key: Vec<u64> = normal_segments.iter().chain([f64::NAN].iter()).chain(limited_segments.iter()).chain([f64::NAN].iter()).chain(attenuated_segments.iter()).map(|value| value.to_bits()).collect();
	let polygons = scene
		.polygons
		.borrow_mut()
		.entry(key)
		.or_insert_with(|| std::rc::Rc::new(timed("lit_on: visibility polygon", || visibility_polygons(sx, sy, &normal_segments, &limited_segments, &attenuated_segments, &bounds))))
		.clone();
	let visible = vec![with_winding(&polygons.visible, 1.0)];
	let visible_here: Vec<Path> = visible.iter().filter_map(|path| clip_to_box(path, &shown_box)).collect();
	let visible_shown = timed("lit_on: shown ∩ visible", || intersection(shown, &visible_here));
	if visible_shown.is_empty() {
		return Vec::new();
	}
	// (a shadow whose box misses the visible part's is left out; the boolean operations below drop the rest cheaply)
	let visible_box = bounding_box(visible_shown.iter(), 0.0);
	for (shadow, kind, reach) in pending {
		let shadow_box = bounding_box(shadow.iter(), 0.0);
		if shadow_box.min_x > visible_box.max_x || shadow_box.max_x < visible_box.min_x || shadow_box.min_y > visible_box.max_y || shadow_box.max_y < visible_box.min_y {
			continue;
		}
		// an attenuated barrier only hides beyond its reach
		let shadow = match (reach.is_finite()).then(|| reach_on_plane(sx, sy, drop, plane, pixels_per_unit, reach)).flatten() {
			Some(reach_path) => difference(&shadow, &[reach_path]),
			None => shadow,
		};
		match kind {
			Kind::Limited => limited.push(shadow),
			Kind::Normal if shadow.iter().all(|path| signed_area(path) >= 0.0) => normal.extend(shadow),
			Kind::Normal => normal_with_holes.push(shadow),
		}
	}
	if !limited.is_empty() {
		let beyond_first_limited = if limited_segments.is_empty() { Vec::new() } else { difference(&visible, &[with_winding(&polygons.before_limited, 1.0)]) };
		limited.push(beyond_first_limited);
		normal_with_holes.push(covered_twice(&limited, &bounds));
	}
	// What the shadows hide of the visible part, then cut out of it. Only the floor's own box matters: the shadows (often reaching
	// across the whole box from the source) and the visible part are cut to it first, by plain clipping, so the boolean
	// operations see no more than the floor (non-zero, the intersection unites the shadows too). The shadows are not grown: a seam
	// of light left between two of them is a sliver the visualizer drops.
	let normal = if normal_with_holes.is_empty() { normal } else { union_of_areas(std::iter::once(normal.as_slice()).chain(normal_with_holes.iter().map(Vec::as_slice))) };
	let hidden = if normal.is_empty() {
		Vec::new()
	} else {
		let near: Vec<Path> = normal.iter().filter_map(|path| clip_to_box(path, &shown_box)).collect();
		timed("lit_on: shadows ∩ visible", || intersection(&near, &visible_here))
	};
	let lit = timed("lit_on: shown − hidden", || if hidden.is_empty() { visible_shown } else { difference(&visible_shown, &hidden) });
	// grown a hair (each corner moved out, no boolean operation), so neighbouring floors' lit parts overlap instead of leaving a
	// hairline between them; the union of all of them, snapped to a grid, settles the overlaps
	grown_direct(&lit)
}

/// Every floor lit and the results united.
pub fn lit_floors_from(data: &[f64]) -> Vec<Path> {
	light_task(&prepare(data), 0, 1)
}

/// What every task of one source's lighting starts from: the barriers seen, and the floors with where each is a floor.
pub struct Prepared {
	scene: Scene,
	floors: Vec<Floor>,
	base_elevation: f64,
	/// every floor's area: the base floor shows everywhere else
	all_claimed: Vec<Path>,
}

/// Reads an input buffer (see Reader) into what its tasks light.
pub fn prepare(data: &[f64]) -> Prepared {
	let mut reader = Reader::new(data);
	let (sx, sy, sz) = (reader.next(), reader.next(), reader.next());
	let bounds = Box2 { min_x: reader.next(), min_y: reader.next(), max_x: reader.next(), max_y: reader.next() };
	let farthest = reader.next();
	let pixels_per_unit = reader.next();
	let vertical_count = reader.count();
	let verticals: Vec<Vertical> = (0..vertical_count)
		.map(|_| Vertical {
			ax: reader.next(),
			ay: reader.next(),
			bx: reader.next(),
			by: reader.next(),
			bottom: reader.next(),
			top: reader.next(),
			bottom_b: reader.next(),
			top_b: reader.next(),
			limited: reader.next() != 0.0,
			document: reader.next(),
			reach: reader.next(),
		})
		.collect();
	let horizontal_count = reader.count();
	let horizontals: Vec<Horizontal> = (0..horizontal_count)
		.map(|_| {
			let limited = reader.next() != 0.0;
			let document = reader.next();
			let reach = reader.next();
			let sloped = reader.next() != 0.0;
			let plane = Plane { a: reader.next(), b: reader.next(), c: reader.next() };
			let elevation = reader.next();
			let bounds = Box2 { min_x: reader.next(), min_y: reader.next(), max_x: reader.next(), max_y: reader.next() };
			let paths = reader.paths();
			Horizontal { limited, document, reach, plane: if sloped { Some(plane) } else { None }, elevation, bounds, paths }
		})
		.collect();
	// the floors at or below the source: flat ones by height, then each roof face, whole while the source is above
	// its plane, else cut to where it is at or below the source, and not below the base floor
	let base_elevation = reader.next();
	let mut floors: Vec<Floor> = Vec::new();
	let flat_count = reader.count();
	for _ in 0..flat_count {
		let height = reader.next();
		let area = union(&reader.paths());
		if !area.is_empty() {
			floors.push(Floor { plane: Plane { a: height, b: 0.0, c: 0.0 }, bounds: bounding_box(area.iter(), 0.0), area, document: -1.0, is_lit: true, own_solid: -1.0 });
		}
	}
	let face_count = reader.count();
	for _ in 0..face_count {
		let plane = Plane { a: reader.next(), b: reader.next(), c: reader.next() };
		let document = reader.next();
		let is_lit = reader.next() != 0.0;
		let is_convex_solid = reader.next() != 0.0;
		let paths = reader.paths();
		let is_above_plane = sz - plane.height(sx, sy) >= -HAIR;
		let mut area = on_side_of(&paths, plane.b, plane.c, plane.a - base_elevation);
		if !is_above_plane {
			area = on_side_of(&area, -plane.b, -plane.c, sz + HAIR - plane.a);
		}
		if area.is_empty() {
			continue;
		}
		let own_solid = if is_convex_solid && sz - plane.height(sx, sy) > HAIR { document } else { -1.0 };
		floors.push(Floor { plane, bounds: bounding_box(area.iter(), 0.0), area, document, is_lit, own_solid });
	}
	let scene = Scene {
		sx,
		sy,
		sz,
		bounds,
		farthest,
		pixels_per_unit,
		vertical_directions: RefCell::new(vec![None; verticals.len()]),
		horizontal_directions: RefCell::new(vec![None; horizontals.len()]),
		verticals,
		horizontals,
		polygons: RefCell::new(HashMap::new()),
	};
	let all_claimed: Vec<Path> = union_of_areas(floors.iter().map(|floor| floor.area.as_slice()));
	Prepared { scene, floors, base_elevation, all_claimed }
}

/// One task of a source's lighting, lit and united: the floors whose position in the list is `part` modulo `parts`, and the
/// `part`th of `parts` strips across the box of the base floor (often the largest and the most shaded: in strips, each its own,
/// its barriers only those between it and the source, the tasks stay even). Every task of a source together lights it all; the
/// workers (scripts/perception/floors.js) take them as they come free, and unite the results (unite).
pub fn light_task(prepared: &Prepared, part: usize, parts: usize) -> Vec<Path> {
	let Prepared { scene, floors, base_elevation, all_claimed } = prepared;
	let (bounds, base_elevation) = (scene.bounds, *base_elevation);
	// Each floor shows where no other floor overlapping it is higher (the part of the other on its side of where their planes
	// meet); the base floor shows everywhere else.
	let mut lit = Vec::new();
	for (floor_index, floor) in floors.iter().enumerate() {
		if !floor.is_lit || floor_index % parts != part {
			continue;
		}
		let mut above: Vec<Vec<Path>> = Vec::new();
		for (other_index, other) in floors.iter().enumerate() {
			if other_index == floor_index || (floor.document >= 0.0 && other.document == floor.document) {
				continue;
			}
			let (first, second) = (&floor.bounds, &other.bounds);
			if second.min_x > first.max_x || second.max_x < first.min_x || second.min_y > first.max_y || second.max_y < first.min_y {
				continue;
			}
			let (alpha, beta, gamma) = (other.plane.b - floor.plane.b, other.plane.c - floor.plane.c, other.plane.a - floor.plane.a);
			if alpha == 0.0 && beta == 0.0 && gamma == 0.0 {
				if other_index < floor_index {
					above.push(other.area.clone());
				}
				continue;
			}
			// only where the two overlap matters: higher or lower all over it, the other is all or none of what is above there
			let overlap = path_from_box(&Box2 { min_x: first.min_x.max(second.min_x), min_y: first.min_y.max(second.min_y), max_x: first.max_x.min(second.max_x), max_y: first.max_y.min(second.max_y) });
			let sides: Vec<f64> = overlap.as_chunks::<2>().0.iter().map(|corner| alpha * corner[0] + beta * corner[1] + gamma).collect();
			if sides.iter().all(|&side| side < 0.0) {
				continue;
			}
			if sides.iter().all(|&side| side >= 0.0) {
				above.push(other.area.clone());
				continue;
			}
			above.push(on_side_of(&other.area, alpha, beta, gamma));
		}
		let above = union_of_areas(above.iter().map(Vec::as_slice));
		let shown = timed("floors: shown", || if above.is_empty() { floor.area.clone() } else { difference(&floor.area, &above) });
		if !shown.is_empty() {
			lit.extend(timed("lit_on (whole)", || lit_on(scene, floor.plane, &shown, floor.own_solid)));
		}
	}
	let strip_width = (bounds.max_x - bounds.min_x) / parts as f64;
	// (each reaching a hair into its neighbours, so neighbouring strips overlap instead of meeting along a seam)
	let strip = Box2 {
		min_x: if part == 0 { bounds.min_x } else { bounds.min_x + strip_width * part as f64 - STRIP_OVERLAP },
		max_x: if part + 1 == parts { bounds.max_x } else { bounds.min_x + strip_width * (part + 1) as f64 + STRIP_OVERLAP },
		..bounds
	};
	let strip_path = path_from_box(&strip);
	let base_shown = if all_claimed.is_empty() { vec![strip_path] } else { difference(&[strip_path], all_claimed) };
	if !base_shown.is_empty() {
		lit.extend(timed("base floor strip", || lit_on(scene, Plane { a: base_elevation, b: 0.0, c: 0.0 }, &base_shown, -1.0)));
	}
	// Every point snapped to a quarter of a pixel, so neighbouring floors' lit parts (worked out apart, their shared edges nearly
	// but not quite the same, each grown a hair) join without a hairline between them. Snapped to the grid only when this is the
	// whole of the lighting: a task's share is united plainly, and the shares are
	// snapped once, together (unite). Snapping each apart would round an edge two floors share differently on either side
	// (snap rounding moves an edge by what else lies near it), opening the very seams it is there to close.
	if parts == 1 { timed("final union", || union_snapped(&lit, SNAP_SCALE)) } else { union(&lit) }
}

// ---- the WebAssembly interface: one input buffer, one output buffer ----

// (the input and output buffers are the store's, shared with scene uploads and raycasts)
thread_local! {
	static PREPARED: RefCell<Option<Prepared>> = const { RefCell::new(None) };
}

/// Lights the floors in the input buffer; returns how many f64s the output buffer holds: the lit paths, as a count, then each
/// path's point count and its coordinates.
#[unsafe(no_mangle)]
pub extern "C" fn lit_floors() -> usize {
	write_output(INPUT.with(|input| lit_floors_from(&input.borrow())))
}

/// Reads the input buffer into what its tasks light (prepare), kept for lit_task; returns how many floors it has.
#[unsafe(no_mangle)]
pub extern "C" fn prepare_input() -> usize {
	let prepared = INPUT.with(|input| prepare(&input.borrow()));
	let floors = prepared.floors.len();
	PREPARED.with(|kept| *kept.borrow_mut() = Some(prepared));
	floors
}

/// Lights one task of what prepare_input kept (light_task) into the output buffer; nothing if nothing is prepared.
#[unsafe(no_mangle)]
pub extern "C" fn lit_task(part: usize, parts: usize) -> usize {
	let paths = PREPARED.with(|kept| kept.borrow().as_ref().map(|prepared| light_task(prepared, part, parts.max(1))).unwrap_or_default());
	write_output(paths)
}

/// Unites the paths in the input buffer (a count, then each path's point count and coordinates), into the output buffer.
#[unsafe(no_mangle)]
pub extern "C" fn unite() -> usize {
	// snapped as each task's own union, so floors from different tasks join without a hairline either
	write_output(INPUT.with(|input| union_snapped(&Reader::new(&input.borrow()).paths(), SNAP_SCALE)))
}

fn write_output(paths: Vec<Path>) -> usize {
	OUTPUT.with(|output| {
		let mut output = output.borrow_mut();
		output.clear();
		output.push(paths.len() as f64);
		for path in &paths {
			output.push((path.len() / 2) as f64);
			output.extend_from_slice(path);
		}
		output.len()
	})
}
