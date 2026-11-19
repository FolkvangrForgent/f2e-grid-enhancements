//! What barriers a source sees (shared by the raycast's source volumes and the floor lighting's gathering), and the raycast
//! through light and darkness source volumes (scripts/raycast/sources.js builds and uploads them).

use crate::geometry::Plane;
use crate::raycast::{AXIS_X, AXIS_Y, Query, QueryOptions};
use crate::reader::Reader;
use crate::rules::*;
use crate::shadows::{Normal, Stretch, Triangle, segment_meets_triangle, shadow_frame, union_of};
use crate::store::*;

/// A barrier seen from a source, with its restriction as seen from there.
pub struct SeenBarrier {
	pub primitive: usize,
	pub restriction: Restriction,
	pub shape: SeenShape,
}

pub enum SeenShape {
	/// a wall's height range or a stretch of a region side, standing from bottom to top at a and bottom_b to top_b at b; a door's
	/// state is read where it is used
	Vertical { ax: f64, ay: f64, bx: f64, by: f64, bottom: f64, top: f64, bottom_b: f64, top_b: f64, is_door: bool },
	/// a region face, lowered a hair (ELEVATION_HAIR); its edges are its primitive's
	Face { elevation: f64, plane: Option<Plane> },
}

pub struct SeenFrom {
	pub x: f64,
	pub y: f64,
	pub elevation: f64,
	pub type_index: usize,
	pub sight: SourceSight,
	/// None: every level
	pub active_levels: Option<Vec<bool>>,
}

impl SeenFrom {
	fn is_level_active(&self, level_index: i32) -> bool {
		match &self.active_levels {
			None => true,
			Some(flags) => level_index < 0 || flags.get(level_index as usize).copied().unwrap_or(false),
		}
	}

	fn is_on_active_level(&self, level_indexes: &[i32]) -> bool {
		level_indexes.is_empty() || level_indexes.iter().any(|&level| self.is_level_active(level))
	}
}

/// What source shadows and the floor lighting are cut by, within bounds (minX, minY, minZ, maxX, maxY, maxZ).
pub fn barriers_seen_from(scene: &Scene, from: &SeenFrom, bounds: &[f64; 6]) -> Vec<SeenBarrier> {
	let pixels_per_unit = scene.pixels_per_unit;
	let type_bit = 1u32 << from.type_index;
	let (x, y, elevation) = (from.x, from.y, from.elevation);
	let mut seen = Vec::new();
	scene.static_bvh.visit_overlapping(bounds, type_bit | REGION_SIDE_MASK | REGION_FACE_MASK | REGION_SLOPE_MASK, &mut |primitive| match &scene.statics[primitive] {
		Primitive::Wall(wall) => {
			let sense = wall.senses[from.type_index];
			if sense == SENSE_NONE {
				return;
			}
			// one-way walls as for a ray from the source (Edge#orientPoint of the source is its direction)
			if wall.edge_direction != 0 {
				let orientation = (wall.start[1] - y) * (wall.end[0] - x) - (wall.start[0] - x) * (wall.end[1] - y);
				let side = if orientation == 0.0 { 0 } else if orientation < 0.0 { 1 } else { 2 };
				if side == wall.edge_direction {
					return;
				}
			}
			for range in &wall.height_ranges {
				if !from.is_level_active(range.level_index) {
					continue;
				}
				let mut distance = || distance_to_wall(wall.start, wall.end, range.bottom, range.top, x, y, elevation, pixels_per_unit);
				let Some(restriction) = restriction_seen_from(sense, wall.thresholds[from.type_index], wall.attenuation, &mut distance, &from.sight) else { continue };
				let shape = SeenShape::Vertical { ax: wall.start[0], ay: wall.start[1], bx: wall.end[0], by: wall.end[1], bottom: range.bottom, top: range.top, bottom_b: range.bottom, top_b: range.top, is_door: wall.is_door };
				seen.push(SeenBarrier { primitive, restriction, shape });
			}
		}
		Primitive::Side(side) => {
			if side.barriers.is_empty() || !from.is_on_active_level(&side.level_indexes) {
				return;
			}
			let roof = side.roof.map(|roof| &scene.roofs[roof]);
			for edge in side.edges.chunks_exact(EDGE_STRIDE) {
				// outward normals: the source outside the side crosses it going in
				let is_entering = edge[EDGE_NORMAL_X] * (x - edge[0]) + edge[EDGE_NORMAL_Y] * (y - edge[1]) > 0.0;
				let mut distance = || distance_to_side(edge, side.bottom, side.top, roof, x, y, elevation, pixels_per_unit);
				let Some(restriction) = barrier_restriction_seen_from(&side.barriers, &scene.barriers, from.type_index, is_entering, &mut distance, &from.sight) else { continue };
				// A roofed region's side stands up to its roof, which bends where the side passes under a ridge or hip line: one entry for
				// each stretch between bends, so its top runs straight from one end to the other.
				let (ax, ay, bx, by) = (edge[0], edge[1], edge[EDGE_END_X], edge[EDGE_END_Y]);
				match roof {
					Some(roof) => {
						let bends = roof_bends(roof, ax, ay, bx, by);
						for pair in bends.windows(2) {
							let (from_x, from_y) = (ax + (bx - ax) * pair[0], ay + (by - ay) * pair[0]);
							let (to_x, to_y) = (ax + (bx - ax) * pair[1], ay + (by - ay) * pair[1]);
							let shape = SeenShape::Vertical {
								ax: from_x,
								ay: from_y,
								bx: to_x,
								by: to_y,
								bottom: side.bottom,
								top: roof_height(roof, from_x, from_y),
								bottom_b: side.bottom,
								top_b: roof_height(roof, to_x, to_y),
								is_door: false,
							};
							seen.push(SeenBarrier { primitive, restriction, shape });
						}
					}
					None => {
						let shape = SeenShape::Vertical { ax, ay, bx, by, bottom: side.bottom, top: side.top, bottom_b: side.bottom, top_b: side.top, is_door: false };
						seen.push(SeenBarrier { primitive, restriction, shape });
					}
				}
			}
		}
		Primitive::Face(face) => {
			if !from.is_on_active_level(&face.level_indexes) {
				return;
			}
			// core's surfaces restrict their types fully; barriers as for a ray from the source (going in through the top going down,
			// through the bottom going up; a flat region's face goes in going down)
			let face_elevation = face.elevation - ELEVATION_HAIR;
			let is_going_down = elevation > face.plane.map_or(face_elevation, |plane| plane.height(x, y) - ELEVATION_HAIR);
			let is_entering = if face.top > face.bottom { face.is_top == is_going_down } else { is_going_down };
			let restriction = if face.surfaces.iter().any(|surface| surface.types & type_bit != 0) {
				Some(OUTRIGHT)
			} else {
				let mut distance = || distance_to_face(&face.edges, face.elevation, face.plane, x, y, elevation, pixels_per_unit, 1.0, 0.0);
				barrier_restriction_seen_from(&face.barriers, &scene.barriers, from.type_index, is_entering, &mut distance, &from.sight)
			};
			if let Some(restriction) = restriction {
				let plane = face.plane.map(|plane| Plane { a: plane.a - ELEVATION_HAIR, ..plane });
				seen.push(SeenBarrier { primitive, restriction, shape: SeenShape::Face { elevation: face_elevation, plane } });
			}
		}
	});
	seen
}

/// Another source's edges cut a source fully, at any distance.
const OCCLUDER_RESTRICTION: Restriction = OUTRIGHT;

/// What ends a span: the sphere, a polygon side's or shadow side's normal, or an end of the tested range inside the volume.
#[derive(Clone, Copy)]
enum Boundary {
	Sphere,
	Surface(Normal),
	RangeEnd,
}

struct InsideStretch {
	from: f64,
	to: f64,
	from_boundary: Boundary,
	to_boundary: Boundary,
}

pub struct SourceSpan {
	pub volume: usize,
	pub enter_t: f64,
	pub enter_point: [f64; 3],
	pub enter_normal: Normal,
	pub exit_t: f64,
	pub exit_point: [f64; 3],
	pub exit_normal: Normal,
	pub starts_inside: bool,
	pub ends_inside: bool,
}

struct SourceQuery<'a, 'q> {
	query: &'q Query<'a>,
	segment_bounds: [f64; 4],
	spans: Vec<SourceSpan>,
}

impl SourceQuery<'_, '_> {
	/// A source volume is a sphere cut to the source's polygon (by other sources' edges) and to what barriers and occluding
	/// sources hide from the source (source_shadows). The ray is inside it in stretches, each starting and ending on the sphere,
	/// the polygon, a shadow's side, or an end of the tested range; each is a span.
	fn cross_source_volume(&mut self, volume_index: usize, volume: &SourceVolume, seen: &[SeenBarrier]) {
		let query = self.query;
		let [min_x, min_y, max_x, max_y] = self.segment_bounds;
		if max_x < volume.bounds[0] || min_x > volume.bounds[2] || max_y < volume.bounds[1] || min_y > volume.bounds[3] {
			return;
		}
		let (mut sphere_entry_t, mut sphere_exit_t) = (f64::NEG_INFINITY, f64::INFINITY);
		if volume.sphere {
			let radius = [volume.radius_xy, volume.radius_xy, volume.radius_z];
			// a tangent line touches the sphere without going in
			let Some([entry, exit]) = query.ellipsoid_crossing_ts(volume.center, radius) else { return };
			if !(entry < exit) {
				return;
			}
			sphere_entry_t = entry;
			sphere_exit_t = exit;
		}
		let from_t = sphere_entry_t.max(query.t_min);
		let to_t = sphere_exit_t.min(query.t_max());
		if !(from_t < to_t) {
			return;
		}

		// the stretches inside the sphere and the polygon
		let edges = &volume.edges;
		let from_point = query.point_at(from_t);
		let mut inside_from = is_point_inside_edges_toward(edges, from_point[0], from_point[1], query.delta[0], query.delta[1], 1.0).then_some(from_t);
		let mut from_boundary = if from_t == sphere_entry_t && sphere_entry_t > query.t_min { Boundary::Sphere } else { Boundary::RangeEnd };
		let mut stretches: Vec<InsideStretch> = Vec::new();
		if query.axes & (AXIS_X | AXIS_Y) != 0 {
			let mut crossings: Vec<(f64, [f64; 3], bool)> = Vec::new();
			for edge in edges.chunks_exact(EDGE_STRIDE) {
				let Some(found) = crossing(query.origin[0], query.origin[1], query.destination[0], query.destination[1], edge[0], edge[1], edge[EDGE_END_X], edge[EDGE_END_Y]) else { continue };
				if !(found.t > from_t) || found.t > to_t || !found.is_counted() {
					continue;
				}
				let (normal_x, normal_y) = (edge[EDGE_NORMAL_X], edge[EDGE_NORMAL_Y]);
				let is_entering = normal_x * query.delta[0] + normal_y * query.delta[1] < 0.0;
				let toward_origin = if is_entering { 1.0 } else { -1.0 };
				crossings.push((found.t, [normal_x * toward_origin, normal_y * toward_origin, 0.0], is_entering));
			}
			crossings.sort_by(|first, second| first.0.total_cmp(&second.0));
			for (t, normal, is_entering) in crossings {
				if is_entering {
					inside_from = Some(t);
					from_boundary = Boundary::Surface(Some(normal));
				} else if let Some(from) = inside_from {
					stretches.push(InsideStretch { from, to: t, from_boundary, to_boundary: Boundary::Surface(Some(normal)) });
					inside_from = None;
				}
			}
		}
		if let Some(from) = inside_from {
			stretches.push(InsideStretch { from, to: to_t, from_boundary, to_boundary: if to_t == sphere_exit_t { Boundary::Sphere } else { Boundary::RangeEnd } });
		}
		if stretches.is_empty() {
			return;
		}

		// less what is hidden from the source; a shadow's sides are boundaries too, each with its normal (a degenerate one falls back
		// to the normal back along the ray)
		let shadows = self.source_shadows(volume, seen, stretches[0].from, stretches[stretches.len() - 1].to);
		let back = query.back_along_ray_normal();
		for stretch in &stretches {
			let (mut from, mut start_boundary) = (stretch.from, stretch.from_boundary);
			for shadow in &shadows {
				if shadow.to <= from || shadow.from >= stretch.to {
					continue;
				}
				if shadow.from > from {
					self.add_source_span(volume_index, volume, from, shadow.from, start_boundary, Boundary::Surface(Some(shadow.from_normal.unwrap_or(back))));
				}
				from = shadow.to;
				start_boundary = Boundary::Surface(Some(shadow.to_normal.unwrap_or(back)));
			}
			if from < stretch.to {
				self.add_source_span(volume_index, volume, from, stretch.to, start_boundary, stretch.to_boundary);
			}
		}
	}

	fn add_source_span(&mut self, volume_index: usize, volume: &SourceVolume, from: f64, to: f64, from_boundary: Boundary, to_boundary: Boundary) {
		let (enter_point, enter_normal) = self.span_end(volume, from, from_boundary, true);
		let (exit_point, exit_normal) = self.span_end(volume, to, to_boundary, false);
		self.spans.push(SourceSpan {
			volume: volume_index,
			enter_t: from,
			enter_point,
			enter_normal,
			exit_t: to,
			exit_point,
			exit_normal,
			starts_inside: matches!(from_boundary, Boundary::RangeEnd),
			ends_inside: matches!(to_boundary, Boundary::RangeEnd),
		});
	}

	fn span_end(&self, volume: &SourceVolume, t: f64, boundary: Boundary, is_entering: bool) -> ([f64; 3], Normal) {
		let point = self.query.point_at(t);
		let normal = match boundary {
			Boundary::Sphere => Some(self.query.ellipsoid_normal(point, volume.center, [volume.radius_xy, volume.radius_xy, volume.radius_z], if is_entering { 1.0 } else { -1.0 })),
			Boundary::Surface(normal) => normal,
			Boundary::RangeEnd => None,
		};
		(point, normal)
	}

	/// Core cuts a source's area by walls in plan; this is the same in 3D, by every barrier restricting the source's own type, with
	/// one-way, limited, threshold and attenuation rules as for a ray from the source (a point is hidden by a normal barrier, or by
	/// two limited ones). Other sources' edges (occluders) cut it at every elevation, as core's sweep is cut by them.
	fn source_shadows(&self, volume: &SourceVolume, seen: &[SeenBarrier], from_t: f64, to_t: f64) -> Vec<Stretch> {
		let query = self.query;
		let scene = query.scene;
		let source = volume.center;
		let Some(frame) = shadow_frame(source, query.origin, query.delta, query.pixels_per_unit) else { return Vec::new() };
		let from = query.point_at(from_t);
		let to = query.point_at(to_t);
		let min_z = source[2].min(from[2]).min(to[2]);
		let max_z = source[2].max(from[2]).max(to[2]);
		// Heights are lowered a hair (ELEVATION_HAIR); unbounded ones are cut to just past the triangle (source, ray stretch) the
		// shadows fall in, and past the side's other end, so it still stands upright (a top below the band with no bottom). Only
		// those: a side's two ends each cut to that band would no longer be the side when its top or bottom slopes, and finite
		// heights need no cutting.
		let side_heights = |bottom: f64, top: f64, bottom_b: f64, top_b: f64| {
			let below = min_z.min(top).min(top_b) - 1.0;
			let above = max_z.max(bottom).max(bottom_b) + 1.0;
			let bounded = |elevation: f64| (if elevation.is_finite() { elevation } else if elevation > 0.0 { above } else { below }) - ELEVATION_HAIR;
			(bounded(bottom), bounded(top), bounded(bottom_b), bounded(top_b))
		};
		// (t, limited, change, normal): a normal shadow or two limited ones hide
		let mut events: Vec<(f64, bool, i32, Normal)> = Vec::new();
		let mut add_shadows = |stretches: Vec<Stretch>, restriction: Restriction| {
			let mut hidden = union_of(stretches);
			if restriction.reach != f64::INFINITY {
				hidden = self.beyond_reach(hidden, source, restriction.reach);
			}
			let limited = restriction.kind == RestrictionKind::Limited;
			for shadow in hidden {
				let low = shadow.from.max(from_t);
				let high = shadow.to.min(to_t);
				if low < high {
					events.push((low, limited, 1, shadow.from_normal));
					events.push((high, limited, -1, shadow.to_normal));
				}
			}
		};
		// what can hide part of the stretch lies within the triangle (source, stretch) seen from above
		let triangle = Triangle { x0: source[0], y0: source[1], x1: from[0], y1: from[1], x2: to[0], y2: to[1] };
		let query_box = [source[0].min(from[0]).min(to[0]), source[1].min(from[1]).min(to[1]), min_z, source[0].max(from[0]).max(to[0]), source[1].max(from[1]).max(to[1]), max_z];
		for barrier in seen {
			if !scene.static_bvh.primitive_overlaps(barrier.primitive, &query_box) {
				continue;
			}
			match barrier.shape {
				SeenShape::Face { elevation, plane } => {
					let Primitive::Face(face) = &scene.statics[barrier.primitive] else { continue };
					add_shadows(frame.face_shadows(&face.edges, EDGE_STRIDE, EDGE_END_X, EDGE_END_Y, elevation, plane), barrier.restriction);
				}
				SeenShape::Vertical { ax, ay, bx, by, bottom, top, bottom_b, top_b, is_door } => {
					if is_door && matches!(&scene.statics[barrier.primitive], Primitive::Wall(wall) if wall.is_open) {
						continue;
					}
					if !segment_meets_triangle(ax, ay, bx, by, &triangle) {
						continue;
					}
					let (bottom, top, bottom_b, top_b) = side_heights(bottom, top, bottom_b, top_b);
					add_shadows(frame.quad_shadow(ax, ay, bx, by, bottom, top, bottom_b, top_b).into_iter().collect(), barrier.restriction);
				}
			}
		}
		// Another source's edges block one way, from outside it (core's source edges, EDGE_DIRECTIONS.LEFT), at every elevation: an
		// edge hides what is behind it when the source is on its outer side.
		for occluder in &volume.occluders {
			let [occluder_min_x, occluder_min_y, occluder_max_x, occluder_max_y] = occluder.bounds;
			if query_box[3] < occluder_min_x || query_box[4] < occluder_min_y || query_box[0] > occluder_max_x || query_box[1] > occluder_max_y {
				continue;
			}
			let mut stretches = Vec::new();
			for edge in occluder.edges.chunks_exact(EDGE_STRIDE) {
				let (ax, ay) = (edge[0], edge[1]);
				if edge[EDGE_NORMAL_X] * (source[0] - ax) + edge[EDGE_NORMAL_Y] * (source[1] - ay) <= 0.0 {
					continue;
				}
				let (bx, by) = (edge[EDGE_END_X], edge[EDGE_END_Y]);
				if !segment_meets_triangle(ax, ay, bx, by, &triangle) {
					continue;
				}
				let (bottom, top, bottom_b, top_b) = side_heights(f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY);
				stretches.extend(frame.quad_shadow(ax, ay, bx, by, bottom, top, bottom_b, top_b));
			}
			if !stretches.is_empty() {
				add_shadows(stretches, OCCLUDER_RESTRICTION);
			}
		}
		if events.is_empty() {
			return Vec::new();
		}
		// in order along the ray, ends before starts at the same t; hidden while a normal shadow or two limited ones cover it
		events.sort_by(|first, second| first.0.total_cmp(&second.0).then(first.2.cmp(&second.2)));
		let mut hidden = Vec::new();
		let (mut normal_count, mut limited_count) = (0i32, 0i32);
		let mut hidden_from: Option<(f64, Normal)> = None;
		for (t, limited, change, normal) in events {
			if limited {
				limited_count += change;
			} else {
				normal_count += change;
			}
			let is_hidden = normal_count > 0 || limited_count > 1;
			match hidden_from {
				None if is_hidden => hidden_from = Some((t, normal)),
				Some((start, start_normal)) if !is_hidden => {
					if t > start {
						hidden.push(Stretch { from: start, to: t, from_normal: start_normal, to_normal: normal });
					}
					hidden_from = None;
				}
				_ => {}
			}
		}
		union_of(hidden)
	}

	/// An attenuated barrier only hides beyond its reach from the source. New ends are on the sphere of that radius.
	fn beyond_reach(&self, stretches: Vec<Stretch>, source: [f64; 3], reach: f64) -> Vec<Stretch> {
		let query = self.query;
		let radius = [reach, reach, reach / query.pixels_per_unit];
		let Some([near_t, far_t]) = query.ellipsoid_crossing_ts(source, radius) else { return stretches };
		let sphere_normal = |t: f64, toward_origin: f64| Some(query.ellipsoid_normal(query.point_at(t), source, radius, toward_origin));
		let mut beyond = Vec::new();
		for stretch in stretches {
			if stretch.from < near_t {
				beyond.push(if stretch.to <= near_t { stretch } else { Stretch { to: near_t, to_normal: sphere_normal(near_t, 1.0), ..stretch } });
			}
			if stretch.to > far_t {
				beyond.push(if stretch.from >= far_t { stretch } else { Stretch { from: far_t, from_normal: sphere_normal(far_t, -1.0), ..stretch } });
			}
		}
		beyond
	}
}

/// The barriers a source volume sees: within the polygon's bounds and the sphere's box (every ray stretch inside the volume is,
/// and so the source's triangle).
fn barriers_seen_by_source(scene: &Scene, volume: &SourceVolume, attenuation_multiplier: f64) -> Vec<SeenBarrier> {
	let [x, y, elevation] = volume.center;
	let bounds = [
		volume.bounds[0].max(x - volume.radius_xy) - 1.0,
		volume.bounds[1].max(y - volume.radius_xy) - 1.0,
		elevation - volume.radius_z - 1.0,
		volume.bounds[2].min(x + volume.radius_xy) + 1.0,
		volume.bounds[3].min(y + volume.radius_xy) + 1.0,
		elevation + volume.radius_z + 1.0,
	];
	let from = SeenFrom {
		x,
		y,
		elevation,
		type_index: volume.own_type,
		sight: SourceSight { radius: volume.radius_xy, external_radius: 0.0, attenuation_multiplier, use_threshold: true },
		active_levels: None,
	};
	barriers_seen_from(scene, &from, &bounds)
}

/// The source query buffer, laid out as flat f64s (scripts/raycast/query.js writes it): slot, originX, originY,
/// originElevation, destinationX, destinationY, destinationElevation, type index, priority, above (0 / 1), range min, range max,
/// attenuation multiplier.
fn source_spans(data: &[f64]) -> Vec<SourceSpan> {
	let mut reader = Reader::new(data);
	let slot = reader.count();
	let origin = [reader.next(), reader.next(), reader.next()];
	let destination = [reader.next(), reader.next(), reader.next()];
	let type_index = reader.count();
	let priority = reader.next();
	let is_above = reader.flag();
	let (t_min, t_max) = (reader.next(), reader.next());
	let attenuation_multiplier = reader.next();
	let options = QueryOptions {
		type_index,
		edge_direction_mode: 0,
		is_above,
		use_threshold: true,
		external_radius: 0.0,
		radius: f64::NAN,
		t_min,
		t_max,
		stop: false,
		all_barriers: false,
		containing: false,
		walls: false,
		regions: false,
		tokens: false,
		attenuation_multiplier,
		active_levels: None,
	};
	with_scene(slot, |scene| {
		let Some(query) = Query::begin(scene, origin, destination, &options) else { return Vec::new() };
		let type_bit = 1u32 << type_index;
		let segment_bounds = [origin[0].min(destination[0]), origin[1].min(destination[1]), origin[0].max(destination[0]), origin[1].max(destination[1])];
		let mut source_query = SourceQuery { query: &query, segment_bounds, spans: Vec::new() };
		for (volume_index, volume) in scene.sources.iter().enumerate() {
			if volume.types & type_bit == 0 || volume.priority < priority {
				continue;
			}
			let seen = scene.seen_by_source(volume_index, || barriers_seen_by_source(scene, volume, attenuation_multiplier));
			source_query.cross_source_volume(volume_index, volume, &seen);
		}
		let mut spans = source_query.spans;
		// by where they start, then in the sources' order
		spans.sort_by(|first, second| first.enter_t.total_cmp(&second.enter_t).then(first.volume.cmp(&second.volume)));
		spans
	})
	.unwrap_or_default()
}

const NO_NORMAL: [f64; 4] = [0.0, 0.0, 0.0, 0.0];

fn push_normal(output: &mut Vec<f64>, normal: Normal) {
	match normal {
		Some([x, y, z]) => output.extend_from_slice(&[1.0, x, y, z]),
		None => output.extend_from_slice(&NO_NORMAL),
	}
}

/// Spans through the source volumes of the ray in the input buffer (source_spans), into the output buffer: a count, then each:
/// volume index, enter t, x, y, elevation, normal (has one (0 / 1), x, y, z), exit t, x, y, elevation, normal, starts inside,
/// ends inside. Returns how many f64s the output holds.
#[unsafe(no_mangle)]
pub extern "C" fn raycast_sources() -> usize {
	let spans = INPUT.with(|input| source_spans(&input.borrow()));
	OUTPUT.with(|output| {
		let mut output = output.borrow_mut();
		output.clear();
		output.push(spans.len() as f64);
		for span in &spans {
			output.push(span.volume as f64);
			output.push(span.enter_t);
			output.extend_from_slice(&span.enter_point);
			push_normal(&mut output, span.enter_normal);
			output.push(span.exit_t);
			output.extend_from_slice(&span.exit_point);
			push_normal(&mut output, span.exit_normal);
			output.push(span.starts_inside as u8 as f64);
			output.push(span.ends_inside as u8 as f64);
		}
		output.len()
	})
}
