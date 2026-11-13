import * as distance from './distance.js';
import * as patch from './patch.js';
import * as raycast from './raycast.js';
import * as setting from './setting.js';

Hooks.once('init', () => {
	// setting
	setting.register('general.default-grid-type', new foundry.data.fields.NumberField({
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
	}));
	setting.register('general.default-level-name', new foundry.data.fields.StringField({
		required: true,
		persisted: true,
		nullable: true,
		initial: null
	}));
	setting.register('general.default-level-top-elevation', new foundry.data.fields.ExtendedNumberField({
		required: true,
		persisted: true,
		nullable: true,
		initial: null,
		integer: false,
		extension: Infinity
	}));
	setting.register('general.default-level-bottom-elevation', new foundry.data.fields.ExtendedNumberField({
		required: true,
		persisted: true,
		nullable: true,
		initial: 0,
		integer: false,
		extension: -Infinity
	}));
	// api
	game.modules.get('f2e-grid-enhancements').api = Object.freeze({raycast: raycast.raycast, distance: distance.distance});
	// system
	const initializeSystem = (name) => {
		import(`./${name}/main.js`).then(module => {
			module.initialize();
		});
	};
	if (game.system.id === 'pf2e') {
		initializeSystem('f2e')
	} else if (game.system.id === 'sf2e') {
		initializeSystem('f2e')
	}
});

Hooks.on('preCreateScene', (scene, data, options, userId) => {
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
		const existing = scene.toObject().levels ?? [];
		if (existing.length) {
			updates.levels = existing.map((level, i) =>
				i === 0 ? { ...level, elevation: { ...level.elevation, ...elevation } } : level
			);
		} else {
			updates.levels = [{
				_id: foundry.utils.randomID(),
				name: setting.get('general.default-level-name') ?? 'SCENE.InitialLevel',
				elevation
			}];
		}
	}
	if (!foundry.utils.isEmpty(updates)) {
		scene.updateSource(updates);
	}
});

const createWallHeightGroup = (app, key, extension, placeholder) => {
	const field = new foundry.data.fields.ExtendedNumberField({
		nullable: true,
		initial: null,
		extension,
		label: game.i18n.localize(`REGION.FIELDS.elevation.${key}.label`)
	});
	const group = field.toFormGroup({}, {
		name: `flags.f2e-grid-enhancements.${key}-elevation`,
		value: app.document.getFlag('f2e-grid-enhancements', `${key}-elevation`) ?? null,
		placeholder
	});
	const checkbox = document.createElement('input');
	checkbox.type = 'checkbox';
	checkbox.name = `flags.f2e-grid-enhancements.${key}-enabled`;
	checkbox.checked = !!app.document.getFlag('f2e-grid-enhancements', `${key}-enabled`);
	checkbox.title = game.i18n.localize('f2e-grid-enhancements.general.wall-height-override');
	const input = group.querySelector(`[name="flags.f2e-grid-enhancements.${key}-elevation"]`);
	const sync = () => {
		input.readOnly = !checkbox.checked;
		input.style.opacity = checkbox.checked ? '' : '0.5';
	};
	checkbox.addEventListener('change', sync);
	input.addEventListener('focus', () => {
		checkbox.checked = true;
		sync();
	});
	group.querySelector('.form-fields').prepend(checkbox);
	sync();
	return group;
};

Hooks.on('renderWallConfig', (app, element) => {
	if (element.querySelector('.f2e-grid-enhancements')) return;
	const fieldset = document.createElement('fieldset');
	fieldset.className = 'f2e-grid-enhancements';
	fieldset.innerHTML = `<legend>${game.i18n.localize('f2e-grid-enhancements.general.wall-height')}</legend>`;
	fieldset.append(
		createWallHeightGroup(app, 'top', Infinity, '∞'),
		createWallHeightGroup(app, 'bottom', -Infinity, '-∞')
	);
	const footer = element.querySelector('footer.form-footer');
	if (footer) {
		footer.before(fieldset);
	} else {
		element.querySelector('form')?.append(fieldset);
	}
});
