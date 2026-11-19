// Spheres cut to their polygon without walls; barriers cut them in 3D as each ray is cast (the crate's sources.rs).
//
// On the viewed scene they are core's live sources: each polygon is made by core's sweep without walls, so other sources'
// edges still cut it in plan as core does, and each volume is cached against the source's shape, which core replaces on
// every initialization. On any other scene there are no live sources, so they are built from the scene's ambient lights
// and token lights as core would build them (sourcesFromDocuments), and cached until a light, token, wall, level or the
// scene changes.
import {boundsOfEdges, polygonToEdges} from '../helpers/geometry.js';
import {gridUnitPixels} from '../helpers/grid.js';
import * as log from '../helpers/log.js';
import {sceneOf} from '../helpers/scene.js';
import {EMPTY_ARRAY, maskOfTypes, TYPES} from '../helpers/types.js';
import {callWasm, Encoder, writeInput} from '../helpers/wasm.js';

const DARKNESS_SOURCE_TYPES = maskOfTypes(['sight', 'light']);
const LIGHT_SOURCE_TYPES = maskOfTypes(['darkness']);
export const SOURCE_TYPES_MASK = DARKNESS_SOURCE_TYPES | LIGHT_SOURCE_TYPES;

function sourceVolumes(scene) {
	if (canvas?.ready && canvas.scene === scene) return liveVolumes(scene);
	let volumes = documentVolumesByScene.get(scene);
	if (volumes === undefined) {
		volumes = volumesFromDocuments(scene);
		documentVolumesByScene.set(scene, volumes);
	}
	return volumes;
}

// The scene store's copy (store.rs Scene::upload_sources), uploaded whenever the list of volumes changes: live volumes are made
// again with their source's shape, volumes from documents when a light, token, wall, level or the scene changes.
const uploadedVolumesByScene = new WeakMap();

export function uploadSourceVolumes(scene, index) {
	const volumes = sourceVolumes(scene);
	const uploaded = uploadedVolumesByScene.get(scene);
	const isUploaded = uploaded?.slot === index.slot && uploaded.volumes.length === volumes.length && uploaded.volumes.every((volume, position) => volume === volumes[position]);
	if (isUploaded) return volumes;
	const encoder = new Encoder();
	encoder.push(volumes.length);
	for (const volume of volumes) {
		encoder.push(volume.kind === 'darkness' ? 1 : 0, volume.types, TYPES.indexOf(volume.ownType), volume.priority, volume.sphere ? 1 : 0);
		encoder.push(volume.centerX, volume.centerY, volume.centerZ, volume.radiusXY, volume.radiusZ, volume.minX, volume.minY, volume.maxX, volume.maxY);
		encoder.list(volume.edges);
		encoder.push(volume.occluders.length);
		for (const occluder of volume.occluders) {
			encoder.push(occluder.minX, occluder.minY, occluder.maxX, occluder.maxY);
			encoder.list(occluder.edges);
		}
	}
	callWasm(exports => {
		writeInput(exports, encoder.values);
		exports.scene_upload_sources(index.slot);
	});
	uploadedVolumesByScene.set(scene, {slot: index.slot, volumes});
	return volumes;
}

// occluders are only needed for volumes built from documents, whose polygons core's sweep cannot cut by sources that do not
// exist. A light's priority is a hair lower, as it loses to darkness at the same priority
// (PointLightSource#_getEdgeCreationOptions).
function buildVolume({kind, source, document, priority, x, y, elevation, radius, polygon, occluders, scene}) {
	const edges = polygon?.points ? polygonToEdges(polygon.points) : null;
	if (!edges || !(radius > 0)) return null;
	// an unbounded radius means the polygon at every elevation, as in core
	const sphere = Number.isFinite(radius);
	const [minX, minY, maxX, maxY] = boundsOfEdges(edges);
	return {
		kind,
		source,
		document,
		types: kind === 'darkness' ? DARKNESS_SOURCE_TYPES : LIGHT_SOURCE_TYPES,
		ownType: kind,
		sourcePriority: priority,
		priority: kind === 'darkness' ? priority : priority - 0.5,
		sphere,
		centerX: x,
		centerY: y,
		centerZ: elevation,
		radiusXY: radius,
		radiusZ: sphere ? radius / gridUnitPixels(scene.grid) : Infinity,
		edges,
		occluders,
		minX,
		minY,
		maxX,
		maxY
	};
}

// Live sources

// Core replaces a source's shape on every initialization.
const volumeByShape = new WeakMap();

function liveVolumes(scene) {
	const volumes = [];
	const {darknessSources, lightSources} = canvas.effects;
	for (const source of darknessSources) {
		const volume = liveVolume(source, 'darkness', scene);
		if (volume) volumes.push(volume);
	}
	for (const source of lightSources) {
		const volume = liveVolume(source, 'light', scene);
		if (volume) volumes.push(volume);
	}
	return volumes;
}

function liveVolume(source, kind, scene) {
	if (!source.active || source.isPreview) return null;
	if (kind === 'light' && (!(source.priority > 0) || source instanceof foundry.canvas.sources.GlobalLightSource)) return null;
	const shape = source.shape;
	if (!shape?.points) return null;
	let volume = volumeByShape.get(shape);
	if (volume === undefined) {
		const {x, y, elevation = 0} = source.data;
		volume = buildVolume({
			kind,
			source,
			document: source.object?.document ?? null,
			priority: source.priority ?? 0,
			x,
			y,
			elevation,
			radius: source.radius,
			polygon: polygonWithoutWalls(source, shape),
			occluders: EMPTY_ARRAY,
			scene
		});
		volumeByShape.set(shape, volume);
	}
	return volume;
}

// For any light or darkness source, priority or not.
const planPolygonByShape = new WeakMap();
export function planPolygon(source) {
	const shape = source.shape;
	if (!shape) return null;
	let polygon = planPolygonByShape.get(shape);
	if (polygon === undefined) {
		polygon = polygonWithoutWalls(source, shape);
		planPolygonByShape.set(shape, polygon);
	}
	return polygon;
}

// Its own shape where that cannot be made.
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

// Sources from documents

let documentVolumesByScene = new WeakMap();

export function installSourceHooks() {
	const forgetDocumentVolumes = document => {
		const scene = sceneOf(document);
		if (scene) documentVolumesByScene.delete(scene);
	};
	for (const event of ['create', 'update', 'delete']) {
		for (const documentName of ['AmbientLight', 'Token', 'Wall', 'Level']) Hooks.on(`${event}${documentName}`, forgetDocumentVolumes);
	}
	// a token's burrowing status comes from its actor's effects, and an actor's tokens can be on any scene
	for (const event of ['createActiveEffect', 'updateActiveEffect', 'deleteActiveEffect']) {
		Hooks.on(event, () => {
			documentVolumesByScene = new WeakMap();
		});
	}
	Hooks.on('updateScene', forgetDocumentVolumes);
}

// As core infers it (Canvas#inferLevelFromElevation): its interior before its bottom before its top.
function levelAtElevation(scene, elevation, levelIds) {
	let bestLevel = null;
	let bestRank = Infinity;
	for (const id of levelIds?.size ? levelIds : scene.levels.keys()) {
		const level = scene.levels.get(id);
		if (!level) continue;
		const {bottom, top} = level.elevation;
		if (elevation < bottom || elevation > top) continue;
		const rank = bottom < elevation && elevation < top ? 0 : bottom === elevation ? 1 : 2;
		if (rank < bestRank) {
			bestLevel = level;
			bestRank = rank;
		}
	}
	return bestLevel ?? scene.initialLevel ?? scene.firstLevel ?? null;
}

const isLightDataEmitting = (config, radius, darknessLevel) => radius > 0 && config.angle > 0 && darknessLevel >= config.darkness.min && darknessLevel <= config.darkness.max;

// As core would make them (AmbientLight#_getLightSourceData, Token#_getLightSourceData). Other than core: the darkness level is the scene's
// own (not as regions adjust it); a source is suppressed (PointDarknessSource / PointLightSource suppression) by the other
// sources' shapes with walls, before suppression; and each is cut by the others' shapes with walls, not as those are cut
// by further sources.
function volumesFromDocuments(scene) {
	const darknessLevel = scene.environment?.darknessLevel ?? 0;
	const distancePixels = scene.dimensions.distancePixels;
	const candidates = [];
	const addCandidate = (document, config, data) => {
		const kind = config.negative ? 'darkness' : 'light';
		if (kind === 'light' && !(config.priority > 0)) return;
		if (!isLightDataEmitting(config, data.radius, darknessLevel)) return;
		const backend = CONFIG.Canvas.polygonBackends[kind];
		const origin = {x: data.x, y: data.y, elevation: data.elevation};
		const polygonConfig = {
			type: kind,
			level: data.level,
			radius: data.radius,
			externalRadius: data.externalRadius,
			angle: config.angle,
			rotation: data.rotation,
			priority: config.priority,
			useThreshold: true
		};
		try {
			candidates.push({
				kind,
				document,
				priority: config.priority,
				...origin,
				radius: data.radius,
				// the shape core would give it (without other sources), and the volume's polygon, without walls
				shape: backend.create(origin, {...polygonConfig, edgeTypes: {wall: data.walls}}),
				polygon: backend.create(origin, {...polygonConfig, edgeTypes: {wall: false}})
			});
		} catch (error) {
			log.warn('could not build a light source', document.uuid, error);
		}
	};

	for (const light of scene.lights) {
		const {config, hidden, x, y, elevation, rotation, walls, levels} = light;
		if (hidden) continue;
		const radius = Math.max(Math.abs(config.dim), Math.abs(config.bright)) * distancePixels;
		addCandidate(light, config, {x, y, elevation, rotation, walls, radius, externalRadius: 0, level: levelAtElevation(scene, elevation, levels)});
	}
	for (const token of scene.tokens) {
		const {hidden, light} = token;
		if (hidden || !(light.dim || light.bright)) continue;
		if (token.hasStatusEffect(CONFIG.specialStatusEffects.BURROW)) continue;
		const {width, height} = token.getSize();
		const externalRadius = Math.min(width, height) / 2;
		// Token#getLightRadius
		const lightRadius = units => (units ? Math.abs(units) * distancePixels + externalRadius : 0);
		const radius = Math.max(lightRadius(light.dim), lightRadius(light.bright));
		const {x, y, elevation} = token.getLightOrigin();
		const level = scene.levels.get(token.level) ?? levelAtElevation(scene, elevation);
		addCandidate(token, light, {x, y, elevation, rotation: token.rotation, walls: true, radius, externalRadius, level});
	}

	// suppressed: darkness inside a light of higher priority, a light inside darkness of at least its priority
	const isInsideShapeOf = (candidate, other) => other.shape?.points?.length >= 6 && other.shape.contains(candidate.x, candidate.y);
	const suppressesOrCuts = (other, candidate) =>
		candidate.kind === 'darkness' ? other.kind === 'light' && other.priority > candidate.priority : other.kind === 'darkness' && other.priority >= candidate.priority;
	const active = candidates.filter(candidate => !candidates.some(other => other !== candidate && suppressesOrCuts(other, candidate) && isInsideShapeOf(candidate, other)));

	// each is cut by the edges of the others restricting it, as core's sweep is by their edges (ClockwiseSweepPolygon
	// #_determineEdgeTypes: source edges at or above the polygon's priority; a light's edges are a hair lower)
	const occluderByCandidate = new Map();
	const occluderOf = candidate => {
		if (!occluderByCandidate.has(candidate)) {
			const edges = candidate.shape?.points ? polygonToEdges(candidate.shape.points) : null;
			const [minX, minY, maxX, maxY] = edges ? boundsOfEdges(edges) : [];
			occluderByCandidate.set(candidate, edges && {edges, minX, minY, maxX, maxY});
		}
		return occluderByCandidate.get(candidate);
	};
	const volumes = [];
	for (const candidate of active) {
		const occluders = active
			.filter(other => other !== candidate && suppressesOrCuts(other, candidate))
			.map(occluderOf)
			.filter(Boolean);
		const volume = buildVolume({
			kind: candidate.kind,
			source: null,
			document: candidate.document,
			priority: candidate.priority,
			x: candidate.x,
			y: candidate.y,
			elevation: candidate.elevation,
			radius: candidate.radius,
			polygon: candidate.polygon,
			occluders: occluders.length ? occluders : EMPTY_ARRAY,
			scene
		});
		if (volume) volumes.push(volume);
	}
	return volumes;
}
