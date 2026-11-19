// API.md documents the options and results.
//
// Exact ties: anything exactly at the ray's elevation is settled by `elevationBias`, the ray lying a hair above it
// ('above') or below it ('below') all along, so A -> B and B -> A agree. An inclusive region top reaches a hair above
// that. A point exactly on an outline is moved a hair along the ray, then a smaller hair to its positive side.
// Crossings exactly at the start of the tested range are left out; those exactly at its end are kept.

import {levelConnectedIdentifiers} from '../helpers/scene.js';
import {bitOfType} from '../helpers/types.js';
import {getSceneIndex} from '../spatial/index.js';
import {rayCacheKey, runQuery, runSourceQuery} from './query.js';
import {installSourceHooks, SOURCE_TYPES_MASK} from './sources.js';

Hooks.once('init', installSourceHooks);

// Results that change only with the scene index are cached with it; they are frozen and may be shared, so callers get a copy
// of the list.
function cachedWithSceneIndex(scene, cacheKey, computeResults) {
	const rayCache = getSceneIndex(scene).rayCache;
	let results = rayCache.get(cacheKey);
	if (results === undefined) rayCache.set(cacheKey, (results = computeResults()));
	return results.slice();
}

const freezeBarrierHit = hit =>
	Object.freeze({
		t: hit.t,
		point: Object.freeze(hit.point),
		normal: Object.freeze(hit.normal),
		blocked: hit.blocking,
		document: hit.document,
		barrier: Object.freeze(hit.barrier)
	});

// Every hit is static, so whole results are cached with the scene index.
export function raycastBarriers(scene, origin, destination, options = {}) {
	const {walls = true, regions = true} = options.hits ?? {};
	const queryOptions = {...options, containing: false, hits: {walls, regions}, allBarriers: true};
	return cachedWithSceneIndex(scene, `barrier|${rayCacheKey(origin, destination, queryOptions)}`, () =>
		runQuery(scene, origin, destination, queryOptions)
			// region crossings with nothing restricting this type are not barriers
			.filter(hit => hit.barrier)
			.map(freezeBarrierHit)
	);
}

const ONLY_REGIONS = {regions: true};
const ONLY_TOKENS = {tokens: true};

// An end of the tested range inside the volume has no surface there, so no normal.
const spanEnd = hit => ({t: hit.t, point: hit.point, normal: hit.inside ? null : hit.normal});

// A document's volumes may overlap or touch (a region on several levels), so its stretches are joined while any of them
// holds the ray. A crossing with no inside (a flat region) is a span whose ends meet.
function spansOf(hits, type) {
	const openSpansByDocument = new Map();
	const spans = [];
	for (const hit of hits) {
		if (hit.type !== type) continue;
		const {document} = hit;
		if (hit.entering === undefined) {
			const end = spanEnd(hit);
			spans.push({document, enter: end, exit: end, startsInside: false, endsInside: false});
			continue;
		}
		let state = openSpansByDocument.get(document);
		if (hit.entering) {
			if (state) state.nestingDepth++;
			else {
				state = {nestingDepth: 1, span: {document, enter: spanEnd(hit), exit: null, startsInside: hit.inside === 'origin', endsInside: false}};
				openSpansByDocument.set(document, state);
				spans.push(state.span);
			}
			continue;
		}
		if (!state) continue;
		if (--state.nestingDepth) continue;
		state.span.exit = spanEnd(hit);
		state.span.endsInside = hit.inside === 'destination';
		openSpansByDocument.delete(document);
	}
	// every volume holding the range end has an exit there (Query#addVolumesContaining); this only guards against rounding
	return spans.filter(span => span.exit);
}

const freezeSpan = span => {
	for (const end of [span.enter, span.exit]) {
		Object.freeze(end.point);
		if (end.normal) Object.freeze(end.normal);
		Object.freeze(end);
	}
	return Object.freeze(span);
};

// Regions change only with the scene index, so results are cached with it.
export function raycastRegions(scene, origin, destination, options = {}) {
	const {elevationBias = 'above', activeLevels, range} = options;
	const queryOptions = {elevationBias, activeLevels, range, useThreshold: false, containing: true, hits: ONLY_REGIONS};
	return cachedWithSceneIndex(scene, `regions|${rayCacheKey(origin, destination, queryOptions)}`, () => spansOf(runQuery(scene, origin, destination, queryOptions), 'region').map(freezeSpan));
}

// Tokens move all the time, so this is not cached.
export function raycastTokens(scene, origin, destination, options = {}) {
	const {elevationBias = 'above', activeLevels, range} = options;
	return spansOf(runQuery(scene, origin, destination, {elevationBias, activeLevels, range, useThreshold: false, containing: true, hits: ONLY_TOKENS}), 'token');
}

// Live sources on the viewed scene, sources built from documents on any other (see sources.js). Not cached.
export function raycastSources(scene, origin, destination, options = {}) {
	const {edgeRestrictionType = 'sight', priority = -Infinity, elevationBias = 'above', range} = options;
	return runSourceQuery(scene, origin, destination, {edgeRestrictionType, priority, elevationBias, range});
}

// Not part of the API. Takes raycastBarriers' options, plus:
// - `level`: the level the ray is on, standing for activeLevels (it and the levels it sees) when that is not given;
// - `sources`: false leaves sources out (they only stop sight, light and darkness);
// - `priority`: sources below it are left out.
// A source's boundary stops the ray one way, as core's source edges do: going in with edgeDirectionMode NORMAL, going out with
// REVERSED, either way with BOTH; not where the tested range starts or ends inside it.
export function blocks(scene, origin, destination, options = {}) {
	const {sources = true, priority = -Infinity, edgeRestrictionType = 'move', edgeDirectionMode = CONST.EDGE_DIRECTION_MODES.NORMAL, elevationBias, range, stop = false, level} = options;
	const activeLevels = options.activeLevels ?? levelConnectedIdentifiers(level, true);
	const stops = raycastBarriers(scene, origin, destination, {...options, activeLevels, stop})
		.filter(hit => hit.blocked)
		.map(({t, point}) => ({t, point}));
	if (!sources || !(bitOfType(edgeRestrictionType) & SOURCE_TYPES_MASK)) return stops;
	// with `stop`, only what is nearer than the barrier that stops the ray matters
	const sourceRange = {min: range?.min ?? 0, max: stop && stops.length ? stops[0].t : (range?.max ?? 1)};
	const directionModes = CONST.EDGE_DIRECTION_MODES;
	for (const span of raycastSources(scene, origin, destination, {edgeRestrictionType, priority, elevationBias, range: sourceRange})) {
		if (edgeDirectionMode !== directionModes.REVERSED && !span.startsInside) stops.push({t: span.enter.t, point: span.enter.point});
		if (edgeDirectionMode !== directionModes.NORMAL && !span.endsInside) stops.push({t: span.exit.t, point: span.exit.point});
	}
	return stops.sort((first, second) => first.t - second.t);
}

export const firstBlock = (scene, origin, destination, options = {}) => blocks(scene, origin, destination, {...options, stop: true})[0] ?? null;

export const isBlocked = (scene, origin, destination, options = {}) => firstBlock(scene, origin, destination, options) !== null;
