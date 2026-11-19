import * as movement from './movement.js';
import * as sound from './sound.js';
import * as vision from './vision.js';

// A form group for one end of a wall's height: an elevation input and a checkbox that turns the override on. Focusing
// the input turns it on; while off, the input is greyed out and read only.
const createWallHeightGroup = (wallConfig, end, unbounded, placeholder) => {
	const field = new foundry.data.fields.ExtendedNumberField({
		nullable: true,
		initial: null,
		extension: unbounded,
		label: game.i18n.localize(`REGION.FIELDS.elevation.${end}.label`)
	});
	const group = field.toFormGroup(
		{},
		{
			name: `flags.f2e-grid-enhancements.${end}-elevation`,
			value: wallConfig.document.getFlag('f2e-grid-enhancements', `${end}-elevation`) ?? null,
			placeholder
		}
	);
	const enabledCheckbox = document.createElement('input');
	enabledCheckbox.type = 'checkbox';
	enabledCheckbox.name = `flags.f2e-grid-enhancements.${end}-enabled`;
	enabledCheckbox.checked = !!wallConfig.document.getFlag('f2e-grid-enhancements', `${end}-enabled`);
	enabledCheckbox.title = game.i18n.localize('BEHAVIOR.TYPES.adjustDarknessLevel.MODES.OVERRIDE.label');
	const elevationInput = group.querySelector(`[name="flags.f2e-grid-enhancements.${end}-elevation"]`);
	const syncInputState = () => {
		elevationInput.readOnly = !enabledCheckbox.checked;
		elevationInput.style.opacity = enabledCheckbox.checked ? '' : '0.5';
	};
	enabledCheckbox.addEventListener('change', syncInputState);
	elevationInput.addEventListener('focus', () => {
		enabledCheckbox.checked = true;
		syncInputState();
	});
	group.querySelector('.form-fields').prepend(enabledCheckbox);
	syncInputState();
	return group;
};

Hooks.once('init', () => {
	vision.initialize();
	sound.initialize();
	movement.initialize();
	Hooks.on('renderWallConfig', renderWallConfig);
});

// Add the wall height fields to the wall config window, before its footer.
function renderWallConfig(wallConfig, element) {
	if (element.querySelector('.f2e-grid-enhancements')) return;
	const fieldset = document.createElement('fieldset');
	fieldset.className = 'f2e-grid-enhancements';
	fieldset.innerHTML = `<legend>${game.i18n.localize('f2e-grid-enhancements.general.wall.elevation')}</legend>`;
	fieldset.append(createWallHeightGroup(wallConfig, 'top', Infinity, '∞'), createWallHeightGroup(wallConfig, 'bottom', -Infinity, '-∞'));
	const footer = element.querySelector('footer.form-footer');
	if (footer) {
		footer.before(fieldset);
	} else {
		element.querySelector('form')?.append(fieldset);
	}
}
