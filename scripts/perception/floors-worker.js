// Given the compiled module once, then tasks {id, input?, part, parts}. With a job's first
// task comes its input, which the worker prepares (the module's prepare_input) and keeps for the job's later tasks; each task
// lights its share (lit_task) and is posted back as {id, part, output}, the lit paths as a Float64Array (a count, then each path's
// point count and its coordinates).
let exports = null;
let preparedJobId = null;

self.onmessage = async ({data}) => {
	if (data.module) {
		try {
			({exports} = await WebAssembly.instantiate(data.module, {}));
			self.postMessage({ready: true});
		} catch (error) {
			self.postMessage({error: String(error)});
		}
		return;
	}
	const {id, input, part, parts} = data;
	try {
		if (input) {
			const pointer = exports.input_buffer(input.length);
			new Float64Array(exports.memory.buffer, pointer, input.length).set(input);
			exports.prepare_input();
			preparedJobId = id;
		} else if (preparedJobId !== id) throw new Error(`task of job ${id} without its input`);
		const length = exports.lit_task(part, parts);
		const output = Float64Array.from(new Float64Array(exports.memory.buffer, exports.output_buffer(), length));
		self.postMessage({id, part, output}, [output.buffer]);
	} catch (error) {
		self.postMessage({id, part, error: String(error)});
	}
};
