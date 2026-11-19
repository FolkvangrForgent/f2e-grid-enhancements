import {levelConnectedIdentifiers} from '../helpers/scene.js';
import {TYPES} from '../helpers/types.js';
import {callWasm, isWasmReady, readOutput, wasm, writeInput} from '../helpers/wasm.js';
import {getSceneIndex} from '../spatial/index.js';

// Plain exports over one input and one output buffer of f64s (see the crate's Reader for the layout), so no generated glue is needed.
//
// Each source's lighting is cut into tasks (a few floors and a strip of the base floor
// each) that a few Web Workers, each with its own copy of the module (floors-worker.js), take as they come free, and the results
// are united here: lighting then runs off the main thread, and litFloorPaths shows a source's last result until its new one arrives. (Waiting on workers synchronously needs
// cross-origin isolation, which Foundry's server does not set up.)

// Set while the workers are up.
export const floorsWasm = {
	workers: false
};

function readPaths(output, readOffset = 0) {
	const paths = [];
	const pathCount = output[readOffset++];
	for (let path = 0; path < pathCount; path++) {
		const pointCount = output[readOffset++];
		paths.push(Array.from(output.subarray(readOffset, readOffset + pointCount * 2)));
		readOffset += pointCount * 2;
	}
	return paths;
}

// A failure turns the module off for good (callWasm).
function runWasmCall(encodedInput, callExport) {
	return callWasm(exports => {
		writeInput(exports, encodedInput);
		return readPaths(readOutput(exports, callExport(exports)));
	});
}

const litFloorsWasm = encodedInput => runWasmCall(encodedInput, exports => exports.lit_floors());

let workers = [];
let nextJobId = 0;
const jobsById = new Map();

// Leaves the main thread a core of its own.
const MAX_WORKERS = 4;
const workerCount = () => Math.max(1, Math.min(MAX_WORKERS, (navigator.hardwareConcurrency || 2) - 1));

// Resolves to whether they all came up.
export async function startFloorsWorkers() {
	if (workers.length) return true;
	if (!wasm.module) return false;
	try {
		const started = Array.from({length: workerCount()}, () => {
			const worker = new Worker(new URL('./floors-worker.js', import.meta.url), {type: 'module'});
			return new Promise((resolve, reject) => {
				worker.onerror = event => reject(new Error(event.message || 'worker failed to start'));
				worker.onmessage = ({data}) => {
					if (data.error) return reject(new Error(data.error));
					workerStates.set(worker, {busy: false, jobId: null});
					worker.onmessage = message => onWorkerMessage(worker, message);
					worker.onerror = error => console.error('f2e-grid-enhancements | a floor lighting worker failed', error);
					resolve(worker);
				};
				worker.postMessage({module: wasm.module});
			});
		});
		workers = await Promise.all(started);
		return true;
	} catch (error) {
		console.warn('f2e-grid-enhancements | the floor lighting workers could not start; lighting stays on the main thread', error);
		stopFloorsWorkers();
		return false;
	}
}

function stopFloorsWorkers() {
	for (const worker of workers) worker.terminate();
	workers = [];
	for (const job of jobsById.values()) job.reject(new Error('the floor lighting workers stopped'));
	jobsById.clear();
	jobsWithTasksLeft.length = 0;
}

const areFloorsWorkersReady = () => isWasmReady() && floorsWasm.workers && workers.length > 0;

// Twice as many as workers, so one that finishes early takes another while a slow one runs, without so many
// that each pays more in overhead than it saves.
const tasksPerJob = () => workers.length * 2;

// A worker is sent a job's input with its first task of it, and keeps it for the rest.
const workerStates = new WeakMap();

// Oldest first.
const jobsWithTasksLeft = [];

function handOutTasks() {
	for (const worker of workers) {
		const state = workerStates.get(worker);
		if (state.busy) continue;
		while (jobsWithTasksLeft.length && jobsWithTasksLeft[0].nextTask >= jobsWithTasksLeft[0].tasks) jobsWithTasksLeft.shift();
		const job = jobsWithTasksLeft[0];
		if (!job) return;
		const part = job.nextTask++;
		state.busy = true;
		const message = {id: job.id, part, parts: job.tasks};
		if (state.jobId !== job.id) {
			message.input = job.encodedInput;
			state.jobId = job.id;
		}
		worker.postMessage(message);
	}
}

function onWorkerMessage(worker, {data: {id, part, output, error}}) {
	workerStates.get(worker).busy = false;
	const job = jobsById.get(id);
	if (job) {
		if (error) {
			jobsById.delete(id);
			const index = jobsWithTasksLeft.indexOf(job);
			if (index >= 0) jobsWithTasksLeft.splice(index, 1);
			job.reject(new Error(error));
		} else {
			job.outputs[part] = output;
			if (!--job.waiting) uniteTaskOutputs(job);
		}
	}
	handOutTasks();
}

// The task outputs' path lists are joined into one input for the crate's unite.
function uniteTaskOutputs(job) {
	jobsById.delete(job.id);
	let length = 1;
	for (const taskOutput of job.outputs) length += taskOutput.length - 1;
	const joined = new Float64Array(length);
	joined[0] = job.outputs.reduce((pathCount, taskOutput) => pathCount + taskOutput[0], 0);
	let writeOffset = 1;
	for (const taskOutput of job.outputs) {
		joined.set(taskOutput.subarray(1), writeOffset);
		writeOffset += taskOutput.length - 1;
	}
	try {
		job.resolve(runWasmCall(joined, exports => exports.unite()));
	} catch (failure) {
		job.reject(failure);
	}
}

function litFloorsInWorkers(encodedInput) {
	if (!workers.length) return Promise.reject(new Error('the floor lighting workers are not running'));
	return new Promise((resolve, reject) => {
		const id = nextJobId++;
		const tasks = tasksPerJob();
		const job = {id, encodedInput, tasks, nextTask: 0, waiting: tasks, outputs: new Array(tasks), resolve, reject};
		jobsById.set(id, job);
		jobsWithTasksLeft.push(job);
		handOutTasks();
	});
}

// Every top or bottom barrier (a region face with a core surface or a Define Barrier
// on it) is a floor, a roof's faces sloped (spatial/roofs.js), and at each point of the map the floor shown is the highest
// one there at or below the source, else the base floor: the lowest bottom of the source's level and the levels it sees (at or
// below the source), or the source's own height when none has one. A level is no floor of its own: upper floors are the regions
// that give one, so a source sees down through every level it sees to the lowest, as the raycast's rays do.
// A roof face counts whole while the source is above its plane (it sees the face's top side, even where that rises above it, as one sees a roof sloping toward one); a flat floor's plane is level, so for it
// that is the same as being at or below the source.
// A floor point is lit when a ray from the source to it gets through, by the raycast's barrier rules:
// every barrier between the source and the floor, walls with their heights, region sides and faces, casts its shadow on it,
// projected from the source. Floors themselves cast shadows on the floors below them. On a sloped floor every shadow is still
// the barrier projected from the source, only onto the floor's plane, so shadows stay polygons.
//
// The floors and the barriers seen from the source are gathered from the scene store (the crate's gather.rs) and lit there, or in
// the workers while they are up, each source keeping its last result until its new one is ready.

// Kept while the scene index's generation stays the same: core makes every light's shape again whenever lighting is
// refreshed, most of them unchanged.
const MAX_CACHED_LIT_AREAS = 256;
const litAreasCacheByScene = new WeakMap();

// With the workers up, a source with a sourceId is lit in them, and until its new result is ready it keeps the last one it
// had (the first time, it is lit here at once). Throws when the module has not loaded, so the visualizer uses core's sweep.
export function litFloorPaths(source, box) {
	const {scene, origin, type, level, radius = Infinity, externalRadius = 0, useThreshold = true} = source;
	const index = getSceneIndex(scene);
	let cache = litAreasCacheByScene.get(scene);
	if (cache?.generation !== index.generation) litAreasCacheByScene.set(scene, (cache = {generation: index.generation, paths: new Map()}));
	const cacheKey = [origin.x, origin.y, origin.elevation ?? 0, type, level?.id, radius, externalRadius, useThreshold, box.minX, box.minY, box.maxX, box.maxY].join('|');
	const sourceKey = source.sourceId ? `${scene.id}|${type}|${source.sourceId}` : null;
	// numbered, so a result only ever replaces an older one on screen
	const request = ++requestCount;
	let paths = cache.paths.get(cacheKey);
	if (!paths) {
		const encodedInput = encodeSource(index, source, box);
		const lastShown = sourceKey && areFloorsWorkersReady() && lastShownBySource.get(sourceKey);
		if (lastShown) {
			queueWorkerJob(sourceKey, {scene, cache, cacheKey, encodedInput, request});
			return lastShown.paths;
		}
		paths = litFloorsWasm(encodedInput);
		rememberLitArea(cache, cacheKey, paths);
	}
	if (sourceKey) lastShownBySource.set(sourceKey, {paths, request});
	return paths;
}

let requestCount = 0;

function rememberLitArea(cache, cacheKey, paths) {
	if (cache.paths.size >= MAX_CACHED_LIT_AREAS) cache.paths.delete(cache.paths.keys().next().value);
	cache.paths.set(cacheKey, paths);
}

const lastShownBySource = new Map();
// One running per source and the newest waiting; older waiting ones are dropped, since only the latest matters.
const jobsBySource = new Map();

function queueWorkerJob(sourceKey, task) {
	let job = jobsBySource.get(sourceKey);
	if (!job) jobsBySource.set(sourceKey, (job = {running: false, next: null}));
	if (job.running) {
		job.next = task;
		return;
	}
	runJob(sourceKey, job, task);
}

async function runJob(sourceKey, job, {scene, cache, cacheKey, encodedInput, request}) {
	job.running = true;
	try {
		const paths = await litFloorsInWorkers(encodedInput);
		// kept unless the scene's index moved on meanwhile (a wall, region or door changed): then the sources are lit again
		if (litAreasCacheByScene.get(scene) === cache) {
			rememberLitArea(cache, cacheKey, paths);
			// the stand-in only when this answers a newer request than the one shown: a source that came back meanwhile to a
			// position already in the cache shows that, and this older shape put in its place would jump it backwards
			if (request > (lastShownBySource.get(sourceKey)?.request ?? -1)) lastShownBySource.set(sourceKey, {paths, request});
		}
		redrawSourcesNextFrame();
	} catch (error) {
		console.error('f2e-grid-enhancements | the floor lighting workers failed; lighting on the main thread', error);
		floorsWasm.workers = false;
	} finally {
		job.running = false;
		const waitingTask = job.next;
		job.next = null;
		if (waitingTask && areFloorsWorkersReady()) runJob(sourceKey, job, waitingTask);
	}
}

// Each source finds its own result in the cache (or its latest, while it moves on).
let isRedrawQueued = false;
function redrawSourcesNextFrame() {
	if (isRedrawQueued) return;
	isRedrawQueued = true;
	requestAnimationFrame(() => {
		isRedrawQueued = false;
		if (canvas?.ready) canvas.perception.update({initializeVision: true, initializeLighting: true});
	});
}

// What needs Foundry's documents is worked out here: the levels the source sees, its base floor (the lowest bottom of those at
// or below it), and which levels are drawn. The layout must match the crate's gather.
function encodeSource(index, {scene, origin, type, level, radius = Infinity, externalRadius = 0, useThreshold = true}, box) {
	const sourceElevation = origin.elevation ?? 0;
	// the source's level and the levels it sees, as for the raycast's rays; documents on no level always count
	const levelIds = levelConnectedIdentifiers(level, true);
	const activeLevelIndexes = levelIds ? levelIds.map(id => index.levelIndexById.get(id)).filter(levelIndex => levelIndex !== undefined) : null;
	const bottoms = [level?.elevation?.bottom, ...(activeLevelIndexes ?? []).map(levelIndex => index.levels[levelIndex].bottom)].filter(bottom => Number.isFinite(bottom) && bottom <= sourceElevation);
	const baseElevation = bottoms.length ? Math.min(...bottoms) : sourceElevation;
	// core draws the maps of the source's level and the levels it lists
	const drawnLevelIds = new Set(level ? [level.id, ...(level.visibility?.levels ?? [])] : []);
	const encoded = [index.slot, origin.x, origin.y, sourceElevation, TYPES.indexOf(type), radius, externalRadius, useThreshold ? 1 : 0, box.minX, box.minY, box.maxX, box.maxY];
	encoded.push(CONFIG.Wall.thresholdAttenuationMultiplier ?? 1, baseElevation, level?.elevation?.top ?? Infinity);
	if (activeLevelIndexes) encoded.push(activeLevelIndexes.length, ...activeLevelIndexes);
	else encoded.push(-1);
	encoded.push(scene.levels.size);
	for (const sceneLevel of scene.levels) encoded.push(sceneLevel.elevation.bottom ?? -Infinity, sceneLevel.elevation.top ?? Infinity, drawnLevelIds.has(sceneLevel.id) ? 1 : 0);
	return callWasm(exports => {
		writeInput(exports, encoded);
		return readOutput(exports, exports.gather_floors()).slice();
	});
}
