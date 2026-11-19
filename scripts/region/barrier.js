// Drawn on its Region at half opacity while the Regions layer is active:
// each face shaded by the way it faces (lit from the north-west), with the ridge, hip and valley lines between faces. While
// a Define Barrier's window is open the plan previews the roof as its fields stand (previewRoofPlan), on any layer.

import {signedArea} from '../helpers/clipper.js';
import {gridUnitPixels} from '../helpers/grid.js';
import * as patch from '../helpers/patch.js';
import {BARRIER_BEHAVIOR_TYPE, isDefineBarrier, onBarrierRegionChange, ROOF_FIELD_DEFAULTS, regionRoofFaces} from '../spatial/barriers.js';
import {ROOF_SHAPES} from '../spatial/roofs.js';

const SHADING_LIGHT_DIRECTION = (() => {
	const [x, y, z] = [-1, -1, 1.5];
	const length = Math.hypot(x, y, z);
	return {x: x / length, y: y / length, z: z / length};
})();

function faceBrightness(plane, pixelsPerUnit) {
	const [x, y, z] = [-pixelsPerUnit * plane.b, -pixelsPerUnit * plane.c, 1];
	return Math.max(0, (x * SHADING_LIGHT_DIRECTION.x + y * SHADING_LIGHT_DIRECTION.y + z * SHADING_LIGHT_DIRECTION.z) / Math.hypot(x, y, z));
}

const isPlanShown = region => region.layer.active || region.f2eRoofPreview !== undefined;

// region.f2eRoofPreview, when set, overrides the saved roof (null: none).
function drawRoofPlan(region) {
	const plan = region.f2eRoofPlan;
	if (!plan || plan.destroyed) return;
	for (const child of plan.removeChildren()) child.destroy();
	plan.visible = isPlanShown(region);
	const document = region.document;
	const scene = document.parent;
	const pixelsPerUnit = gridUnitPixels(scene.grid);
	const preview = region.f2eRoofPreview;
	const roofedTop = preview === undefined ? regionRoofFaces(document) : preview && regionRoofFaces(document, preview);
	if (!roofedTop) return;

	const uiScale = canvas.dimensions.uiScale;
	const faces = plan.addChild(new PIXI.Graphics());
	for (const {plane, paths} of roofedTop.pieces) {
		const shade = Math.round(255 * (0.15 + 0.85 * faceBrightness(plane, pixelsPerUnit)));
		faces.beginFill((shade << 16) | (shade << 8) | shade, 0.45);
		for (const path of paths) if (signedArea(path) > 0) faces.drawPolygon(path);
		for (const path of paths) {
			if (signedArea(path) >= 0) continue;
			faces.beginHole().drawPolygon(path).endHole();
		}
		faces.endFill();
	}
	// the ridge and hip lines: every piece's outline (the region's own border is core's)
	faces.lineStyle({width: 2 * uiScale, color: 0x000000, alpha: 0.7, alignment: 0.5});
	for (const {paths} of roofedTop.pieces) for (const path of paths) faces.drawPolygon(path);
}

function redrawRoofPlanOf(document) {
	const region = document?.object;
	if (region?.f2eRoofPlan) drawRoofPlan(region);
}

// Shown whatever layer is active. roof null previews no roof; undefined ends the preview.
function previewRoofPlan(document, roof) {
	const region = document?.object;
	if (!region) return;
	if (roof === undefined) delete region.f2eRoofPreview;
	else region.f2eRoofPreview = roof;
	if (region.f2eRoofPlan) drawRoofPlan(region);
}

Hooks.once('init', () => {
	// the plan sits under the region's measurements, border and controls
	patch.add('foundry.canvas.placeables.Region.prototype._draw', async (wrapped, region, ...args) => {
		const result = await wrapped(...args);
		region.f2eRoofPlan = new PIXI.Container();
		region.f2eRoofPlan.eventMode = 'none';
		region.f2eRoofPlan.alpha = 0.5;
		region.addChildAt(region.f2eRoofPlan, Math.max(0, region.getChildIndex(region._measurementLines)));
		drawRoofPlan(region);
		return result;
	});
	// the shapes changed (core refreshes the border when the geometry changes)
	patch.add('foundry.canvas.placeables.Region.prototype._refreshBorder', (wrapped, region, ...args) => {
		const result = wrapped(...args);
		drawRoofPlan(region);
		return result;
	});
	onBarrierRegionChange(isDefineBarrier, redrawRoofPlanOf);
	const updatePlanVisibility = layer => {
		for (const region of layer.placeables) if (region.f2eRoofPlan) region.f2eRoofPlan.visible = isPlanShown(region);
	};
	Hooks.on('activateRegionLayer', updatePlanVisibility);
	Hooks.on('deactivateRegionLayer', updatePlanVisibility);
});

// With the visualizer off, barriers are also handed to core's edges and surfaces (barrier-core.js).

Hooks.once('init', () => {
	CONFIG.RegionBehavior.dataModels[BARRIER_BEHAVIOR_TYPE] = BarrierRegionBehaviorType;
	CONFIG.RegionBehavior.typeIcons[BARRIER_BEHAVIOR_TYPE] = 'fa-solid fa-layer-group';
	CONFIG.RegionBehavior.typeLabels[BARRIER_BEHAVIOR_TYPE] = 'f2e-grid-enhancements.general.behavior.barrier.label';
	CONFIG.RegionBehavior.typeHints[BARRIER_BEHAVIOR_TYPE] = 'f2e-grid-enhancements.general.behavior.barrier.hint';
});

// In the order the window lists them.
const hasRoof = roof => roof.shape !== 'none';
const ROOF_FIELD_SHOWN = {
	show: hasRoof,
	shape: () => true,
	pitch: hasRoof,
	direction: roof => roof.shape === 'manual',
	ridge: roof => roof.shape === 'manual',
	teeth: roof => roof.shape === 'manual',
	lowerGable: roof => roof.shape === 'auto',
	upperGable: roof => roof.shape === 'auto'
};

// Laid out like a wall's config: Placement checkboxes in one row, Restrictions with each threshold beside its restriction,
// then Advanced Options with the roof's fields and its eave and ridge heights.
Hooks.on('renderRegionBehaviorConfig', (sheet, element) => {
	if (!isDefineBarrier(sheet.document)) return;
	const groupOf = name => element.querySelector(`[name="system.${name}"]`)?.closest('.form-group');
	const placementFieldset = groupOf('bottom')?.closest('fieldset');
	if (!placementFieldset || placementFieldset.dataset.f2eGridEnhancementsArranged) return;
	placementFieldset.dataset.f2eGridEnhancementsArranged = 'true';
	const units = sheet.document.parent?.parent?.grid?.units || game.i18n.localize('MEASUREMENT.GridUnits');
	arrangePlacement(placementFieldset, groupOf);
	const restrictions = arrangeRestrictions(placementFieldset, groupOf);
	arrangeRoofFields(sheet.document.parent, placementFieldset, restrictions, groupOf, units);
	arrangeThresholds(groupOf, units);
});

function arrangePlacement(placementFieldset, groupOf) {
	const placementTitle = game.i18n.localize('BEHAVIOR.TYPES.defineSurface.FIELDS.placement.label');
	placementFieldset.querySelector('legend').textContent = placementTitle;
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
}

function arrangeRestrictions(placementFieldset, groupOf) {
	const restrictions = document.createElement('fieldset');
	const legend = document.createElement('legend');
	legend.textContent = game.i18n.localize('TILE.FIELDS.restrictions.label');
	restrictions.append(legend);
	for (const name of ['move', 'light', 'sight', 'sound', 'direction', 'threshold.attenuation']) {
		const group = groupOf(name);
		if (group) restrictions.append(group);
	}
	placementFieldset.after(restrictions);
	return restrictions;
}

// Shows only the fields the roof's shape uses, and its eave and ridge heights, previewing the roof plan on the canvas as the
// fields stand.
function arrangeRoofFields(region, placementFieldset, restrictions, groupOf, units) {
	const coreRoofFieldset = groupOf('roof.shape')?.closest('fieldset');
	const advanced = document.createElement('fieldset');
	advanced.innerHTML = `<legend>${game.i18n.localize('TOKEN.SECTIONS.advanced')}</legend>`;
	for (const name of Object.keys(ROOF_FIELD_SHOWN)) {
		const group = groupOf(`roof.${name}`);
		if (group) advanced.append(group);
	}
	restrictions.after(advanced);
	if (coreRoofFieldset && coreRoofFieldset !== placementFieldset && !coreRoofFieldset.querySelector('.form-group')) coreRoofFieldset.remove();
	const roofFieldValue = name => advanced.querySelector(`[name="system.roof.${name}"]`)?.value;
	const roofAsShown = () =>
		Object.fromEntries(
			Object.entries(ROOF_FIELD_DEFAULTS).map(([name, defaultValue]) => {
				const text = roofFieldValue(name) ?? '';
				return [name, text === '' ? defaultValue : typeof defaultValue === 'number' ? Number(text) : text];
			})
		);
	const showUsedRoofFields = () => {
		const roof = roofAsShown();
		for (const [name, isShown] of Object.entries(ROOF_FIELD_SHOWN)) {
			const group = groupOf(`roof.${name}`);
			if (group) group.hidden = !isShown(roof);
		}
	};
	const heightRangeHint = document.createElement('p');
	heightRangeHint.className = 'hint';
	advanced.append(heightRangeHint);
	const showHeightRange = () => {
		const roof = roofAsShown();
		previewRoofPlan(region, roof.shape === 'none' ? null : roof);
		const roofedTop = region ? regionRoofFaces(region, roof) : null;
		heightRangeHint.hidden = !roofedTop;
		if (!roofedTop) return;
		const formatHeight = elevation => `${Math.round(elevation * 10) / 10} ${units}`;
		const eaves = Math.min(...roofedTop.pieces.map(piece => piece.low));
		const ridge = Math.max(...roofedTop.pieces.map(piece => piece.high));
		heightRangeHint.textContent = game.i18n.format('f2e-grid-enhancements.general.behavior.barrier.roofRange', {eaves: formatHeight(eaves), ridge: formatHeight(ridge)});
	};
	const showRoofFieldsAndHeights = () => {
		showUsedRoofFields();
		showHeightRange();
	};
	advanced.addEventListener('change', showRoofFieldsAndHeights);
	advanced.addEventListener('input', showHeightRange);
	showRoofFieldsAndHeights();
}

// Each threshold beside its restriction. As on walls: a threshold shows only for Proximity and Reverse Proximity (hidden and
// disabled, so it is not submitted), and attenuation only while any restriction uses one.
function arrangeThresholds(groupOf, units) {
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
	const attenuationGroup = groupOf('threshold.attenuation');
	const showUsedThresholds = () => {
		let anyThreshold = false;
		for (const {select, input} of thresholds) {
			const isThreshold = Number(select.value) >= CONST.EDGE_SENSE_TYPES.PROXIMITY;
			anyThreshold ||= isThreshold;
			input.hidden = !isThreshold;
			input.disabled = !isThreshold;
		}
		if (attenuationGroup) attenuationGroup.hidden = !anyThreshold;
	};
	for (const {select} of thresholds) select.addEventListener('change', showUsedThresholds);
	showUsedThresholds();
}

// The roof plan previewed while the window is open goes back to the roof as saved when it closes.
Hooks.on('closeRegionBehaviorConfig', sheet => {
	if (isDefineBarrier(sheet.document)) previewRoofPlan(sheet.document.parent, undefined);
});

const wallChoiceLabels = record => Object.fromEntries(Object.entries(record).map(([key, value]) => [value, `WALL.SenseTypes.${key}`]));

class BarrierRegionBehaviorType extends foundry.data.regionBehaviors.RegionBehaviorType {
	// Labels are core's where it has one (its Define Surface placements and its wall fields), else this module's; the config
	// sheet localizes them.
	static defineSchema() {
		const {fields} = foundry.data;
		const roofLabel = name => `f2e-grid-enhancements.general.behavior.barrier.fields.roof.${name}`;
		const roofChoiceField = (name, initial, values, labelGroup) =>
			new fields.StringField({
				required: true,
				blank: false,
				initial,
				label: roofLabel(name),
				choices: Object.fromEntries(values.map(value => [value, `f2e-grid-enhancements.general.behavior.barrier.${labelGroup}.${value}`]))
			});
		const roofPercentField = (initial, name) => new fields.NumberField({required: true, nullable: false, initial, min: 0, max: 100, step: 1, label: roofLabel(name), hint: roofLabel(`${name}-hint`)});
		const senseField = label => new fields.NumberField({required: true, choices: wallChoiceLabels(CONST.EDGE_SENSE_TYPES), initial: CONST.EDGE_SENSE_TYPES.NORMAL, label});
		const thresholdField = () => new fields.NumberField({required: true, nullable: true, initial: null, positive: true});
		return {
			bottom: new fields.BooleanField({initial: true, label: 'BEHAVIOR.TYPES.defineSurface.PLACEMENTS.bottom.label'}),
			top: new fields.BooleanField({initial: true, label: 'BEHAVIOR.TYPES.defineSurface.PLACEMENTS.top.label'}),
			sides: new fields.BooleanField({initial: true, label: 'f2e-grid-enhancements.general.behavior.barrier.fields.sides'}),
			light: senseField('WALL.FIELDS.light.label'),
			move: new fields.NumberField({
				required: true,
				choices: wallChoiceLabels(CONST.WALL_MOVEMENT_TYPES),
				initial: CONST.WALL_MOVEMENT_TYPES.NORMAL,
				label: 'WALL.FIELDS.move.label'
			}),
			sight: senseField('WALL.FIELDS.sight.label'),
			sound: senseField('WALL.FIELDS.sound.label'),
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
				light: thresholdField(),
				sight: thresholdField(),
				sound: thresholdField(),
				attenuation: new fields.BooleanField({label: 'WALL.FIELDS.threshold.attenuation.label'})
			}),
			// the region's top as a roof (spatial/roofs.js), rising from its Bottom (flattened below its Top); its sides and any core
			// surfaces on its top follow it
			roof: new fields.SchemaField({
				shape: roofChoiceField('shape', 'none', ['none', ...ROOF_SHAPES], 'roofs'),
				// manual: the ridge along `direction` (degrees clockwise from east) at `ridge` (percent across, 0 its left side facing the
				// direction), repeated `teeth` times across
				direction: new fields.AngleField({initial: 0, label: roofLabel('direction')}),
				ridge: roofPercentField(50, 'ridge'),
				teeth: new fields.NumberField({required: true, nullable: false, initial: 1, min: 1, max: 50, integer: true, label: roofLabel('teeth'), hint: roofLabel('teeth-hint')}),
				// auto: its ridge ends, gables below and above the hip as deep as `lowerGable` and `upperGable` (percent of the end's
				// depth): 0 and 0 a hip, all of it a gable, some below a jerkinhead, some above a Dutch gable
				lowerGable: roofPercentField(0, 'lowerGable'),
				upperGable: roofPercentField(0, 'upperGable'),
				pitch: new fields.NumberField({required: true, nullable: false, initial: 30, min: 0, max: 89, label: roofLabel('pitch'), hint: roofLabel('pitch-hint')}),
				// off: the roof, where it is the floor a source sees, is left out of the source's shape (unexplored); seen from beneath
				// it, the inside shows as ever (perception/floors.js)
				show: new fields.BooleanField({initial: true, label: roofLabel('show')})
			})
		};
	}
}
