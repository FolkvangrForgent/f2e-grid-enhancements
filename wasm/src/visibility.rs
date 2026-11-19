//! The visibility polygons of a point among segments in the plan, within a box. Each segment hides everything beyond it (a
//! barrier rising to the source's height or above, seen on a floor, hides the whole wedge behind where its shadow starts): a
//! normal one from where it is, limited ones together from the second one along a ray (the first is let through, as for walls),
//! an attenuated one only beyond its reach from the point. Together they leave star-shaped areas around the point, found by
//! casting rays at every angle where what is nearest can change: segment ends, where segments (or a segment and the box) cross,
//! the box's corners, and along an attenuated segment's reach. Rays are cast just either side of each such angle as well, so the
//! polygon steps from one segment to the next behind it. Each ray is only tested against the segments in its angle (angle
//! buckets), nearest first, until none left can be nearer than what it has met.

use crate::geometry::{Box2, Path, distance_to_segment};
use std::f64::consts::{PI, TAU};

const NUDGE: f64 = 1e-6;

/// A bucket's segments by kind: blocking (normal and the box's sides), limited and attenuated positions.
type BucketKinds = (Vec<usize>, Vec<usize>, Vec<usize>);
const RANGE_PADDING: f64 = 1e-8;

/// The distances at which a ray meets the segments listed by `positions` (nearest first, with their nearest distances): the
/// nearest, and with `second` the two nearest.
fn hits(x: f64, y: f64, dx: f64, dy: f64, all: &[f64], positions: &[usize], nearest: Option<&[f64]>, second: bool) -> (f64, f64) {
	let (mut first, mut next) = (f64::INFINITY, f64::INFINITY);
	for &position in positions {
		if let Some(nearest) = nearest {
			let bound = if second { next } else { first };
			if nearest[position] > bound + 1e-9 * (1.0 + bound) {
				break;
			}
		}
		let offset = position * 4;
		let (ax, ay) = (all[offset], all[offset + 1]);
		let (ex, ey) = (all[offset + 2] - ax, all[offset + 3] - ay);
		let denominator = dx * ey - dy * ex;
		if denominator == 0.0 {
			continue;
		}
		let (wx, wy) = (ax - x, ay - y);
		let t = (wx * ey - wy * ex) / denominator;
		let s = (wx * dy - wy * dx) / denominator;
		if !(t > 1e-9 && (0.0..=1.0).contains(&s)) {
			continue;
		}
		if t < first {
			next = first;
			first = t;
		} else if t < next {
			next = t;
		}
	}
	(first, next)
}

pub struct Polygons {
	pub visible: Path,
	pub before_limited: Path,
}

/// The visibility polygons of (x, y) among `normal` and `limited` segments (flat [ax, ay, bx, by, ...]) and `attenuated` ones
/// ([ax, ay, bx, by, reach, ...], each hiding only beyond `reach` from the point), within `b`: `visible`, reached before the
/// nearest normal segment, attenuated reach and second limited segment, and `before_limited`, reached before the nearest of those
/// and the first limited segment (so what lies between the two is behind exactly one limited segment).
pub fn visibility_polygons(x: f64, y: f64, normal: &[f64], limited: &[f64], attenuated: &[f64], bounds: &Box2) -> Polygons {
	let mut all: Vec<f64> = normal.to_vec();
	all.extend_from_slice(&[
		bounds.min_x, bounds.min_y, bounds.max_x, bounds.min_y, bounds.max_x, bounds.min_y, bounds.max_x, bounds.max_y, bounds.max_x, bounds.max_y, bounds.min_x, bounds.max_y, bounds.min_x, bounds.max_y, bounds.min_x, bounds.min_y,
	]);
	let blocking_count = all.len() / 4;
	all.extend_from_slice(limited);
	let attenuated_start = all.len() / 4;
	let reaches: Vec<f64> = attenuated.as_chunks::<5>().0.iter().map(|entry| entry[4]).collect();
	for entry in attenuated.as_chunks::<5>().0 {
		all.extend_from_slice(&entry[..4]);
	}
	let segment_count = all.len() / 4;
	let distances: Vec<f64> = (0..segment_count).map(|index| distance_to_segment(x, y, all[index * 4], all[index * 4 + 1], all[index * 4 + 2], all[index * 4 + 3])).collect();
	let mut nearest_first: Vec<usize> = (0..segment_count).collect();
	nearest_first.sort_by(|&a, &b| distances[a].total_cmp(&distances[b]));

	// angle buckets
	let count = segment_count.clamp(16, 4096);
	let bucket_of = |angle: f64| {
		let wrapped = if angle < -PI { angle + TAU } else if angle >= PI { angle - TAU } else { angle };
		(((wrapped + PI) / TAU * count as f64).floor() as isize).clamp(0, count as isize - 1) as usize
	};
	let mut buckets: Vec<Vec<usize>> = vec![Vec::new(); count];
	let mut starts: Vec<Vec<usize>> = vec![Vec::new(); count];
	{
		let mut add_range = |from: f64, to: f64, segment: usize| {
			let first = bucket_of(from.max(-PI));
			let last = bucket_of(to.min(PI - 1e-12));
			for bucket in first..=last {
				buckets[bucket].push(segment);
				starts[bucket].push(first);
			}
		};
		for &segment in &nearest_first {
			let offset = segment * 4;
			let (ax, ay, bx, by) = (all[offset] - x, all[offset + 1] - y, all[offset + 2] - x, all[offset + 3] - y);
			let cross = ax * by - ay * bx;
			let dot = ax * bx + ay * by;
			if cross.abs() <= 1e-9 * (ax * ax + ay * ay + bx * bx + by * by) && dot <= 0.0 {
				add_range(-PI, PI, segment);
				continue;
			}
			let (mut from, mut to) = (ay.atan2(ax), by.atan2(bx));
			if to < from {
				std::mem::swap(&mut from, &mut to);
			}
			if to - from > PI {
				add_range(to - RANGE_PADDING, PI, segment);
				add_range(-PI, from + RANGE_PADDING, segment);
			} else {
				add_range(from - RANGE_PADDING, to + RANGE_PADDING, segment);
			}
		}
	}

	// how far each bucket can be seen into
	let bucket_width = TAU / count as f64;
	let mut seen_to = vec![f64::INFINITY; count];
	for (bucket, positions) in buckets.iter().enumerate() {
		let from_angle = -PI + bucket as f64 * bucket_width;
		let (from_x, from_y) = (from_angle.cos(), from_angle.sin());
		let (to_x, to_y) = ((from_angle + bucket_width).cos(), (from_angle + bucket_width).sin());
		for &position in positions {
			if distances[position] >= seen_to[bucket] {
				break;
			}
			if position >= blocking_count {
				continue;
			}
			let single = [position];
			let through = hits(x, y, from_x, from_y, &all, &single, None, false).0.max(hits(x, y, to_x, to_y, &all, &single, None, false).0);
			if through < seen_to[bucket] {
				seen_to[bucket] = through;
			}
		}
	}
	let is_seen_at = |distance: f64, bucket: usize| distance <= seen_to[bucket] * (1.0 + 1e-9) + 1e-9;
	let mut is_seen = vec![false; segment_count];
	for (bucket, positions) in buckets.iter().enumerate() {
		for &position in positions {
			if !is_seen_at(distances[position], bucket) {
				break;
			}
			is_seen[position] = true;
		}
	}
	let mut angles: Vec<f64> = Vec::new();
	for segment in 0..segment_count {
		if !is_seen[segment] {
			continue;
		}
		for (px, py) in [(all[segment * 4], all[segment * 4 + 1]), (all[segment * 4 + 2], all[segment * 4 + 3])] {
			if px != x || py != y {
				angles.push((py - y).atan2(px - x));
			}
		}
	}
	// crossings, each pair once, in the bucket where the later run starts
	for (bucket, positions) in buckets.iter().enumerate() {
		let run_starts = &starts[bucket];
		for starter_index in 0..positions.len() {
			if run_starts[starter_index] != bucket || !is_seen[positions[starter_index]] {
				continue;
			}
			for other_index in 0..positions.len() {
				if other_index == starter_index || (run_starts[other_index] == bucket && other_index < starter_index) || !is_seen[positions[other_index]] {
					continue;
				}
				let first = positions[starter_index].min(positions[other_index]) * 4;
				let second = positions[starter_index].max(positions[other_index]) * 4;
				let (ax, ay) = (all[first], all[first + 1]);
				let (ex, ey) = (all[first + 2] - ax, all[first + 3] - ay);
				let (bx, by) = (all[second], all[second + 1]);
				let (fx, fy) = (all[second + 2] - bx, all[second + 3] - by);
				let denominator = ex * fy - ey * fx;
				if denominator == 0.0 {
					continue;
				}
				let s = ((bx - ax) * fy - (by - ay) * fx) / denominator;
				let u = ((bx - ax) * ey - (by - ay) * ex) / denominator;
				if !(s > 0.0 && s < 1.0 && u > 0.0 && u < 1.0) {
					continue;
				}
				let (px, py) = (ax + ex * s, ay + ey * s);
				if px == x && py == y {
					continue;
				}
				let angle = (py - y).atan2(px - x);
				if is_seen_at((px - x).hypot(py - y), bucket_of(angle)) {
					angles.push(angle);
				}
			}
		}
	}
	// An attenuated segment's reach is an arc of a circle about the point: rays along it every few pixels (as core approximates
	// circles), and where it crosses the segment (where the farther of the two changes).
	for (index, &reach) in reaches.iter().enumerate() {
		let position = attenuated_start + index;
		if !is_seen[position] {
			continue;
		}
		let offset = position * 4;
		let (ax, ay, bx, by) = (all[offset], all[offset + 1], all[offset + 2], all[offset + 3]);
		let (ex, ey) = (bx - ax, by - ay);
		let (fx, fy) = (ax - x, ay - y);
		let a = ex * ex + ey * ey;
		let b = 2.0 * (fx * ex + fy * ey);
		let c = fx * fx + fy * fy - reach * reach;
		let discriminant = b * b - 4.0 * a * c;
		if a > 0.0 && discriminant >= 0.0 {
			for sign in [-1.0, 1.0] {
				let s = (-b + sign * discriminant.sqrt()) / (2.0 * a);
				if s > 0.0 && s < 1.0 {
					let (px, py) = (ax + ex * s, ay + ey * s);
					if px != x || py != y {
						angles.push((py - y).atan2(px - x));
					}
				}
			}
		}
		let (mut from, mut to) = ((ay - y).atan2(ax - x), (by - y).atan2(bx - x));
		if to < from {
			std::mem::swap(&mut from, &mut to);
		}
		// the shorter way round (the segment never spans half a turn about a point it does not pass through)
		let (span_from, span_to) = if to - from > PI { (to, from + TAU) } else { (from, to) };
		let step = 4.0 / reach.max(1.0);
		let mut angle = span_from + step;
		while angle < span_to {
			angles.push(if angle > PI { angle - TAU } else { angle });
			angle += step;
		}
	}
	// each bucket's segments by kind (positions are already nearest first)
	let mut kinds: Vec<Option<BucketKinds>> = vec![None; count];
	let mut rays: Vec<f64> = Vec::with_capacity(angles.len() * 3);
	for angle in &angles {
		rays.push(angle - NUDGE);
		rays.push(*angle);
		rays.push(angle + NUDGE);
	}
	rays.sort_by(|a, b| a.total_cmp(b));
	let mut visible = Vec::new();
	let mut before_limited = Vec::new();
	let add_point = |points: &mut Vec<f64>, dx: f64, dy: f64, t: f64| {
		let (px, py) = (x + dx * t, y + dy * t);
		let length = points.len();
		if length >= 2 && (points[length - 2] - px).abs() < 1e-7 && (points[length - 1] - py).abs() < 1e-7 {
			return;
		}
		points.push(px);
		points.push(py);
	};
	let mut previous = f64::NAN;
	for &ray in &rays {
		if ray == previous {
			continue;
		}
		previous = ray;
		let (dx, dy) = (ray.cos(), ray.sin());
		let bucket = bucket_of(ray);
		let (blocking, limited_here, attenuated_here) = kinds[bucket].get_or_insert_with(|| {
			let (mut blocking, mut limited_here, mut attenuated_here) = (Vec::new(), Vec::new(), Vec::new());
			for &position in &buckets[bucket] {
				if position < blocking_count {
					blocking.push(position)
				} else if position < attenuated_start {
					limited_here.push(position)
				} else {
					attenuated_here.push(position)
				}
			}
			(blocking, limited_here, attenuated_here)
		});
		let mut to_normal = hits(x, y, dx, dy, &all, blocking, Some(&distances), false).0;
		if !to_normal.is_finite() {
			continue;
		}
		for &position in attenuated_here.iter() {
			let to_segment = hits(x, y, dx, dy, &all, &[position], None, false).0;
			if to_segment.is_finite() {
				to_normal = to_normal.min(to_segment.max(reaches[position - attenuated_start]));
			}
		}
		let (to_first_limited, to_second_limited) = hits(x, y, dx, dy, &all, limited_here, Some(&distances), true);
		add_point(&mut visible, dx, dy, to_normal.min(to_second_limited));
		add_point(&mut before_limited, dx, dy, to_normal.min(to_first_limited));
	}
	Polygons { visible: without_collinear_points(visible), before_limited: without_collinear_points(before_limited) }
}

fn without_collinear_points(points: Path) -> Path {
	let count = points.len() / 2;
	if count < 4 {
		return points;
	}
	let is_on_line = |ax: f64, ay: f64, px: f64, py: f64, bx: f64, by: f64| ((px - ax) * (by - ay) - (py - ay) * (bx - ax)).abs() <= 1e-3 * (bx - ax).hypot(by - ay);
	let mut kept = vec![points[0], points[1]];
	for index in 1..count {
		let next = ((index + 1) % count) * 2;
		let (last_x, last_y) = (kept[kept.len() - 2], kept[kept.len() - 1]);
		if !is_on_line(last_x, last_y, points[index * 2], points[index * 2 + 1], points[next], points[next + 1]) {
			kept.push(points[index * 2]);
			kept.push(points[index * 2 + 1]);
		}
	}
	let length = kept.len();
	if length >= 8 && is_on_line(kept[length - 2], kept[length - 1], kept[0], kept[1], kept[2], kept[3]) {
		kept.drain(0..2);
	}
	if kept.len() >= 6 { kept } else { points }
}
