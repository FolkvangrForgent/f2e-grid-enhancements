import {distanceToSegment} from '../raycast/geometry.js';

// The visibility polygons of a point among segments in the plan, within a box. Each segment hides everything beyond it (a barrier
// rising to the source's height or above, seen on a floor, hides the whole wedge behind where its shadow starts): a normal one
// from where it is, limited ones together from the second one along a ray (the first is let through, as for walls). Together
// they leave star-shaped areas around the point, found by casting rays at every angle where what is nearest can change: segment
// ends, where segments (or a segment and the box) cross, and the box's corners. Rays are cast just either side of each such angle
// as well, so the polygon steps from one segment to the next behind it. Each ray is only tested against the segments in its
// angle (see angleBuckets), nearest first, until none left can be nearer than what it has met.

// how far either side of an angle the extra rays go, in radians
const NUDGE = 1e-6;

// The distances (in units of (dx, dy)) at which a ray from (x, y) along (dx, dy) meets some segments (flat [ax, ay, bx, by, ...]):
// the nearest, or with `second` the two nearest as [first, second] (Infinity where there are none). Given each segment's nearest
// distance from (x, y) in `nearest`, the segments sorted by it, the search stops at the first that is no nearer than what is
// already met (the nearest, or with `second` the second nearest), since neither it nor any after it can change that.
function hits(x, y, dx, dy, segments, {second = false, nearest = null} = {}) {
	let first = Infinity;
	let next = Infinity;
	for (let index = 0, offset = 0; offset < segments.length; index++, offset += 4) {
		if (nearest) {
			const bound = second ? next : first;
			// a hair of margin, so a segment met at the same distance (rounded either way) still counts
			if (nearest[index] > bound + 1e-9 * (1 + bound)) break;
		}
		const ax = segments[offset];
		const ay = segments[offset + 1];
		const ex = segments[offset + 2] - ax;
		const ey = segments[offset + 3] - ay;
		const denominator = dx * ey - dy * ex;
		if (denominator === 0) continue;
		const wx = ax - x;
		const wy = ay - y;
		const t = (wx * ey - wy * ex) / denominator;
		const s = (wx * dy - wy * dx) / denominator;
		if (!(t > 1e-9 && s >= 0 && s <= 1)) continue;
		if (t < first) {
			next = first;
			first = t;
		} else if (t < next) next = t;
	}
	return second ? [first, next] : first;
}

// The angles about a point are cut into buckets, each listing the segments seen in it: a ray only meets segments whose angle
// range about the point holds its angle, so it is tested against its bucket's segments alone, and two segments can only cross
// in a bucket both are in. Ranges are widened by this many radians, so rounding never leaves out a segment a ray meets.
const RANGE_PADDING = 1e-8;
const TWO_PI = 2 * Math.PI;

// Buckets of segments by the angles they cover about (x, y): bucketOf(angle) gives an angle's bucket, each bucket's segments
// are listed by their positions in `segments` (flat [ax, ay, bx, by, ...]) in the order of `order` (all positions), and
// `starts` has, for each of those, the first bucket of the run of buckets it covers this one in (a segment across the half
// turn covers two runs).
function angleBuckets(x, y, segments, order) {
	const segmentCount = segments.length / 4;
	const count = Math.min(4096, Math.max(16, segmentCount));
	const bucketOf = angle => {
		const wrapped = angle < -Math.PI ? angle + TWO_PI : angle >= Math.PI ? angle - TWO_PI : angle;
		return Math.min(count - 1, Math.max(0, Math.floor(((wrapped + Math.PI) / TWO_PI) * count)));
	};
	const buckets = Array.from({length: count}, () => []);
	const starts = Array.from({length: count}, () => []);
	const addRange = (from, to, segment) => {
		const first = bucketOf(Math.max(from, -Math.PI));
		const last = bucketOf(Math.min(to, Math.PI - 1e-12));
		for (let bucket = first; bucket <= last; bucket++) {
			buckets[bucket].push(segment);
			starts[bucket].push(first);
		}
	};
	for (const segment of order) {
		const offset = segment * 4;
		const ax = segments[offset] - x;
		const ay = segments[offset + 1] - y;
		const bx = segments[offset + 2] - x;
		const by = segments[offset + 3] - y;
		// a segment through the point (or nearly) is seen at every angle
		const cross = ax * by - ay * bx;
		const dot = ax * bx + ay * by;
		if (Math.abs(cross) <= 1e-9 * (ax * ax + ay * ay + bx * bx + by * by) && dot <= 0) {
			addRange(-Math.PI, Math.PI, segment);
			continue;
		}
		let from = Math.atan2(ay, ax);
		let to = Math.atan2(by, bx);
		if (to < from) [from, to] = [to, from];
		// the shorter way round, which crosses the cut at a half turn when it is more than half a turn the other way
		if (to - from > Math.PI) {
			addRange(to - RANGE_PADDING, Math.PI, segment);
			addRange(-Math.PI, from + RANGE_PADDING, segment);
		} else addRange(from - RANGE_PADDING, to + RANGE_PADDING, segment);
	}
	return {buckets, starts, bucketOf};
}

// The flat segments of `segments` at some positions, and their `distances` (one per segment) in the same order.
const segmentsAt = (segments, distances, positions) => {
	const flat = new Array(positions.length * 4);
	positions.forEach((position, slot) => {
		for (let part = 0; part < 4; part++) flat[slot * 4 + part] = segments[position * 4 + part];
	});
	return {segments: flat, nearest: positions.map(position => distances[position])};
};

// The visibility polygons of (x, y) among `normal` and `limited` segments (each flat [ax, ay, bx, by, ...]) and `attenuated` ones
// ([{segment: [ax, ay, bx, by], reach}], each hiding only beyond `reach` from the point), within `box` ({minX, minY, maxX, maxY}),
// as flat paths: `visible`, reached before the nearest normal segment, attenuated reach and second limited segment, and
// `beforeLimited`, reached before the nearest of those and the first limited segment (so what lies between the two is behind
// exactly one limited segment).
export function visibilityPolygons(x, y, normal, limited, box, attenuated = []) {
	const {minX, minY, maxX, maxY} = box;
	const blocking = [...normal, minX, minY, maxX, minY, maxX, minY, maxX, maxY, maxX, maxY, minX, maxY, minX, maxY, minX, minY];
	const all = [...blocking, ...limited, ...attenuated.flatMap(({segment}) => segment)];
	const blockingCount = blocking.length / 4;
	const limitedCount = limited.length / 4;
	// each segment's nearest distance from the point; buckets list them nearest first, as hits() reads them
	const distances = new Float64Array(all.length / 4);
	for (let offset = 0; offset < all.length; offset += 4) distances[offset / 4] = distanceToSegment(x, y, all[offset], all[offset + 1], all[offset + 2], all[offset + 3]);
	const nearestFirst = Array.from(distances.keys()).sort((first, second) => distances[first] - distances[second]);
	const {buckets, starts, bucketOf} = angleBuckets(x, y, all, nearestFirst);
	// How far each bucket can be seen into: past where a normal segment (or the box) crosses its whole angle range, nothing in it
	// is seen. A segment, crossing or arc farther than that wherever it is cannot change the polygons, so it casts no rays: with
	// the whole scene in reach (a vision source's line of sight), most of the scene's walls are behind nearer ones.
	const bucketWidth = TWO_PI / buckets.length;
	const seenTo = new Float64Array(buckets.length).fill(Infinity);
	buckets.forEach((positions, bucket) => {
		const fromAngle = -Math.PI + bucket * bucketWidth;
		const fromX = Math.cos(fromAngle);
		const fromY = Math.sin(fromAngle);
		const toX = Math.cos(fromAngle + bucketWidth);
		const toY = Math.sin(fromAngle + bucketWidth);
		for (const position of positions) {
			// nearest first: one no nearer than how far is seen cannot bring it closer
			if (distances[position] >= seenTo[bucket]) break;
			if (position >= blockingCount) continue;
			const segment = all.slice(position * 4, position * 4 + 4);
			const throughWholeRange = Math.max(hits(x, y, fromX, fromY, segment), hits(x, y, toX, toY, segment));
			if (throughWholeRange < seenTo[bucket]) seenTo[bucket] = throughWholeRange;
		}
	});
	// a hair of margin, so something seen exactly at the limit still counts
	const isSeenAt = (distance, bucket) => distance <= seenTo[bucket] * (1 + 1e-9) + 1e-9;
	const isSeen = new Uint8Array(distances.length);
	buckets.forEach((positions, bucket) => {
		for (const position of positions) {
			if (!isSeenAt(distances[position], bucket)) break;
			isSeen[position] = 1;
		}
	});
	const angles = [];
	const addAngle = (px, py) => {
		if (px !== x || py !== y) angles.push(Math.atan2(py - y, px - x));
	};
	for (let offset = 0; offset < all.length; offset += 4) {
		if (!isSeen[offset / 4]) continue;
		addAngle(all[offset], all[offset + 1]);
		addAngle(all[offset + 2], all[offset + 3]);
	}
	// Where two segments (or a segment and the box) cross, what is nearest can change too. Two segments can only cross at an
	// angle both cover, so a pair is only tested where their runs of buckets overlap, once, in the bucket where the later run
	// starts: each segment starting its run in a bucket against the others there (the earlier of two starting together).
	buckets.forEach((positions, bucket) => {
		const runStarts = starts[bucket];
		for (let starterIndex = 0; starterIndex < positions.length; starterIndex++) {
			if (runStarts[starterIndex] !== bucket || !isSeen[positions[starterIndex]]) continue;
			for (let otherIndex = 0; otherIndex < positions.length; otherIndex++) {
				if (otherIndex === starterIndex || (runStarts[otherIndex] === bucket && otherIndex < starterIndex) || !isSeen[positions[otherIndex]]) continue;
				// the earlier segment first, so a crossing is worked out the same whichever starts here
				const first = Math.min(positions[starterIndex], positions[otherIndex]) * 4;
				const second = Math.max(positions[starterIndex], positions[otherIndex]) * 4;
				const ax = all[first];
				const ay = all[first + 1];
				const ex = all[first + 2] - ax;
				const ey = all[first + 3] - ay;
				const bx = all[second];
				const by = all[second + 1];
				const fx = all[second + 2] - bx;
				const fy = all[second + 3] - by;
				const denominator = ex * fy - ey * fx;
				if (denominator === 0) continue;
				const s = ((bx - ax) * fy - (by - ay) * fx) / denominator;
				const u = ((bx - ax) * ey - (by - ay) * ex) / denominator;
				if (!(s > 0 && s < 1 && u > 0 && u < 1)) continue;
				const px = ax + ex * s;
				const py = ay + ey * s;
				if (px === x && py === y) continue;
				const angle = Math.atan2(py - y, px - x);
				if (isSeenAt(Math.hypot(px - x, py - y), bucketOf(angle))) angles.push(angle);
			}
		}
	});
	// An attenuated segment's reach is an arc of a circle about the point: rays along it every few pixels (as core approximates
	// circles), and where it crosses the segment (where the farther of the two changes).
	attenuated.forEach(({segment, reach}, index) => {
		if (!isSeen[blockingCount + limitedCount + index]) return;
		const [ax, ay, bx, by] = segment;
		const ex = bx - ax;
		const ey = by - ay;
		// where |(a + e s) - (x, y)| = reach
		const fx = ax - x;
		const fy = ay - y;
		const a = ex * ex + ey * ey;
		const b = 2 * (fx * ex + fy * ey);
		const c = fx * fx + fy * fy - reach * reach;
		const discriminant = b * b - 4 * a * c;
		if (a > 0 && discriminant >= 0) {
			for (const sign of [-1, 1]) {
				const s = (-b + sign * Math.sqrt(discriminant)) / (2 * a);
				if (s > 0 && s < 1) addAngle(ax + ex * s, ay + ey * s);
			}
		}
		let from = Math.atan2(ay - y, ax - x);
		let to = Math.atan2(by - y, bx - x);
		if (to < from) [from, to] = [to, from];
		// the shorter way round (the segment never spans half a turn about a point it does not pass through)
		const span = to - from > Math.PI ? [to, from + 2 * Math.PI] : [from, to];
		const step = 4 / Math.max(reach, 1);
		for (let angle = span[0] + step; angle < span[1]; angle += step) angles.push(angle > Math.PI ? angle - 2 * Math.PI : angle);
	});
	// each bucket's segments by kind, as hits() reads them, made when a ray first needs them
	const bucketSegments = new Array(buckets.length);
	const segmentsInBucket = bucket => (bucketSegments[bucket] ??= kindsOf(buckets[bucket]));
	const kindsOf = positions => {
		const blockingPositions = [];
		const limitedPositions = [];
		const attenuatedHere = [];
		for (const position of positions) {
			if (position < blockingCount) blockingPositions.push(position);
			else if (position < blockingCount + limitedCount) limitedPositions.push(position);
			else attenuatedHere.push(attenuated[position - blockingCount - limitedCount]);
		}
		return {blocking: segmentsAt(all, distances, blockingPositions), limited: segmentsAt(all, distances, limitedPositions), attenuated: attenuatedHere};
	};
	// every ray, in angle order (the extra rays either side of two close angles interleave; a typed array sorts natively, much
	// faster than with a comparison function)
	const rays = new Float64Array(angles.length * 3);
	for (let index = 0; index < angles.length; index++) {
		rays[index * 3] = angles[index] - NUDGE;
		rays[index * 3 + 1] = angles[index];
		rays[index * 3 + 2] = angles[index] + NUDGE;
	}
	rays.sort();
	const visible = [];
	const beforeLimited = [];
	const addPoint = (points, dx, dy, t) => {
		const px = x + dx * t;
		const py = y + dy * t;
		const last = points.length - 2;
		if (last >= 0 && Math.abs(points[last] - px) < 1e-7 && Math.abs(points[last + 1] - py) < 1e-7) return;
		points.push(px, py);
	};
	let previous = NaN;
	for (const ray of rays) {
		if (ray === previous) continue;
		previous = ray;
		const dx = Math.cos(ray);
		const dy = Math.sin(ray);
		const here = segmentsInBucket(bucketOf(ray));
		let toNormal = hits(x, y, dx, dy, here.blocking.segments, {nearest: here.blocking.nearest});
		if (!Number.isFinite(toNormal)) continue;
		for (const {segment, reach} of here.attenuated) {
			const toSegment = hits(x, y, dx, dy, segment);
			if (Number.isFinite(toSegment)) toNormal = Math.min(toNormal, Math.max(toSegment, reach));
		}
		const [toFirstLimited, toSecondLimited] = hits(x, y, dx, dy, here.limited.segments, {second: true, nearest: here.limited.nearest});
		addPoint(visible, dx, dy, Math.min(toNormal, toSecondLimited));
		addPoint(beforeLimited, dx, dy, Math.min(toNormal, toFirstLimited));
	}
	return {visible: withoutCollinearPoints(visible), beforeLimited: withoutCollinearPoints(beforeLimited)};
}

// A closed flat path without the points lying on the straight line from the last point kept to the next one: most rays meet a
// segment between its ends, which only repeats it, and every later boolean operation pays for each point.
function withoutCollinearPoints(points) {
	const count = points.length / 2;
	if (count < 4) return points;
	const isOnLine = (ax, ay, px, py, bx, by) => Math.abs((px - ax) * (by - ay) - (py - ay) * (bx - ax)) <= 1e-3 * Math.hypot(bx - ax, by - ay);
	const kept = [points[0], points[1]];
	for (let index = 1; index < count; index++) {
		const next = ((index + 1) % count) * 2;
		const lastX = kept[kept.length - 2];
		const lastY = kept[kept.length - 1];
		if (!isOnLine(lastX, lastY, points[index * 2], points[index * 2 + 1], points[next], points[next + 1])) kept.push(points[index * 2], points[index * 2 + 1]);
	}
	// the first point, between the last kept and the second
	if (kept.length >= 8 && isOnLine(kept[kept.length - 2], kept[kept.length - 1], kept[0], kept[1], kept[2], kept[3])) kept.splice(0, 2);
	return kept.length >= 6 ? kept : points;
}
