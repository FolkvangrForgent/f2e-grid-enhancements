import * as patch from './helpers/patch.js';
import {levelAtElevation, sequentialLevels} from './helpers/scene.js';
import * as setting from './helpers/setting.js';

Hooks.on('preCreateScene', applySceneDefaults);

function applySceneDefaults(scene, data, options, userId) {
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

// A checkbox for a scene flag at the top of the scene config's Levels tab, which is drawn again whenever the levels change.
// Null when the tab is not there or already has it.
function addLevelsTabCheckbox(sheet, element, flag) {
	const tab = element.querySelector('.tab[data-tab="levels"]');
	const name = `flags.f2e-grid-enhancements.${flag}`;
	if (!tab || tab.querySelector(`[name="${name}"]`)) return null;
	const field = new foundry.data.fields.BooleanField({
		label: `f2e-grid-enhancements.general.scene.${flag}`,
		hint: `f2e-grid-enhancements.general.scene.${flag}-hint`
	});
	const group = field.toFormGroup({localize: true}, {name, value: !!sheet.document.getFlag('f2e-grid-enhancements', flag)});
	tab.querySelector('fieldset')?.after(group);
	return group;
}

// Core shows and takes elevations relative to the viewed level's base (its bottom). On a scene with the Absolute Elevations
// option, those display and input methods see a base of 0, so elevations read as stored. Each reads the base synchronously,
// before any await, so the base is back before anything else runs. Placement defaults and pasting keep core's relative behavior.

const ABSOLUTE_ELEVATION_FLAG = 'absolute-elevation';

function withLevelBaseAtZero(runWrapped) {
	const elevation = canvas?.level?.elevation;
	if (!elevation || elevation.base === 0 || !canvas.scene?.getFlag('f2e-grid-enhancements', ABSOLUTE_ELEVATION_FLAG)) return runWrapped();
	const relativeBase = elevation.base;
	elevation.base = 0;
	try {
		return runWrapped();
	} finally {
		elevation.base = relativeBase;
	}
}

const DISPLAY_AND_INPUT_METHODS = [
	'foundry.applications.hud.BasePlaceableHUD.prototype._prepareContext',
	'foundry.applications.hud.BasePlaceableHUD.prototype._onSubmitElevation',
	'foundry.applications.hud.TokenHUD.prototype._onSubmitElevation',
	'foundry.canvas.placeables.Token.prototype._getTooltipText',
	'foundry.canvas.placeables.AmbientLight.prototype._getTooltipText',
	'foundry.canvas.placeables.AmbientSound.prototype._getTooltipText',
	'foundry.canvas.placeables.Note.prototype._refreshElevation',
	'foundry.canvas.placeables.tokens.TokenRuler.prototype._getWaypointLabelContext'
];

Hooks.once('init', () => {
	for (const method of DISPLAY_AND_INPUT_METHODS) patch.add(method, (wrapped, self, ...args) => withLevelBaseAtZero(() => wrapped(...args)));
});

Hooks.on('renderSceneConfig', (sheet, element) => addLevelsTabCheckbox(sheet, element, ABSOLUTE_ELEVATION_FLAG));

// Tooltips, labels and HUDs are drawn again with the new base.
Hooks.on('updateScene', (scene, changes) => {
	const isToggled = foundry.utils.hasProperty(changes, `flags.f2e-grid-enhancements.${ABSOLUTE_ELEVATION_FLAG}`);
	if (isToggled && canvas?.ready && scene === canvas.scene) canvas.draw();
});

// A scene option: when a movement of a token on such a scene ends at an elevation on another of its levels, the token is moved
// to that level, as a Change Level region moves it. Only while the scene's levels stack one on the next (helpers/scene.js sequentialLevels), so every elevation has one level.

const AUTO_CHANGE_LEVEL_FLAG = 'auto-change-level';

Hooks.on('renderSceneConfig', addAutoChangeLevelOption);
Hooks.on('moveToken', changeLevelByElevation);

function addAutoChangeLevelOption(sheet, element) {
	const group = addLevelsTabCheckbox(sheet, element, AUTO_CHANGE_LEVEL_FLAG);
	if (!group || sequentialLevels(sheet.document)) return;
	const warning = document.createElement('p');
	warning.className = 'hint';
	warning.textContent = game.i18n.localize('f2e-grid-enhancements.general.scene.auto-change-level-unusable');
	group.append(warning);
}

// By the user who moved the token, once its movement is over and its animation done.
// The hook's movement has no state since 14.371; it is stopped when constrained and completed with nothing pending, as core
// decides it.
const isMovementFinished = movement => movement.constrained || movement.pending.waypoints.length === 0;

async function changeLevelByElevation(token, movement, operation, user) {
	if (!user.isSelf || !isMovementFinished(movement)) return;
	const scene = token.parent;
	if (!scene?.getFlag('f2e-grid-enhancements', AUTO_CHANGE_LEVEL_FLAG)) return;
	const levels = sequentialLevels(scene);
	if (!levels) return;
	if (token.rendered && token.object.movementAnimationPromise) await game.raceWithWindowHidden(token.object.movementAnimationPromise);
	// unless it moved on meanwhile
	if (token.movement.id !== movement.id) return;
	const level = levelAtElevation(levels, token._source.elevation);
	const originLevelId = token._source.level;
	if (!level || level.id === originLevelId) return;
	// a displacement: no movement cost, and no Change Level region asks again
	await token.move({level: level.id, action: 'displace'});
	// the GM's view follows the token, as for a Change Level region
	if (game.user.isGM && scene.isView && canvas.level?.id === originLevelId) await scene.view({level: level.id, controlledTokens: [token.id]});
}
