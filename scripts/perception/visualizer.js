import {clipTree, fromClipperPath, signedArea, toClipperPath, withWinding} from '../helpers/clipper.js';
import {distanceToSegment} from '../helpers/geometry.js';
import * as log from '../helpers/log.js';
import * as patch from '../helpers/patch.js';
import * as setting from '../helpers/setting.js';
import {isWasmReady, wasmReady} from '../helpers/wasm.js';
import {isDefineBarrier, onBarrierRegionChange} from '../spatial/barriers.js';
import {floorsWasm, litFloorPaths, startFloorsWorkers} from './floors.js';

// A shape is a PIXI.Polygon (its main outline) with `holes` (PIXI.Polygon[]) and `islands` (further outlines, each with its own
// `holes`).

function boundingBox(flatPath, margin = 0) {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (let index = 0; index < flatPath.length; index += 2) {
		minX = Math.min(minX, flatPath[index]);
		maxX = Math.max(maxX, flatPath[index]);
		minY = Math.min(minY, flatPath[index + 1]);
		maxY = Math.max(maxY, flatPath[index + 1]);
	}
	return {minX: minX - margin, minY: minY - margin, maxX: maxX + margin, maxY: maxY + margin};
}

// Even nesting depths are outlines; an outline inside a hole is a piece of its own.
function* outlinesWithTheirHoles(nodes, nestingDepth = 0) {
	for (const node of nodes) {
		if (nestingDepth % 2 === 0) yield {contour: node.Contour(), holes: node.Childs().map(child => child.Contour())};
		yield* outlinesWithTheirHoles(node.Childs(), nestingDepth + 1);
	}
}

function distanceToOutline(flatPath, x, y) {
	let nearest = Infinity;
	for (let index = 0; index < flatPath.length; index += 2) {
		const next = (index + 2) % flatPath.length;
		nearest = Math.min(nearest, distanceToSegment(x, y, flatPath[index], flatPath[index + 1], flatPath[next], flatPath[next + 1]));
	}
	return nearest;
}

// Smaller or thinner pieces and holes are rounding slivers.
const MIN_PIECE_AREA_SQUARE_PIXELS = 4;
const MIN_PIECE_WIDTH_PIXELS = 0.5;
const MIN_ORIGIN_DISTANCE_FROM_OUTLINE = 0.05;

function perimeter(flatPath) {
	let length = 0;
	for (let index = 0; index < flatPath.length; index += 2) {
		const next = (index + 2) % flatPath.length;
		length += Math.hypot(flatPath[next] - flatPath[index], flatPath[next + 1] - flatPath[index + 1]);
	}
	return length || 1;
}

const inPiece = (piece, isInShape) => isInShape(piece) && !piece.holes?.some(isInShape);

// The main piece comes first: the one around the origin (the source), else, when the origin is on an outline or in no piece
// (a shadow covers it), the largest.
function piecesFromTree(tree, origin) {
	// a long hairline has area, but its width (twice its area over its perimeter) is nothing
	const isSliver = polygon => {
		const area = Math.abs(signedArea(polygon.points));
		return area < MIN_PIECE_AREA_SQUARE_PIXELS || (2 * area) / perimeter(polygon.points) < MIN_PIECE_WIDTH_PIXELS;
	};
	const pieces = [];
	for (const {contour, holes} of outlinesWithTheirHoles(tree.Childs())) {
		const piece = new PIXI.Polygon(fromClipperPath(contour));
		piece.holes = holes.map(hole => new PIXI.Polygon(fromClipperPath(hole))).filter(hole => !isSliver(hole));
		if (!isSliver(piece)) pieces.push(piece);
	}
	if (!pieces.length) return pieces;
	const holdsOrigin = piece => distanceToOutline(piece.points, origin.x, origin.y) > MIN_ORIGIN_DISTANCE_FROM_OUTLINE && inPiece(piece, polygon => polygon.contains(origin.x, origin.y));
	let mainIndex = pieces.findIndex(holdsOrigin);
	if (mainIndex < 0) {
		const areas = pieces.map(piece => Math.abs(signedArea(piece.points)));
		mainIndex = areas.indexOf(Math.max(...areas));
	}
	const [main] = pieces.splice(mainIndex, 1);
	return [main, ...pieces];
}

// Holes get the opposite winding.
const shapePaths = (shape, outlineWinding = 1) =>
	[shape, ...(shape.islands ?? [])].flatMap(piece => [withWinding(piece.points, outlineWinding), ...(piece.holes ?? []).map(hole => withWinding(hole.points, -outlineWinding))]);

// No pieces empties the polygon.
function setPieces(polygon, pieces) {
	const [main, ...islands] = pieces;
	polygon.points = main ? main.points : [];
	polygon.holes = main?.holes.length ? main.holes : null;
	polygon.islands = islands.length ? islands : null;
}

// Core only ever gives PolygonMesher#triangulate one contour.

function drawMasksWithHolesAndIslands() {
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

// The mesher only receives the contour, so the shape is handed over for the duration of the source's _updateGeometry.
function meshSourcesWithHolesAndIslands() {
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

// As PolygonMesher does, the outline is offset
// inwards in passes of at most 3px, the depth running from depthOuter on the outline to depthInner inside (the soft edge); every
// pass offsets the whole shape, so holes get a soft edge too, and each face (a band between two passes, or the inside) is
// triangulated with its holes. Null when it cannot be built (core's then meshes the plain outline).
const MAX_PIXELS_PER_PASS = 3;
const MAX_16_BIT_INDEX = 65535;
function triangulateWithHoles(mesher, geometry, shape) {
	const {x: centerX, y: centerY, radius, normalize, offset, depthOuter, depthInner, scale, miterLimit} = mesher.options;
	const passCount = Math.ceil(Math.abs(offset) / MAX_PIXELS_PER_PASS);
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
			const pixelX = earcutData[index] / scale;
			const pixelY = earcutData[index + 1] / scale;
			vertices.push(normalize ? (pixelX - centerX) / radius : pixelX, normalize ? (pixelY - centerY) / radius : pixelY);
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
		const addFacesOf = (nodes, nestingDepth) => {
			for (const node of nodes) {
				if (nestingDepth % 2 === 0)
					addFace(
						pass,
						node.Contour(),
						node.Childs().map(child => child.Contour())
					);
				addFacesOf(node.Childs(), nestingDepth + 1);
			}
		};
		addFacesOf(tree.Childs(), 0);
	}
	// core's index buffer is 16-bit
	if (!indices.length || depths.length > MAX_16_BIT_INDEX) return null;
	if (geometry) {
		geometry.getBuffer('aVertexPosition').update(new Float32Array(vertices));
		geometry.getIndex().update(new Uint16Array(indices));
		geometry.getBuffer('aDepthValue').update(new Float32Array(depths));
		return geometry;
	}
	return new PIXI.Geometry().addAttribute('aVertexPosition', vertices, 2).addAttribute('aTextureCoord', [0, 0, 1, 0, 1, 1, 0, 1], 2).addAttribute('aDepthValue', depths, 1).addIndex(indices);
}

// Core makes a source's shape with PointSourcePolygon.create: a clockwise sweep from the source (walls, other sources' edges,
// the scene's bounds, the radius and the angle), then threshold attenuation, then the elevated surface exposure. Here the sweep
// is made without walls, and its result is cut down to the lit floors, which already apply every wall and region barrier with
// its thresholds and attenuation (core's attenuation is skipped for it). What is left can have holes (shadows inside the lit
// area) and islands (lit areas beyond a shadow): they are kept on the polygon (setPieces), copied when core constrains it to a
// smaller radius, tested by contains, and drawn by masks and meshes (drawMasksWithHolesAndIslands, meshSourcesWithHolesAndIslands).

const TYPES_DRAWN_FROM_BARRIERS = new Set(['light', 'darkness', 'sight', 'sound']);

const CUT_BY_BARRIERS_CONFIG_KEY = 'f2eGridEnhancementsBarriers';

// No barrier cuts a polygon whose walls are off either.
const areWallsOff = config => config.edgeTypes?.wall === false || config.edgeTypes?.wall?.mode === 0;

// Leaves the polygon as it was, flagged, if this fails.
function cutToLitFloors(polygon) {
	polygon.holes = null;
	polygon.islands = null;
	if (polygon.points.length < 6) return;
	const {origin, config} = polygon;
	try {
		const box = boundingBox(polygon.points, 2);
		const lit = litFloorPaths(
			{
				scene: config.level?.parent ?? canvas.scene,
				origin,
				type: config.type,
				level: config.level,
				radius: config.radius,
				externalRadius: config.externalRadius ?? 0,
				useThreshold: config.useThreshold ?? false,
				sourceId: config.source?.sourceId
			},
			box
		);
		const tree = clipTree([withWinding(polygon.points, 1)], lit, ClipperLib.ClipType.ctIntersection);
		if (!tree) throw new Error('Clipper could not cut the polygon');
		setPieces(polygon, piecesFromTree(tree, origin));
	} catch (error) {
		polygon.f2eGridEnhancementsFailed = true;
		log.error("could not draw a source from barriers; using core's sweep", error);
	}
}

// Core works bounds out from the main outline alone.
function boundsWithIslands(polygon) {
	const bounds = polygon.getBounds();
	for (const island of polygon.islands ?? []) bounds.enlarge(island.getBounds());
	return bounds;
}

function drawSourcePolygonsFromBarriers() {
	// A source's shape (config.source, of a drawn type) is swept without walls and cut by barriers instead; core's sweep is used
	// when the setting is off, when walls are off for the shape, or when the cut fails.
	patch.add('foundry.canvas.geometry.PointSourcePolygon.create', (wrapped, polygonClass, origin, config = {}) => {
		const type = config.type ?? config.source?.constructor?.sourceType;
		if (!setting.get('general.barrier-visualization') || !isWasmReady() || !config.source || !TYPES_DRAWN_FROM_BARRIERS.has(type) || areWallsOff(config)) return wrapped(origin, config);
		const polygon = wrapped(origin, {...config, type, edgeTypes: {...config.edgeTypes, wall: false}, [CUT_BY_BARRIERS_CONFIG_KEY]: true});
		return polygon.f2eGridEnhancementsFailed ? wrapped(origin, config) : polygon;
	});

	// cut after core's own _compute, which also applies the radius, the angle and the boundary shapes
	patch.add('foundry.canvas.geometry.ClockwiseSweepPolygon.prototype._compute', (wrapped, polygon, ...args) => {
		const result = wrapped(...args);
		if (polygon.config?.[CUT_BY_BARRIERS_CONFIG_KEY]) cutToLitFloors(polygon);
		return result;
	});

	// core works the bounds out from the main outline; islands can lie beyond it
	patch.add('foundry.canvas.geometry.PointSourcePolygon.prototype.compute', (wrapped, polygon, ...args) => {
		const result = wrapped(...args);
		if (polygon.islands?.length) polygon.bounds = boundsWithIslands(polygon);
		return result;
	});

	// the barriers already apply thresholds and attenuation, in 3D
	patch.add('foundry.canvas.geometry.PointSourcePolygon.applyThresholdAttenuation', (wrapped, polygonClass, polygon) => {
		if (polygon.config?.[CUT_BY_BARRIERS_CONFIG_KEY]) return polygon;
		return wrapped(polygon);
	});

	// A constrained copy (a vision source's light and field of vision, a darkness source's padded shape) keeps the pieces: core
	// intersects the main outline alone.
	patch.add('foundry.canvas.geometry.PointSourcePolygon.prototype.applyConstraint', (wrapped, polygon, constraint, options = {}) => {
		const constrained = wrapped(constraint, options);
		if ((!polygon.holes && !polygon.islands) || !constrained.points.length) return constrained;
		const constraintPoints = constraint instanceof PIXI.Polygon ? constraint.points : constraint.toPolygon({density: options.density ?? polygon.config.density}).points;
		const tree = clipTree(shapePaths(polygon), [withWinding(constraintPoints, 1)], ClipperLib.ClipType.ctIntersection);
		if (!tree) return constrained;
		setPieces(constrained, piecesFromTree(tree, polygon.origin));
		constrained.bounds = boundsWithIslands(constrained);
		return constrained;
	});

	// copies keep the pieces (core copies the main outline)
	patch.add('foundry.canvas.geometry.PointSourcePolygon.prototype.clone', (wrapped, polygon, ...args) => {
		const copy = wrapped(...args);
		copy.holes = polygon.holes ?? null;
		copy.islands = polygon.islands ?? null;
		return copy;
	});

	// a point in a hole is not inside, and one in an island is
	patch.add('foundry.canvas.geometry.PointSourcePolygon.prototype.contains', (wrapped, polygon, x, y) => {
		if (!polygon.holes && !polygon.islands) return wrapped(x, y);
		const containsPoint = shape => shape.contains(x, y);
		if (wrapped(x, y) && !polygon.holes?.some(containsPoint)) return true;
		return polygon.islands?.some(island => inPiece(island, containsPoint)) ?? false;
	});
}

// A darkness source's (or priority light's) shape is also edges that cut other sources (core's _createEdges, from the main
// outline): the outlines of its holes and islands are edges too. They are one way (core's LEFT), so islands wind as the main
// outline does and holes the other way, keeping the source's side the same.
function addEdgesForHolesAndIslands() {
	for (const path of ['PointLightSource', 'PointDarknessSource']) {
		patch.add(`foundry.canvas.sources.${path}.prototype._createEdges`, (wrapped, source, ...args) => {
			const result = wrapped(...args);
			const {shape} = source;
			if (!source.requiresEdges || !source.active || source.isPreview || (!shape?.holes && !shape?.islands)) return result;
			const outlineWinding = Math.sign(signedArea(shape.points)) || 1;
			const rings = [
				...(shape.holes ?? []).map(hole => withWinding(hole.points, -outlineWinding)),
				...(shape.islands ?? []).flatMap(island => [withWinding(island.points, outlineWinding), ...(island.holes ?? []).map(hole => withWinding(hole.points, -outlineWinding))])
			];
			const options = source._getEdgeCreationOptions();
			const {Edge} = foundry.canvas.geometry.edges;
			rings.forEach((ring, ringIndex) => {
				for (let index = 0; index < ring.length; index += 2) {
					const next = (index + 2) % ring.length;
					const id = `${source.constructor.sourceType}.${source.sourceId}.f2e${ringIndex}.${index / 2}`;
					const edge = new Edge({x: ring[index], y: ring[index + 1]}, {x: ring[next], y: ring[next + 1]}, {...options, id});
					source.edges.push(edge);
					canvas.edges.set(edge.id, edge);
				}
			});
			return result;
		});
	}
}

// Sources are drawn from walls, regions and levels, so their shapes are made again when those change in ways core does not
// already redraw for: a wall's height, a level, and regions with barriers (core's surfaces or Define Barriers) changing where
// they are or what they do. Other regions draw nothing.
const isDrawnBarrierBehavior = behavior => isDefineBarrier(behavior) || behavior.system instanceof foundry.data.regionBehaviors.DefineSurfaceRegionBehaviorType;

function reinitializeSourcesOnBarrierChanges() {
	const reinitializeSources = () => {
		if (!canvas?.ready || !setting.get('general.barrier-visualization')) return;
		canvas.perception.update({initializeVision: true, initializeLighting: true, initializeSounds: true});
	};
	Hooks.on('updateWall', (wall, changes) => {
		if (foundry.utils.hasProperty(changes, 'flags.f2e-grid-enhancements')) reinitializeSources();
	});
	for (const event of ['create', 'update', 'delete']) Hooks.on(`${event}Level`, reinitializeSources);
	onBarrierRegionChange(isDrawnBarrierBehavior, reinitializeSources);
}

Hooks.once('init', () => {
	// on the main thread alone if the workers cannot start
	wasmReady
		.then(loaded => loaded && startFloorsWorkers())
		.then(started => {
			floorsWasm.workers = !!started;
		});
	drawSourcePolygonsFromBarriers();
	addEdgesForHolesAndIslands();
	drawMasksWithHolesAndIslands();
	meshSourcesWithHolesAndIslands();
	reinitializeSourcesOnBarrierChanges();
});
