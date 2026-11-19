import {gridString} from '../helpers/grid.js';
import * as patch from '../helpers/patch.js';
import * as setting from '../helpers/setting.js';
import * as auras from './auras.js';
import * as regions from './regions.js';
import * as tokens from './tokens.js';

// libWrapper targets: the classes the system configures
const TOKEN_DOCUMENT = 'CONFIG.Token.documentClass.prototype';
const TOKEN_OBJECT = 'CONFIG.Token.objectClass.prototype';
const REGION_OBJECT = 'CONFIG.Region.objectClass.prototype';
const REGION_LAYER = 'CONFIG.Canvas.layers.regions.layerClass.prototype';

export function initialize() {
	registerSettings();
	tokens.initialize();
	// [ hex & square & gridless ] Token size enforcement, before core records the change as movement
	patch.add(`${TOKEN_DOCUMENT}._preUpdate`, tokens.enforceTokenSize);
	// [ hex & square & gridless ] Dimension enforcement
	patch.add(`${TOKEN_DOCUMENT}.applyActiveEffects`, tokens.enforceEffectDimensions);
	// [ hex & square & gridless ] Custom distance to measurement for 3D support
	patch.add(`${TOKEN_OBJECT}.distanceTo`, tokens.measureTokenDistance);
	// [ hex & square & gridless ] Reach enforcement support
	patch.add(`${TOKEN_OBJECT}._onClickLeft2`, tokens.openTokenWithinReach);
	// [ hex ] Tiny token snap points
	patch.add(`${TOKEN_DOCUMENT}.getSnappedPosition`, tokens.snapTinyToken);
	// [ hex & square & gridless ] Chat template snap point
	patch.add(`${REGION_OBJECT}.snappingMode`, regions.templateSnappingMode);
	// [ hex & square & gridless ] Chat template placement
	patch.add(`${REGION_LAYER}.placeRegion`, regions.placeChatTemplate);
	// [ hex & square & gridless ] Region cone and line rotation snapping
	patch.add(`${REGION_LAYER}._onDragLeftMove`, regions.snapTemplateRotation);
	patchAurasOnceFound();
	redrawAurasWhenDefeatChanges();
	redoCoverageWhenBarrierEdgesChange();
	Hooks.on('getSceneControlButtons', controls => {
		if (!canvas?.ready || !controls?.regions?.tools?.cone?.shapeData) return;
		controls.regions.tools.cone.shapeData.angle = setting.get(`f2e.${gridString(canvas.grid)}.cone-template-angle`);
	});
}

function patchAurasOnceFound() {
	// The system's aura classes are not exported, so their prototypes are taken from the first token with an aura and
	// wrapped directly (libWrapper only wraps what a global path reaches).
	const patchAuras = foundry.utils.debounce((rendererPrototype, tokenAuraPrototype) => {
		// [ hex & gridless ] Aura highlighting
		patch.method(rendererPrototype, 'highlight', 'AuraRenderer#highlight', auras.highlightAura);
		// [ hex & square & gridless ] Aura drawing
		patch.method(rendererPrototype, 'draw', 'AuraRenderer#draw', auras.drawAura);
		// [ hex & square & gridless ] Aura texture position
		patch.method(rendererPrototype, 'repositionTexture', 'AuraRenderer#repositionTexture', auras.positionAuraTexture);
		// [ hex & square & gridless ] Aura contain token
		patch.method(tokenAuraPrototype, 'containsToken', 'TokenAura#containsToken', auras.auraContainsToken);
		// [ hex & square & gridless ] Aura enable
		patch.add('CONFIG.Scene.documentClass.prototype.canHaveAuras', auras.allowAuras);
		// refresh visuals of auras
		patch.defer(auras.redrawTokensWithAuras);
	}, 100);
	const findAurasHook = Hooks.on('refreshToken', token => {
		if (!(token.auras?.size > 0)) return;
		const renderer = token.auras.values().next().value;
		const tokenAura = token.document.auras?.values().next().value;
		if (renderer && tokenAura) {
			patchAuras(Object.getPrototypeOf(renderer), Object.getPrototypeOf(tokenAura));
			Hooks.off('refreshToken', findAurasHook);
		}
	});
}

function redrawAurasWhenDefeatChanges() {
	const refreshAurasIfDefeatDisables = () => {
		if (setting.get('f2e.aura.defeated-disable')) auras.redrawAuras();
	};
	for (const hook of ['createActiveEffect', 'deleteActiveEffect']) {
		Hooks.on(hook, effect => {
			if (effect.statuses.has(CONFIG.specialStatusEffects.DEFEATED)) refreshAurasIfDefeatDisables();
		});
	}
	Hooks.on('updateCombatant', (combatant, changes) => {
		if ('defeated' in changes) refreshAurasIfDefeatDisables();
	});
	Hooks.on('updateActor', (actor, changes) => {
		if (foundry.utils.hasProperty(changes, 'system.attributes.hp')) refreshAurasIfDefeatDisables();
	});
}

function redoCoverageWhenBarrierEdgesChange() {
	// Barrier side edges (region/barrier-core.js) cut a measured area's line of effect as walls do, so they redo its coverage as the
	// system does when a wall changes (WallDocumentPF2e#onEdgeChange).
	Hooks.on('f2eGridEnhancements.barrierEdgesChanged', scene => {
		if (scene !== canvas.scene) return;
		const areas = scene.regions.filter(region => region.isMeasuredArea);
		if (!areas.length) return;
		for (const area of areas) {
			area.clearCoverage?.();
			area.object?.renderFlags.set({refreshGeometry: true});
		}
		if (game.user.isActiveGM) scene.updateTokenRegions();
	});
}

function registerSettings() {
	setting.register(
		'f2e.hex.cone-template-angle',
		new foundry.data.fields.AngleField({
			required: true,
			persisted: true,
			nullable: false,
			initial: 60
		})
	);
	setting.register(
		'f2e.square.cone-template-angle',
		new foundry.data.fields.AngleField({
			required: true,
			persisted: true,
			nullable: false,
			initial: 90
		})
	);
	setting.register(
		'f2e.gridless.cone-template-angle',
		new foundry.data.fields.AngleField({
			required: true,
			persisted: true,
			nullable: false,
			initial: 90
		})
	);
	setting.register(
		'f2e.hex.cone-snapping-angle',
		new foundry.data.fields.AngleField({
			required: true,
			persisted: true,
			nullable: false,
			initial: 30
		})
	);
	setting.register(
		'f2e.square.cone-snapping-angle',
		new foundry.data.fields.AngleField({
			required: true,
			persisted: true,
			nullable: false,
			initial: 45
		})
	);
	setting.register(
		'f2e.gridless.cone-snapping-angle',
		new foundry.data.fields.AngleField({
			required: true,
			persisted: true,
			nullable: false,
			initial: 15
		})
	);
	setting.register(
		'f2e.aura.defeated-disable',
		new foundry.data.fields.BooleanField({
			required: true,
			persisted: true,
			nullable: false,
			initial: true
		}),
		{
			onChange: () => auras.redrawAuras()
		}
	);
	setting.register(
		'f2e.reach-exception',
		new foundry.data.fields.BooleanField({
			required: true,
			persisted: true,
			nullable: false,
			initial: true
		})
	);
}
