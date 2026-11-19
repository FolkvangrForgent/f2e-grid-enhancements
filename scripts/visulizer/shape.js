import {distanceToSegment} from '../raycast/geometry.js';

// Flat polygons and Clipper: the boolean operations the visualizer cuts shapes with, and the form core's polygons carry their
// pieces in. A flat path is [x0, y0, x1, y1, ...]; in a list of them, outlines have a positive signed area and holes a negative
// one (non-zero fill). A shape is a PIXI.Polygon (its main outline) with `holes` (PIXI.Polygon[]) and `islands` (further
// outlines, each with its own `holes`).

// Clipper works on integers: coordinates are multiplied by core's CONST.CLIPPER_SCALING_FACTOR (100: a hundredth of a pixel)
// and rounded. A finer scale would push a scene's coordinates past ClipperLib's fast range (its loRange, 47,453,132 in the
// JavaScript build: 4,745 pixels at 10,000), where every operation does big-integer math.
const clipperScale = () => CONST.CLIPPER_SCALING_FACTOR;

// How far every shadow is grown before it is cut out, in pixels: shadows that meet along a ray (neighbouring walls) are only
// nearly collinear once rounded, and growing them a hair makes them overlap instead of leaving a seam of light between them.
// Several of Clipper's rounding steps (a hundredth of a pixel), so rounding never undoes it.
const CUT_GROW = 0.05;

export function signedArea(flat) {
	let area = 0;
	for (let index = 0; index < flat.length; index += 2) {
		const next = (index + 2) % flat.length;
		area += flat[index] * flat[next + 1] - flat[next] * flat[index + 1];
	}
	return area / 2;
}

// The same path, reversed if needed so its signed area has the sign `winding` (1 or -1).
export function withWinding(flat, winding) {
	if (Math.sign(signedArea(flat)) === winding) return flat;
	const reversed = [];
	for (let index = flat.length - 2; index >= 0; index -= 2) reversed.push(flat[index], flat[index + 1]);
	return reversed;
}

// A flat path as Clipper's integer points, at `scale` (core's polygon mesher has its own).
export const toClipperPath = (flat, scale = clipperScale()) => {
	const path = [];
	for (let index = 0; index < flat.length; index += 2) path.push(new ClipperLib.IntPoint(Math.round(flat[index] * scale), Math.round(flat[index + 1] * scale)));
	return path;
};

const fromClipperPath = (path, scale = clipperScale()) => path.flatMap(point => [point.X / scale, point.Y / scale]);

const isFinitePath = path => path.length >= 6 && path.every(Number.isFinite);

// Runs a boolean operation (a ClipperLib.ClipType) on two lists of flat paths and returns Clipper's PolyTree, or null if it
// cannot. `subjectFill` and `clipFill` are ClipperLib.PolyFillType (non-zero by default). StrictlySimple turns holes that touch
// an outline into notches in it, which the masks and the mesher draw correctly; it costs a good deal on many paths, so the
// steps along the way (the boolean operations below) leave it out, and only shapes that are drawn need it.
export function clipTree(subjectPaths, clipPaths, clipType, subjectFill = ClipperLib.PolyFillType.pftNonZero, clipFill = ClipperLib.PolyFillType.pftNonZero, strictlySimple = true) {
	const clipper = new ClipperLib.Clipper();
	clipper.StrictlySimple = strictlySimple;
	clipper.AddPaths(
		subjectPaths.filter(isFinitePath).map(path => toClipperPath(path)),
		ClipperLib.PolyType.ptSubject,
		true
	);
	clipper.AddPaths(
		clipPaths.filter(isFinitePath).map(path => toClipperPath(path)),
		ClipperLib.PolyType.ptClip,
		true
	);
	const tree = new ClipperLib.PolyTree();
	return clipper.Execute(clipType, tree, subjectFill, clipFill) ? tree : null;
}

// Every outline and hole of a PolyTree, nested at any depth, as flat paths (outlines positive, holes negative).
export function treePaths(tree) {
	const paths = [];
	const collect = (nodes, depth) => {
		for (const node of nodes) {
			paths.push(withWinding(fromClipperPath(node.Contour()), depth % 2 === 0 ? 1 : -1));
			collect(node.Childs(), depth + 1);
		}
	};
	if (tree) collect(tree.Childs(), 0);
	return paths;
}

// The boolean operations on lists of flat paths, as lists of flat paths. Paths read with the even-odd rule where `evenOdd`
// (a region's outlines, which nest without a winding), otherwise non-zero.
export const union = (paths, evenOdd = false) => {
	const fill = evenOdd ? ClipperLib.PolyFillType.pftEvenOdd : ClipperLib.PolyFillType.pftNonZero;
	return treePaths(clipTree(paths, [], ClipperLib.ClipType.ctUnion, fill, fill, false));
};
const nonZero = (subject, clip, clipType) => treePaths(clipTree(subject, clip, clipType, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero, false));
export const difference = (subject, clip) => (clip.length ? nonZero(subject, clip, ClipperLib.ClipType.ctDifference) : subject);
export const intersection = (subject, clip) => nonZero(subject, clip, ClipperLib.ClipType.ctIntersection);

// Where at least two of some areas (each a list of flat paths wound once: outlines positive, holes negative) overlap, within
// `box`: every area counts one, the box (grown a pixel, so nothing lies on its edge) counts minus one, and what stays positive
// is covered twice or more. One operation, however many areas.
export function coveredTwice(areas, box) {
	const grownBox = {minX: box.minX - 1, minY: box.minY - 1, maxX: box.maxX + 1, maxY: box.maxY + 1};
	const positive = ClipperLib.PolyFillType.pftPositive;
	return treePaths(clipTree([...areas.flat(), withWinding(pathFromBox(grownBox), -1)], [], ClipperLib.ClipType.ctUnion, positive, positive, false));
}

// Paths grown by CUT_GROW (see there), as one non-zero set.
export function grown(paths) {
	if (!paths.length) return paths;
	const offsetter = new ClipperLib.ClipperOffset(2);
	offsetter.AddPaths(
		paths.filter(isFinitePath).map(path => toClipperPath(path)),
		ClipperLib.JoinType.jtMiter,
		ClipperLib.EndType.etClosedPolygon
	);
	const result = new ClipperLib.Paths();
	offsetter.Execute(result, CUT_GROW * clipperScale());
	const flat = result.map(path => fromClipperPath(path)).filter(isFinitePath);
	return flat.length ? flat : paths;
}

// A circle as a flat path, with about one vertex every few pixels, as core approximates circles.
export function circlePath(x, y, radius) {
	const count = Math.min(512, Math.max(32, Math.ceil((2 * Math.PI * radius) / 4)));
	const path = [];
	for (let index = 0; index < count; index++) {
		const angle = (2 * Math.PI * index) / count;
		path.push(x + radius * Math.cos(angle), y + radius * Math.sin(angle));
	}
	return path;
}

export const pathFromBox = ({minX, minY, maxX, maxY}) => [minX, minY, maxX, minY, maxX, maxY, minX, maxY];

// A test of whether some flat paths overlap an area (flat paths, non-zero: outlines positive, holes negative): their boxes
// meet, and a point of one lies inside the other or two of their edges cross. Touching counts, so nothing that overlaps by a
// hair is missed.
export function overlapTest(areaPaths) {
	const areaBox = boundingBox(areaPaths.flat());
	const isInsideArea = (x, y) => areaPaths.reduce((sum, path) => sum + windingAt(path, x, y), 0) !== 0;
	return paths => {
		const box = boundingBox(paths.flat());
		if (box.minX > areaBox.maxX || box.maxX < areaBox.minX || box.minY > areaBox.maxY || box.maxY < areaBox.minY) return false;
		for (const path of paths) {
			if (isInsideArea(path[0], path[1])) return true;
			for (const areaPath of areaPaths) {
				if (windingAt(path, areaPath[0], areaPath[1])) return true;
				if (pathsCross(path, areaPath)) return true;
			}
		}
		return false;
	};
}

// The winding number of a closed flat path about a point.
function windingAt(path, x, y) {
	let winding = 0;
	for (let index = 0; index < path.length; index += 2) {
		const next = (index + 2) % path.length;
		const ax = path[index];
		const ay = path[index + 1];
		const bx = path[next];
		const by = path[next + 1];
		const side = (bx - ax) * (y - ay) - (x - ax) * (by - ay);
		if (ay <= y) {
			if (by > y && side > 0) winding++;
		} else if (by <= y && side < 0) winding--;
	}
	return winding;
}

// Which side of the line p -> q the point r is on (-1, 0 or 1).
const sideOf = (px, py, qx, qy, rx, ry) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));

// Whether an edge of one closed flat path crosses (or touches) an edge of another.
function pathsCross(first, second) {
	for (let index = 0; index < first.length; index += 2) {
		const next = (index + 2) % first.length;
		const ax = first[index];
		const ay = first[index + 1];
		const bx = first[next];
		const by = first[next + 1];
		const minX = Math.min(ax, bx);
		const maxX = Math.max(ax, bx);
		const minY = Math.min(ay, by);
		const maxY = Math.max(ay, by);
		for (let other = 0; other < second.length; other += 2) {
			const otherNext = (other + 2) % second.length;
			const cx = second[other];
			const cy = second[other + 1];
			const dx = second[otherNext];
			const dy = second[otherNext + 1];
			if (Math.max(cx, dx) < minX || Math.min(cx, dx) > maxX || Math.max(cy, dy) < minY || Math.min(cy, dy) > maxY) continue;
			if (sideOf(ax, ay, bx, by, cx, cy) * sideOf(ax, ay, bx, by, dx, dy) <= 0 && sideOf(cx, cy, dx, dy, ax, ay) * sideOf(cx, cy, dx, dy, bx, by) <= 0) return true;
		}
	}
	return false;
}

// The smallest box around a flat path, grown by `margin`.
export function boundingBox(flat, margin = 0) {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (let index = 0; index < flat.length; index += 2) {
		minX = Math.min(minX, flat[index]);
		maxX = Math.max(maxX, flat[index]);
		minY = Math.min(minY, flat[index + 1]);
		maxY = Math.max(maxY, flat[index + 1]);
	}
	return {minX: minX - margin, minY: minY - margin, maxX: maxX + margin, maxY: maxY + margin};
}

// A path clipped to a box (Sutherland-Hodgman), keeping its orientation, or null when nothing is left. A shadow can reach
// millions of pixels out (a wall seen nearly edge-on); only the part in the polygon's box matters, and Clipper wants small
// coordinates.
export function clipToBox(flat, box) {
	let points = [];
	for (let index = 0; index < flat.length; index += 2) points.push({x: flat[index], y: flat[index + 1]});
	const sides = [
		['x', 1, box.minX],
		['x', -1, box.maxX],
		['y', 1, box.minY],
		['y', -1, box.maxY]
	];
	for (const [axis, direction, bound] of sides) {
		const other = axis === 'x' ? 'y' : 'x';
		const isInside = point => direction * (point[axis] - bound) >= 0;
		const crossing = (from, to) => {
			const t = (bound - from[axis]) / (to[axis] - from[axis]);
			return {[axis]: bound, [other]: from[other] + t * (to[other] - from[other])};
		};
		const kept = [];
		for (let index = 0; index < points.length; index++) {
			const current = points[index];
			const previous = points[(index + points.length - 1) % points.length];
			if (isInside(current)) {
				if (!isInside(previous)) kept.push(crossing(previous, current));
				kept.push(current);
			} else if (isInside(previous)) kept.push(crossing(previous, current));
		}
		points = kept;
		if (points.length < 3) return null;
	}
	const result = points.flatMap(point => [point.x, point.y]);
	return Math.abs(signedArea(result)) >= 1e-3 ? result : null;
}

// The point `factor` times as far from (originX, originY) as (x, y), on the same ray.
const scaleFrom = (originX, originY, x, y, factor) => [originX + (x - originX) * factor, originY + (y - originY) * factor];

// The floor a segment (ax, ay)-(bx, by) shades, seen from (originX, originY): the part of each ray past it scaled from `near` to
// `far` times its distance, clipped to `box`, or null. (The shadow of a vertical barrier on a floor below the source.)
export function segmentShadow(originX, originY, ax, ay, bx, by, near, far, box) {
	if (!(far - near > 1e-9)) return null;
	const quad = [...scaleFrom(originX, originY, ax, ay, near), ...scaleFrom(originX, originY, bx, by, near), ...scaleFrom(originX, originY, bx, by, far), ...scaleFrom(originX, originY, ax, ay, far)];
	if (!isFinitePath(quad) || Math.abs(signedArea(quad)) < 1e-3) return null;
	return clipToBox(withWinding(quad, 1), box);
}

// A flat path scaled by `factor` from (originX, originY). (The shadow of a horizontal barrier on a floor below the source.)
export const scaledPath = (flat, originX, originY, factor) => flat.map((value, index) => (index % 2 ? originY : originX) + (value - (index % 2 ? originY : originX)) * factor);

// ---- shapes with holes and islands ----

// The outlines of a PolyTree's nodes, each with the holes directly in it (depths 0, 2, ... are outlines; an outline inside a hole
// is a piece of its own).
function* outlines(nodes, depth = 0) {
	for (const node of nodes) {
		if (depth % 2 === 0) yield {contour: node.Contour(), holes: node.Childs().map(child => child.Contour())};
		yield* outlines(node.Childs(), depth + 1);
	}
}

function distanceToOutline(flat, x, y) {
	let nearest = Infinity;
	for (let index = 0; index < flat.length; index += 2) {
		const next = (index + 2) % flat.length;
		nearest = Math.min(nearest, distanceToSegment(x, y, flat[index], flat[index + 1], flat[next], flat[next + 1]));
	}
	return nearest;
}

// Pieces and holes smaller than this many square pixels, or thinner than this many pixels, are rounding slivers.
const MIN_PIECE_AREA = 4;
const MIN_PIECE_WIDTH = 0.5;

function perimeter(flat) {
	let length = 0;
	for (let index = 0; index < flat.length; index += 2) {
		const next = (index + 2) % flat.length;
		length += Math.hypot(flat[next] - flat[index], flat[next + 1] - flat[index + 1]);
	}
	return length || 1;
}

// Whether `test` holds for a piece's outline and fails for each of its holes.
export const inPiece = (piece, test) => test(piece) && !piece.holes?.some(test);

// The pieces of a PolyTree, each a PIXI.Polygon with `holes`, the main one first: the one around the origin (the source), else,
// when the origin is on an outline or in no piece (a shadow covers it), the largest. Slivers are dropped. Empty when nothing is
// left.
export function piecesFromTree(tree, origin) {
	// slivers: too small, or too thin (a long hairline has area, but its width, twice its area over its perimeter, is nothing)
	const isSliver = polygon => {
		const area = Math.abs(signedArea(polygon.points));
		return area < MIN_PIECE_AREA || (2 * area) / perimeter(polygon.points) < MIN_PIECE_WIDTH;
	};
	const pieces = [];
	for (const {contour, holes} of outlines(tree.Childs())) {
		const piece = new PIXI.Polygon(fromClipperPath(contour));
		piece.holes = holes.map(hole => new PIXI.Polygon(fromClipperPath(hole))).filter(hole => !isSliver(hole));
		if (!isSliver(piece)) pieces.push(piece);
	}
	if (!pieces.length) return pieces;
	const holdsOrigin = piece => distanceToOutline(piece.points, origin.x, origin.y) > 0.05 && inPiece(piece, polygon => polygon.contains(origin.x, origin.y));
	let mainIndex = pieces.findIndex(holdsOrigin);
	if (mainIndex < 0) {
		const areas = pieces.map(piece => Math.abs(signedArea(piece.points)));
		mainIndex = areas.indexOf(Math.max(...areas));
	}
	const [main] = pieces.splice(mainIndex, 1);
	return [main, ...pieces];
}

// A shape's pieces as flat paths (outlines with the sign `winding`, holes the other).
export const shapePaths = (shape, winding = 1) =>
	[shape, ...(shape.islands ?? [])].flatMap(piece => [withWinding(piece.points, winding), ...(piece.holes ?? []).map(hole => withWinding(hole.points, -winding))]);

// Stores pieces on a polygon: its points are the main outline, with `holes` and `islands`. Nothing left empties it.
export function setPieces(polygon, pieces) {
	const [main, ...islands] = pieces;
	polygon.points = main ? main.points : [];
	polygon.holes = main?.holes.length ? main.holes : null;
	polygon.islands = islands.length ? islands : null;
}
