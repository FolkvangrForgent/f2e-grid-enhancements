// A "Define Barrier" region behavior: barriers at the region's bottom, top and/or sides with a wall's options for
// each restriction type (none, limited, normal, proximity, reverse proximity, with thresholds and attenuation), and a
// one-way direction (blocking only going into or only going out of the region). Only this module's raycast reads it (see
// raycast/scene-index.js and query.js); core's own surface checks do not.

import {BARRIER_TYPE} from '../raycast/scene-index.js';

Hooks.once('init', () => {
	CONFIG.RegionBehavior.dataModels[BARRIER_TYPE] = BarrierRegionBehaviorType;
	CONFIG.RegionBehavior.typeIcons[BARRIER_TYPE] = 'fa-solid fa-layer-group';
	CONFIG.RegionBehavior.typeLabels[BARRIER_TYPE] = 'f2e-grid-enhancements.general.behavior.barrier.label';
	CONFIG.RegionBehavior.typeHints[BARRIER_TYPE] = 'f2e-grid-enhancements.general.behavior.barrier.hint';
});

// The config sheet laid out like a wall's: a Placement fieldset with the bottom, top and sides as one row of checkboxes,
// then a Restrictions fieldset with each restriction and its threshold beside it (shown only for Proximity and Reverse
// Proximity, in the scene's grid units), the direction and attenuation.
Hooks.on('renderRegionBehaviorConfig', (sheet, element) => {
	if (sheet.document.type !== BARRIER_TYPE) return;
	const groupOf = name => element.querySelector(`[name="system.${name}"]`)?.closest('.form-group');
	const placementFieldset = groupOf('bottom')?.closest('fieldset');
	if (!placementFieldset || placementFieldset.dataset.f2eGridEnhancementsArranged) return;
	placementFieldset.dataset.f2eGridEnhancementsArranged = 'true';
	const placementTitle = game.i18n.localize('BEHAVIOR.TYPES.defineSurface.FIELDS.placement.label');
	placementFieldset.querySelector('legend').textContent = placementTitle;
	// the bottom, top and sides checkboxes in one row
	const placement = document.createElement('div');
	placement.className = 'form-group';
	placement.innerHTML = `<label>${placementTitle}</label><div class="form-fields"></div>`;
	const checkboxes = placement.querySelector('.form-fields');
	for (const name of ['bottom', 'top', 'sides']) {
		const group = groupOf(name);
		const input = group?.querySelector('input');
		if (!input) continue;
		const label = document.createElement('label');
		label.className = 'checkbox';
		label.append(input, game.i18n.localize(BarrierRegionBehaviorType.schema.fields[name].label));
		checkboxes.append(label);
		group.remove();
	}
	placementFieldset.querySelector('legend').after(placement);
	const restrictions = document.createElement('fieldset');
	const legend = document.createElement('legend');
	legend.textContent = game.i18n.localize('TILE.FIELDS.restrictions.label');
	restrictions.append(legend);
	for (const name of ['move', 'light', 'sight', 'sound', 'direction', 'threshold.attenuation']) {
		const group = groupOf(name);
		if (group) restrictions.append(group);
	}
	placementFieldset.after(restrictions);
	const units = sheet.document.parent?.parent?.grid?.units || game.i18n.localize('MEASUREMENT.GridUnits');
	const thresholds = [];
	for (const type of ['light', 'sight', 'sound']) {
		const select = groupOf(type)?.querySelector('select');
		const thresholdGroup = groupOf(`threshold.${type}`);
		const input = thresholdGroup?.querySelector('input');
		if (!select || !input) continue;
		input.classList.add('threshold');
		input.placeholder = units;
		select.after(input);
		thresholdGroup.remove();
		thresholds.push({select, input});
	}
	// As on walls: a threshold shows only for Proximity and Reverse Proximity (hidden and disabled, so it is not submitted),
	// and attenuation only while any restriction uses one.
	const attenuationGroup = groupOf('threshold.attenuation');
	const showThresholds = () => {
		let anyThreshold = false;
		for (const {select, input} of thresholds) {
			const isThreshold = Number(select.value) >= CONST.EDGE_SENSE_TYPES.PROXIMITY;
			anyThreshold ||= isThreshold;
			input.hidden = !isThreshold;
			input.disabled = !isThreshold;
		}
		if (attenuationGroup) attenuationGroup.hidden = !anyThreshold;
	};
	for (const {select} of thresholds) select.addEventListener('change', showThresholds);
	showThresholds();
});

// Wall choices labelled as core labels them on walls.
const choicesOf = record => Object.fromEntries(Object.entries(record).map(([key, value]) => [value, `WALL.SenseTypes.${key}`]));

class BarrierRegionBehaviorType extends foundry.data.regionBehaviors.RegionBehaviorType {
	// Labels are core's where it has one (its Define Surface placements and its wall fields), else this module's; the config
	// sheet localizes them.
	static defineSchema() {
		const {fields} = foundry.data;
		const sense = label => new fields.NumberField({required: true, choices: choicesOf(CONST.EDGE_SENSE_TYPES), initial: CONST.EDGE_SENSE_TYPES.NORMAL, label});
		const threshold = () => new fields.NumberField({required: true, nullable: true, initial: null, positive: true});
		return {
			bottom: new fields.BooleanField({initial: true, label: 'BEHAVIOR.TYPES.defineSurface.PLACEMENTS.bottom.label'}),
			top: new fields.BooleanField({label: 'BEHAVIOR.TYPES.defineSurface.PLACEMENTS.top.label'}),
			sides: new fields.BooleanField({label: 'f2e-grid-enhancements.general.behavior.barrier.fields.sides'}),
			light: sense('WALL.FIELDS.light.label'),
			move: new fields.NumberField({
				required: true,
				choices: choicesOf(CONST.WALL_MOVEMENT_TYPES),
				initial: CONST.WALL_MOVEMENT_TYPES.NORMAL,
				label: 'WALL.FIELDS.move.label'
			}),
			sight: sense('WALL.FIELDS.sight.label'),
			sound: sense('WALL.FIELDS.sound.label'),
			direction: new fields.StringField({
				required: true,
				blank: false,
				initial: 'both',
				label: 'WALL.FIELDS.dir.label',
				choices: {
					both: 'f2e-grid-enhancements.general.behavior.barrier.directions.both',
					in: 'f2e-grid-enhancements.general.behavior.barrier.directions.in',
					out: 'f2e-grid-enhancements.general.behavior.barrier.directions.out'
				}
			}),
			threshold: new fields.SchemaField({
				light: threshold(),
				sight: threshold(),
				sound: threshold(),
				attenuation: new fields.BooleanField({label: 'WALL.FIELDS.threshold.attenuation.label'})
			})
		};
	}
}
