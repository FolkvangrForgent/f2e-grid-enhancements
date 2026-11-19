import {compilePack} from '@foundryvtt/foundryvtt-cli';

// <system> in condition UUIDs and icon paths becomes the system's id.
const replaceSystemPlaceholder = system => entry => {
	Object.assign(entry, JSON.parse(JSON.stringify(entry).replaceAll('<system>', system)));
};

for (const system of ['pf2e', 'sf2e']) {
	await compilePack('packs/f2e/off-guard-toggle', `build/packs/f2e/off-guard-toggle-${system}`, {transformEntry: replaceSystemPlaceholder(system)});
}
