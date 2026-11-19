// Darkness sources (restricting sight and light) and priority light sources (restricting darkness) as spheres cut to
// their polygon without walls (other sources' edges still cut it in plan, as core does): barriers cut them in 3D as each
// ray is cast (query.js sourceShadows). Read live on each ray, with each volume cached against the source's shape, which
// core replaces on every initialization.
import {gridUnitPixels} from '../helpers/grid.js';
import {polygonToEdges} from './geometry.js';
import {maskOfTypes} from './types.js';

export const DARKNESS_SOURCE_TYPES = maskOfTypes(['sight', 'light']);
export const LIGHT_SOURCE_TYPES = maskOfTypes(['darkness']);
export const SOURCE_TYPES_MASK = DARKNESS_SOURCE_TYPES | LIGHT_SOURCE_TYPES;

const volumeByShape = new WeakMap();

// A source's volume, or null for an inactive source, a preview, a light without priority, or no area.
export function sourceVolume(source, kind, scene) {
	if (!source.active || source.isPreview) return null;
	if (kind === 'light' && (!(source.priority > 0) || source instanceof foundry.canvas.sources.GlobalLightSource)) return null;
	const shape = source.shape;
	if (!shape?.points) return null;
	let volume = volumeByShape.get(shape);
	if (volume === undefined) {
		volume = buildVolume(source, kind, shape, scene);
		volumeByShape.set(shape, volume);
	}
	return volume;
}

// The source's polygon as core makes it, but without walls; its own shape where that cannot be made.
function polygonWithoutWalls(source, shape) {
	try {
		const config = source._getPolygonConfiguration();
		config.edgeTypes = {...config.edgeTypes, wall: false};
		config.radius = source.radius;
		return source._getPolygonBackend().create(source.origin, config);
	} catch {
		return shape;
	}
}

function buildVolume(source, kind, shape, scene) {
	const polygon = polygonWithoutWalls(source, shape);
	const edges = polygonToEdges(polygon.points);
	const radius = source.radius;
	if (!edges || !(radius > 0)) return null;
	const {x, y, elevation = 0} = source.data;
	// an unbounded radius has no sphere: the polygon at every elevation, as in core
	const sphere = Number.isFinite(radius);
	const bounds = polygon.bounds ?? polygon.getBounds();
	return {
		kind,
		source,
		document: source.object?.document ?? null,
		types: kind === 'darkness' ? DARKNESS_SOURCE_TYPES : LIGHT_SOURCE_TYPES,
		// the type barriers must restrict to cut the source's own reach
		ownType: kind,
		// light loses to darkness at the same priority (see PointLightSource#_getEdgeCreationOptions)
		priority: kind === 'darkness' ? (source.priority ?? 0) : source.priority - 0.5,
		sphere,
		centerX: x,
		centerY: y,
		centerZ: elevation,
		radiusXY: radius,
		radiusZ: sphere ? radius / gridUnitPixels(scene.grid) : Infinity,
		edges,
		minX: bounds.x,
		minY: bounds.y,
		maxX: bounds.x + bounds.width,
		maxY: bounds.y + bounds.height
	};
}
