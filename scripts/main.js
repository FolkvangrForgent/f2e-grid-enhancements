import './setting.js';
import './perception/index.js';
import './wall.js';
import './scene.js';
import './region/index.js';
import './token.js';
import * as distance from './distance.js';
import {wasmReady} from './helpers/wasm.js';
import * as raycast from './raycast/index.js';

Hooks.once('init', () => {
	game.modules.get('f2e-grid-enhancements').api = Object.freeze({
		raycastBarriers: raycast.raycastBarriers,
		raycastRegions: raycast.raycastRegions,
		raycastTokens: raycast.raycastTokens,
		raycastSources: raycast.raycastSources,
		distance: distance.distance,
		// resolves to whether the WebAssembly raycast loaded; the raycasts throw until it has
		ready: wasmReady
	});
	if (['pf2e', 'sf2e'].includes(game.system.id)) {
		import('./f2e/index.js').then(module => module.initialize());
	}
});
