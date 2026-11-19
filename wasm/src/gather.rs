//! Gathers a source's floor lighting input (the layout lib.rs's prepare reads) from the scene store: the floors at or below the
//! source, and every barrier between them and the source with its restriction as seen from there. scripts/perception/floors.js
//! asks for it, then lights it here or hands it to its workers.

use crate::geometry::{Path, Plane, bounding_box, union};
use crate::reader::Reader;
use crate::rules::{ELEVATION_HAIR, RestrictionKind, SourceSight};
use crate::sources::{SeenBarrier, SeenFrom, SeenShape, barriers_seen_from};
use crate::store::*;
use std::collections::BTreeMap;

/// Floors above the source's level, which no document stands for, are numbered past every document.
const ABOVE_LEVEL_DOCUMENT_BASE: f64 = 1e9;

struct SceneLevel {
	bottom: f64,
	top: f64,
	is_drawn: bool,
}

fn push_paths(output: &mut Vec<f64>, paths: &[Path]) {
	output.push(paths.len() as f64);
	for path in paths {
		output.push((path.len() / 2) as f64);
		output.extend_from_slice(path);
	}
}

/// The gather query, laid out as flat f64s (scripts/perception/floors.js writes it): slot, sourceX, sourceY, sourceElevation,
/// type index, radius, externalRadius, useThreshold, box minX, minY, maxX, maxY, attenuation multiplier, base elevation, the top
/// of the source's level, active level count (-1 for every level) then each index, scene level count then each: bottom, top,
/// drawn (0 / 1).
fn gather(data: &[f64], output: &mut Vec<f64>) {
	let mut reader = Reader::new(data);
	let slot = reader.count();
	let (sx, sy, sz) = (reader.next(), reader.next(), reader.next());
	let type_index = reader.count();
	let radius = reader.next();
	let external_radius = reader.next();
	let use_threshold = reader.flag();
	let (min_x, min_y, max_x, max_y) = (reader.next(), reader.next(), reader.next(), reader.next());
	let attenuation_multiplier = reader.next();
	let base_elevation = reader.next();
	let level_top = reader.next();
	let active_count = reader.next();
	let active_levels: Option<Vec<i32>> = (active_count >= 0.0).then(|| reader.take(active_count as usize).iter().map(|&level| level as i32).collect());
	let level_count = reader.count();
	let scene_levels: Vec<SceneLevel> = (0..level_count).map(|_| SceneLevel { bottom: reader.next(), top: reader.next(), is_drawn: reader.flag() }).collect();
	output.clear();
	with_scene(slot, |scene| {
		let active_flags = active_levels.map(|levels| {
			let mut flags = vec![false; scene.level_count];
			for level in levels {
				if level >= 0 && (level as usize) < flags.len() {
					flags[level as usize] = true;
				}
			}
			flags
		});
		let is_on_active_level = |level_indexes: &[i32]| match &active_flags {
			None => true,
			Some(flags) => level_indexes.is_empty() || level_indexes.iter().any(|&level| level < 0 || flags.get(level as usize).copied().unwrap_or(false)),
		};
		// The shape is drawn on the source's level, with core drawing the maps of the levels it lists above and below. A floor on a
		// level that is not drawn (a source climbing past its ceiling into an unlisted level before it changes level) still hides
		// what is beneath it but is never lit: lit, it would reveal the source's own level's map under it.
		let is_on_undrawn_level = |height: f64| height >= level_top && !scene_levels.iter().find(|level| level.bottom <= height && height < level.top).is_some_and(|level| level.is_drawn);

		// Every point of the box is within this of the source, so no shadow needs to reach further; nor past the radius (core's sweep
		// keeps the shape within it, a radius of 0 being none).
		let box_reach = (sx - min_x).max(max_x - sx).hypot((sy - min_y).max(max_y - sy));
		let farthest = (if radius > 0.0 { box_reach.min(radius) } else { box_reach }) + 1.0;

		// The floors at or below the source: flat ones by height (all of a height one floor), and each roof face on its own (the
		// lighting works out where each is a floor). Roof faces at any height: one can rise above the source and still be seen
		// from above its plane.
		let is_floor = |face: &RegionFace| (!face.surfaces.is_empty() || !face.barriers.is_empty()) && is_on_active_level(&face.level_indexes);
		let mut sloped: Vec<usize> = Vec::new();
		scene.static_bvh.visit_overlapping(&[min_x, min_y, base_elevation, max_x, max_y, f64::INFINITY], REGION_SLOPE_MASK, &mut |primitive| {
			if let Primitive::Face(face) = &scene.statics[primitive] {
				if is_floor(face) {
					sloped.push(primitive);
				}
			}
		});
		// by height (its bits as the key), each with its documents once
		let mut flat_floors: BTreeMap<u64, Vec<i32>> = BTreeMap::new();
		let mut floors_above_level: BTreeMap<u64, Vec<i32>> = BTreeMap::new();
		scene.static_bvh.visit_overlapping(&[min_x, min_y, base_elevation, max_x, max_y, sz + ELEVATION_HAIR], REGION_FACE_MASK, &mut |primitive| {
			let Primitive::Face(face) = &scene.statics[primitive] else { return };
			if !is_floor(face) || face.elevation < base_elevation || face.elevation - ELEVATION_HAIR > sz {
				return;
			}
			let floors = if is_on_undrawn_level(face.elevation) { &mut floors_above_level } else { &mut flat_floors };
			let documents = floors.entry(face.elevation.to_bits()).or_default();
			if !documents.contains(&face.document) {
				documents.push(face.document);
			}
		});

		// Every barrier that can shade a floor between the base floor and the source, up to the highest any roof face reaches (where
		// it is a floor can only be lower).
		let mut faces_top = sz;
		for &primitive in &sloped {
			let Primitive::Face(face) = &scene.statics[primitive] else { continue };
			let Some(plane) = face.plane else { continue };
			let bounds = bounding_box(face.paths.iter(), 0.0);
			for (x, y) in [(bounds.min_x, bounds.min_y), (bounds.max_x, bounds.min_y), (bounds.min_x, bounds.max_y), (bounds.max_x, bounds.max_y)] {
				faces_top = faces_top.max(plane.height(x, y));
			}
		}
		let from = SeenFrom {
			x: sx,
			y: sy,
			elevation: sz,
			type_index,
			sight: SourceSight { radius, external_radius, attenuation_multiplier, use_threshold },
			active_levels: active_flags.clone(),
		};
		let seen = barriers_seen_from(scene, &from, &[min_x, min_y, base_elevation.min(sz - 1.0), max_x, max_y, faces_top + ELEVATION_HAIR]);
		let is_open_door = |barrier: &SeenBarrier| matches!(barrier.shape, SeenShape::Vertical { is_door: true, .. }) && matches!(&scene.statics[barrier.primitive], Primitive::Wall(wall) if wall.is_open);
		let verticals: Vec<&SeenBarrier> = seen.iter().filter(|barrier| matches!(barrier.shape, SeenShape::Vertical { .. }) && !is_open_door(barrier)).collect();
		let horizontals: Vec<&SeenBarrier> = seen.iter().filter(|barrier| matches!(barrier.shape, SeenShape::Face { .. })).collect();
		let region_area = |document: i32| scene.region_areas.iter().find(|(area_document, _)| *area_document == document).map(|(_, area)| area.as_slice()).unwrap_or(&[]);

		// A sloped floor whose plane runs above the source is seen only through its own face; one that blocks the source outright
		// leaves it all dark (from beside a cone, the faces sloping away), with no shadows to work out.
		let is_seen_only_through_itself = |primitive: usize, plane: Plane| {
			if sz >= plane.height(sx, sy) - ELEVATION_HAIR {
				return false;
			}
			horizontals.iter().find(|horizontal| horizontal.primitive == primitive).is_some_and(|horizontal| horizontal.restriction.kind == RestrictionKind::Normal && horizontal.restriction.reach == f64::INFINITY)
		};

		output.extend_from_slice(&[sx, sy, sz, min_x, min_y, max_x, max_y, farthest, scene.pixels_per_unit, verticals.len() as f64]);
		for barrier in &verticals {
			let SeenShape::Vertical { ax, ay, bx, by, bottom, top, bottom_b, top_b, .. } = barrier.shape else { continue };
			let document = primitive_document(&scene.statics[barrier.primitive]);
			output.extend_from_slice(&[ax, ay, bx, by, bottom, top, bottom_b, top_b, (barrier.restriction.kind == RestrictionKind::Limited) as u8 as f64, document as f64, barrier.restriction.reach]);
		}
		output.push(horizontals.len() as f64);
		for barrier in &horizontals {
			let SeenShape::Face { elevation, plane } = barrier.shape else { continue };
			let Primitive::Face(face) = &scene.statics[barrier.primitive] else { continue };
			let bounds = scene.static_bvh.primitive_box(barrier.primitive);
			let plane_values = plane.map_or([0.0; 3], |plane| [plane.a, plane.b, plane.c]);
			output.extend_from_slice(&[(barrier.restriction.kind == RestrictionKind::Limited) as u8 as f64, face.document as f64, barrier.restriction.reach, plane.is_some() as u8 as f64]);
			output.extend_from_slice(&plane_values);
			output.extend_from_slice(&[elevation, bounds[0], bounds[1], bounds[3], bounds[4]]);
			if plane.is_some() { push_paths(output, &face.paths) } else { push_paths(output, region_area(face.document)) }
		}
		output.push(base_elevation);
		output.push(flat_floors.len() as f64);
		for (height, documents) in &flat_floors {
			output.push(f64::from_bits(*height));
			let areas: Vec<Path> = documents.iter().flat_map(|&document| region_area(document).iter().cloned()).collect();
			push_paths(output, &areas);
		}
		output.push((sloped.len() + floors_above_level.len()) as f64);
		for &primitive in &sloped {
			let Primitive::Face(face) = &scene.statics[primitive] else { continue };
			let Some(plane) = face.plane else { continue };
			let lowest_height = face.paths.iter().flat_map(|path| path.chunks_exact(2).map(move |point| plane.height(point[0], point[1]))).fold(f64::INFINITY, f64::min);
			// a roof not shown (its barrier's Show Roof off) is still the floor there, but never lit: left out, unexplored
			let is_lit = face.is_shown && !is_seen_only_through_itself(primitive, plane) && !is_on_undrawn_level(lowest_height);
			output.extend_from_slice(&[plane.a, plane.b, plane.c, face.document as f64, is_lit as u8 as f64, face.is_convex_solid as u8 as f64]);
			push_paths(output, &face.paths);
		}
		// flat, as faces of their own so they can be unlit; one per height, as faces of one document are never compared
		for (position, (height, documents)) in floors_above_level.iter().enumerate() {
			let areas: Vec<Path> = documents.iter().flat_map(|&document| region_area(document).iter().cloned()).collect();
			output.extend_from_slice(&[f64::from_bits(*height), 0.0, 0.0, ABOVE_LEVEL_DOCUMENT_BASE + position as f64, 0.0, 0.0]);
			push_paths(output, &union(&areas));
		}
	});
}

fn primitive_document(primitive: &Primitive) -> i32 {
	match primitive {
		Primitive::Wall(wall) => wall.document,
		Primitive::Side(side) => side.document,
		Primitive::Face(face) => face.document,
	}
}

/// The floor lighting input for the source in the input buffer (gather), into the output buffer; returns how many f64s it holds
/// (none when the scene slot holds nothing).
#[unsafe(no_mangle)]
pub extern "C" fn gather_floors() -> usize {
	INPUT.with(|input| {
		OUTPUT.with(|output| {
			let mut output = output.borrow_mut();
			gather(&input.borrow(), &mut output);
			output.len()
		})
	})
}
