// The barrier visualizer: light, darkness, vision and sound shapes drawn from this module's barriers in 3D (see floors.js), in
// place of core's flat wall sweep, while the Elevation Visualization setting is on.
//
// Core makes a source's shape with PointSourcePolygon.create: a clockwise sweep from the source (walls, other sources' edges,
// the scene's bounds, the radius and the angle), then threshold attenuation, then the elevated surface exposure. Here the sweep
// is made without walls, and its result is cut down to the lit floors, which already apply every wall and region barrier with
// its thresholds and attenuation (core's attenuation is skipped for it). What is left can have holes (shadows inside the lit
// area) and islands (lit areas beyond a shadow): they are kept on the polygon (shape.js), copied when core constrains it to a
// smaller radius, tested by contains, and drawn by masks and meshes (render.js).
import * as patch from '../helpers/patch.js';
import * as setting from '../helpers/setting.js';
import {BARRIER_TYPE} from '../raycast/scene-index.js';
import {litFloorPaths} from './floors.js';
import * as render from './render.js';
import {boundingBox, clipTree, inPiece, piecesFromTree, setPieces, shapePaths, signedArea, withWinding} from './shape.js';

// the restriction types whose source shapes are drawn from barriers
const SOURCE_TYPES = new Set(['light', 'darkness', 'sight', 'sound']);

// the key a polygon's config carries when it is cut by barriers
const BARRIERS = 'f2eGridEnhancementsBarriers';

// A polygon config's walls are off (core's edgeTypes: false, or mode 0), in which case no barrier cuts it either.
const wallsOff = config => config.edgeTypes?.wall === false || config.edgeTypes?.wall?.mode === 0;

// Cuts a computed polygon down to the floors its source reaches, keeping the pieces. Leaves it as it was, flagged, if that fails.
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
				useThreshold: config.useThreshold ?? false
			},
			box
		);
		const tree = clipTree([withWinding(polygon.points, 1)], lit, ClipperLib.ClipType.ctIntersection);
		if (!tree) throw new Error('Clipper could not cut the polygon');
		setPieces(polygon, piecesFromTree(tree, origin));
	} catch (error) {
		polygon.f2eGridEnhancementsFailed = true;
		console.error(`${game.i18n.localize('f2e-grid-enhancements.name')} | could not draw a source from barriers; using core's sweep`, error);
	}
}

// Includes a polygon's islands in its bounds (core works them out from its main outline alone).
function boundsWithIslands(polygon) {
	const bounds = polygon.getBounds();
	for (const island of polygon.islands ?? []) bounds.enlarge(island.getBounds());
	return bounds;
}

function patchPolygons() {
	// A source's shape (config.source, of a drawn type) is swept without walls and cut by barriers instead; core's sweep is used
	// when the setting is off, when walls are off for the shape, or when the cut fails.
	patch.add('foundry.canvas.geometry.PointSourcePolygon.create', (wrapped, polygonClass, origin, config = {}) => {
		const type = config.type ?? config.source?.constructor?.sourceType;
		if (!setting.get('general.elevation-visualization') || !config.source || !SOURCE_TYPES.has(type) || wallsOff(config)) return wrapped(origin, config);
		const polygon = wrapped(origin, {...config, type, edgeTypes: {...config.edgeTypes, wall: false}, [BARRIERS]: true});
		return polygon.f2eGridEnhancementsFailed ? wrapped(origin, config) : polygon;
	});

	// cut after core's own _compute, which also applies the radius, the angle and the boundary shapes
	patch.add('foundry.canvas.geometry.ClockwiseSweepPolygon.prototype._compute', (wrapped, polygon, ...args) => {
		const result = wrapped(...args);
		if (polygon.config?.[BARRIERS]) cutToLitFloors(polygon);
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
		if (polygon.config?.[BARRIERS]) return polygon;
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
		const inside = shape => shape.contains(x, y);
		if (wrapped(x, y) && !polygon.holes?.some(inside)) return true;
		return polygon.islands?.some(island => inPiece(island, inside)) ?? false;
	});
}

// A darkness source's (or priority light's) shape is also edges that cut other sources (core's _createEdges, from the main
// outline): the outlines of its holes and islands are edges too. They are one way (core's LEFT), so islands wind as the main
// outline does and holes the other way, keeping the source's side the same.
function patchSourceEdges() {
	for (const path of ['PointLightSource', 'PointDarknessSource']) {
		patch.add(`foundry.canvas.sources.${path}.prototype._createEdges`, (wrapped, source, ...args) => {
			const result = wrapped(...args);
			const {shape} = source;
			if (!source.requiresEdges || !source.active || source.isPreview || (!shape?.holes && !shape?.islands)) return result;
			const winding = Math.sign(signedArea(shape.points)) || 1;
			const rings = [
				...(shape.holes ?? []).map(hole => withWinding(hole.points, -winding)),
				...(shape.islands ?? []).flatMap(island => [withWinding(island.points, winding), ...(island.holes ?? []).map(hole => withWinding(hole.points, -winding))])
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
const REGION_FIELDS_DRAWN = new Set(['shapes', 'elevation', 'levels', 'hidden']);
const isBarrierBehavior = behavior => behavior.type === BARRIER_TYPE || behavior.system instanceof foundry.data.regionBehaviors.DefineSurfaceRegionBehaviorType;
const hasBarriers = region => region.behaviors.some(isBarrierBehavior);

function registerRefreshHooks() {
	const refresh = () => {
		if (!canvas?.ready || !setting.get('general.elevation-visualization')) return;
		canvas.perception.update({initializeVision: true, initializeLighting: true, initializeSounds: true});
	};
	Hooks.on('updateWall', (wall, changes) => {
		if (foundry.utils.hasProperty(changes, 'flags.f2e-grid-enhancements')) refresh();
	});
	for (const event of ['create', 'update', 'delete']) {
		Hooks.on(`${event}Level`, refresh);
		Hooks.on(`${event}RegionBehavior`, behavior => {
			if (isBarrierBehavior(behavior)) refresh();
		});
		Hooks.on(`${event}Region`, (region, changes) => {
			if (!hasBarriers(region)) return;
			if (event !== 'update' || Object.keys(changes).some(key => REGION_FIELDS_DRAWN.has(key))) refresh();
		});
	}
}

Hooks.once('init', () => {
	patchPolygons();
	patchSourceEdges();
	render.initialize();
	registerRefreshHooks();
});
