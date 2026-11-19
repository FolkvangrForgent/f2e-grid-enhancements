// A flat path is [x0, y0, x1, y1, ...]; in a list of them, outlines have a positive signed area and holes a negative one.

export function clip(subjectPaths, clipPaths, clipType, solution) {
	const clipper = new ClipperLib.Clipper();
	clipper.AddPaths(subjectPaths, ClipperLib.PolyType.ptSubject, true);
	clipper.AddPaths(clipPaths, ClipperLib.PolyType.ptClip, true);
	clipper.Execute(clipType, solution, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
	return solution;
}

// Clipper works on integers: coordinates are multiplied by core's CONST.CLIPPER_SCALING_FACTOR (100: a hundredth of a pixel)
// and rounded. A finer scale would push a scene's coordinates past ClipperLib's fast range (its loRange, 47,453,132 in the
// JavaScript build: 4,745 pixels at 10,000), where every operation does big-integer math.
const clipperScale = () => CONST.CLIPPER_SCALING_FACTOR;

export function signedArea(flatPath) {
	let area = 0;
	for (let index = 0; index < flatPath.length; index += 2) {
		const next = (index + 2) % flatPath.length;
		area += flatPath[index] * flatPath[next + 1] - flatPath[next] * flatPath[index + 1];
	}
	return area / 2;
}

export function withWinding(flatPath, signOfArea) {
	if (Math.sign(signedArea(flatPath)) === signOfArea) return flatPath;
	const reversed = [];
	for (let index = flatPath.length - 2; index >= 0; index -= 2) reversed.push(flatPath[index], flatPath[index + 1]);
	return reversed;
}

export const toClipperPath = (flatPath, scale = clipperScale()) => {
	const clipperPath = [];
	for (let index = 0; index < flatPath.length; index += 2) clipperPath.push(new ClipperLib.IntPoint(Math.round(flatPath[index] * scale), Math.round(flatPath[index + 1] * scale)));
	return clipperPath;
};

export const fromClipperPath = (clipperPath, scale = clipperScale()) => clipperPath.flatMap(point => [point.X / scale, point.Y / scale]);

const isFinitePath = path => path.length >= 6 && path.every(Number.isFinite);

// StrictlySimple turns holes that touch
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

function treePaths(tree) {
	const paths = [];
	const collect = (nodes, nestingDepth) => {
		for (const node of nodes) {
			paths.push(withWinding(fromClipperPath(node.Contour()), nestingDepth % 2 === 0 ? 1 : -1));
			collect(node.Childs(), nestingDepth + 1);
		}
	};
	if (tree) collect(tree.Childs(), 0);
	return paths;
}

// evenOdd is for a region's outlines, which nest without a winding.
export const union = (paths, evenOdd = false) => {
	const fill = evenOdd ? ClipperLib.PolyFillType.pftEvenOdd : ClipperLib.PolyFillType.pftNonZero;
	return treePaths(clipTree(paths, [], ClipperLib.ClipType.ctUnion, fill, fill, false));
};
const nonZeroOperation = (subject, clipPaths, clipType) => treePaths(clipTree(subject, clipPaths, clipType, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero, false));
export const difference = (subject, clipPaths) => (clipPaths.length ? nonZeroOperation(subject, clipPaths, ClipperLib.ClipType.ctDifference) : subject);
export const intersection = (subject, clipPaths) => nonZeroOperation(subject, clipPaths, ClipperLib.ClipType.ctIntersection);
