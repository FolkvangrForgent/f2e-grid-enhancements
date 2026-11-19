import {regionOutlines} from '../helpers/geometry.js';
import {gridUnitPixels} from '../helpers/grid.js';
import {EMPTY_ARRAY} from '../helpers/types.js';
import {ROOF_SHAPES, roofFaces} from './roofs.js';

export const BARRIER_BEHAVIOR_TYPE = 'f2e-grid-enhancements.barrier';
export const isDefineBarrier = behavior => behavior.type === BARRIER_BEHAVIOR_TYPE;

// As core places surfaces (Scene#updateSurfaces): a flat region's one face takes every placement. Unbounded ends are
// included (as null) for the caller to leave out.
export function placedElevations(region, onBottom, onTop) {
	const {bottom, top} = region.elevation;
	if (bottom === top) return onBottom || onTop ? [bottom] : [];
	const elevations = [];
	if (onBottom) elevations.push(bottom);
	if (onTop) elevations.push(top);
	return elevations;
}

// attachment counts because a region attached to a hidden token is inactive.
const REGION_FIELDS_MOVING_BARRIERS = new Set(['shapes', 'elevation', 'levels', 'hidden', 'attachment']);

// Core's token.attachments.regions misses regions created with their scene, so the scene's regions are searched.
export const regionsAttachedTo = token => token.parent?.regions.filter(region => region.attachment.token === token) ?? [];

export function onBarrierRegionChange(isBarrierBehavior, onRegionChanged) {
	for (const event of ['create', 'update', 'delete']) {
		Hooks.on(`${event}RegionBehavior`, behavior => {
			if (isBarrierBehavior(behavior)) onRegionChanged(behavior.parent);
		});
		Hooks.on(`${event}Region`, (region, changes) => {
			if (!region.behaviors.some(isBarrierBehavior)) return;
			if (event !== 'update' || Object.keys(changes).some(key => REGION_FIELDS_MOVING_BARRIERS.has(key))) onRegionChanged(region);
		});
	}
	// hiding or showing a token makes the regions attached to it inactive or active, without a region update
	Hooks.on('updateToken', (token, changes) => {
		if (!('hidden' in changes)) return;
		for (const region of regionsAttachedTo(token)) if (region.behaviors.some(isBarrierBehavior)) onRegionChanged(region);
	});
}

export const ROOF_FIELD_DEFAULTS = {shape: 'none', pitch: 0, direction: 0, ridge: 50, teeth: 1, lowerGable: 0, upperGable: 0};

// From the first enabled Define Barrier behavior that gives one.
// Inactive regions (hidden, or attached to a hidden token) have none, as core treats their surfaces.
export function regionRoof(region) {
	if (!region.active) return null;
	for (const behavior of region.behaviors) {
		if (behavior.disabled || !isDefineBarrier(behavior)) continue;
		const roof = behavior.system.roof;
		if (!ROOF_SHAPES.includes(roof?.shape) || !(roof.pitch > 0)) continue;
		const fields = Object.fromEntries(Object.entries(ROOF_FIELD_DEFAULTS).map(([name, defaultValue]) => [name, roof[name] ?? defaultValue]));
		return {...fields, show: roof.show ?? true};
	}
	return null;
}

// Cached per region shape and roof, since the index, the roof plan and the behavior's window all ask and the straight
// skeleton is costly.
const MAX_CACHED_ROOFS_PER_SHAPE = 16;
const roofFacesByPolygonTree = new WeakMap();
export function regionRoofFaces(region, roof = regionRoof(region)) {
	if (!roof || !ROOF_SHAPES.includes(roof.shape)) return null;
	const top = region.elevation.top ?? Infinity;
	const bottom = region.elevation.bottom ?? -Infinity;
	const pixelsPerUnit = gridUnitPixels(region.parent.grid);
	let facesByRoofKey = roofFacesByPolygonTree.get(region.polygonTree);
	if (!facesByRoofKey) roofFacesByPolygonTree.set(region.polygonTree, (facesByRoofKey = new Map()));
	const roofKey = [...Object.keys(ROOF_FIELD_DEFAULTS).map(name => roof[name]), top, bottom, pixelsPerUnit].join('|');
	let faces = facesByRoofKey.get(roofKey);
	if (faces === undefined) {
		faces = roofFaces(regionOutlines(region), roof, top, bottom, pixelsPerUnit);
		if (facesByRoofKey.size >= MAX_CACHED_ROOFS_PER_SHAPE) facesByRoofKey.delete(facesByRoofKey.keys().next().value);
		facesByRoofKey.set(roofKey, faces);
	}
	return faces;
}

// Darkness follows light, as for walls; thresholds are in pixels.
export function regionBarriers(region, pixelsPerUnit) {
	if (!region.active) return EMPTY_ARRAY;
	const barriers = [];
	for (const behavior of region.behaviors) {
		if (behavior.disabled || !isDefineBarrier(behavior)) continue;
		const {bottom, top, sides, light, move, sight, sound, direction, threshold} = behavior.system;
		const gridUnitsToPixels = distance => (distance ? distance * pixelsPerUnit : null);
		barriers.push({
			behavior,
			bottom,
			top,
			sides,
			senses: {light, darkness: light, move, sight, sound},
			thresholds: {light: gridUnitsToPixels(threshold.light), darkness: gridUnitsToPixels(threshold.light), sight: gridUnitsToPixels(threshold.sight), sound: gridUnitsToPixels(threshold.sound)},
			attenuation: threshold.attenuation,
			direction
		});
	}
	return barriers.length ? barriers : EMPTY_ARRAY;
}
