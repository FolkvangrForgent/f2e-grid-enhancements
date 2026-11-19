import * as setting from '../helpers/setting.js';

Hooks.once('init', () => {
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
	Hooks.on('preCreateScene', preCreateScene);
});

// The default level name setting shows core's own name for a new scene's level (Level.defaultName, the document's label, which is
// all a new scene's first level can be called), greyed as a placeholder, while it is unset.
Hooks.on('renderSettingsConfig', (settingsConfig, element) => {
	const input = element.querySelector('[name="f2e-grid-enhancements.general.default-level-name"]');
	if (input) input.placeholder = game.i18n.localize(foundry.documents.Level.metadata.label);
});

function preCreateScene(scene, data, options, userId) {
	if (game.user.id !== userId) return;
	const updates = {};
	if (data.grid?.type === undefined) {
		updates['grid.type'] = setting.get('general.default-grid-type');
	}
	if (!data.levels?.length) {
		const elevation = {
			bottom: setting.get('general.default-level-bottom-elevation'),
			top: setting.get('general.default-level-top-elevation')
		};
		const existingLevels = scene.toObject().levels ?? [];
		// core gives a new scene its first level (Scene#_preCreate) before this hook, named Level.defaultName
		const name = setting.get('general.default-level-name') || null;
		if (existingLevels.length) {
			updates.levels = existingLevels.map((level, index) => (index === 0 ? {...level, name: name ?? level.name, elevation: {...level.elevation, ...elevation}} : level));
		} else {
			updates.levels = [
				{
					_id: foundry.utils.randomID(),
					name: name ?? foundry.documents.Level.defaultName({parent: scene}),
					elevation
				}
			];
		}
	}
	if (!foundry.utils.isEmpty(updates)) {
		scene.updateSource(updates);
	}
}
