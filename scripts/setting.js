// Registered in the order the settings window lists them.
import * as setting from './helpers/setting.js';
import {syncAllScenes} from './region/barrier-core.js';

Hooks.once('init', () => {
	setting.register(
		'general.barrier-visualization',
		new foundry.data.fields.BooleanField({
			required: true,
			persisted: true,
			nullable: false,
			initial: true
		}),
		{
			// the visualizer (perception/visualizer.js) and perception (perception/vision.js) check the setting when they run, so
			// recomputing perception is enough to switch them on or off; barriers are handed to core, or taken back (region/barrier-core.js)
			onChange: () => {
				syncAllScenes();
				if (!canvas?.ready) return;
				canvas.perception.update({initializeVision: true, initializeLighting: true, initializeSounds: true});
			}
		}
	);
	setting.register(
		'general.default-grid-type',
		new foundry.data.fields.NumberField({
			required: true,
			persisted: true,
			nullable: false,
			initial: CONST.GRID_TYPES.SQUARE,
			integer: true,
			choices: {
				[CONST.GRID_TYPES.GRIDLESS]: 'SCENE.GridGridless',
				[CONST.GRID_TYPES.SQUARE]: 'SCENE.GridSquare',
				[CONST.GRID_TYPES.HEXODDR]: 'SCENE.GridHexOddR',
				[CONST.GRID_TYPES.HEXEVENR]: 'SCENE.GridHexEvenR',
				[CONST.GRID_TYPES.HEXODDQ]: 'SCENE.GridHexOddQ',
				[CONST.GRID_TYPES.HEXEVENQ]: 'SCENE.GridHexEvenQ'
			}
		})
	);
	setting.register(
		'general.default-level-name',
		new foundry.data.fields.StringField({
			required: true,
			persisted: true,
			nullable: true,
			initial: null
		})
	);
	setting.register(
		'general.default-level-top-elevation',
		new foundry.data.fields.ExtendedNumberField({
			required: true,
			persisted: true,
			nullable: true,
			initial: null,
			integer: false,
			extension: Infinity
		})
	);
	setting.register(
		'general.default-level-bottom-elevation',
		new foundry.data.fields.ExtendedNumberField({
			required: true,
			persisted: true,
			nullable: true,
			initial: 0,
			integer: false,
			extension: -Infinity
		})
	);
});

Hooks.on('renderSettingsConfig', (settingsConfig, element) => {
	// a heading before each group's first setting
	for (const group of ['general', 'f2e']) {
		const firstSetting = element.querySelector(`[name^="f2e-grid-enhancements.${group}."]`)?.closest('.form-group');
		if (!firstSetting || firstSetting.previousElementSibling?.classList.contains('f2e-grid-enhancements-section')) continue;
		const heading = document.createElement('h4');
		heading.className = 'divider f2e-grid-enhancements-section';
		heading.textContent = game.i18n.localize(`f2e-grid-enhancements.setting.${group}.title`);
		firstSetting.before(heading);
	}
});

// The default level name shows core's own name for a new scene's level (Level.defaultName, the document's label, which is all
// a new scene's first level can be called), greyed as the field's placeholder, while it is unset. Set once translations are
// loaded, which is after the settings are registered (init); the settings window renders the field with it.
Hooks.once('i18nInit', () => {
	const field = game.settings.settings.get('f2e-grid-enhancements.general.default-level-name')?.type;
	if (field) field.placeholder = game.i18n.localize(foundry.documents.Level.metadata.label);
});
