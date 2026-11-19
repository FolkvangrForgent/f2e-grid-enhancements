import {gridString} from '../../helpers/grid.js';
import * as patch from '../../helpers/patch.js';
import * as setting from '../../helpers/setting.js';
import * as auras from './auras.js';
import * as refresh from './refresh.js';
import * as regions from './regions.js';
import * as settings from './settings.js';
import * as tokens from './tokens.js';

const patchFunctionsByName = {...tokens, ...regions, ...auras};

CONFIG.F2e = {
	Token: {
		object: CONFIG.Token.objectClass.prototype,
		document: CONFIG.Token.documentClass.prototype
	},
	Scene: {
		document: CONFIG.Scene.documentClass.prototype
	},
	Region: {
		object: CONFIG.Region.objectClass.prototype,
		layer: CONFIG.Canvas.layers.regions.layerClass.prototype
	}
};

function patchFunction(targetPath) {
	const [, , group, kind, method] = targetPath.split('.');
	const patchFunctionName = `${group}_${kind}_${method}`;
	if (patchFunctionsByName[patchFunctionName] !== undefined) {
		patch.add(targetPath, patchFunctionsByName[patchFunctionName]);
	} else {
		console.warn(`${game.i18n.localize('f2e-grid-enhancements.name')} | ${targetPath} does not have a patch function.`);
	}
}

export function initialize() {
	settings.register();
	tokens.initialize();
	// [ hex & square & gridless ] Token size enforcement, before core records the change as movement
	patchFunction('CONFIG.F2e.Token.document._preUpdate');
	// [ hex & square & gridless ] Dimentsion enforcement
	patchFunction('CONFIG.F2e.Token.document.applyActiveEffects');
	// [ hex & square & gridless ] Custom distance to measurement for 3D support
	patchFunction('CONFIG.F2e.Token.object.distanceTo');
	// [ hex & square & gridless ] Reach enforcement support
	patchFunction('CONFIG.F2e.Token.object._onClickLeft2');
	// [ hex ] Tiny token snap points
	patchFunction('CONFIG.F2e.Token.document.getSnappedPosition');
	// [ hex & square & gridless ] Chat template snap point
	patchFunction('CONFIG.F2e.Region.object.snappingMode');
	// [ hex & square & gridless ] Chat template placement
	patchFunction('CONFIG.F2e.Region.layer.placeRegion');
	// [ hex & square & gridless ] Region cone and line rotation snapping
	patchFunction('CONFIG.F2e.Region.layer._onDragLeftMove');
	// The system's aura classes are not exported, so they are taken from the first token with an aura.
	const patchAuras = foundry.utils.debounce((AuraRenderer, TokenAura) => {
		CONFIG.F2e.Aura = {
			renderer: AuraRenderer,
			token: TokenAura
		};
		// [ hex & gridless ] Aura highlighting
		patchFunction('CONFIG.F2e.Aura.renderer.highlight');
		// [ hex & square & gridless ] Aura drawing
		patchFunction('CONFIG.F2e.Aura.renderer.draw');
		// [ hex & square & gridless ] Aura texture position
		patchFunction('CONFIG.F2e.Aura.renderer.repositionTexture');
		// [ hex & square & gridless ] Aura contain token
		patchFunction('CONFIG.F2e.Aura.token.containsToken');
		// [ hex & square & gridless ] Aura enable
		patchFunction('CONFIG.F2e.Scene.document.canHaveAuras');
		// refrsh visuals of auras
		patch.defer(refresh.tokens);
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
	const refreshAurasIfDefeatDisables = () => {
		if (setting.get('f2e.aura.defeated-disable')) refresh.auras();
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
	Hooks.on('getSceneControlButtons', controls => {
		if (!canvas?.ready || !controls?.regions?.tools?.cone?.shapeData) return;
		controls.regions.tools.cone.shapeData.angle = setting.get(`f2e.${gridString(canvas.grid)}.cone-template-angle`);
	});
}
