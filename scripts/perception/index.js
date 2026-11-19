// Perception and movement through the raycast instead of core's flat sweep.
import './collision.js';
import './footprint.js';
import './light.js';
import './sound.js';
import './vision.js';
import './visualizer.js';
import {wasmReady} from '../helpers/wasm.js';

// Sources made before the raycast loaded used core's checks; made again, they use it.
wasmReady.then(loaded => {
	if (loaded && canvas?.ready) canvas.perception.update({initializeVision: true, initializeLighting: true, initializeSounds: true});
});
