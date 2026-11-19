// Drawing shapes with holes and islands (see shape.js): masks through Graphics#drawShape, and light, darkness and vision meshes
// through PolygonMesher#triangulate, which core only ever gives one contour.
import * as patch from '../helpers/patch.js';
import {shapePaths, signedArea, toClipperPath} from './shape.js';

// Masks: a shape's holes are cut out with beginHole / endHole, and its islands drawn after it.
function patchMasks() {
	for (const path of ['PIXI.LegacyGraphics', 'PIXI.Graphics']) {
		patch.add(`${path}.prototype.drawShape`, (wrapped, graphics, shape, ...args) => {
			const result = wrapped(shape, ...args);
			if (shape?.holes?.length) {
				graphics.beginHole();
				for (const hole of shape.holes) graphics.drawShape(hole);
				graphics.endHole();
			}
			for (const island of shape?.islands ?? []) graphics.drawShape(island);
			return result;
		});
	}
}

// Meshes: while a source with holes or islands builds its geometry (its own _updateGeometry), PolygonMesher#triangulate builds it
// with them. The mesher only receives the contour, so the shape is handed over for the duration of that call.
function patchMeshes() {
	let shapeBeingMeshed = null;
	for (const path of ['PointLightSource', 'PointDarknessSource', 'PointVisionSource']) {
		patch.add(`foundry.canvas.sources.${path}.prototype._updateGeometry`, (wrapped, source, ...args) => {
			const shape = source._visualShape ?? source.shape;
			if (shapeBeingMeshed || (!shape?.holes?.length && !shape?.islands?.length)) return wrapped(...args);
			shapeBeingMeshed = shape;
			try {
				return wrapped(...args);
			} finally {
				shapeBeingMeshed = null;
			}
		});
	}
	patch.add('foundry.canvas.geometry.PolygonMesher.prototype.triangulate', (wrapped, mesher, geometry) => {
		// the interleaved layout is another attribute format, not built here
		if (!shapeBeingMeshed || mesher.options.interleaved) return wrapped(geometry);
		return triangulateWithHoles(mesher, geometry, shapeBeingMeshed) ?? wrapped(geometry);
	});
}

// The geometry PolygonMesher#triangulate builds, for a shape with holes and islands. As PolygonMesher does, the outline is offset
// inwards in passes of at most 3px, the depth running from depthOuter on the outline to depthInner inside (the soft edge); every
// pass offsets the whole shape, so holes get a soft edge too, and each face (a band between two passes, or the inside) is
// triangulated with its holes. Null when it cannot be built (core's then meshes the plain outline).
function triangulateWithHoles(mesher, geometry, shape) {
	const {x: centerX, y: centerY, radius, normalize, offset, depthOuter, depthInner, scale, miterLimit} = mesher.options;
	const passCount = Math.ceil(Math.abs(offset) / 3);
	// outlines and islands with the main outline's orientation, holes the other: ClipperOffset reads "inwards" from them
	const outlineWinding = Math.sign(signedArea(shape.points)) || 1;
	const pathsByPass = [shapePaths(shape, outlineWinding).map(path => toClipperPath(path, scale))];
	const offsetPerPass = passCount ? Math.round((offset * scale) / passCount) : 0;
	for (let pass = 1; pass <= passCount; pass++) {
		const offsetter = new ClipperLib.ClipperOffset(miterLimit);
		offsetter.AddPaths(pathsByPass[pass - 1], ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
		const offsetPaths = new ClipperLib.Paths();
		offsetter.Execute(offsetPaths, offsetPerPass);
		if (!offsetPaths.length) break;
		pathsByPass.push(offsetPaths);
	}
	const passDepth = pass => (pass === 0 ? (offset === 0 ? 1 : depthOuter) : depthOuter + (depthInner - depthOuter) * (pass / passCount));
	const vertexKey = point => `${point.X},${point.Y}`;
	const depthByVertex = pathsByPass.map((paths, pass) => {
		const depths = new Map();
		for (const path of paths) for (const point of path) depths.set(vertexKey(point), passDepth(pass));
		return depths;
	});
	const vertices = [];
	const depths = [];
	const indices = [];
	const addFace = (pass, ring, holeRings) => {
		const earcutData = [];
		const holeStarts = [];
		const addRing = path => {
			for (const point of path) {
				const key = vertexKey(point);
				earcutData.push(point.X, point.Y, depthByVertex[pass].get(key) ?? depthByVertex[pass + 1]?.get(key) ?? passDepth(pass));
			}
		};
		addRing(ring);
		for (const holeRing of holeRings) {
			holeStarts.push(earcutData.length / 3);
			addRing(holeRing);
		}
		const firstVertex = depths.length;
		for (let index = 0; index < earcutData.length; index += 3) {
			const px = earcutData[index] / scale;
			const py = earcutData[index + 1] / scale;
			vertices.push(normalize ? (px - centerX) / radius : px, normalize ? (py - centerY) / radius : py);
			depths.push(earcutData[index + 2]);
		}
		for (const vertex of PIXI.utils.earcut(earcutData, holeStarts.length ? holeStarts : null, 3)) indices.push(firstVertex + vertex);
	};
	for (let pass = 0; pass < pathsByPass.length; pass++) {
		const innerPaths = pathsByPass[pass + 1];
		const clipper = new ClipperLib.Clipper();
		// holes touching their outline become notches: earcut cannot triangulate touching holes
		clipper.StrictlySimple = true;
		clipper.AddPaths(pathsByPass[pass], ClipperLib.PolyType.ptSubject, true);
		if (innerPaths) clipper.AddPaths(innerPaths, ClipperLib.PolyType.ptClip, true);
		const tree = new ClipperLib.PolyTree();
		const fill = ClipperLib.PolyFillType.pftEvenOdd;
		clipper.Execute(innerPaths ? ClipperLib.ClipType.ctDifference : ClipperLib.ClipType.ctUnion, tree, fill, fill);
		const collect = (nodes, depth) => {
			for (const node of nodes) {
				if (depth % 2 === 0)
					addFace(
						pass,
						node.Contour(),
						node.Childs().map(child => child.Contour())
					);
				collect(node.Childs(), depth + 1);
			}
		};
		collect(tree.Childs(), 0);
	}
	// core's index buffer is 16-bit
	if (!indices.length || depths.length > 65535) return null;
	if (geometry) {
		geometry.getBuffer('aVertexPosition').update(new Float32Array(vertices));
		geometry.getIndex().update(new Uint16Array(indices));
		geometry.getBuffer('aDepthValue').update(new Float32Array(depths));
		return geometry;
	}
	return new PIXI.Geometry().addAttribute('aVertexPosition', vertices, 2).addAttribute('aTextureCoord', [0, 0, 1, 0, 1, 1, 0, 1], 2).addAttribute('aDepthValue', depths, 1).addIndex(indices);
}

export function initialize() {
	patchMasks();
	patchMeshes();
}
