// Straight skeleton: every edge moves inward at the same speed, along its normal,
// and each edge's roof face is what it sweeps. Worked out by following that wavefront from event to event: an edge shrinking
// to nothing (its ends meet), or a reflex corner running into an edge (splitting the wavefront in two). Between events every
// wavefront edge sweeps a trapezoid of its face; the faces are those trapezoids together.
import {signedArea} from '../helpers/clipper.js';

const NEGLIGIBLE_PIXELS = 1e-7;
const MAX_EVENTS_PER_EDGE_PAIR = 50;

// The v with v . n1 = v . n2 = 1, so the corner stays on both edge lines as they move along their unit normals; along the
// normal when the edges run straight on, still when they double back.
function cornerVelocity(n1x, n1y, n2x, n2y) {
	const determinant = n1x * n2y - n1y * n2x;
	if (Math.abs(determinant) > 1e-12) return [(n2y - n1y) / determinant, (n1x - n2x) / determinant];
	return n1x * n2x + n1y * n2y > 0 ? [n1x, n1y] : [0, 0];
}

// Wound positively: the inside is to the left of each edge.
function withoutRepeatedOrCollinearPoints(points) {
	let corners = [];
	for (let index = 0; index < points.length; index += 2) corners.push([points[index], points[index + 1]]);
	let changed = true;
	while (changed && corners.length >= 3) {
		changed = false;
		for (let index = 0; index < corners.length; index++) {
			const [previous, here, next] = [corners[(index + corners.length - 1) % corners.length], corners[index], corners[(index + 1) % corners.length]];
			const cross = (here[0] - previous[0]) * (next[1] - here[1]) - (here[1] - previous[1]) * (next[0] - here[0]);
			const lengthProduct = Math.hypot(here[0] - previous[0], here[1] - previous[1]) * Math.hypot(next[0] - here[0], next[1] - here[1]);
			if (Math.hypot(here[0] - previous[0], here[1] - previous[1]) < NEGLIGIBLE_PIXELS || Math.abs(cross) <= 1e-12 * lengthProduct) {
				corners.splice(index, 1);
				changed = true;
				break;
			}
		}
	}
	if (corners.length < 3) return null;
	if (signedArea(corners.flat()) < 0) corners = corners.reverse();
	return corners;
}

// Douglas-Peucker (closed) within tolerance pixels, then moved out by that much (in when grow is false), so it lies wholly
// outside (inside) the original: a circle's hundreds of corners need not each be a roof face. The original when no corner
// can go.
const MAX_CORNERS_KEPT_AS_IS = 8;
export function roofOutline(points, tolerance, grow = true) {
	const corners = withoutRepeatedOrCollinearPoints(points);
	if (!corners || corners.length <= MAX_CORNERS_KEPT_AS_IS) return points;
	// split the ring at its two corners farthest apart
	const farthestFrom = (fromIndex, indexes) =>
		indexes.reduce(
			(farthest, index) =>
				Math.hypot(corners[index][0] - corners[fromIndex][0], corners[index][1] - corners[fromIndex][1]) >
				Math.hypot(corners[farthest][0] - corners[fromIndex][0], corners[farthest][1] - corners[fromIndex][1])
					? index
					: farthest,
			indexes[0]
		);
	const allIndexes = corners.map((_, index) => index);
	const start = farthestFrom(0, allIndexes);
	const end = farthestFrom(start, allIndexes);
	const keptIndexes = new Set([start, end]);
	const keepCornersStrayingPastTolerance = (from, to) => {
		const between = [];
		for (let index = (from + 1) % corners.length; index !== to; index = (index + 1) % corners.length) between.push(index);
		if (!between.length) return;
		const [[ax, ay], [bx, by]] = [corners[from], corners[to]];
		let [farthest, farthestDistance] = [-1, -1];
		for (const index of between) {
			const [x, y] = corners[index];
			const length = Math.hypot(bx - ax, by - ay);
			const distanceFromChord = length ? Math.abs((bx - ax) * (ay - y) - (ax - x) * (by - ay)) / length : Math.hypot(x - ax, y - ay);
			if (distanceFromChord > farthestDistance) [farthest, farthestDistance] = [index, distanceFromChord];
		}
		if (farthestDistance <= tolerance) return;
		keptIndexes.add(farthest);
		keepCornersStrayingPastTolerance(from, farthest);
		keepCornersStrayingPastTolerance(farthest, to);
	};
	keepCornersStrayingPastTolerance(start, end);
	keepCornersStrayingPastTolerance(end, start);
	if (keptIndexes.size === corners.length || keptIndexes.size < 3) return points;
	const kept = corners.filter((_, index) => keptIndexes.has(index));
	// out (or in) along each corner's bisector, so every edge moves by the tolerance
	const signedTolerance = grow ? tolerance : -tolerance;
	const moved = [];
	for (let index = 0; index < kept.length; index++) {
		const [previous, here, next] = [kept[(index + kept.length - 1) % kept.length], kept[index], kept[(index + 1) % kept.length]];
		const normalOf = ([ax, ay], [bx, by]) => {
			const length = Math.hypot(bx - ax, by - ay);
			return [(by - ay) / length, -(bx - ax) / length];
		};
		const [vx, vy] = cornerVelocity(...normalOf(previous, here), ...normalOf(here, next));
		moved.push(here[0] + vx * signedTolerance, here[1] + vy * signedTolerance);
	}
	return moved;
}

export function isConvex(points) {
	const corners = withoutRepeatedOrCollinearPoints(points);
	if (!corners) return false;
	for (let index = 0; index < corners.length; index++) {
		const [previous, here, next] = [corners[(index + corners.length - 1) % corners.length], corners[index], corners[(index + 1) % corners.length]];
		if ((here[0] - previous[0]) * (next[1] - here[1]) - (here[1] - previous[1]) * (next[0] - here[0]) < 0) return false;
	}
	return true;
}

// edges: the outline's, then each hole's; n is the normal into the polygon, previous and next the indexes of the neighbouring
// edges on the same outline. faces: flat quads per edge. time: pixels in to the last of it. Null when the polygon is
// degenerate or the wavefront cannot be followed. A hole's wavefront moves out and joins the one it runs into.
export function straightSkeleton(points, holes = []) {
	const outline = withoutRepeatedOrCollinearPoints(points);
	if (!outline) return null;
	// each outline with the polygon to the left of its edges: the outer one wound positively, holes the other way
	const loops = [
		outline,
		...holes
			.map(withoutRepeatedOrCollinearPoints)
			.filter(Boolean)
			.map(corners => corners.reverse())
	];
	const edges = [];
	const firstEdges = loops.map(corners => {
		const first = edges.length;
		corners.forEach(([ax, ay], index) => {
			const [bx, by] = corners[(index + 1) % corners.length];
			const length = Math.hypot(bx - ax, by - ay);
			const [previous, next] = [first + ((index + corners.length - 1) % corners.length), first + ((index + 1) % corners.length)];
			edges.push({ax, ay, bx, by, dx: (bx - ax) / length, dy: (by - ay) / length, nx: -(by - ay) / length, ny: (bx - ax) / length, previous, next});
		});
		return first;
	});
	const wavefrontCorner = (x, y, previous, next) => {
		const [first, second] = [edges[previous], edges[next]];
		const [vx, vy] = cornerVelocity(first.nx, first.ny, second.nx, second.ny);
		const isReflex = first.dx * second.dy - first.dy * second.dx < -1e-12;
		return {x, y, vx, vy, previous, next, isReflex};
	};
	let wavefronts = loops.map((corners, loop) => corners.map(([x, y], index) => wavefrontCorner(x, y, firstEdges[loop] + ((index + corners.length - 1) % corners.length), firstEdges[loop] + index)));
	const faces = edges.map(() => []);
	let sweptDistance = 0;
	const isCollapsed = wavefront => wavefront.length < 3 || Math.abs(signedArea(wavefront.flatMap(({x, y}) => [x, y]))) < 1e-6;

	for (let step = 0; step < MAX_EVENTS_PER_EDGE_PAIR * edges.length * edges.length + 100; step++) {
		wavefronts = wavefronts.filter(wavefront => !isCollapsed(wavefront));
		if (!wavefronts.length) return {edges, faces, time: sweptDistance};
		let next = {after: Infinity};
		wavefronts.forEach((wavefront, which) => {
			const count = wavefront.length;
			for (let index = 0; index < count; index++) {
				const [start, end] = [wavefront[index], wavefront[(index + 1) % count]];
				const {dx, dy} = edges[start.next];
				const length = (end.x - start.x) * dx + (end.y - start.y) * dy;
				const shrinking = (end.vx - start.vx) * dx + (end.vy - start.vy) * dy;
				const after = length <= NEGLIGIBLE_PIXELS ? 0 : shrinking < -1e-12 ? -length / shrinking : Infinity;
				if (after < next.after) next = {after, kind: 'edge', which, index};
			}
			// a reflex corner running into an edge: of its own wavefront (splitting it), or of another (joining them)
			for (let reflexIndex = 0; reflexIndex < count; reflexIndex++) {
				const reflex = wavefront[reflexIndex];
				if (!reflex.isReflex) continue;
				for (const [other, target] of wavefronts.entries()) {
					const targetCount = target.length;
					for (let index = 0; index < targetCount; index++) {
						if (other === which && (index === reflexIndex || (index + 1) % count === reflexIndex)) continue;
						const [start, end] = [target[index], target[(index + 1) % targetCount]];
						const edge = edges[start.next];
						const ahead = (reflex.x - start.x) * edge.nx + (reflex.y - start.y) * edge.ny;
						const closing = 1 - (reflex.vx * edge.nx + reflex.vy * edge.ny);
						if (closing <= 1e-12 || ahead < -NEGLIGIBLE_PIXELS) continue;
						const after = Math.max(0, ahead / closing);
						if (after >= next.after) continue;
						// where it meets the edge's line then, within the edge as it then is
						const along = (reflex.x + reflex.vx * after - (start.x + start.vx * after)) * edge.dx + (reflex.y + reflex.vy * after - (start.y + start.vy * after)) * edge.dy;
						const span = (end.x + end.vx * after - (start.x + start.vx * after)) * edge.dx + (end.y + end.vy * after - (start.y + start.vy * after)) * edge.dy;
						if (span < -NEGLIGIBLE_PIXELS || along < -NEGLIGIBLE_PIXELS || along > span + NEGLIGIBLE_PIXELS) continue;
						next = {after, kind: other === which ? 'split' : 'join', which, other, index, reflexIndex};
					}
				}
			}
		});
		if (!Number.isFinite(next.after)) return null;
		// every wavefront edge sweeps its face up to then
		if (next.after > 0) {
			for (const wavefront of wavefronts) {
				for (let index = 0; index < wavefront.length; index++) {
					const [start, end] = [wavefront[index], wavefront[(index + 1) % wavefront.length]];
					const t = next.after;
					faces[start.next].push([start.x, start.y, end.x, end.y, end.x + end.vx * t, end.y + end.vy * t, start.x + start.vx * t, start.y + start.vy * t]);
				}
				for (const point of wavefront) {
					point.x += point.vx * next.after;
					point.y += point.vy * next.after;
				}
			}
			sweptDistance += next.after;
		}
		const wavefront = wavefronts[next.which];
		const count = wavefront.length;
		if (next.kind === 'edge') {
			// its two ends become one corner
			const [start, end] = [wavefront[next.index], wavefront[(next.index + 1) % count]];
			const merged = wavefrontCorner((start.x + end.x) / 2, (start.y + end.y) / 2, start.previous, end.next);
			const rest = [];
			for (let offset = 2; offset < count; offset++) rest.push(wavefront[(next.index + offset) % count]);
			wavefronts[next.which] = [merged, ...rest];
		} else if (next.kind === 'join') {
			// the reflex corner joins the two wavefronts where it meets the other's edge: from the corner along that edge to its end,
			// round the other wavefront back to the edge's start, along the edge to the corner again, then round its own
			const reflex = wavefront[next.reflexIndex];
			const target = wavefronts[next.other];
			const edgeId = target[next.index].next;
			const joined = [wavefrontCorner(reflex.x, reflex.y, reflex.previous, edgeId)];
			for (let offset = 1; offset <= target.length; offset++) joined.push(target[(next.index + offset) % target.length]);
			joined.push(wavefrontCorner(reflex.x, reflex.y, edgeId, reflex.next));
			for (let offset = 1; offset < count; offset++) joined.push(wavefront[(next.reflexIndex + offset) % count]);
			wavefronts = wavefronts.filter((_, which) => which !== next.which && which !== next.other);
			wavefronts.push(joined);
		} else {
			// the reflex corner splits the wavefront where it meets the edge: one part runs on from the corner to the edge's start,
			// the other from the edge's end back to the corner
			const reflex = wavefront[next.reflexIndex];
			const edgeId = wavefront[next.index].next;
			const first = [wavefrontCorner(reflex.x, reflex.y, edgeId, reflex.next)];
			for (let index = (next.reflexIndex + 1) % count; ; index = (index + 1) % count) {
				first.push(wavefront[index]);
				if (index === next.index) break;
			}
			const second = [wavefrontCorner(reflex.x, reflex.y, reflex.previous, edgeId)];
			for (let index = (next.index + 1) % count; index !== next.reflexIndex; index = (index + 1) % count) second.push(wavefront[index]);
			wavefronts.splice(next.which, 1, first, second);
		}
	}
	return null;
}
