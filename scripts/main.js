import * as grid from './grid.js';

CONFIG.F2e = {
	Token: {
		object: CONFIG.Token.objectClass.prototype,
	},
	Scene: {
		document: CONFIG.Scene.documentClass.prototype,
	},
	Region: {
		object: CONFIG.Region.objectClass.prototype,
		layer: CONFIG.Canvas.layers.regions.layerClass.prototype,
	}
}

function patchFunction(target_function_name) {
	const split = target_function_name.split('.');
	const base = split[2] + '_' + split[3] + '_' + split[4];
	if (grid[base] !== undefined) {
		libWrapper.register('f2e-grid-enhancements', target_function_name, function(wrapped, ...args) {
			try {
				return grid[base](wrapped, this, ...args);
			} catch (error) {
				console.error(game.i18n.localize('f2e-grid-enhancements.name') + ' | ' + target_function_name + ' errored');
				console.error(error);
				return wrapped(...args);
			}
		}, 'MIXED');
		console.info(game.i18n.localize('f2e-grid-enhancements.name') + ' | ' + target_function_name + ' patched');
	} else {
		console.warn(game.i18n.localize('f2e-grid-enhancements.name') + ' | ' + target_function_name + ' unpatched');
	}
}

function refreshRegions() {
	if (deferCallback(refreshRegions)) return;
	for (const region of canvas.regions?.placeables ?? []) {
		region.renderFlags.set({redraw: true});
	}
}

function refreshTokens() {
	if (deferCallback(refreshTokens)) return;
	for (const token of canvas.tokens?.placeables ?? []) {
		if (token.document.auras?.size) {
			token.renderFlags.set({redraw: true});
		}
	}
}

let refreshAurasRunning = false;
let refreshAurasPending = false;
const refreshAuras = foundry.utils.debounce(async () => {
	if (deferCallback(refreshAuras)) return;
	if (!canvas.scene) return;
	if (refreshAurasRunning) {
		refreshAurasPending = true;
		return;
	} else {
		refreshAurasRunning = true;
	}
	try {
		for (const tokenDocument of canvas.scene.tokens) {
			if (!tokenDocument.auras?.size) continue;
			tokenDocument.object?.renderFlags.set({redraw: true});
			for (const aura of tokenDocument.auras.values()) {
				await aura.notifyActors();
			}
		}
		// remove removeOnExit effects from actors: logic from `checkAreaEffects` helper
		for (const actor of new Set(canvas.scene.tokens.map((tokenDocument) => tokenDocument.actor).filter(Boolean))) {
			if (actor.primaryUpdater !== game.user || actor.isOfType('party')) continue;
			const actorTokens = actor.getActiveTokens(true, true);
			const expired = [];
			for (const effect of actor.itemTypes.effect) {
				const auraData = effect.flags?.[game.system.id]?.aura;
				if (!auraData?.removeOnExit) continue;
				const aura_actor = await fromUuid(auraData.origin);
				const aura = aura_actor?.getActiveTokens(true, true)[0]?.auras.get(auraData.slug);
				const still_applies = aura_actor?.auras.get(auraData.slug)?.effects.some((e) => e.uuid === effect.sourceId);
				if (!still_applies || !actorTokens.some((tokenDocument) => aura?.containsToken(tokenDocument))) {
					expired.push(effect.id);
				}
			}
			if (expired.length > 0) {
				await actor.deleteEmbeddedDocuments('Item', expired);
			}
		}
	} finally {
		refreshAurasRunning = false;
		if (refreshAurasPending) {
			refreshAurasPending = false;
			refreshAuras();
		}
	}
}, 100);

const deferCallbacks = new Set();
function deferCallback(callback) {
	if (canvas?.ready && !canvas.loading) {
		return false;
	}
	if (!deferCallbacks.has(callback)) {
		deferCallbacks.add(callback);
		Hooks.once('canvasReady', () => {
			deferCallbacks.delete(callback);
			callback();
		});
	}
	return true;
}

Hooks.once('libWrapper.Ready', () => {
	// [ hex & square & gridless ] Custom distance to measurement for 3D support
	patchFunction('CONFIG.F2e.Token.object.distanceTo');
	// [ hex & square & gridless ] Custom chat template placement
	patchFunction('CONFIG.F2e.Region.layer.placeRegion');
	// [ hex & square & gridless ] Custom chat template snap point
	patchFunction('CONFIG.F2e.Region.object.snappingMode');
	// [ hex & square ] Rules accurate lines
	patchFunction('CONFIG.F2e.Region.object._getCoveredGridSpaceOffsets');
	// [ hex & square & gridless ] Custom region point hacky support & Custom cone and line region rotation snapping
	patchFunction('CONFIG.F2e.Region.layer._onDragLeftMove');
	// [ hex & square & gridless ] Custom flanking
	patchFunction('CONFIG.F2e.Token.object.onOppositeSides');
	// [ hex & square & gridless ] Custom Reach enforcement support
	patchFunction('CONFIG.F2e.Token.object._onClickLeft2');
	// Refresh regions created before wrapping
	game.ready ? refreshRegions() : Hooks.once('ready', refreshRegions);
});

function registerSetting(key, type, value, extra = {}) {
	game.settings.register('f2e-grid-enhancements', key, {
		name: `f2e-grid-enhancements.setting.${key}.name`,
		hint: `f2e-grid-enhancements.setting.${key}.hint`,
		scope: 'world',
		config: true,
		type,
		default: value,
		...extra
	});
}

const angleField = (min) => new foundry.data.fields.NumberField({nullable: false, min, max: 360, step: 5});
const booleanField = () => new foundry.data.fields.BooleanField();
const nullableNumberField = () => new foundry.data.fields.NumberField({nullable: true});

Hooks.once('init', () => {
	// setup settings
	registerSetting('hex-cone-template-angle', angleField(5), 60, {requiresReload: true});
	registerSetting('square-cone-template-angle', angleField(5), 90, {requiresReload: true});
	registerSetting('gridless-cone-template-angle', angleField(5), 90, {requiresReload: true});
	registerSetting('hex-cone-snapping-angle', angleField(0), 30);
	registerSetting('square-cone-snapping-angle', angleField(0), 45);
	registerSetting('gridless-cone-snapping-angle', angleField(0), 15);
	registerSetting('aura-collisions-highlight', booleanField(), true, {onChange: () => refreshTokens()});
	registerSetting('aura-defeated-disable', booleanField(), true, {onChange: () => refreshAuras()});
	registerSetting('line-region-padding', booleanField(), false, {onChange: () => refreshRegions()});
	registerSetting('line-region-rectilinear-corners', booleanField(), false, {onChange: () => refreshRegions()});
	registerSetting('reach-exception', booleanField(), true);
	registerSetting('default-top-elevation', nullableNumberField(), null);
	registerSetting('default-bottom-elevation', nullableNumberField(), null);
	registerSetting('default-grid-type', Number, 1, {
		choices: {
			0: 'SCENE.GridGridless',
			1: 'SCENE.GridSquare',
			2: 'SCENE.GridHexOddR',
			3: 'SCENE.GridHexEvenR',
			4: 'SCENE.GridHexOddQ',
			5: 'SCENE.GridHexEvenQ'
		}
	});
	registerSetting('flanking-angle', angleField(0), 135);
	registerSetting('flanking-gridless-override', booleanField(), false);
	registerSetting('flanking-hex-override', booleanField(), false);
	registerSetting('flanking-square-override', booleanField(), false);
	// expose api
	game.modules.get('f2e-grid-enhancements').api = Object.freeze({raycast: grid.raycast});
});

// setup new scene having unbounded elevations
Hooks.on("preCreateScene", (scene, data, options, userId) => {
	if (game.user.id !== userId) return;
	const updates = {};
	if (data.grid?.type === undefined) {
		updates['grid.type'] = game.settings.get('f2e-grid-enhancements', 'default-grid-type');
	}
	if (!data.levels?.length) {
		const elevation = {
			bottom: game.settings.get('f2e-grid-enhancements', 'default-bottom-elevation'),
			top: game.settings.get('f2e-grid-enhancements', 'default-top-elevation')
		};
		const existing = scene.toObject().levels ?? [];
		if (existing.length) {
			updates.levels = existing.map((level, i) =>
				i === 0 ? { ...level, elevation: { ...level.elevation, ...elevation } } : level
			);
		} else {
			updates.levels = [{
				_id: foundry.utils.randomID(),
				name: 'Level',
				elevation
			}];
		}
	}
	if (!foundry.utils.isEmpty(updates)) {
		scene.updateSource(updates);
	}
});

Hooks.on('getSceneControlButtons', (controls) => {
	// ensure canvas is ready and controls contain regions
	if (!canvas?.ready || !controls?.regions?.tools?.cone?.shapeData) {
		return;
	}
	// get and set cone angle from settings
	controls.regions.tools.cone.shapeData.angle = game.settings.get('f2e-grid-enhancements', `${canvas.grid.isHexagonal ? 'hex' : canvas.grid.isSquare ? 'square' : 'gridless'}-cone-template-angle`);
	const point = canvas.grid.isHexagonal ? 'hex' : canvas.grid.isSquare ? 'square' : 'point';
	controls.regions.tools.point = {
		name: 'point',
		order: 8,
		creation: true,
		control: !canvas.regions?.templateMode,
		shapeData: {type: 'circle', x: 0, y: 0, radius: 0},
		title: `f2e-grid-enhancements.region.${point}`,
		icon: {hex: 'fa-solid fa-hexagon', square: 'fa-solid fa-square', point: 'fa-solid fa-circle'}[point],
		toolclip: {
			heading: `f2e-grid-enhancements.region.${point}`,
			items: foundry.applications.ui.SceneControls.buildToolclipItems([
				!canvas.regions?.templateMode ? {paragraph: 'CONTROLS.RegionShape'} : '',
				'draw',
				!canvas.regions?.templateMode ? {paragraph: 'CONTROLS.RegionPerformance'} : ''
			])
		}
	}
});

const auraPatcher = foundry.utils.debounce((AuraRenderer, TokenAura) => {
	CONFIG.F2e.Aura = {
		renderer: AuraRenderer,
		token: TokenAura
	}
	// [ hex & gridless ] Aura highlighting
	patchFunction('CONFIG.F2e.Aura.renderer.highlight');
	// [ hex & square & gridless ] Aura drawing
	patchFunction('CONFIG.F2e.Aura.renderer.draw');
	// [ hex & square & gridless ] Aura contain token
	patchFunction('CONFIG.F2e.Aura.token.containsToken');
	// [ hex & square & gridless ] Aura enable
	patchFunction('CONFIG.F2e.Scene.document.canHaveAuras');
	// refresh auras now that they are patched
	refreshTokens();
}, 100);

const auraFinderHook = Hooks.on('refreshToken', (token, event) => {
	if (token.auras?.size > 0) {
		const aura = token.auras?.values().next().value;
		const document_aura = token.document.auras?.values().next().value;
		if (aura && document_aura) {
			auraPatcher(Object.getPrototypeOf(aura), Object.getPrototypeOf(document_aura));
			Hooks.off('refreshToken', auraFinderHook);
		}
	}
});

// refresh auras when defeated disable is enabled
Hooks.on('createActiveEffect', (effect) => {
	if (effect.statuses.has(CONFIG.specialStatusEffects.DEFEATED) && game.settings.get('f2e-grid-enhancements', 'aura-defeated-disable')) {
		refreshAuras();
	}
});

// refresh auras when defeated disable is enabled
Hooks.on('deleteActiveEffect', (effect) => {
	if (effect.statuses.has(CONFIG.specialStatusEffects.DEFEATED) && game.settings.get('f2e-grid-enhancements', 'aura-defeated-disable')) {
		refreshAuras();
	}
});
