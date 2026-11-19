//! The scenes the raycast and the floor lighting work on, kept in WebAssembly memory and updated in parts: JavaScript reads
//! the Foundry documents (scripts/spatial/index.js) and uploads a scene's static part (walls, regions and their roofs,
//! barriers and surfaces) whenever any of it changes, its tokens whenever one moves, its light and darkness sources when they
//! change (scripts/raycast/sources.js), and a door's state when it opens or closes. Documents are numbered by JavaScript;
//! results name them by number.

use crate::bvh::Bvh;
use crate::geometry::{Path, Plane};
use crate::reader::Reader;
use crate::sources::SeenBarrier;
use std::cell::{Cell, RefCell};
use std::rc::Rc;

/// Restriction types in core's order (CONST.EDGE_RESTRICTION_TYPES), which bit masks follow.
pub const TYPE_COUNT: usize = 5;
pub const REGION_SIDE_MASK: u32 = 1 << 8;
pub const REGION_FACE_MASK: u32 = 1 << 9;
/// A ray can cross a sloped face without climbing, so every ray walks them.
pub const REGION_SLOPE_MASK: u32 = 1 << 10;
pub const UNIFORM_MASK: u32 = 1;

/// CONST.EDGE_SENSE_TYPES
pub const SENSE_NONE: u8 = 0;
pub const SENSE_LIMITED: u8 = 10;
pub const SENSE_NORMAL: u8 = 20;
pub const SENSE_PROXIMITY: u8 = 30;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum BarrierDirection {
	Both,
	In,
	Out,
}

/// A Define Barrier behavior's restrictions (spatial/barriers.js regionBarriers). Thresholds are pixels, 0 for none.
pub struct Barrier {
	pub behavior: i32,
	pub senses: [u8; TYPE_COUNT],
	pub thresholds: [f64; TYPE_COUNT],
	pub attenuation: bool,
	pub direction: BarrierDirection,
}

pub struct RoofPiece {
	pub plane: Plane,
	/// min_x, min_y, max_x, max_y
	pub bounds: [f64; 4],
	pub edges: Vec<f64>,
	pub paths: Vec<Path>,
}

/// A region's roofed top (spatial/roofs.js): the lowest of its planes when convex (never below `floor`), else the plane of
/// the piece a point is in.
pub struct Roof {
	pub is_lowest: bool,
	pub floor: f64,
	pub planes: Vec<Plane>,
	pub pieces: Vec<RoofPiece>,
	/// the piece found last, tried first: points asked one after another mostly fall in the same one
	pub last_piece: Cell<usize>,
}

pub struct HeightRange {
	/// -1 for a wall on no level
	pub level_index: i32,
	pub bottom: f64,
	pub top: f64,
}

pub struct Wall {
	pub document: i32,
	pub is_door: bool,
	/// read live in JavaScript before; set by scene_set_door_open
	pub is_open: bool,
	pub senses: [u8; TYPE_COUNT],
	pub limited_types: u32,
	pub level_indexes: Vec<i32>,
	pub height_ranges: Vec<HeightRange>,
	pub start: [f64; 2],
	pub end: [f64; 2],
	pub normal: [f64; 2],
	/// its edge's CONST.EDGE_DIRECTIONS: 0 both, 1 left, 2 right
	pub edge_direction: u8,
	/// its edge's thresholds in pixels, 0 for none
	pub thresholds: [f64; TYPE_COUNT],
	pub attenuation: bool,
}

/// A run of a region's outline edges (flat: startX, startY, endX, endY, normalX, normalY), standing from bottom to top (or its roof).
pub struct RegionSide {
	pub document: i32,
	pub bottom: f64,
	pub top: f64,
	pub top_inclusive: bool,
	pub level_indexes: Vec<i32>,
	pub barriers: Vec<usize>,
	pub roof: Option<usize>,
	pub edges: Vec<f64>,
}

pub struct Surface {
	pub types: u32,
	pub behavior: i32,
}

/// A region's bottom or top face, or one piece of a roofed top (with its plane).
pub struct RegionFace {
	pub document: i32,
	pub elevation: f64,
	pub is_top: bool,
	pub bottom: f64,
	pub top: f64,
	pub top_inclusive: bool,
	pub level_indexes: Vec<i32>,
	pub surfaces: Vec<Surface>,
	pub barriers: Vec<usize>,
	pub plane: Option<Plane>,
	pub is_shown: bool,
	pub is_convex_solid: bool,
	pub edges: Vec<f64>,
	/// a roof piece's paths
	pub paths: Vec<Path>,
}

pub enum Primitive {
	Wall(Wall),
	Side(RegionSide),
	Face(RegionFace),
}

/// A region's inside, for which regions hold a point.
pub struct RegionVolume {
	pub document: i32,
	pub bounds: [f64; 6],
	pub bottom: f64,
	pub top: f64,
	pub top_inclusive: bool,
	pub level_indexes: Vec<i32>,
	pub roof: Option<usize>,
	pub edges: Vec<f64>,
}

pub struct Ellipsoid {
	pub center: [f64; 3],
	pub radius: [f64; 3],
}

/// A prism from bottom to top over its footprint's edges, or an ellipsoid.
pub struct Token {
	pub document: i32,
	/// read live in JavaScript before; -1 when its level is unknown (then on every level)
	pub level_index: i32,
	pub bottom: f64,
	pub top: f64,
	pub ellipsoid: Option<Ellipsoid>,
	pub edges: Vec<f64>,
}

pub struct Occluder {
	pub bounds: [f64; 4],
	pub edges: Vec<f64>,
}

/// A light or darkness source's volume (raycast/sources.js): a sphere cut to its polygon without walls, and by occluders.
pub struct SourceVolume {
	pub is_darkness: bool,
	/// the types it restricts, as a mask
	pub types: u32,
	/// its own type (light or darkness), whose barriers cut it
	pub own_type: usize,
	pub priority: f64,
	pub sphere: bool,
	pub center: [f64; 3],
	pub radius_xy: f64,
	pub radius_z: f64,
	/// min_x, min_y, max_x, max_y
	pub bounds: [f64; 4],
	pub edges: Vec<f64>,
	pub occluders: Vec<Occluder>,
}

#[derive(Default)]
pub struct Scene {
	pub pixels_per_unit: f64,
	pub level_count: usize,
	pub roofs: Vec<Roof>,
	pub barriers: Vec<Barrier>,
	pub statics: Vec<Primitive>,
	pub static_bvh: Bvh,
	pub volumes: Vec<RegionVolume>,
	pub volume_bvh: Bvh,
	/// each region's area (its outlines united even-odd), by document, for flat floors
	pub region_areas: Vec<(i32, Vec<Path>)>,
	pub tokens: Vec<Token>,
	pub token_bvh: Bvh,
	pub sources: Vec<SourceVolume>,
	/// bumped on every static upload, so caches built from the static part know when it changed
	pub static_generation: u32,
	/// what each source volume sees, which depends on the source alone, so it is worked out once per volume and static upload
	/// rather than for every ray
	seen_by_source: RefCell<Vec<Option<(u32, Rc<Vec<SeenBarrier>>)>>>,
}

fn read_box(reader: &mut Reader) -> [f64; 6] {
	reader.take(6).try_into().unwrap()
}

fn read_senses(reader: &mut Reader) -> [u8; TYPE_COUNT] {
	let mut senses = [0; TYPE_COUNT];
	for sense in &mut senses {
		*sense = reader.next() as u8;
	}
	senses
}

fn read_thresholds(reader: &mut Reader) -> [f64; TYPE_COUNT] {
	reader.take(TYPE_COUNT).try_into().unwrap()
}

fn read_plane(reader: &mut Reader) -> Plane {
	Plane { a: reader.next(), b: reader.next(), c: reader.next() }
}

fn read_barrier_indices(reader: &mut Reader) -> Vec<usize> {
	reader.indices().into_iter().map(|index| index as usize).collect()
}

fn read_roof_index(reader: &mut Reader) -> Option<usize> {
	let index = reader.index();
	(index >= 0).then_some(index as usize)
}

impl Scene {
	/// The static part, laid out as flat f64s (scripts/spatial/index.js writes it):
	/// - pixels per grid unit, level count
	/// - roof count, then each: lowest (0 / 1), floor, planes (count, then a, b, c each), pieces (count, then each: a, b, c, bounds
	///   minX, minY, maxX, maxY, edges (count, then the f64s), paths)
	/// - barrier count, then each: behavior, senses ×5, thresholds ×5, attenuation, direction (0 both, 1 in, 2 out)
	/// - primitive count, then each: kind (0 wall, 1 region side, 2 region face), mask, box ×6, then
	///   - wall: document, door, open, senses ×5, limited types, level indexes (count, then each), height ranges (count, then
	///     level index, bottom, top each), startX, startY, endX, endY, normalX, normalY, edge direction, thresholds ×5, attenuation
	///   - side: document, bottom, top, top inclusive, level indexes, barrier indices (count, then each), roof (-1 none), edges
	///   - face: document, elevation, top (0 / 1), bottom, top, top inclusive, level indexes, surfaces (count, then types and
	///     behavior each), barrier indices, sloped (0 / 1), a, b, c, shown, convex solid, edges, paths
	/// - region volume count, then each: document, box ×6, bottom, top, top inclusive, level indexes, roof, edges
	/// - region area count, then each: document, paths
	pub fn upload_static(&mut self, data: &[f64]) {
		let mut reader = Reader::new(data);
		self.pixels_per_unit = reader.next();
		self.level_count = reader.count();
		let roof_count = reader.count();
		self.roofs = (0..roof_count)
			.map(|_| {
				let is_lowest = reader.flag();
				let floor = reader.next();
				let plane_count = reader.count();
				let planes = (0..plane_count).map(|_| read_plane(&mut reader)).collect();
				let piece_count = reader.count();
				let pieces = (0..piece_count)
					.map(|_| {
						let plane = read_plane(&mut reader);
						let bounds = reader.take(4).try_into().unwrap();
						let edges = reader.list();
						let paths = reader.paths();
						RoofPiece { plane, bounds, edges, paths }
					})
					.collect();
				Roof { is_lowest, floor, planes, pieces, last_piece: Cell::new(0) }
			})
			.collect();
		let barrier_count = reader.count();
		self.barriers = (0..barrier_count)
			.map(|_| {
				let behavior = reader.index();
				let senses = read_senses(&mut reader);
				let thresholds = read_thresholds(&mut reader);
				let attenuation = reader.flag();
				let direction = match reader.count() {
					1 => BarrierDirection::In,
					2 => BarrierDirection::Out,
					_ => BarrierDirection::Both,
				};
				Barrier { behavior, senses, thresholds, attenuation, direction }
			})
			.collect();
		let primitive_count = reader.count();
		let mut statics = Vec::with_capacity(primitive_count);
		let mut boxes = Vec::with_capacity(primitive_count * 6);
		let mut masks = Vec::with_capacity(primitive_count);
		for _ in 0..primitive_count {
			let kind = reader.count();
			masks.push(reader.next() as u32);
			boxes.extend_from_slice(&read_box(&mut reader));
			statics.push(match kind {
				0 => {
					let document = reader.index();
					let is_door = reader.flag();
					let is_open = reader.flag();
					let senses = read_senses(&mut reader);
					let limited_types = reader.next() as u32;
					let level_indexes = reader.indices();
					let range_count = reader.count();
					let height_ranges = (0..range_count).map(|_| HeightRange { level_index: reader.index(), bottom: reader.next(), top: reader.next() }).collect();
					let start = [reader.next(), reader.next()];
					let end = [reader.next(), reader.next()];
					let normal = [reader.next(), reader.next()];
					let edge_direction = reader.next() as u8;
					let thresholds = read_thresholds(&mut reader);
					let attenuation = reader.flag();
					Primitive::Wall(Wall { document, is_door, is_open, senses, limited_types, level_indexes, height_ranges, start, end, normal, edge_direction, thresholds, attenuation })
				}
				1 => {
					let document = reader.index();
					let bottom = reader.next();
					let top = reader.next();
					let top_inclusive = reader.flag();
					let level_indexes = reader.indices();
					let barriers = read_barrier_indices(&mut reader);
					let roof = read_roof_index(&mut reader);
					let edges = reader.list();
					Primitive::Side(RegionSide { document, bottom, top, top_inclusive, level_indexes, barriers, roof, edges })
				}
				_ => {
					let document = reader.index();
					let elevation = reader.next();
					let is_top = reader.flag();
					let bottom = reader.next();
					let top = reader.next();
					let top_inclusive = reader.flag();
					let level_indexes = reader.indices();
					let surface_count = reader.count();
					let surfaces = (0..surface_count).map(|_| Surface { types: reader.next() as u32, behavior: reader.index() }).collect();
					let barriers = read_barrier_indices(&mut reader);
					let sloped = reader.flag();
					let plane = read_plane(&mut reader);
					let is_shown = reader.flag();
					let is_convex_solid = reader.flag();
					let edges = reader.list();
					let paths = reader.paths();
					Primitive::Face(RegionFace {
						document,
						elevation,
						is_top,
						bottom,
						top,
						top_inclusive,
						level_indexes,
						surfaces,
						barriers,
						plane: sloped.then_some(plane),
						is_shown,
						is_convex_solid,
						edges,
						paths,
					})
				}
			});
		}
		self.static_bvh = Bvh::new(boxes, &masks, self.pixels_per_unit);
		self.statics = statics;
		let volume_count = reader.count();
		let mut volume_boxes = Vec::with_capacity(volume_count * 6);
		self.volumes = (0..volume_count)
			.map(|_| {
				let document = reader.index();
				let bounds = read_box(&mut reader);
				volume_boxes.extend_from_slice(&bounds);
				let bottom = reader.next();
				let top = reader.next();
				let top_inclusive = reader.flag();
				let level_indexes = reader.indices();
				let roof = read_roof_index(&mut reader);
				let edges = reader.list();
				RegionVolume { document, bounds, bottom, top, top_inclusive, level_indexes, roof, edges }
			})
			.collect();
		self.volume_bvh = Bvh::new(volume_boxes, &vec![UNIFORM_MASK; volume_count], self.pixels_per_unit);
		let area_count = reader.count();
		self.region_areas = (0..area_count).map(|_| (reader.index(), reader.paths())).collect();
		self.static_generation = self.static_generation.wrapping_add(1);
	}

	pub fn seen_by_source(&self, volume: usize, compute: impl FnOnce() -> Vec<SeenBarrier>) -> Rc<Vec<SeenBarrier>> {
		if let Some(Some((generation, seen))) = self.seen_by_source.borrow().get(volume) {
			if *generation == self.static_generation {
				return seen.clone();
			}
		}
		let seen = Rc::new(compute());
		let mut cache = self.seen_by_source.borrow_mut();
		if cache.len() <= volume {
			cache.resize(volume + 1, None);
		}
		cache[volume] = Some((self.static_generation, seen.clone()));
		seen
	}

	/// Tokens, laid out as: count, then each: document, level index (-1 unknown), box ×6, bottom, top, ellipsoid (0 / 1), then
	/// centerX, centerY, centerZ, radiusX, radiusY, radiusZ for an ellipsoid or the footprint's edges for a prism.
	pub fn upload_tokens(&mut self, data: &[f64]) {
		let mut reader = Reader::new(data);
		let count = reader.count();
		let mut boxes = Vec::with_capacity(count * 6);
		self.tokens = (0..count)
			.map(|_| {
				let document = reader.index();
				let level_index = reader.index();
				boxes.extend_from_slice(&read_box(&mut reader));
				let bottom = reader.next();
				let top = reader.next();
				let (ellipsoid, edges) = if reader.flag() {
					let values = reader.take(6);
					(Some(Ellipsoid { center: [values[0], values[1], values[2]], radius: [values[3], values[4], values[5]] }), Vec::new())
				} else {
					(None, reader.list())
				};
				Token { document, level_index, bottom, top, ellipsoid, edges }
			})
			.collect();
		self.token_bvh = Bvh::new(boxes, &vec![UNIFORM_MASK; count], self.pixels_per_unit);
	}

	/// Source volumes, laid out as: count, then each: darkness (0 / 1), types mask, own type index, priority, sphere (0 / 1),
	/// centerX, centerY, centerZ, radiusXY, radiusZ, bounds minX, minY, maxX, maxY, edges, occluders (count, then each: bounds
	/// ×4, edges).
	pub fn upload_sources(&mut self, data: &[f64]) {
		let mut reader = Reader::new(data);
		let count = reader.count();
		self.sources = (0..count)
			.map(|_| {
				let is_darkness = reader.flag();
				let types = reader.next() as u32;
				let own_type = reader.count();
				let priority = reader.next();
				let sphere = reader.flag();
				let center = [reader.next(), reader.next(), reader.next()];
				let radius_xy = reader.next();
				let radius_z = reader.next();
				let bounds = reader.take(4).try_into().unwrap();
				let edges = reader.list();
				let occluder_count = reader.count();
				let occluders = (0..occluder_count).map(|_| Occluder { bounds: reader.take(4).try_into().unwrap(), edges: reader.list() }).collect();
				SourceVolume { is_darkness, types, own_type, priority, sphere, center, radius_xy, radius_z, bounds, edges, occluders }
			})
			.collect();
		self.seen_by_source.borrow_mut().clear();
	}
}

thread_local! {
	static SCENES: RefCell<Vec<Option<Scene>>> = const { RefCell::new(Vec::new()) };
	/// what JavaScript writes uploads and queries into
	pub static INPUT: RefCell<Vec<f64>> = const { RefCell::new(Vec::new()) };
	/// what results are written into
	pub static OUTPUT: RefCell<Vec<f64>> = const { RefCell::new(Vec::new()) };
}

pub fn with_scene<T>(slot: usize, run: impl FnOnce(&Scene) -> T) -> Option<T> {
	SCENES.with(|scenes| scenes.borrow().get(slot).and_then(Option::as_ref).map(run))
}

fn with_scene_mut(slot: usize, run: impl FnOnce(&mut Scene)) {
	SCENES.with(|scenes| {
		if let Some(Some(scene)) = scenes.borrow_mut().get_mut(slot) {
			run(scene);
		}
	});
}

fn with_input<T>(run: impl FnOnce(&[f64]) -> T) -> T {
	INPUT.with(|input| run(&input.borrow()))
}

/// A new, empty scene; returns its slot.
#[unsafe(no_mangle)]
pub extern "C" fn scene_create() -> usize {
	SCENES.with(|scenes| {
		let mut scenes = scenes.borrow_mut();
		if let Some(free) = scenes.iter().position(Option::is_none) {
			scenes[free] = Some(Scene::default());
			return free;
		}
		scenes.push(Some(Scene::default()));
		scenes.len() - 1
	})
}

#[unsafe(no_mangle)]
pub extern "C" fn scene_free(slot: usize) {
	SCENES.with(|scenes| {
		if let Some(entry) = scenes.borrow_mut().get_mut(slot) {
			*entry = None;
		}
	});
}

/// The static part from the input buffer (Scene::upload_static).
#[unsafe(no_mangle)]
pub extern "C" fn scene_upload_static(slot: usize) {
	with_input(|data| with_scene_mut(slot, |scene| scene.upload_static(data)));
}

/// The tokens from the input buffer (Scene::upload_tokens).
#[unsafe(no_mangle)]
pub extern "C" fn scene_upload_tokens(slot: usize) {
	with_input(|data| with_scene_mut(slot, |scene| scene.upload_tokens(data)));
}

/// The source volumes from the input buffer (Scene::upload_sources).
#[unsafe(no_mangle)]
pub extern "C" fn scene_upload_sources(slot: usize) {
	with_input(|data| with_scene_mut(slot, |scene| scene.upload_sources(data)));
}

/// A door wall's state, by its primitive's index in the static upload.
#[unsafe(no_mangle)]
pub extern "C" fn scene_set_door_open(slot: usize, primitive: usize, is_open: bool) {
	with_scene_mut(slot, |scene| {
		if let Some(Primitive::Wall(wall)) = scene.statics.get_mut(primitive) {
			wall.is_open = is_open;
		}
	});
}

/// The input buffer, grown to hold `length` f64s, for JavaScript to write into. Shared by uploads, queries and the floor
/// lighting.
#[unsafe(no_mangle)]
pub extern "C" fn input_buffer(length: usize) -> *mut f64 {
	INPUT.with(|input| {
		let mut input = input.borrow_mut();
		input.resize(length, 0.0);
		input.as_mut_ptr()
	})
}

#[unsafe(no_mangle)]
pub extern "C" fn output_buffer() -> *const f64 {
	OUTPUT.with(|output| output.borrow().as_ptr())
}
