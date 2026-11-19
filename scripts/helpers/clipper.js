export function clip(subjectPaths, clipPaths, clipType, solution) {
	const clipper = new ClipperLib.Clipper();
	clipper.AddPaths(subjectPaths, ClipperLib.PolyType.ptSubject, true);
	clipper.AddPaths(clipPaths, ClipperLib.PolyType.ptClip, true);
	clipper.Execute(clipType, solution, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
	return solution;
}
