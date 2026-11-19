// The module's WebAssembly (the wasm/ crate): the scene store, the raycast and the floor lighting. It starts loading when this
// file is imported; Foundry does not wait for a module's scripts, so until it is ready (or if it cannot load) what needs it
// falls back to core (isWasmReady), and the API's `ready` resolves once it is settled.
//
// Exports take and give flat f64s through one input and one output buffer (see the crate's reader.rs), so no generated glue
// is needed.

const WASM_URL = new URL('../../wasm/f2e_grid.wasm', import.meta.url);

// status: 'loading', 'ready', or 'failed: ...'. module is kept for the floor lighting's workers.
export const wasm = {module: null, exports: null, status: 'loading'};

export const wasmReady = (async () => {
	try {
		const response = await fetch(WASM_URL);
		if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
		wasm.module = await WebAssembly.compile(await response.arrayBuffer());
		wasm.exports = (await WebAssembly.instantiate(wasm.module, {})).exports;
		wasm.status = 'ready';
		return true;
	} catch (error) {
		wasm.status = `failed: ${error.message}`;
		console.error("f2e-grid-enhancements | the WebAssembly module could not load; movement, perception and the visualizer use core's flat checks", error);
		return false;
	}
})();

export const isWasmReady = () => wasm.exports !== null;

// A trap leaves the module's state unknown, so it is turned off for good and everything falls back to core.
export function callWasm(run) {
	if (!wasm.exports) throw new Error(`the WebAssembly module is not loaded (${wasm.status})`);
	try {
		return run(wasm.exports);
	} catch (error) {
		wasm.exports = null;
		wasm.status = `failed: ${error.message}`;
		console.error("f2e-grid-enhancements | the WebAssembly module failed and is turned off; core's flat checks are used from now on", error);
		throw error;
	}
}

// Call inside callWasm. Views are made after each call that can grow memory, which detaches earlier ones.
export function writeInput(exports, values) {
	const pointer = exports.input_buffer(values.length);
	new Float64Array(exports.memory.buffer, pointer, values.length).set(values);
}

export const readOutput = (exports, length) => new Float64Array(exports.memory.buffer, exports.output_buffer(), length);

// Collects f64s for an upload or a query: lists are a count then the values, paths a count then each path's point count and
// its coordinates.
export class Encoder {
	values = [];

	push(...values) {
		for (const value of values) this.values.push(value);
	}

	list(values) {
		this.values.push(values.length);
		for (let index = 0; index < values.length; index++) this.values.push(values[index]);
	}

	paths(paths) {
		this.values.push(paths.length);
		for (const path of paths) {
			this.values.push(path.length / 2);
			for (let index = 0; index < path.length; index++) this.values.push(path[index]);
		}
	}
}
