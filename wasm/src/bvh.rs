//! Bounding volume hierarchy: a static tree of axis-aligned boxes, built with a binned SAH and walked front to back. Boxes are
//! stored flat as minX, minY, minZ, maxX, maxY, maxZ (z is elevation). A primitive is a box and a 32-bit mask; each node holds
//! the OR of the masks below it, so a query skips subtrees with nothing it wants. Nodes are depth-first (the left child is the
//! next node). Unbounded elevations are real ±Infinity, which the slab test handles exactly.

const BOX_STRIDE: usize = 6;
const EMPTY_BOX: [f64; 6] = [f64::INFINITY, f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
const LEAF_SIZE: usize = 4;
const BIN_COUNT: usize = 8;

/// What a walk along a ray needs: its origin, 1 / its delta per axis, which axes it moves along (bits 1, 2, 4), and the range
/// of t still wanted (a visitor may lower t_max to cut the walk short).
pub struct RayBounds {
	pub origin: [f64; 3],
	pub inverse_delta: [f64; 3],
	pub axes: u32,
	pub t_min: f64,
	pub t_max: f64,
}

impl RayBounds {
	/// The slab test, within [t_min, t_max]; Infinity on a miss. On an axis the ray does not move along, its origin must be
	/// inside the box.
	fn box_entry(&self, boxes: &[f64], offset: usize) -> f64 {
		let mut entry = self.t_min;
		let mut exit = self.t_max;
		for axis in 0..3 {
			let min = boxes[offset + axis];
			let max = boxes[offset + axis + 3];
			if self.axes & (1 << axis) != 0 {
				let mut near = (min - self.origin[axis]) * self.inverse_delta[axis];
				let mut far = (max - self.origin[axis]) * self.inverse_delta[axis];
				if near > far {
					std::mem::swap(&mut near, &mut far);
				}
				if near > entry {
					entry = near;
				}
				if far < exit {
					exit = far;
				}
				if entry > exit {
					return f64::INFINITY;
				}
			} else if self.origin[axis] < min || self.origin[axis] > max {
				return f64::INFINITY;
			}
		}
		entry
	}
}

#[derive(Default)]
pub struct Bvh {
	pub primitive_count: usize,
	/// each primitive's own box, for box queries
	primitive_boxes: Vec<f64>,
	node_boxes: Vec<f64>,
	node_masks: Vec<u32>,
	right_child: Vec<usize>,
	/// a leaf owns leaf_order[leaf_start, leaf_start + leaf_count); inner nodes have a leaf_count of 0
	leaf_start: Vec<usize>,
	leaf_count: Vec<usize>,
	leaf_order: Vec<usize>,
	leaf_masks: Vec<u32>,
	/// the most nodes a ray walk can have waiting
	depth: usize,
}

fn grow(target: &mut [f64], source: &[f64]) {
	for axis in 0..3 {
		if source[axis] < target[axis] {
			target[axis] = source[axis];
		}
		if source[axis + 3] > target[axis + 3] {
			target[axis + 3] = source[axis + 3];
		}
	}
}

fn half_surface_area(bounds: &[f64]) -> f64 {
	let (x, y, z) = (bounds[3] - bounds[0], bounds[4] - bounds[1], bounds[5] - bounds[2]);
	x * y + x * z + y * z
}

impl Bvh {
	/// Each node is split where the surface-area heuristic estimates a ray costs least. z_scale is pixels per elevation unit,
	/// so vertical extents compare with horizontal ones.
	pub fn new(primitive_boxes: Vec<f64>, primitive_masks: &[u32], z_scale: f64) -> Bvh {
		let count = primitive_masks.len();
		let max_nodes = (2 * count).max(1);
		let mut bvh = Bvh {
			primitive_count: count,
			primitive_boxes,
			node_boxes: vec![0.0; max_nodes * BOX_STRIDE],
			node_masks: vec![0; max_nodes],
			right_child: vec![0; max_nodes],
			leaf_start: vec![0; max_nodes],
			leaf_count: vec![0; max_nodes],
			leaf_order: (0..count).collect(),
			leaf_masks: vec![0; count],
			depth: 0,
		};
		if count == 0 {
			return bvh;
		}
		Builder::new(&mut bvh, primitive_masks, z_scale).build_node(0, count, 0);
		for slot in 0..count {
			bvh.leaf_masks[slot] = primitive_masks[bvh.leaf_order[slot]];
		}
		bvh
	}

	pub fn primitive_box(&self, primitive: usize) -> &[f64] {
		&self.primitive_boxes[primitive * BOX_STRIDE..primitive * BOX_STRIDE + BOX_STRIDE]
	}

	pub fn primitive_overlaps(&self, primitive: usize, query: &[f64; 6]) -> bool {
		let b = self.primitive_box(primitive);
		!(query[3] < b[0] || query[4] < b[1] || query[5] < b[2] || query[0] > b[3] || query[1] > b[4] || query[2] > b[5])
	}

	/// visit(primitive) for every primitive in a leaf whose box contains the point: a candidate for the caller to test exactly.
	pub fn visit_containing(&self, x: f64, y: f64, z: f64, visit: &mut impl FnMut(usize)) {
		if self.primitive_count == 0 {
			return;
		}
		let mut stack = vec![0usize];
		while let Some(node) = stack.pop() {
			let b = &self.node_boxes[node * BOX_STRIDE..node * BOX_STRIDE + BOX_STRIDE];
			if x < b[0] || y < b[1] || z < b[2] || x > b[3] || y > b[4] || z > b[5] {
				continue;
			}
			if self.leaf_count[node] != 0 {
				for slot in self.leaf_start[node]..self.leaf_start[node] + self.leaf_count[node] {
					visit(self.leaf_order[slot]);
				}
			} else {
				// the left subtree first, as the recursive walk visits it
				stack.push(self.right_child[node]);
				stack.push(node + 1);
			}
		}
	}

	/// visit(primitive) for every primitive matching `mask` whose box overlaps `query` (minX, minY, minZ, maxX, maxY, maxZ).
	pub fn visit_overlapping(&self, query: &[f64; 6], mask: u32, visit: &mut impl FnMut(usize)) {
		if self.primitive_count == 0 {
			return;
		}
		let overlaps = |node: usize| {
			let b = &self.node_boxes[node * BOX_STRIDE..node * BOX_STRIDE + BOX_STRIDE];
			!(query[3] < b[0] || query[4] < b[1] || query[5] < b[2] || query[0] > b[3] || query[1] > b[4] || query[2] > b[5])
		};
		let mut stack = vec![0usize];
		while let Some(node) = stack.pop() {
			if self.node_masks[node] & mask == 0 || !overlaps(node) {
				continue;
			}
			if self.leaf_count[node] != 0 {
				for slot in self.leaf_start[node]..self.leaf_start[node] + self.leaf_count[node] {
					if self.leaf_masks[slot] & mask == 0 {
						continue;
					}
					let primitive = self.leaf_order[slot];
					if self.primitive_overlaps(primitive, query) {
						visit(primitive);
					}
				}
			} else {
				stack.push(self.right_child[node]);
				stack.push(node + 1);
			}
		}
	}

	/// visit(primitive, ray) for every primitive matching `mask` in a leaf whose box the ray reaches, nearer leaves first: a
	/// candidate for the caller to test exactly. The visitor may lower ray.t_max to cut the walk short.
	pub fn visit_along_ray<S>(&self, state: &mut S, ray: impl Fn(&mut S) -> &mut RayBounds, mask: u32, visit: &mut impl FnMut(&mut S, usize)) {
		if self.primitive_count == 0 || self.node_masks[0] & mask == 0 || ray(state).box_entry(&self.node_boxes, 0) == f64::INFINITY {
			return;
		}
		let mut stack_nodes: Vec<usize> = Vec::with_capacity(self.depth * 2 + 2);
		let mut stack_ts: Vec<f64> = Vec::with_capacity(self.depth * 2 + 2);
		let mut node = 0usize;
		loop {
			if self.leaf_count[node] != 0 {
				for slot in self.leaf_start[node]..self.leaf_start[node] + self.leaf_count[node] {
					if self.leaf_masks[slot] & mask != 0 {
						visit(state, self.leaf_order[slot]);
					}
				}
			} else {
				let left = node + 1;
				let right = self.right_child[node];
				let bounds = ray(state);
				let left_t = if self.node_masks[left] & mask != 0 { bounds.box_entry(&self.node_boxes, left * BOX_STRIDE) } else { f64::INFINITY };
				let right_t = if self.node_masks[right] & mask != 0 { bounds.box_entry(&self.node_boxes, right * BOX_STRIDE) } else { f64::INFINITY };
				if right_t < left_t {
					if left_t != f64::INFINITY {
						stack_nodes.push(left);
						stack_ts.push(left_t);
					}
					node = right;
					continue;
				}
				if left_t != f64::INFINITY {
					if right_t != f64::INFINITY {
						stack_nodes.push(right);
						stack_ts.push(right_t);
					}
					node = left;
					continue;
				}
			}
			loop {
				let Some(entry_t) = stack_ts.pop() else { return };
				let waiting = stack_nodes.pop().unwrap();
				if entry_t <= ray(state).t_max {
					node = waiting;
					break;
				}
			}
		}
	}
}

struct Builder<'a> {
	bvh: &'a mut Bvh,
	masks: &'a [u32],
	/// boxes for costing splits only: elevation in pixels, infinite extents cut a little beyond the finite ones
	cost_boxes: Vec<f64>,
	centroids: Vec<f64>,
	centroid_box: [f64; 6],
	bin_sizes: [usize; BIN_COUNT],
	bin_boxes: [[f64; 6]; BIN_COUNT],
	count_left: [usize; BIN_COUNT],
	area_left: [f64; BIN_COUNT],
	count_right: [usize; BIN_COUNT],
	area_right: [f64; BIN_COUNT],
	node_count: usize,
}

impl<'a> Builder<'a> {
	fn new(bvh: &'a mut Bvh, masks: &'a [u32], z_scale: f64) -> Self {
		let boxes = &bvh.primitive_boxes;
		let count = masks.len();
		let (mut lowest, mut highest) = (f64::INFINITY, f64::NEG_INFINITY);
		for z_index in (2..boxes.len()).step_by(3) {
			let z = boxes[z_index];
			if z.is_finite() {
				lowest = lowest.min(z);
				highest = highest.max(z);
			}
		}
		if lowest > highest {
			lowest = 0.0;
			highest = 0.0;
		}
		let margin = (highest - lowest) / 2.0 + 1.0;
		let mut cost_boxes = boxes.clone();
		let mut centroids = vec![0.0; count * 3];
		for primitive in 0..count {
			let offset = primitive * BOX_STRIDE;
			for axis in 0..3 {
				// an infinite extent has no usable centre
				let centre = (boxes[offset + axis] + boxes[offset + axis + 3]) / 2.0;
				centroids[primitive * 3 + axis] = if centre.is_finite() { centre } else { 0.0 };
			}
			cost_boxes[offset + 2] = boxes[offset + 2].clamp(lowest - margin, highest + margin) * z_scale;
			cost_boxes[offset + 5] = boxes[offset + 5].clamp(lowest - margin, highest + margin) * z_scale;
		}
		Builder {
			bvh,
			masks,
			cost_boxes,
			centroids,
			centroid_box: EMPTY_BOX,
			bin_sizes: [0; BIN_COUNT],
			bin_boxes: [EMPTY_BOX; BIN_COUNT],
			count_left: [0; BIN_COUNT],
			area_left: [0.0; BIN_COUNT],
			count_right: [0; BIN_COUNT],
			area_right: [0.0; BIN_COUNT],
			node_count: 0,
		}
	}

	fn bin_of(&self, primitive: usize, axis: usize, bins_per_unit: f64) -> usize {
		(((self.centroids[primitive * 3 + axis] - self.centroid_box[axis]) * bins_per_unit) as usize).min(BIN_COUNT - 1)
	}

	/// counts[bin] and areas[bin]: everything from the first bin of the walk up to and including `bin`.
	fn accumulate(&mut self, forward: bool) {
		let mut running = EMPTY_BOX;
		let mut running_count = 0;
		for step in 0..BIN_COUNT {
			let bin = if forward { step } else { BIN_COUNT - 1 - step };
			if self.bin_sizes[bin] != 0 {
				grow(&mut running, &self.bin_boxes[bin]);
				running_count += self.bin_sizes[bin];
			}
			let area = if running_count != 0 { half_surface_area(&running) } else { 0.0 };
			if forward {
				self.count_left[bin] = running_count;
				self.area_left[bin] = area;
			} else {
				self.count_right[bin] = running_count;
				self.area_right[bin] = area;
			}
		}
	}

	/// Bin the centroids per axis, cost each bin boundary as area * count on both sides, and reorder the range so the cheapest
	/// split's left side comes first. Returns where the right side starts, or None when nothing separates.
	fn partition(&mut self, start: usize, end: usize) -> Option<usize> {
		let mut best_cost = f64::INFINITY;
		let mut best: Option<(usize, usize)> = None;
		// only the wider of x and y is tried (they do the same job), and z
		let cb = self.centroid_box;
		let wider_horizontal = if cb[3] - cb[0] >= cb[4] - cb[1] { 0 } else { 1 };
		for axis in [wider_horizontal, 2] {
			let extent = cb[axis + 3] - cb[axis];
			if !(extent > 0.0) {
				continue;
			}
			self.bin_sizes = [0; BIN_COUNT];
			self.bin_boxes = [EMPTY_BOX; BIN_COUNT];
			let bins_per_unit = BIN_COUNT as f64 / extent;
			for slot in start..end {
				let primitive = self.bvh.leaf_order[slot];
				let bin = self.bin_of(primitive, axis, bins_per_unit);
				self.bin_sizes[bin] += 1;
				let offset = primitive * BOX_STRIDE;
				let source: [f64; 6] = self.cost_boxes[offset..offset + 6].try_into().unwrap();
				grow(&mut self.bin_boxes[bin], &source);
			}
			self.accumulate(true);
			self.accumulate(false);
			for bin in 0..BIN_COUNT - 1 {
				if self.count_left[bin] == 0 || self.count_right[bin + 1] == 0 {
					continue;
				}
				let cost = self.area_left[bin] * self.count_left[bin] as f64 + self.area_right[bin + 1] * self.count_right[bin + 1] as f64;
				if cost < best_cost {
					best_cost = cost;
					best = Some((axis, bin));
				}
			}
		}
		let (axis, best_bin) = best?;
		let bins_per_unit = BIN_COUNT as f64 / (cb[axis + 3] - cb[axis]);
		let (mut left_end, mut right_start) = (start as isize, end as isize - 1);
		while left_end <= right_start {
			if self.bin_of(self.bvh.leaf_order[left_end as usize], axis, bins_per_unit) <= best_bin {
				left_end += 1;
			} else {
				self.bvh.leaf_order.swap(left_end as usize, right_start as usize);
				right_start -= 1;
			}
		}
		let left_end = left_end as usize;
		if left_end > start && left_end < end { Some(left_end) } else { None }
	}

	fn build_node(&mut self, start: usize, end: usize, depth: usize) {
		let node = self.node_count;
		self.node_count += 1;
		if depth > self.bvh.depth {
			self.bvh.depth = depth;
		}
		let mut node_box = EMPTY_BOX;
		self.centroid_box = EMPTY_BOX;
		let mut node_mask = 0;
		for slot in start..end {
			let primitive = self.bvh.leaf_order[slot];
			let offset = primitive * BOX_STRIDE;
			let source: [f64; 6] = self.bvh.primitive_boxes[offset..offset + 6].try_into().unwrap();
			grow(&mut node_box, &source);
			node_mask |= self.masks[primitive];
			for axis in 0..3 {
				let centre = self.centroids[primitive * 3 + axis];
				if centre < self.centroid_box[axis] {
					self.centroid_box[axis] = centre;
				}
				if centre > self.centroid_box[axis + 3] {
					self.centroid_box[axis + 3] = centre;
				}
			}
		}
		self.bvh.node_boxes[node * BOX_STRIDE..node * BOX_STRIDE + BOX_STRIDE].copy_from_slice(&node_box);
		self.bvh.node_masks[node] = node_mask;
		let mut split = None;
		if end - start > LEAF_SIZE {
			// coinciding centroids stay a leaf; otherwise with no split found (rounding), the range is halved as it stands
			let cb = self.centroid_box;
			let centroids_differ = (cb[3] - cb[0]).max(cb[4] - cb[1]).max(cb[5] - cb[2]) > 0.0;
			split = self.partition(start, end);
			if split.is_none() && centroids_differ {
				split = Some((start + end) >> 1);
			}
		}
		let Some(split) = split else {
			self.bvh.leaf_start[node] = start;
			self.bvh.leaf_count[node] = end - start;
			return;
		};
		self.build_node(start, split, depth + 1);
		self.bvh.right_child[node] = self.node_count;
		self.build_node(split, end, depth + 1);
	}
}

// Against checking every box, with masks. Box queries find exactly the matching boxes. Point and ray queries find candidates:
// every matching box, plus others sharing a leaf with one, which their callers test exactly; so they must miss nothing and
// only offer boxes of the asked mask. Random scenes from a fixed seed, so a failure repeats.
#[cfg(test)]
mod tests {
	use super::*;

	/// mulberry32
	fn random(mut seed: u32) -> impl FnMut() -> f64 {
		move || {
			seed = seed.wrapping_add(0x6d2b79f5);
			let mut value = (seed ^ (seed >> 15)).wrapping_mul(1 | seed);
			value = value.wrapping_add((value ^ (value >> 7)).wrapping_mul(61 | value)) ^ value;
			((value ^ (value >> 14)) as f64) / 4294967296.0
		}
	}

	/// `count` boxes in a 1000-pixel square, 100 units tall, some unbounded in elevation, with masks of one or two of 4 bits.
	fn random_scene(count: usize, next: &mut impl FnMut() -> f64) -> (Vec<f64>, Vec<u32>) {
		let mut boxes = Vec::with_capacity(count * 6);
		let mut masks = Vec::with_capacity(count);
		for _ in 0..count {
			let (x, y, z) = (next() * 1000.0, next() * 1000.0, next() * 100.0);
			let unbounded = next() < 0.1;
			let (width, height, depth) = (next() * 120.0, next() * 120.0, next() * 30.0);
			boxes.extend_from_slice(&[x, y, if unbounded { f64::NEG_INFINITY } else { z }, x + width, y + height, if unbounded { f64::INFINITY } else { z + depth }]);
			let first = 1 << ((next() * 4.0) as u32);
			let second = if next() < 0.3 { 1 << ((next() * 4.0) as u32) } else { 0 };
			masks.push(first | second);
		}
		(boxes, masks)
	}

	/// t where origin + t delta (t in 0..1) enters the box, or Infinity: the slab test, checked directly.
	fn segment_entry(origin: [f64; 3], delta: [f64; 3], bounds: &[f64]) -> f64 {
		let (mut entry, mut exit) = (0.0f64, 1.0f64);
		for axis in 0..3 {
			if delta[axis] == 0.0 {
				if origin[axis] < bounds[axis] || origin[axis] > bounds[axis + 3] {
					return f64::INFINITY;
				}
				continue;
			}
			let mut near = (bounds[axis] - origin[axis]) / delta[axis];
			let mut far = (bounds[axis + 3] - origin[axis]) / delta[axis];
			if near > far {
				std::mem::swap(&mut near, &mut far);
			}
			entry = entry.max(near);
			exit = exit.min(far);
			if entry > exit {
				return f64::INFINITY;
			}
		}
		entry
	}

	fn ray(origin: [f64; 3], delta: [f64; 3]) -> RayBounds {
		let axes = (0..3).filter(|&axis| delta[axis] != 0.0).fold(0, |axes, axis| axes | (1 << axis));
		RayBounds { origin, inverse_delta: [1.0 / delta[0], 1.0 / delta[1], 1.0 / delta[2]], axes, t_min: 0.0, t_max: 1.0 }
	}

	fn assert_candidates(mut candidates: Vec<usize>, matches: impl Iterator<Item = usize>, allowed: impl Fn(usize) -> bool) {
		candidates.sort_unstable();
		let count = candidates.len();
		candidates.dedup();
		assert_eq!(candidates.len(), count, "a box offered twice");
		for index in matches {
			assert!(candidates.binary_search(&index).is_ok(), "box {index} missed");
		}
		for &index in &candidates {
			assert!(allowed(index), "box {index} is not of the asked mask");
		}
	}

	#[test]
	fn points_boxes_and_rays_find_what_checking_every_box_finds() {
		for count in [1usize, 7, 64, 500] {
			let mut next = random(count as u32 * 7919);
			let (boxes, masks) = random_scene(count, &mut next);
			let bvh = Bvh::new(boxes.clone(), &masks, 20.0);
			let bounds = |index: usize| &boxes[index * 6..index * 6 + 6];
			for _ in 0..200 {
				let (x, y, z) = (next() * 1100.0 - 50.0, next() * 1100.0 - 50.0, next() * 140.0 - 20.0);
				let mut found = Vec::new();
				bvh.visit_containing(x, y, z, &mut |index| found.push(index));
				let contains = |index: usize| {
					let b = bounds(index);
					x >= b[0] && y >= b[1] && z >= b[2] && x <= b[3] && y <= b[4] && z <= b[5]
				};
				assert_candidates(found, (0..count).filter(|&index| contains(index)), |_| true);

				let mask = 1 + (next() * 15.0) as u32;
				let query = [x, y, z, x + next() * 300.0, y + next() * 300.0, z + next() * 40.0];
				let mut found = Vec::new();
				bvh.visit_overlapping(&query, mask, &mut |index| found.push(index));
				found.sort_unstable();
				let expected: Vec<usize> = (0..count)
					.filter(|&index| {
						let b = bounds(index);
						masks[index] & mask != 0 && !(query[3] < b[0] || query[4] < b[1] || query[5] < b[2] || query[0] > b[3] || query[1] > b[4] || query[2] > b[5])
					})
					.collect();
				assert_eq!(found, expected);

				// rays in every direction, some flat (no change in elevation) or straight up and down
				let mut delta = [if next() < 0.1 { 0.0 } else { next() * 1200.0 - 600.0 }, if next() < 0.1 { 0.0 } else { next() * 1200.0 - 600.0 }, if next() < 0.3 { 0.0 } else { next() * 80.0 - 40.0 }];
				if delta == [0.0; 3] {
					delta[0] = 1.0;
				}
				let origin = [x, y, z];
				let mut state = (ray(origin, delta), Vec::new());
				bvh.visit_along_ray(&mut state, |state| &mut state.0, mask, &mut |state, index| state.1.push(index));
				let matches = (0..count).filter(|&index| masks[index] & mask != 0 && segment_entry(origin, delta, bounds(index)) != f64::INFINITY);
				assert_candidates(state.1, matches, |index| masks[index] & mask != 0);
			}
		}
	}

	#[test]
	fn a_visitor_lowering_t_max_cuts_the_walk_short_but_never_skips_a_box_entered_before_it() {
		let mut next = random(4242);
		let (boxes, masks) = random_scene(300, &mut next);
		let bvh = Bvh::new(boxes.clone(), &masks, 1.0);
		let (origin, delta) = ([0.0, 500.0, 50.0], [1000.0, 0.0, 0.0]);
		let mut state = (ray(origin, delta), Vec::new());
		bvh.visit_along_ray(&mut state, |state| &mut state.0, 0xf, &mut |state, index| {
			state.1.push(index);
			let entry = segment_entry(origin, delta, &boxes[index * 6..index * 6 + 6]);
			if entry < state.0.t_max {
				state.0.t_max = entry;
			}
		});
		let (walk, visited) = state;
		for index in 0..300 {
			let entry = segment_entry(origin, delta, &boxes[index * 6..index * 6 + 6]);
			if entry < walk.t_max {
				assert!(visited.contains(&index), "box {index} entered at {entry} before {} was skipped", walk.t_max);
			}
		}
	}

	#[test]
	fn an_empty_hierarchy_finds_nothing() {
		let bvh = Bvh::new(Vec::new(), &[], 1.0);
		let mut found = Vec::new();
		bvh.visit_containing(0.0, 0.0, 0.0, &mut |index| found.push(index));
		bvh.visit_overlapping(&[0.0, 0.0, 0.0, 1.0, 1.0, 1.0], 0xf, &mut |index| found.push(index));
		let mut state = (ray([0.0; 3], [1.0; 3]), ());
		bvh.visit_along_ray(&mut state, |state| &mut state.0, 0xf, &mut |_, index| found.push(index));
		assert!(found.is_empty());
	}
}
