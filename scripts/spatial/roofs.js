// A region's top shaped as a manual or an auto roof, each face a plane rising inward. The roof's
// lowest eaves sit at the region's bottom and it rises from there as high as its pitch takes it; a region with a top lower than
// that flattens it to fit. Planes are z = a + b x + c y (elevation; x, y in pixels).
//
// - Auto: a face rises from every edge of the region's outline (its straight skeleton, skeleton.js): a pyramid on a square,
//   hipped ends on a rectangle, valleys where the outline turns in, so it fits a hexagon, an L or any other outline. Its ends
//   (where a ridge ends) are hips with a gable below (all of the end: a gable on a rectangle, crossing gables on an L; some: a
//   jerkinhead) and a gable above (set back on the hip: a Dutch gable), each as deep as the roof says.
// - Manual: a straight ridge along the roof's direction, at its ridge position across the box around the outline (0 its left
//   side, facing the direction, 100 its right), and a face rising to it from each side: a gable at 50, a shed (one face) at 0
//   or 100, a saltbox between, its longer face's eave lower. With teeth, that cross-section repeats across the box (a sawtooth
//   of sheds, or a row of gables).
//
// Both rise straight from the eave at the pitch. Vertical steps inside the outline (between sawtooth teeth, a Dutch gable's
// set-back wall) are faces too, steep strips a pixel or less wide, so every ray and point under the roof meets one.
import {difference, intersection, signedArea, union, withWinding} from '../helpers/clipper.js';
import {clipToHalfPlane, polygonToEdges} from '../helpers/geometry.js';
import {isConvex, roofOutline, straightSkeleton} from './skeleton.js';

// Pixels an auto roof's outline may stray from the region's, so a round region is not hundreds of faces.
const HIP_TOLERANCE = 3;

// In the order the behavior's window lists them, after None.
export const ROOF_SHAPES = ['manual', 'auto'];

const SHORTEST_RUN_PIXELS = 1e-6;
const planeHeight = (plane, x, y) => plane.a + plane.b * x + plane.c * y;

function pieceOf(plane, paths) {
	let [low, high] = [Infinity, -Infinity];
	let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
	for (const path of paths) {
		for (let index = 0; index < path.length; index += 2) {
			const [x, y] = [path[index], path[index + 1]];
			const height = planeHeight(plane, x, y);
			[low, high] = [Math.min(low, height), Math.max(high, height)];
			[minX, minY, maxX, maxY] = [Math.min(minX, x), Math.min(minY, y), Math.max(maxX, x), Math.max(maxY, y)];
		}
	}
	const edges = Float64Array.from(paths.flatMap(path => Array.from(polygonToEdges(path, signedArea(path) < 0) ?? [])));
	return {plane, paths, edges, low, high, bounds: {minX, minY, maxX, maxY}};
}

const withArea = paths => paths.filter(path => Math.abs(signedArea(path)) > 1e-6);

function paddedBoxAroundPaths(paths) {
	let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
	for (const path of paths) {
		for (let index = 0; index < path.length; index += 2) {
			[minX, maxX] = [Math.min(minX, path[index]), Math.max(maxX, path[index])];
			[minY, maxY] = [Math.min(minY, path[index + 1]), Math.max(maxY, path[index + 1])];
		}
	}
	return [minX - 1, minY - 1, maxX + 1, minY - 1, maxX + 1, maxY + 1, minX - 1, maxY + 1];
}

// Where (x, y) . (normalX, normalY) - offset lies between from and to (either may be infinite); null when nothing is left.
function slabOfConvexPath(path, normalX, normalY, offset, from, to) {
	let part = path;
	if (from > -Infinity) part = part && clipToHalfPlane(part, -normalX, -normalY, offset + from);
	if (to < Infinity) part = part && clipToHalfPlane(part, normalX, normalY, -offset - to);
	return part;
}

// Null when they are in a line seen from above.
function planeThrough([x1, y1, z1], [x2, y2, z2], [x3, y3, z3]) {
	const determinant = (x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1);
	if (Math.abs(determinant) < 1e-9) return null;
	const b = ((z2 - z1) * (y3 - y1) - (z3 - z1) * (y2 - y1)) / determinant;
	const c = ((x2 - x1) * (z3 - z1) - (x3 - x1) * (z2 - z1)) / determinant;
	return {a: z1 - b * x1 - c * y1, b, c};
}

const risePerPixelAtPitch = (pitch, pixelsPerUnit) => Math.tan(Math.clamp(pitch ?? 0, 0, 89.9) * (Math.PI / 180)) / pixelsPerUnit;

// depth is the farthest any face runs. Flattened to fit below the region's top; null when it does not rise.
function roofProfile(roof, depth, top, bottom, pixelsPerUnit) {
	let slope = risePerPixelAtPitch(roof.pitch, pixelsPerUnit);
	const height = slope * depth;
	if (!(height > 0)) return null;
	if (height > top - bottom) slope *= (top - bottom) / height;
	return {slope, rise: distance => slope * distance, total: slope * depth};
}

// Height is eaveHeight + rise(shift + distance in from the eave line through (eaveX, eaveY)).
function slopePieces(paths, {eaveX, eaveY, inwardX, inwardY, eaveHeight, shift = 0}, profile) {
	if (!paths.length) return [];
	const {slope} = profile;
	return [pieceOf({a: eaveHeight + slope * (shift - eaveX * inwardX - eaveY * inwardY), b: slope * inwardX, c: slope * inwardY}, paths)];
}

// Drops points within a hair of the one before or of the line between their neighbours, which Clipper's rounding leaves.
const CORNER_HAIR = 0.05;
function cornersOfFace(path) {
	const corners = [];
	for (let index = 0; index < path.length; index += 2) corners.push([path[index], path[index + 1]]);
	for (let changed = true; changed && corners.length > 3; ) {
		changed = false;
		for (let index = 0; index < corners.length; index++) {
			const [[previousX, previousY], [x, y], [nextX, nextY]] = [corners[(index + corners.length - 1) % corners.length], corners[index], corners[(index + 1) % corners.length]];
			const length = Math.hypot(nextX - previousX, nextY - previousY);
			const distanceFromLine = length ? Math.abs((nextX - previousX) * (previousY - y) - (previousX - x) * (nextY - previousY)) / length : 0;
			if (Math.hypot(x - previousX, y - previousY) < CORNER_HAIR || distanceFromLine < CORNER_HAIR) {
				corners.splice(index, 1);
				changed = true;
				break;
			}
		}
	}
	return corners;
}

// An auto roof's ends: where a ridge ends, an edge's face is a triangle whose tip only it and its two neighbours meet at, its
// neighbours' edges running opposite ways. Where many faces meet at a point (a pyramid, a cone) there is no ridge end, and the
// hip stays. Each end can be a gable below (roof.lowerGable) and above (roof.upperGable), each taking its share of the end's
// depth (from its edge to the tip, in percent), the hip what is left between them (none at 100 together: a gable):
// - below: the neighbours run on to the edge, which stands as a gable end, as far up as the lower gable reaches; the hip sits
//   above, its eave moved out by that much (it meets the neighbours along lines parallel to where it met them before). All of
//   it is a plain gable, the triangle going to the neighbours split along the ridge line; some of it, a jerkinhead.
// - above: the hip stops short of the ridge, and the neighbours run on over the rest, standing on the hip in a steep wall
//   set back from the edge: a Dutch gable.
// extra holds faces with their own slope.
function roofEnds(edges, facePaths, slopes, profile, roof) {
	const lowerGable = Math.clamp(roof.lowerGable ?? 0, 0, 100) / 100;
	const upperGable = Math.clamp(roof.upperGable ?? 0, 0, 100) / 100;
	const unchanged = {facePaths, extra: [], walls: [], changed: false};
	if (!lowerGable && !upperGable) return unchanged;
	const corners = facePaths.map(paths => (paths.length === 1 ? cornersOfFace(paths[0]) : null));
	const isNear = ([ax, ay], [bx, by]) => Math.hypot(ax - bx, ay - by) < 2 * CORNER_HAIR;
	const eaveLineOffset = edge => edge.ax * edge.nx + edge.ay * edge.ny;
	const distanceInFromEave = (edge, x, y) => x * edge.nx + y * edge.ny - eaveLineOffset(edge);
	const addedPathsByEdge = edges.map(() => []);
	const extra = [];
	const walls = [];
	const replacedEdgeIndexes = new Set();
	edges.forEach((edge, index) => {
		const triangle = corners[index];
		if (triangle?.length !== 3) return;
		const {previous, next} = edge;
		if (edges[previous].nx * edges[next].nx + edges[previous].ny * edges[next].ny > -1 + 1e-6) return;
		const tip = triangle.find(point => !isNear(point, [edge.ax, edge.ay]) && !isNear(point, [edge.bx, edge.by]));
		if (!tip) return;
		const meeting = corners.filter((others, other) => other !== index && others?.some(point => isNear(point, tip)));
		if (meeting.length !== 2) return;
		// where the ridge, through the tip along the neighbours' edges, meets this edge
		const [dx, dy] = [edges[next].dx, edges[next].dy];
		const [edgeX, edgeY] = [edge.bx - edge.ax, edge.by - edge.ay];
		const denominator = dx * edgeY - dy * edgeX;
		if (Math.abs(denominator) < 1e-12) return;
		const fractionAlong = Math.min(1, Math.max(0, ((tip[1] - edge.ay) * dx - (tip[0] - edge.ax) * dy) / denominator));
		const ridgeFoot = [edge.ax + edgeX * fractionAlong, edge.ay + edgeY * fractionAlong];
		const depth = distanceInFromEave(edge, ...tip);
		if (!(depth > SHORTEST_RUN_PIXELS)) return;
		// the gables take their shares of the end's depth from the bottom and the top, the hip what is left between them
		const lowerGableDepth = lowerGable * depth;
		const hipTop = depth - lowerGableDepth;
		const upperGableStart = Math.min(hipTop, (1 - upperGable) * depth - lowerGableDepth);
		if (lowerGableDepth <= SHORTEST_RUN_PIXELS && upperGableStart >= depth - SHORTEST_RUN_PIXELS) return;
		replacedEdgeIndexes.add(index);
		// where the raised hip is below both neighbours: its distance in plus the lower gable's depth short of theirs
		const raisedHipPart = convexPath => {
			let part = convexPath;
			for (const other of [edges[previous], edges[next]]) part = part && clipToHalfPlane(part, edge.nx - other.nx, edge.ny - other.ny, eaveLineOffset(other) - eaveLineOffset(edge) + lowerGableDepth);
			return part;
		};
		// the hip up to the wall, the wall (a strip a pixel or less wide) up to the neighbours' slopes, then those
		const hasWall = upperGableStart < hipTop - SHORTEST_RUN_PIXELS;
		const wallWidth = hasWall ? Math.min(1, upperGableStart / 10, (hipTop - upperGableStart) / 10) : 0;
		const hipBetween = (path, from, to) => (upperGableStart > SHORTEST_RUN_PIXELS ? slabOfConvexPath(raisedHipPart(path), edge.nx, edge.ny, eaveLineOffset(edge), from, to) : null);
		const hip = hipBetween([edge.ax, edge.ay, edge.bx, edge.by, ...tip], -Infinity, hasWall ? upperGableStart - wallWidth : Infinity);
		if (hip) extra.push({slope: {...slopes[index], shift: lowerGableDepth}, paths: [withWinding(hip, 1)]});
		const hipHeight = (x, y) => slopes[index].eaveHeight + profile.rise(distanceInFromEave(edge, x, y) + lowerGableDepth);
		for (const [half, neighbour] of [
			[[edge.ax, edge.ay, ...ridgeFoot, ...tip], previous],
			[[...ridgeFoot, edge.bx, edge.by, ...tip], next]
		]) {
			// the neighbour runs on over all of its half of the end but the hip and the wall
			const taken = hipBetween(half, -Infinity, upperGableStart);
			addedPathsByEdge[neighbour].push(...(taken ? difference([withWinding(half, 1)], [withWinding(taken, 1)]) : [half]));
			const strip = hasWall && hipBetween(half, upperGableStart - wallWidth, upperGableStart);
			if (!strip) continue;
			// the wall's foot on the hip, its top on the neighbour's slope, in triangles (the two lines are not in one plane)
			const neighbourHeight = (x, y) => slopes[neighbour].eaveHeight + profile.rise(distanceInFromEave(edges[neighbour], x, y));
			const points = [];
			for (let offset = 0; offset < strip.length; offset += 2) {
				const [x, y] = [strip[offset], strip[offset + 1]];
				points.push([x, y, distanceInFromEave(edge, x, y) < upperGableStart - wallWidth / 2 ? hipHeight(x, y) : neighbourHeight(x, y)]);
			}
			for (let corner = 1; corner + 1 < points.length; corner++) {
				const plane = planeThrough(points[0], points[corner], points[corner + 1]);
				if (plane) walls.push({plane, path: withWinding([...points[0].slice(0, 2), ...points[corner].slice(0, 2), ...points[corner + 1].slice(0, 2)], 1)});
			}
		}
	});
	if (!replacedEdgeIndexes.size) return unchanged;
	return {
		facePaths: facePaths.map((paths, index) => {
			const own = replacedEdgeIndexes.has(index) ? [] : paths;
			return addedPathsByEdge[index].length ? union([...own, ...addedPathsByEdge[index].map(path => withWinding(path, 1))]) : own;
		}),
		extra,
		walls,
		changed: true
	};
}

// A hole belongs to the smallest outer outline holding its first point (an island in a hole is an outer outline of its own).
function holesByOuter(outlines, outers) {
	const holesByOuterIndex = outers.map(() => []);
	const isInside = (points, x, y) => {
		let inside = false;
		for (let index = 0, last = points.length - 2; index < points.length; last = index, index += 2) {
			const [ax, ay, bx, by] = [points[index], points[index + 1], points[last], points[last + 1]];
			if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
		}
		return inside;
	};
	for (const hole of outlines.filter(outline => outline.isHole)) {
		const [x, y] = hole.points;
		let smallestOuter = -1;
		outers.forEach(({points}, index) => {
			if (isInside(points, x, y) && (smallestOuter < 0 || Math.abs(signedArea(points)) < Math.abs(signedArea(outers[smallestOuter].points)))) smallestOuter = index;
		});
		if (smallestOuter >= 0) holesByOuterIndex[smallestOuter].push(hole);
	}
	return holesByOuterIndex;
}

// Holes get eaves too, so the roof falls to every hole as to the outside (a courtyard). Outlines are simplified within the
// region (roofOutline): outers a hair smaller, holes a hair larger. Where an outline was rounded, the band between its eaves and the region's border is a flat eave strip at the bottom, so the
// roof meets the border at the bottom all round (eaves standing on a sliver of wall there would cast hairline shadows).
function autoRoof(outlines, area, roof, top, bottom, pixelsPerUnit) {
	const outers = outlines.filter(outline => !outline.isHole);
	const holesOf = holesByOuter(outlines, outers);
	let isRounded = false;
	const simplified = (points, grow) => {
		const outline = roofOutline(points, HIP_TOLERANCE, grow);
		isRounded ||= outline !== points;
		return outline;
	};
	const hipOutlines = outers.map(({points}) => simplified(Array.from(points), false));
	const skeletons = hipOutlines.map((hipOutline, index) =>
		straightSkeleton(
			hipOutline,
			holesOf[index].map(({points}) => simplified(Array.from(points), true))
		)
	);
	if (!skeletons.length || skeletons.some(skeleton => !skeleton)) return null;
	const depth = Math.max(...skeletons.map(skeleton => skeleton.time));
	if (!(depth > 0)) return null;
	const profile = roofProfile(roof, depth, top, bottom, pixelsPerUnit);
	if (!profile) return null;
	const eaveHeight = bottom;
	const pieces = [];
	const inArea = paths => (paths.length ? withArea(intersection(area, paths)) : []);
	let hasWalls = false;
	for (const {edges, faces} of skeletons) {
		const facePaths = faces.map(quads => union(quads.filter(quad => Math.abs(signedArea(quad)) > 1e-9).map(quad => withWinding(quad, 1))));
		const slopes = edges.map(edge => ({eaveX: edge.ax, eaveY: edge.ay, inwardX: edge.nx, inwardY: edge.ny, eaveHeight}));
		const ends = roofEnds(edges, facePaths, slopes, profile, roof);
		hasWalls ||= ends.walls.length > 0;
		for (const [index, paths] of ends.facePaths.entries()) pieces.push(...slopePieces(inArea(paths), slopes[index], profile));
		for (const {slope, paths} of ends.extra) pieces.push(...slopePieces(inArea(paths), slope, profile));
		for (const {plane, path} of ends.walls) {
			const paths = inArea([path]);
			if (paths.length) pieces.push(pieceOf(plane, paths));
		}
	}
	if (!pieces.length) return null;
	const planes = pieces.map(piece => piece.plane);
	// what of the region the faces leave becomes a flat eave strip at the bottom
	if (isRounded) {
		const strip = withArea(
			difference(
				area,
				pieces.flatMap(piece => piece.paths)
			)
		);
		if (strip.length) pieces.push(pieceOf({a: bottom, b: 0, c: 0}, strip));
	}
	// one convex outline's roof without holes is the lowest of its faces everywhere, down to the bottom (gable ends drop a face,
	// a jerkinhead's lowers one: still the lowest of those left), unless a Dutch gable's wall steps it
	const isLowest = !hasWalls && outers.length === 1 && !holesOf[0].length && isConvex(hipOutlines[0]);
	return {planes, floor: bottom, pieces, isLowest, isConvexSolid: isLowest};
}

function manualRoof(outlines, area, roof, top, bottom, pixelsPerUnit) {
	// across the direction, to its right (clockwise from east, y down)
	const angle = (roof.direction * Math.PI) / 180;
	const [acrossX, acrossY] = [-Math.sin(angle), Math.cos(angle)];
	let [left, right] = [Infinity, -Infinity];
	for (const {points} of outlines) {
		for (let index = 0; index < points.length; index += 2) {
			const across = points[index] * acrossX + points[index + 1] * acrossY;
			[left, right] = [Math.min(left, across), Math.max(right, across)];
		}
	}
	const teeth = Math.max(1, Math.round(roof.teeth ?? 1));
	const width = (right - left) / teeth;
	if (!(width > 0)) return null;
	// each tooth's ridge, and how far each of its faces runs from its eave to it; the longer run is the roof's depth
	const ridgeAt = (width * Math.clamp(roof.ridge ?? 50, 0, 100)) / 100;
	const [leftRun, rightRun] = [ridgeAt, width - ridgeAt];
	const profile = roofProfile(roof, Math.max(leftRun, rightRun), top, bottom, pixelsPerUnit);
	if (!profile) return null;
	// the ridge, where the longer face's eave sits at the region's bottom
	const peak = bottom + profile.total;
	// the height at a distance across a tooth, from its start
	const toothHeight = offset =>
		offset <= ridgeAt ? (leftRun > SHORTEST_RUN_PIXELS ? peak - profile.rise(leftRun) + profile.rise(offset) : peak) : peak - profile.rise(rightRun) + profile.rise(width - offset);
	const [startHeight, endHeight] = [toothHeight(0), toothHeight(width)];
	// Where one tooth ends higher than the next starts (a sawtooth's sheds), a steep wall joins them, taken from the higher side.
	const wallWidth = Math.min(1, width / 100);
	const wallAtEnd = endHeight > startHeight + 1e-9;
	const wallAtStart = startHeight > endHeight + 1e-9;
	const box = paddedBoxAroundPaths(outlines.map(({points}) => points));
	const within = (from, to) => {
		const strip = from < to ? slabOfConvexPath(box, acrossX, acrossY, 0, from, to) : null;
		return strip ? withArea(intersection(area, [strip])) : [];
	};
	const pieces = [];
	for (let tooth = 0; tooth < teeth; tooth++) {
		const start = left + tooth * width;
		const end = start + width;
		const from = start + (tooth > 0 && wallAtStart ? wallWidth : 0);
		const to = end - (tooth < teeth - 1 && wallAtEnd ? wallWidth : 0);
		const ridge = start + ridgeAt;
		if (leftRun > SHORTEST_RUN_PIXELS) {
			const slope = {eaveX: acrossX * start, eaveY: acrossY * start, inwardX: acrossX, inwardY: acrossY, eaveHeight: peak - profile.rise(leftRun)};
			pieces.push(...slopePieces(within(from, Math.min(ridge, to)), slope, profile));
		}
		if (rightRun > SHORTEST_RUN_PIXELS) {
			const slope = {eaveX: acrossX * end, eaveY: acrossY * end, inwardX: -acrossX, inwardY: -acrossY, eaveHeight: peak - profile.rise(rightRun)};
			pieces.push(...slopePieces(within(Math.max(ridge, from), to), slope, profile));
		}
		if (tooth === teeth - 1 || !(wallAtEnd || wallAtStart)) continue;
		// the wall: level along the ridge, falling across it from one tooth's height to the next's
		const [wallFrom, wallTo] = wallAtEnd ? [end - wallWidth, end] : [end, end + wallWidth];
		const [heightFrom, heightTo] = wallAtEnd ? [toothHeight(width - wallWidth), startHeight] : [endHeight, toothHeight(wallWidth)];
		const fall = (heightTo - heightFrom) / wallWidth;
		const paths = within(wallFrom, wallTo);
		if (paths.length) pieces.push(pieceOf({a: heightFrom - fall * wallFrom, b: fall * acrossX, c: fall * acrossY}, paths));
	}
	// a single tooth is the lowest of its faces everywhere, and over one convex outline
	// without holes the region under it is a convex solid
	const isLowest = teeth === 1;
	const outers = outlines.filter(outline => !outline.isHole);
	const isConvexSolid = isLowest && outers.length === outlines.length && outers.length === 1 && isConvex(Array.from(outers[0].points));
	return pieces.length ? {planes: pieces.map(piece => piece.plane), floor: -Infinity, pieces, isLowest, isConvexSolid} : null;
}

// Each piece is where in plan one face is the roof: the region's outlines cut along the ridge, hip and valley lines.
// planes leaves out an eave strip's; floor is the eave strip's height, else -Infinity. isLowest: the roof is the lowest of
// its planes everywhere, down to its floor. isConvexSolid: the region under it is convex. Null when the roof is flat.
export function roofFaces(outlines, roof, top, bottom, pixelsPerUnit) {
	if (!ROOF_SHAPES.includes(roof?.shape) || !(roof.pitch > 0) || !Number.isFinite(bottom) || !(top > bottom)) return null;
	const area = union(
		outlines.map(({points}) => Array.from(points)),
		true
	);
	return (roof.shape === 'auto' ? autoRoof : manualRoof)(outlines, area, roof, top, bottom, pixelsPerUnit);
}
