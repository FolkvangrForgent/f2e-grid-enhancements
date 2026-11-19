import './elevation/index.js';
import './scene/index.js';
import './region/index.js';
import './token/index.js';
import './visulizer/index.js';
import * as distance from './distance/index.js';
import * as raycast from './raycast/index.js';

Hooks.once('init', () => {
	game.modules.get('f2e-grid-enhancements').api = Object.freeze({
		raycast: raycast.raycast,
		distance: distance.distance
	});
	if (['pf2e', 'sf2e'].includes(game.system.id)) {
		import('./systems/f2e/index.js').then(module => module.initialize());
	}
});

Hooks.on('renderSettingsConfig', (settingsConfig, element) => {
	for (const group of ['general', 'f2e']) {
		const firstSetting = element.querySelector(`[name^="f2e-grid-enhancements.${group}."]`)?.closest('.form-group');
		if (!firstSetting || firstSetting.previousElementSibling?.classList.contains('f2e-grid-enhancements-section')) continue;
		const heading = document.createElement('h4');
		heading.className = 'divider f2e-grid-enhancements-section';
		heading.textContent = game.i18n.localize(`f2e-grid-enhancements.setting.${group}.title`);
		firstSetting.before(heading);
	}
});
