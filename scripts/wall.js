import {wallHeightOverride} from './helpers/wall.js';

// Focusing the input turns the override on; while off, the input is greyed out and read only.
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

Hooks.on('renderWallConfig', addWallHeightFields);

// As core validates a region's elevation: with both overrides on, the bottom may not be above the top (equal is allowed, a
// wall of no height). A single override past the level's other end is allowed, since a wall on several levels can stand on
// some and not others; the scene index leaves out the levels where it has no height.
function hasInvertedOverrides(wall, flagChanges) {
	const flags = foundry.utils.mergeObject(foundry.utils.deepClone(wall._source.flags?.['f2e-grid-enhancements'] ?? {}), flagChanges ?? {}, {inplace: false, performDeletions: true});
	const merged = {flags: {'f2e-grid-enhancements': flags}};
	const bottom = wallHeightOverride(merged, 'bottom');
	const top = wallHeightOverride(merged, 'top');
	return bottom !== null && top !== null && bottom > top;
}

function rejectInvertedOverrides(wall, flagChanges) {
	if (!hasInvertedOverrides(wall, flagChanges)) return true;
	ui.notifications?.error('f2e-grid-enhancements.general.wall.elevation-inverted', {localize: true});
	return false;
}

Hooks.on('preCreateWall', wall => rejectInvertedOverrides(wall, null));
Hooks.on('preUpdateWall', (wall, changes) => {
	const flagChanges = foundry.utils.getProperty(changes, 'flags.f2e-grid-enhancements');
	if (flagChanges === undefined) return true;
	return rejectInvertedOverrides(wall, flagChanges);
});

function addWallHeightFields(wallConfig, element) {
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
