//! The 3D raycast over a stored scene (store.rs): barriers (walls, region sides and faces with Define Barrier behaviors and
//! core surfaces), regions and tokens. scripts/raycast/query.js writes the query and reads the hits; API.md documents the
//! options and results.
//!
//! Exact ties: anything exactly at the ray's elevation is settled by `elevationBias`, the ray lying a hair above it ('above')
//! or below it ('below') all along, so A -> B and B -> A agree. An inclusive region top reaches a hair above that. A point
//! exactly on an outline is moved a hair along the ray, then a smaller hair to its positive side. Crossings exactly at the start
//! of the tested range are left out; those exactly at its end are kept.

use crate::bvh::RayBounds;
use crate::geometry::Plane;
use crate::reader::Reader;
use crate::rules::*;
use crate::store::*;

pub const AXIS_X: u32 = 1;
pub const AXIS_Y: u32 = 2;
pub const AXIS_Z: u32 = 4;

/// CONST.EDGE_DIRECTION_MODES
const MODE_NORMAL: u8 = 0;
const MODE_REVERSED: u8 = 1;
const MODE_BOTH: u8 = 2;

#[derive(Clone, Copy, PartialEq)]
pub enum HitKind {
	Wall = 0,
	Region = 1,
	Token = 2,
	Attenuation = 3,
}

/// How a barrier was crossed: 'towards' the way a one-way barrier restricts (with edgeDirectionMode NORMAL), 'away' the other way.
#[derive(Clone, Copy, PartialEq)]
pub enum CrossedDirection {
	Both = 0,
	Towards = 1,
	Away = 2,
}

/// The barrier that decided a hit.
#[derive(Clone, Copy)]
pub struct DecidingBarrier {
	pub sense: u8,
	pub direction: CrossedDirection,
}

const CORE_SURFACE_BARRIER: DecidingBarrier = DecidingBarrier { sense: SENSE_NORMAL, direction: CrossedDirection::Both };

#[derive(Clone, Copy, PartialEq)]
pub enum Inside {
	No = 0,
	Origin = 1,
	Destination = 2,
}

#[derive(Clone)]
pub struct Hit {
	pub kind: HitKind,
	pub document: i32,
	pub t: f64,
	pub point: [f64; 3],
	pub normal: [f64; 3],
	pub blocking: bool,
	pub limited: bool,
	pub entering: Option<bool>,
	pub inside: Inside,
	pub attenuated: bool,
	pub forgiven: bool,
	pub surface: i32,
	pub barrier: Option<DecidingBarrier>,
	/// the endpoint a limited wall is crossed exactly at
	wall_vertex: Option<[f64; 2]>,
	/// orders hits at exactly the same t: -2 an inside hit at the range start, -1 / 1 a horizontal face the hair moves earlier /
	/// later, (-0.5, 0.5) a corner crossing, 0 any other crossing, 2 an inside hit at the range end
	sub_t: f64,
	/// then by primitive, so the result does not depend on the tree walk
	tie_break: f64,
}

impl Hit {
	fn new(kind: HitKind, document: i32, t: f64, point: [f64; 3], normal: [f64; 3]) -> Hit {
		Hit {
			kind,
			document,
			t,
			point,
			normal,
			blocking: false,
			limited: false,
			entering: None,
			inside: Inside::No,
			attenuated: false,
			forgiven: false,
			surface: -1,
			barrier: None,
			wall_vertex: None,
			sub_t: 0.0,
			tie_break: 0.0,
		}
	}
}

pub const HIT_STRIDE: usize = 18;

/// The options of a raycast, as the query buffer gives them.
pub struct QueryOptions {
	pub type_index: usize,
	pub edge_direction_mode: u8,
	pub is_above: bool,
	pub use_threshold: bool,
	pub external_radius: f64,
	/// NaN for none (the ray's length)
	pub radius: f64,
	pub t_min: f64,
	pub t_max: f64,
	pub stop: bool,
	/// also keep barriers the ray passes without effect (one-way the other way, or let through by a threshold)
	pub all_barriers: bool,
	/// a hit for each region and token holding an end of the tested range
	pub containing: bool,
	pub walls: bool,
	pub regions: bool,
	pub tokens: bool,
	pub attenuation_multiplier: f64,
	/// None: every level
	pub active_levels: Option<Vec<i32>>,
}

/// Where a barrier lets a ray through, blocks or limits it: normal and limited are the behaviors that block or limit,
/// attenuation_t where a ray an attenuating barrier let through runs out (NaN if none).
struct BarrierResult {
	normal: i32,
	limited: i32,
	attenuation_t: f64,
	deciding: Option<DecidingBarrier>,
}

pub struct Query<'a> {
	pub scene: &'a Scene,
	pub bounds: RayBounds,
	pub origin: [f64; 3],
	pub delta: [f64; 3],
	pub destination: [f64; 2],
	pub axes: u32,
	pub t_min: f64,
	/// the end of the requested range (t_max may move in)
	pub range_end: f64,
	pub type_index: usize,
	pub type_bit: u32,
	edge_direction_mode: u8,
	pub is_above: bool,
	/// lying a hair above (or below) itself, the ray meets a horizontal plane a hair later or earlier
	crossing_moves_later: bool,
	use_threshold: bool,
	pub external_radius: f64,
	pub radius: f64,
	/// in pixels, for thresholds and attenuation, which are measured in 3D
	pub ray_length: f64,
	pub pixels_per_unit: f64,
	pub attenuation_multiplier: f64,
	active_levels: Option<Vec<bool>>,
	stop: bool,
	all_barriers: bool,
	first_limited_t: f64,
	second_limited_t: f64,
	pub hits: Vec<Hit>,
	tie_break: f64,
	sub_t: f64,
	contained_t: f64,
	contained_point: [f64; 3],
	contained_is_ray_end: bool,
}

impl<'a> Query<'a> {
	/// None when the ray tests nothing: no length, or an empty range.
	pub fn begin(scene: &'a Scene, origin: [f64; 3], destination: [f64; 3], options: &QueryOptions) -> Option<Query<'a>> {
		let delta = [destination[0] - origin[0], destination[1] - origin[1], destination[2] - origin[2]];
		let axes = (if delta[0] != 0.0 { AXIS_X } else { 0 }) | (if delta[1] != 0.0 { AXIS_Y } else { 0 }) | (if delta[2] != 0.0 { AXIS_Z } else { 0 });
		let t_min = options.t_min.max(0.0);
		let t_max = options.t_max.min(1.0);
		if axes == 0 || t_min > t_max {
			return None;
		}
		let pixels_per_unit = scene.pixels_per_unit;
		let ray_length = delta[0].hypot(delta[1]).hypot(delta[2] * pixels_per_unit);
		let radius = if options.radius >= 0.0 { options.radius } else { ray_length };
		let active_levels = options.active_levels.as_ref().map(|requested| {
			let mut flags = vec![false; scene.level_count];
			for &level in requested {
				if level >= 0 && (level as usize) < flags.len() {
					flags[level as usize] = true;
				}
			}
			flags
		});
		Some(Query {
			scene,
			bounds: RayBounds { origin, inverse_delta: [1.0 / delta[0], 1.0 / delta[1], 1.0 / delta[2]], axes, t_min, t_max },
			origin,
			delta,
			destination: [destination[0], destination[1]],
			axes,
			t_min,
			range_end: t_max,
			type_index: options.type_index,
			type_bit: 1 << options.type_index,
			edge_direction_mode: options.edge_direction_mode,
			is_above: options.is_above,
			crossing_moves_later: options.is_above == (delta[2] < 0.0),
			use_threshold: options.use_threshold,
			external_radius: options.external_radius,
			radius,
			ray_length,
			pixels_per_unit,
			attenuation_multiplier: options.attenuation_multiplier,
			active_levels,
			stop: options.stop,
			all_barriers: options.all_barriers,
			first_limited_t: f64::INFINITY,
			second_limited_t: f64::INFINITY,
			hits: Vec::new(),
			tie_break: -1.0,
			sub_t: 0.0,
			contained_t: 0.0,
			contained_point: [0.0; 3],
			contained_is_ray_end: false,
		})
	}

	pub fn t_max(&self) -> f64 {
		self.bounds.t_max
	}

	pub fn run(mut self, options: &QueryOptions) -> Vec<Hit> {
		let scene = self.scene;
		if options.containing {
			self.add_volumes_containing(self.t_min, false, options.regions, options.tokens);
			self.add_volumes_containing(self.bounds.t_max, true, options.regions, options.tokens);
		}
		let mut static_mask = 0;
		if self.axes & (AXIS_X | AXIS_Y) != 0 {
			static_mask |= (if options.walls { self.type_bit } else { 0 }) | (if options.regions { REGION_SIDE_MASK } else { 0 });
		}
		if self.axes & AXIS_Z != 0 && options.regions {
			static_mask |= REGION_FACE_MASK;
		}
		// a sloped face can be crossed without climbing
		if options.regions {
			static_mask |= REGION_SLOPE_MASK;
		}
		if static_mask != 0 {
			scene.static_bvh.visit_along_ray(&mut self, |query| &mut query.bounds, static_mask, &mut |query, index| query.visit_static(index));
		}
		if options.tokens {
			scene.token_bvh.visit_along_ray(&mut self, |query| &mut query.bounds, UNIFORM_MASK, &mut |query, index| query.cross_token(index));
		}
		let mut hits = std::mem::take(&mut self.hits);
		hits.sort_by(|first, second| first.t.total_cmp(&second.t).then(first.sub_t.total_cmp(&second.sub_t)).then(first.tie_break.total_cmp(&second.tie_break)));
		if self.stop {
			let t_max = self.bounds.t_max;
			while hits.last().is_some_and(|hit| hit.t > t_max) {
				hits.pop();
			}
		}
		// The first limited crossing is let through and the next blocks. Limited walls joined at the point the ray passes (a window
		// drawn as two segments) are one crossing.
		let Some(first) = hits.iter().position(|hit| hit.blocking && hit.limited) else { return hits };
		let shared_vertex = hits[first].wall_vertex;
		for (index, hit) in hits.iter_mut().enumerate() {
			let joins_first = hit.blocking && hit.limited && hit.wall_vertex.is_some() && shared_vertex.is_some() && hit.wall_vertex == shared_vertex;
			if index != first && !joins_first {
				continue;
			}
			hit.blocking = false;
			hit.forgiven = true;
		}
		hits
	}

	fn add_hit(&mut self, mut hit: Hit) {
		hit.tie_break = self.tie_break;
		hit.sub_t = self.sub_t;
		self.sub_t = 0.0;
		let (t, blocking, limited) = (hit.t, hit.blocking, hit.limited);
		self.hits.push(hit);
		if self.stop && blocking {
			self.lower_t_max(t, limited);
		}
	}

	/// Pull t_max in to the nearest possible final blocker, so the tree walk skips everything behind it. For limited crossings
	/// that is the second distinct t (joined limited walls share a t).
	fn lower_t_max(&mut self, t: f64, limited: bool) {
		if !limited {
			if t < self.bounds.t_max {
				self.bounds.t_max = t;
			}
			return;
		}
		if t == self.first_limited_t || t == self.second_limited_t {
			return;
		}
		if t < self.first_limited_t {
			self.second_limited_t = self.first_limited_t;
			self.first_limited_t = t;
		} else if t < self.second_limited_t {
			self.second_limited_t = t;
		}
		if self.second_limited_t < self.bounds.t_max {
			self.bounds.t_max = self.second_limited_t;
		}
	}

	pub fn point_at(&self, t: f64) -> [f64; 3] {
		[self.origin[0] + self.delta[0] * t, self.origin[1] + self.delta[1] * t, self.origin[2] + self.delta[2] * t]
	}

	/// A horizontal face's crossing passes its exact elevation.
	fn point_at_elevation(&self, t: f64, elevation: f64) -> [f64; 3] {
		[self.origin[0] + self.delta[0] * t, self.origin[1] + self.delta[1] * t, elevation]
	}

	fn horizontal_face_normal(&self) -> [f64; 3] {
		[0.0, 0.0, if self.delta[2] < 0.0 { 1.0 } else { -1.0 }]
	}

	/// Seen from above, within (t_min, t_max], else None.
	fn edge_crossing(&self, start_x: f64, start_y: f64, end_x: f64, end_y: f64) -> Option<Crossing> {
		let found = crossing(self.origin[0], self.origin[1], self.destination[0], self.destination[1], start_x, start_y, end_x, end_y)?;
		(found.t > self.t_min && found.t <= self.bounds.t_max).then_some(found)
	}

	/// Within (t_min, t_max], else NaN. Exactly at an end of the requested range the elevation hair moves the crossing in or out.
	fn plane_crossing_t(&self, elevation: f64, moves_later: bool) -> f64 {
		let t = (elevation - self.origin[2]) / self.delta[2];
		self.within_range(t, moves_later)
	}

	/// climb: how much the ray rises above the plane per unit of t.
	fn slope_crossing_t(&self, plane: Plane, climb: f64, moves_later: bool) -> f64 {
		if climb == 0.0 {
			return f64::NAN;
		}
		let t = (plane.a + plane.b * self.origin[0] + plane.c * self.origin[1] - self.origin[2]) / climb;
		self.within_range(t, moves_later)
	}

	fn within_range(&self, t: f64, moves_later: bool) -> f64 {
		if t == self.t_min {
			return if moves_later { t } else { f64::NAN };
		}
		if t == self.range_end {
			return if moves_later { f64::NAN } else { t };
		}
		if t > self.t_min && t <= self.bounds.t_max { t } else { f64::NAN }
	}

	/// Pixel space, facing the ray's origin.
	fn slope_normal(&self, plane: Plane, climb: f64) -> [f64; 3] {
		let x = -plane.b * self.pixels_per_unit;
		let y = -plane.c * self.pixels_per_unit;
		let scale = (if climb < 0.0 { 1.0 } else { -1.0 }) / x.hypot(y).hypot(1.0);
		[x * scale, y * scale, scale]
	}

	/// [bottom, top) above, (bottom, top] below; an inclusive top makes 'above' [bottom, top].
	fn is_within_height(&self, elevation: f64, bottom: f64, top: f64, top_inclusive: bool) -> bool {
		if !self.is_above {
			return bottom < elevation && elevation <= top;
		}
		bottom <= elevation && if top_inclusive { elevation <= top } else { elevation < top }
	}

	fn is_level_active(&self, level_index: i32) -> bool {
		match &self.active_levels {
			None => true,
			Some(flags) => level_index >= 0 && flags.get(level_index as usize).copied().unwrap_or(false),
		}
	}

	pub fn is_on_active_level(&self, level_indexes: &[i32]) -> bool {
		level_indexes.is_empty() || self.active_levels.is_none() || level_indexes.iter().any(|&level| self.is_level_active(level))
	}

	fn is_token_on_active_level(&self, token: &Token) -> bool {
		self.active_levels.is_none() || token.level_index < 0 || self.is_level_active(token.level_index)
	}

	fn visit_static(&mut self, index: usize) {
		let scene = self.scene;
		self.tie_break = index as f64;
		match &scene.statics[index] {
			Primitive::Wall(wall) => self.cross_wall(wall),
			Primitive::Side(side) => {
				if self.is_on_active_level(&side.level_indexes) {
					let roof = side.roof.map(|roof| &scene.roofs[roof]);
					self.cross_prism_sides(&side.edges, side.bottom, side.top, side.top_inclusive, roof, HitKind::Region, side.document, &side.barriers);
				}
			}
			Primitive::Face(face) => self.cross_region_face(face),
		}
	}

	/// Where an attenuated ray runs out: it blocks. The reach is a distance from the ray's origin, so the ray runs out on a sphere
	/// around the origin, whose normal facing the origin points back along the ray.
	fn add_attenuation_hit(&mut self, document: i32, t: f64, barrier: Option<DecidingBarrier>) {
		let mut hit = Hit::new(HitKind::Attenuation, document, t, self.point_at(t), self.back_along_ray_normal());
		hit.blocking = true;
		hit.barrier = barrier;
		self.add_hit(hit);
	}

	pub fn back_along_ray_normal(&self) -> [f64; 3] {
		let delta_z = self.delta[2] * self.pixels_per_unit;
		let length = self.delta[0].hypot(self.delta[1]).hypot(delta_z);
		[-self.delta[0] / length, -self.delta[1] / length, -delta_z / length]
	}

	/// Scaled to a unit sphere it is a t² + 2 b t + c = 0, with roots (-b ∓ √(b² - a c)) / a. None on a miss.
	pub fn ellipsoid_crossing_ts(&self, center: [f64; 3], radius: [f64; 3]) -> Option<[f64; 2]> {
		let unit_start = [(self.origin[0] - center[0]) / radius[0], (self.origin[1] - center[1]) / radius[1], (self.origin[2] - center[2]) / radius[2]];
		let unit_delta = [self.delta[0] / radius[0], self.delta[1] / radius[1], self.delta[2] / radius[2]];
		let a = unit_delta[0] * unit_delta[0] + unit_delta[1] * unit_delta[1] + unit_delta[2] * unit_delta[2];
		let b = unit_start[0] * unit_delta[0] + unit_start[1] * unit_delta[1] + unit_start[2] * unit_delta[2];
		let c = unit_start[0] * unit_start[0] + unit_start[1] * unit_start[1] + unit_start[2] * unit_start[2] - 1.0;
		let discriminant = b * b - a * c;
		if !(discriminant >= 0.0) {
			return None;
		}
		let root = discriminant.sqrt();
		Some([(-b - root) / a, (-b + root) / a])
	}

	/// toward_origin is 1 at an entry, -1 at an exit.
	pub fn ellipsoid_normal(&self, point: [f64; 3], center: [f64; 3], radius: [f64; 3], toward_origin: f64) -> [f64; 3] {
		let gradient_x = (point[0] - center[0]) / (radius[0] * radius[0]);
		let gradient_y = (point[1] - center[1]) / (radius[1] * radius[1]);
		let gradient_z = (point[2] - center[2]) / (radius[2] * radius[2] * self.pixels_per_unit);
		let length = gradient_x.hypot(gradient_y).hypot(gradient_z);
		let scale = toward_origin / if length != 0.0 { length } else { 1.0 };
		[gradient_x * scale, gradient_y * scale, gradient_z * scale]
	}

	// ---- volumes holding an end of the tested range ----

	/// Crossings cannot tell a ray starting inside a region or token from one never touching it, so each one containing a range
	/// end gets an extra hit there. A volume's hits then always alternate entering and leaving.
	fn add_volumes_containing(&mut self, t: f64, is_ray_end: bool, regions: bool, tokens: bool) {
		let scene = self.scene;
		self.contained_t = t;
		self.contained_is_ray_end = is_ray_end;
		self.contained_point = self.point_at(t);
		let [x, y, z] = self.contained_point;
		if regions {
			let mut found = Vec::new();
			scene.volume_bvh.visit_containing(x, y, z, &mut |index| found.push(index));
			for index in found {
				self.test_region_volume(index);
			}
		}
		if tokens {
			let mut found = Vec::new();
			scene.token_bvh.visit_containing(x, y, z, &mut |index| found.push(index));
			for index in found {
				self.test_token_volume(index);
			}
		}
	}

	fn add_inside_hit(&mut self, kind: HitKind, document: i32, order: usize) {
		let is_ray_end = self.contained_is_ray_end;
		self.tie_break = order as f64;
		self.sub_t = if is_ray_end { 2.0 } else { -2.0 };
		let mut hit = Hit::new(kind, document, self.contained_t, self.contained_point, self.back_along_ray_normal());
		hit.entering = Some(!is_ray_end);
		hit.inside = if is_ray_end { Inside::Destination } else { Inside::Origin };
		self.add_hit(hit);
	}

	fn test_region_volume(&mut self, index: usize) {
		let scene = self.scene;
		let volume = &scene.volumes[index];
		let [x, y, elevation] = self.contained_point;
		let [min_x, min_y, _, max_x, max_y, _] = volume.bounds;
		if x < min_x || x > max_x || y < min_y || y > max_y {
			return;
		}
		let top = match volume.roof {
			Some(roof) => roof_height(&scene.roofs[roof], x, y),
			None => volume.top,
		};
		if !self.is_within_height(elevation, volume.bottom, top, volume.top_inclusive) || !self.is_on_active_level(&volume.level_indexes) {
			return;
		}
		if is_point_inside_edges_toward(&volume.edges, x, y, self.delta[0], self.delta[1], 1.0) {
			self.add_inside_hit(HitKind::Region, volume.document, index);
		}
	}

	fn test_token_volume(&mut self, index: usize) {
		let scene = self.scene;
		let token = &scene.tokens[index];
		if !self.is_token_on_active_level(token) {
			return;
		}
		let [x, y, elevation] = self.contained_point;
		let is_inside = match &token.ellipsoid {
			Some(Ellipsoid { center, radius }) => {
				// in the unit-sphere frame; exactly on the surface counts as inside when heading inward
				let unit = [(x - center[0]) / radius[0], (y - center[1]) / radius[1], (elevation - center[2]) / radius[2]];
				let distance_squared = unit[0] * unit[0] + unit[1] * unit[1] + unit[2] * unit[2];
				let heading_out = (unit[0] * self.delta[0]) / radius[0] + (unit[1] * self.delta[1]) / radius[1] + (unit[2] * self.delta[2]) / radius[2];
				distance_squared < 1.0 || (distance_squared == 1.0 && heading_out < 0.0)
			}
			None => self.is_within_height(elevation, token.bottom, token.top, false) && is_point_inside_edges_toward(&token.edges, x, y, self.delta[0], self.delta[1], 1.0),
		};
		if is_inside {
			self.add_inside_hit(HitKind::Token, token.document, scene.volumes.len() + index);
		}
	}

	// ---- tokens ----

	fn cross_token(&mut self, index: usize) {
		let scene = self.scene;
		let token = &scene.tokens[index];
		if !self.is_token_on_active_level(token) {
			return;
		}
		self.tie_break = (scene.statics.len() + index) as f64;
		if let Some(Ellipsoid { center, radius }) = &token.ellipsoid {
			self.cross_ellipsoid(*center, *radius, token.document);
			return;
		}
		if self.axes & (AXIS_X | AXIS_Y) != 0 {
			self.cross_prism_sides(&token.edges, token.bottom, token.top, false, None, HitKind::Token, token.document, &[]);
		}
		if self.axes & AXIS_Z != 0 {
			self.cross_token_face(token, token.bottom);
			self.cross_token_face(token, token.top);
		}
	}

	fn cross_token_face(&mut self, token: &Token, elevation: f64) {
		let t = self.plane_crossing_t(elevation, self.crossing_moves_later);
		if t.is_nan() {
			return;
		}
		let point = self.point_at_elevation(t, elevation);
		let nudge = if self.crossing_moves_later { 1.0 } else { -1.0 };
		if !is_point_inside_edges_toward(&token.edges, point[0], point[1], self.delta[0], self.delta[1], nudge) {
			return;
		}
		self.sub_t = nudge;
		let mut hit = Hit::new(HitKind::Token, token.document, t, point, self.horizontal_face_normal());
		hit.entering = Some((elevation == token.top) == (self.delta[2] < 0.0));
		self.add_hit(hit);
	}

	fn cross_ellipsoid(&mut self, center: [f64; 3], radius: [f64; 3], document: i32) {
		let Some(ts) = self.ellipsoid_crossing_ts(center, radius) else { return };
		// entry then exit; a tangent ray gets both at one t
		for (root_index, t) in ts.into_iter().enumerate() {
			let root_sign = if root_index == 1 { 1.0 } else { -1.0 };
			if !(t > self.t_min) || t > self.bounds.t_max {
				continue;
			}
			let point = self.point_at(t);
			let mut hit = Hit::new(HitKind::Token, document, t, point, self.ellipsoid_normal(point, center, radius, -root_sign));
			hit.entering = Some(root_sign < 0.0);
			self.add_hit(hit);
		}
	}

	// ---- walls ----

	fn cross_wall(&mut self, wall: &Wall) {
		// the cheap crossing test first: almost every candidate fails it
		let Some(found) = self.edge_crossing(wall.start[0], wall.start[1], wall.end[0], wall.end[1]) else { return };
		if wall.is_door && wall.is_open {
			return;
		}
		let t = found.t;
		let is_at_start = found.start_side == 0.0;
		let is_at_end = !is_at_start && found.end_side == 0.0;

		// one height range per level the wall is on; a ray along a floor meets the walls standing on it, not those below
		let elevation = self.origin[2] + self.delta[2] * t;
		let check_levels = !wall.level_indexes.is_empty();
		let Some(crossed_range) = wall.height_ranges.iter().find(|range| (!check_levels || self.is_level_active(range.level_index)) && self.is_within_height(elevation, range.bottom, range.top, false)) else {
			return;
		};

		// one-way walls as core decides them (ClockwiseSweepPolygon#_testEdgeInclusion); thresholds in 3D
		let sense = wall.senses[self.type_index];
		let mut direction = CrossedDirection::Both;
		let mut is_passed = false;
		if wall.edge_direction != 0 {
			// Edge#orientPoint of the ray's origin
			let orientation = (wall.start[1] - self.origin[1]) * (wall.end[0] - self.origin[0]) - (wall.start[0] - self.origin[0]) * (wall.end[1] - self.origin[1]);
			let origin_side = if orientation == 0.0 { 0 } else if orientation < 0.0 { 1 } else { 2 };
			let is_from_facing_side = origin_side == wall.edge_direction;
			direction = if is_from_facing_side { CrossedDirection::Away } else { CrossedDirection::Towards };
			if self.edge_direction_mode != MODE_BOTH && (self.edge_direction_mode == MODE_NORMAL) == is_from_facing_side {
				is_passed = true;
			}
		}
		let mut attenuation_t = f64::NAN;
		let threshold = wall.thresholds[self.type_index];
		if !is_passed && self.use_threshold && threshold != 0.0 && sense >= SENSE_PROXIMITY {
			let distance = distance_to_wall(wall.start, wall.end, crossed_range.bottom, crossed_range.top, self.origin[0], self.origin[1], self.origin[2], self.pixels_per_unit);
			match threshold_reach(sense, threshold, wall.attenuation, distance, self.radius, self.external_radius, self.attenuation_multiplier) {
				// let through, unlimited; attenuated, the ray runs out at its reach, which blocks here if not past the wall
				Some(reach) if reach == f64::INFINITY => is_passed = true,
				Some(reach) if reach / self.ray_length > t => attenuation_t = reach / self.ray_length,
				_ => {}
			}
		}
		// a wall passed without effect is only a hit for the barrier raycast
		if is_passed && !self.all_barriers {
			return;
		}
		let is_attenuated = !attenuation_t.is_nan();
		let toward_origin = if wall.normal[0] * self.delta[0] + wall.normal[1] * self.delta[1] > 0.0 { -1.0 } else { 1.0 };
		let mut hit = Hit::new(HitKind::Wall, wall.document, t, self.point_at_elevation(t, elevation), [wall.normal[0] * toward_origin, wall.normal[1] * toward_origin, 0.0]);
		hit.blocking = !is_attenuated && !is_passed;
		hit.limited = !is_passed && wall.limited_types & self.type_bit != 0;
		let barrier = DecidingBarrier { sense, direction };
		hit.barrier = Some(barrier);
		hit.attenuated = is_attenuated;
		if hit.limited && (is_at_start || is_at_end) {
			hit.wall_vertex = Some(if is_at_start { wall.start } else { wall.end });
		}
		self.add_hit(hit);
		if is_attenuated && attenuation_t <= self.bounds.t_max {
			self.add_attenuation_hit(wall.document, attenuation_t, Some(barrier));
		}
	}

	// ---- region sides and faces (prism tokens share the side crossing) ----

	/// A region side blocks or limits only through Define Barrier behaviors; tokens never block.
	fn cross_prism_sides(&mut self, edges: &[f64], bottom: f64, top: f64, top_inclusive: bool, roof: Option<&Roof>, kind: HitKind, document: i32, barriers: &[usize]) {
		for edge in edges.chunks_exact(EDGE_STRIDE) {
			let Some(found) = self.edge_crossing(edge[0], edge[1], edge[EDGE_END_X], edge[EDGE_END_Y]) else { continue };
			if !found.is_counted() {
				continue;
			}
			let t = found.t;
			let elevation = self.origin[2] + self.delta[2] * t;
			// a roofed region's side reaches up to its roof where the ray crosses it
			let side_top = match roof {
				Some(roof) => roof_height(roof, self.origin[0] + self.delta[0] * t, self.origin[1] + self.delta[1] * t),
				None => top,
			};
			if !self.is_within_height(elevation, bottom, side_top, top_inclusive) {
				continue;
			}
			let point = self.point_at_elevation(t, elevation);
			let (normal_x, normal_y) = (edge[EDGE_NORMAL_X], edge[EDGE_NORMAL_Y]);
			let is_entering = normal_x * self.delta[0] + normal_y * self.delta[1] < 0.0;
			let toward_origin = if is_entering { 1.0 } else { -1.0 };
			// two edges counted at one corner are ordered as the shifted ray meets them, kept within (-0.5, 0.5)
			if found.is_corner() {
				let corner_is_start = found.start_side == 0.0;
				let along_x = if corner_is_start { edge[EDGE_END_X] - edge[0] } else { edge[0] - edge[EDGE_END_X] };
				let along_y = if corner_is_start { edge[EDGE_END_Y] - edge[1] } else { edge[1] - edge[EDGE_END_Y] };
				let along_ray = along_x * self.delta[0] + along_y * self.delta[1];
				let toward_side = along_x * self.delta[1] - along_y * self.delta[0];
				self.sub_t = (along_ray / toward_side).atan() / std::f64::consts::PI;
			}
			let mut hit = Hit::new(kind, document, t, point, [normal_x * toward_origin, normal_y * toward_origin, 0.0]);
			hit.entering = Some(is_entering);
			if barriers.is_empty() {
				self.add_hit(hit);
				continue;
			}
			let (origin, pixels_per_unit) = (self.origin, self.pixels_per_unit);
			let mut distance = || distance_to_side(edge, bottom, top, roof, origin[0], origin[1], origin[2], pixels_per_unit);
			let result = self.resolve_barriers(barriers, is_entering, &mut distance, t);
			if result.normal >= 0 || result.limited >= 0 {
				hit.blocking = true;
				hit.limited = result.normal < 0;
				hit.surface = if result.normal >= 0 { result.normal } else { result.limited };
			}
			hit.barrier = result.deciding;
			self.add_barrier_hit(hit, Some(&result));
		}
	}

	fn cross_region_face(&mut self, face: &RegionFace) {
		// How fast the ray climbs above the face, per unit of t: its own climb for a flat face, less the plane's rise along the ray
		// for a sloped one. Climbing decides which way the ray crosses it, and the ties, as climbing does for a flat face.
		let climb = match face.plane {
			Some(plane) => self.delta[2] - plane.b * self.delta[0] - plane.c * self.delta[1],
			None => self.delta[2],
		};
		// an inclusive top sits a hair above its elevation (a flat region's single face does not), higher than the ray's own hair, so
		// the ray is always below it and crosses it later going up
		let is_lifted = face.top_inclusive && face.is_top && face.top > face.bottom;
		let moves_later = if is_lifted { climb > 0.0 } else { self.is_above == (climb < 0.0) };
		let t = match face.plane {
			Some(plane) => self.slope_crossing_t(plane, climb, moves_later),
			None => self.plane_crossing_t(face.elevation, moves_later),
		};
		if t.is_nan() || !self.is_on_active_level(&face.level_indexes) {
			return;
		}
		let point = if face.plane.is_some() { self.point_at(t) } else { self.point_at_elevation(t, face.elevation) };
		let nudge = if moves_later { 1.0 } else { -1.0 };
		if !is_point_inside_edges_toward(&face.edges, point[0], point[1], self.delta[0], self.delta[1], nudge) {
			return;
		}
		// down through the top or up through the bottom goes in; a flat region has no inside (a one-way barrier on one goes in going
		// down)
		let has_inside = face.top > face.bottom;
		let is_entering = if has_inside { face.is_top == (climb < 0.0) } else { climb < 0.0 };
		let result = if face.barriers.is_empty() {
			None
		} else {
			let (origin, pixels_per_unit, delta) = (self.origin, self.pixels_per_unit, self.delta);
			let mut distance = || distance_to_face(&face.edges, face.elevation, face.plane, origin[0], origin[1], origin[2], pixels_per_unit, delta[0], delta[1]);
			Some(self.resolve_barriers(&face.barriers, is_entering, &mut distance, t))
		};
		// core's surfaces block the types they restrict, as do barriers restricting fully; a barrier only limiting limits
		let core_surface = face.surfaces.iter().find(|surface| surface.types & self.type_bit != 0).map(|surface| surface.behavior);
		let normal_surface = core_surface.or(result.as_ref().map(|result| result.normal).filter(|&behavior| behavior >= 0));
		let limited_surface = if normal_surface.is_some() { None } else { result.as_ref().map(|result| result.limited).filter(|&behavior| behavior >= 0) };
		let normal = match face.plane {
			Some(plane) => self.slope_normal(plane, climb),
			None => self.horizontal_face_normal(),
		};
		let mut hit = Hit::new(HitKind::Region, face.document, t, point, normal);
		hit.blocking = normal_surface.is_some() || limited_surface.is_some();
		hit.limited = limited_surface.is_some();
		hit.surface = normal_surface.or(limited_surface).unwrap_or(-1);
		if has_inside {
			hit.entering = Some(is_entering);
		}
		hit.barrier = if core_surface.is_some() { Some(CORE_SURFACE_BARRIER) } else { result.as_ref().and_then(|result| result.deciding) };
		self.sub_t = nudge;
		self.add_barrier_hit(hit, result.as_ref());
	}

	/// One let through by an attenuating barrier runs out further on, which blocks.
	fn add_barrier_hit(&mut self, mut hit: Hit, result: Option<&BarrierResult>) {
		let attenuation_t = result.map_or(f64::NAN, |result| result.attenuation_t);
		let is_attenuated = !hit.blocking && !attenuation_t.is_nan();
		hit.attenuated = is_attenuated;
		let (document, deciding) = (hit.document, result.and_then(|result| result.deciding));
		self.add_hit(hit);
		if is_attenuated && attenuation_t <= self.bounds.t_max {
			self.add_attenuation_hit(document, attenuation_t, deciding);
		}
	}

	/// As a wall would. deciding is the barrier that decided the crossing: the first that blocks, else limits, else the nearest
	/// attenuating one, else the first the ray passes without effect.
	fn resolve_barriers(&self, barriers: &[usize], is_entering: bool, distance_to_barrier: &mut impl FnMut() -> f64, t: f64) -> BarrierResult {
		let mut result = BarrierResult { normal: -1, limited: -1, attenuation_t: f64::NAN, deciding: None };
		let (mut normal_barrier, mut limited_barrier, mut attenuating_barrier, mut passed_barrier) = (None, None, None, None);
		let mut distance: Option<f64> = None;
		for &index in barriers {
			let barrier = &self.scene.barriers[index];
			let sense = barrier.senses[self.type_index];
			if sense == SENSE_NONE {
				continue;
			}
			let direction = if barrier.direction == BarrierDirection::Both {
				CrossedDirection::Both
			} else if (barrier.direction == BarrierDirection::In) == is_entering {
				CrossedDirection::Towards
			} else {
				CrossedDirection::Away
			};
			let crossed = DecidingBarrier { sense, direction };
			if !self.barrier_blocks_this_way(barrier.direction, is_entering) {
				passed_barrier = passed_barrier.or(Some(crossed));
				continue;
			}
			let threshold = barrier.thresholds[self.type_index];
			if self.use_threshold && threshold != 0.0 && sense >= SENSE_PROXIMITY {
				let distance = *distance.get_or_insert_with(&mut *distance_to_barrier);
				match threshold_reach(sense, threshold, barrier.attenuation, distance, self.radius, self.external_radius, self.attenuation_multiplier) {
					Some(reach) if reach == f64::INFINITY => {
						passed_barrier = passed_barrier.or(Some(crossed));
						continue;
					}
					reach => {
						// attenuated: the ray runs out at its reach (the nearest of them), or is restricted here if that is not past it
						let attenuation_t = reach.map_or(f64::NAN, |reach| reach / self.ray_length);
						if attenuation_t > t {
							if !(attenuation_t >= result.attenuation_t) {
								result.attenuation_t = attenuation_t;
								attenuating_barrier = Some(crossed);
							}
							continue;
						}
					}
				}
			}
			if sense == SENSE_LIMITED {
				if result.limited < 0 {
					result.limited = barrier.behavior;
					limited_barrier = Some(crossed);
				}
			} else if result.normal < 0 {
				result.normal = barrier.behavior;
				normal_barrier = Some(crossed);
			}
		}
		result.deciding = normal_barrier.or(limited_barrier).or(attenuating_barrier).or(passed_barrier);
		result
	}

	/// As for one-way walls, edgeDirectionMode reverses (REVERSED) or ignores (BOTH) a one-way barrier's direction.
	fn barrier_blocks_this_way(&self, direction: BarrierDirection, is_entering: bool) -> bool {
		if direction == BarrierDirection::Both || self.edge_direction_mode == MODE_BOTH {
			return true;
		}
		((direction == BarrierDirection::In) == is_entering) != (self.edge_direction_mode == MODE_REVERSED)
	}
}

/// The query buffer, laid out as flat f64s (scripts/raycast/query.js writes it): slot, originX, originY, originElevation,
/// destinationX, destinationY, destinationElevation, type index, edgeDirectionMode, above (0 / 1), useThreshold, externalRadius,
/// radius (NaN for none), range min, range max, stop, all barriers, containing, walls, regions, tokens, attenuation multiplier,
/// active level count (-1 for every level), then each level index.
pub fn read_query(reader: &mut Reader) -> (usize, [f64; 3], [f64; 3], QueryOptions) {
	let slot = reader.count();
	let origin = [reader.next(), reader.next(), reader.next()];
	let destination = [reader.next(), reader.next(), reader.next()];
	let type_index = reader.count();
	let edge_direction_mode = reader.next() as u8;
	let is_above = reader.flag();
	let use_threshold = reader.flag();
	let external_radius = reader.next();
	let radius = reader.next();
	let t_min = reader.next();
	let t_max = reader.next();
	let stop = reader.flag();
	let all_barriers = reader.flag();
	let containing = reader.flag();
	let walls = reader.flag();
	let regions = reader.flag();
	let tokens = reader.flag();
	let attenuation_multiplier = reader.next();
	let level_count = reader.next();
	let active_levels = (level_count >= 0.0).then(|| reader.take(level_count as usize).iter().map(|&level| level as i32).collect());
	let options = QueryOptions {
		type_index,
		edge_direction_mode,
		is_above,
		use_threshold,
		external_radius,
		radius,
		t_min,
		t_max,
		stop,
		all_barriers,
		containing,
		walls,
		regions,
		tokens,
		attenuation_multiplier,
		active_levels,
	};
	(slot, origin, destination, options)
}

/// Each hit as HIT_STRIDE f64s: kind (0 wall, 1 region, 2 token, 3 attenuation), document, t, x, y, elevation, normal x, y, z,
/// blocking, limited, entering (-1 none, 0, 1), inside (0 no, 1 origin, 2 destination), attenuated, forgiven, surface (-1 none),
/// barrier sense (-1 none), barrier direction (0 both, 1 towards, 2 away).
fn write_hits(hits: &[Hit], output: &mut Vec<f64>) {
	output.clear();
	output.push(hits.len() as f64);
	for hit in hits {
		output.extend_from_slice(&[
			hit.kind as u8 as f64,
			hit.document as f64,
			hit.t,
			hit.point[0],
			hit.point[1],
			hit.point[2],
			hit.normal[0],
			hit.normal[1],
			hit.normal[2],
			hit.blocking as u8 as f64,
			hit.limited as u8 as f64,
			hit.entering.map_or(-1.0, |entering| entering as u8 as f64),
			hit.inside as u8 as f64,
			hit.attenuated as u8 as f64,
			hit.forgiven as u8 as f64,
			hit.surface as f64,
			hit.barrier.map_or(-1.0, |barrier| barrier.sense as f64),
			hit.barrier.map_or(0.0, |barrier| barrier.direction as u8 as f64),
		]);
	}
}

/// Casts the ray in the input buffer (read_query); returns how many f64s the output buffer holds (write_hits). A scene slot
/// that holds nothing casts nothing.
#[unsafe(no_mangle)]
pub extern "C" fn raycast() -> usize {
	let hits = INPUT.with(|input| {
		let input = input.borrow();
		let mut reader = Reader::new(&input);
		let (slot, origin, destination, options) = read_query(&mut reader);
		with_scene(slot, |scene| Query::begin(scene, origin, destination, &options).map(|query| query.run(&options)).unwrap_or_default()).unwrap_or_default()
	});
	OUTPUT.with(|output| {
		let mut output = output.borrow_mut();
		write_hits(&hits, &mut output);
		output.len()
	})
}
