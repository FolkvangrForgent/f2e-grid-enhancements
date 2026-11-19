// Raycasts run in the WebAssembly module over its copy of the scene (wasm/src/raycast.rs and sources.rs); this writes a query
// into it and reads the results back. The layouts must match the crate's read_query, write_hits and write_spans.
import {bitOfType, TYPES} from '../helpers/types.js';
import {callWasm, readOutput, writeInput} from '../helpers/wasm.js';
import {getSceneIndex} from '../spatial/index.js';
import {SOURCE_TYPES_MASK, uploadSourceVolumes} from './sources.js';

const isValidElevation = elevation => typeof elevation === 'number' && !Number.isNaN(elevation);

const HIT_STRIDE = 18;
const HIT_TYPES = ['wall', 'region', 'token', 'attenuation'];
const INSIDE_ENDS = [undefined, 'origin', 'destination'];
const CROSSED_DIRECTIONS = ['both', 'towards', 'away'];

// The level indexes of activeLevels (ids), unknown ones left out; null for every level.
function activeLevelIndexes(index, activeLevels) {
	if (!activeLevels) return null;
	const levelIndexes = [];
	for (const levelId of activeLevels) {
		const levelIndex = index.levelIndexById.get(levelId);
		if (levelIndex !== undefined) levelIndexes.push(levelIndex);
	}
	return levelIndexes;
}

function encodeQuery(index, origin, destination, options, typeIndex) {
	const {
		edgeDirectionMode = CONST.EDGE_DIRECTION_MODES.NORMAL,
		elevationBias = 'above',
		useThreshold = true,
		externalRadius = 0,
		radius,
		range,
		stop = false,
		allBarriers = false,
		containing = false
	} = options;
	const {walls = false, regions = false, tokens = false} = options.hits ?? {};
	const levelIndexes = activeLevelIndexes(index, options.activeLevels);
	const encoded = [index.slot, origin.x, origin.y, origin.elevation, destination.x, destination.y, destination.elevation, typeIndex, edgeDirectionMode, elevationBias === 'above' ? 1 : 0];
	encoded.push(useThreshold ? 1 : 0, externalRadius, radius >= 0 ? radius : NaN, range?.min ?? 0, range?.max ?? 1, stop ? 1 : 0, allBarriers ? 1 : 0, containing ? 1 : 0);
	encoded.push(walls ? 1 : 0, regions ? 1 : 0, tokens ? 1 : 0, CONFIG.Wall.thresholdAttenuationMultiplier ?? 1);
	if (levelIndexes) encoded.push(levelIndexes.length, ...levelIndexes);
	else encoded.push(-1);
	return encoded;
}

function checkQuery(origin, destination, edgeRestrictionType) {
	const typeIndex = TYPES.indexOf(edgeRestrictionType);
	if (typeIndex < 0) throw new TypeError(`raycast: unknown edgeRestrictionType "${edgeRestrictionType}"`);
	if (!isValidElevation(origin.elevation)) throw new TypeError('raycast: origin.elevation must be a number');
	if (!isValidElevation(destination?.elevation)) throw new TypeError('raycast: destination.elevation must be a number');
	return typeIndex;
}

function decodeHit(output, offset, documents) {
	const hit = {
		type: HIT_TYPES[output[offset]],
		document: documents[output[offset + 1]] ?? null,
		t: output[offset + 2],
		point: {x: output[offset + 3], y: output[offset + 4], elevation: output[offset + 5]},
		normal: {x: output[offset + 6], y: output[offset + 7], z: output[offset + 8]},
		blocking: output[offset + 9] === 1,
		limited: output[offset + 10] === 1
	};
	if (output[offset + 11] >= 0) hit.entering = output[offset + 11] === 1;
	if (output[offset + 12]) hit.inside = INSIDE_ENDS[output[offset + 12]];
	if (output[offset + 13]) hit.attenuated = true;
	if (output[offset + 14]) hit.forgiven = true;
	if (output[offset + 15] >= 0) hit.surface = documents[output[offset + 15]];
	if (output[offset + 16] >= 0) hit.barrier = {sense: output[offset + 16], direction: CROSSED_DIRECTIONS[output[offset + 17]]};
	return hit;
}

// Hits nearest first, as plain objects; `barrier` is the barrier that decided a wall or region hit ({sense, direction}).
// options are the raycasts' (API.md), plus `containing` (a hit for each region and token holding an end of the tested range)
// and `allBarriers` (also barriers the ray passes without effect).
export function runQuery(scene, origin, destination, options = {}) {
	const typeIndex = checkQuery(origin, destination, options.edgeRestrictionType ?? 'move');
	const index = getSceneIndex(scene);
	const encoded = encodeQuery(index, origin, destination, options, typeIndex);
	return callWasm(exports => {
		writeInput(exports, encoded);
		const length = exports.raycast();
		const output = readOutput(exports, length);
		const hits = new Array(output[0]);
		for (let hit = 0; hit < hits.length; hit++) hits[hit] = decodeHit(output, 1 + hit * HIT_STRIDE, index.documents);
		return hits;
	});
}

const SPAN_STRIDE = 19;

function decodeSpanEnd(output, offset) {
	const normal = output[offset + 4] ? {x: output[offset + 5], y: output[offset + 6], z: output[offset + 7]} : null;
	return {t: output[offset], point: {x: output[offset + 1], y: output[offset + 2], elevation: output[offset + 3]}, normal};
}

// Spans through the light and darkness sources (sources.js), by where they start. A null normal is an end of the tested range
// inside the volume.
export function runSourceQuery(scene, origin, destination, {edgeRestrictionType = 'sight', priority = -Infinity, elevationBias = 'above', range} = {}) {
	const typeIndex = checkQuery(origin, destination, edgeRestrictionType);
	if (!(bitOfType(edgeRestrictionType) & SOURCE_TYPES_MASK)) return [];
	const index = getSceneIndex(scene);
	const volumes = uploadSourceVolumes(scene, index);
	const encoded = [index.slot, origin.x, origin.y, origin.elevation, destination.x, destination.y, destination.elevation, typeIndex, priority, elevationBias === 'above' ? 1 : 0];
	encoded.push(range?.min ?? 0, range?.max ?? 1, CONFIG.Wall.thresholdAttenuationMultiplier ?? 1);
	return callWasm(exports => {
		writeInput(exports, encoded);
		const output = readOutput(exports, exports.raycast_sources());
		const spans = new Array(output[0]);
		for (let span = 0; span < spans.length; span++) {
			const offset = 1 + span * SPAN_STRIDE;
			const volume = volumes[output[offset]];
			spans[span] = {
				document: volume.document,
				source: volume.source,
				kind: volume.kind,
				priority: volume.sourcePriority,
				enter: decodeSpanEnd(output, offset + 1),
				exit: decodeSpanEnd(output, offset + 9),
				startsInside: output[offset + 17] === 1,
				endsInside: output[offset + 18] === 1
			};
		}
		return spans;
	});
}

// Every option of the barrier and region raycasts.
export function rayCacheKey(origin, destination, options) {
	const {walls = false, regions = false} = options.hits ?? {};
	const activeLevels = options.activeLevels ? Array.from(options.activeLevels).join(',') : '*';
	return `${origin.x},${origin.y},${origin.elevation}>${destination.x},${destination.y},${destination.elevation}|${options.edgeRestrictionType}|${options.edgeDirectionMode}|${options.elevationBias}|${!!options.stop}|${options.useThreshold}|${options.externalRadius}|${options.radius}|${options.range?.min},${options.range?.max}|${walls}${regions}|${activeLevels}`;
}
