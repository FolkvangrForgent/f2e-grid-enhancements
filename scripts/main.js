import * as distance from './distance.js';
import * as grid from './grid.js';
import * as raycast from './raycast.js';
import * as refresh from './refresh.js';
import * as setting from './setting.js';

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
	refresh.regions();
});

Hooks.once('init', () => {
	// setup settings
	const angleField = (min) => new foundry.data.fields.NumberField({nullable: false, min, max: 360, step: 5});
	const booleanField = () => new foundry.data.fields.BooleanField();
	const nullableNumberField = () => new foundry.data.fields.NumberField({nullable: true});
	setting.register('hex-cone-template-angle', angleField(5), 60, {requiresReload: true});
	setting.register('square-cone-template-angle', angleField(5), 90, {requiresReload: true});
	setting.register('gridless-cone-template-angle', angleField(5), 90, {requiresReload: true});
	setting.register('hex-cone-snapping-angle', angleField(0), 30);
	setting.register('square-cone-snapping-angle', angleField(0), 45);
	setting.register('gridless-cone-snapping-angle', angleField(0), 15);
	setting.register('aura-collisions-highlight', booleanField(), true, {onChange: () => refresh.tokens()});
	setting.register('aura-defeated-disable', booleanField(), true, {onChange: () => refresh.auras()});
	setting.register('line-region-padding', booleanField(), false, {onChange: () => refresh.regions()});
	setting.register('line-region-rectilinear-corners', booleanField(), false, {onChange: () => refresh.regions()});
	setting.register('reach-exception', booleanField(), true);
	setting.register('default-top-elevation', nullableNumberField(), null);
	setting.register('default-bottom-elevation', nullableNumberField(), null);
	setting.register('default-grid-type', Number, 1, {
		choices: {
			0: 'SCENE.GridGridless',
			1: 'SCENE.GridSquare',
			2: 'SCENE.GridHexOddR',
			3: 'SCENE.GridHexEvenR',
			4: 'SCENE.GridHexOddQ',
			5: 'SCENE.GridHexEvenQ'
		}
	});
	setting.register('flanking-angle', angleField(0), 135);
	setting.register('flanking-gridless-override', booleanField(), false);
	setting.register('flanking-hex-override', booleanField(), false);
	setting.register('flanking-square-override', booleanField(), false);
	// expose api
	game.modules.get('f2e-grid-enhancements').api = Object.freeze({raycast: raycast.raycast, distance: distance.distance});
});

Hooks.on("preCreateScene", (scene, data, options, userId) => {
	if (game.user.id !== userId) return;
	const updates = {};
	if (data.grid?.type === undefined) {
		updates['grid.type'] = setting.get('default-grid-type');
	}
	if (!data.levels?.length) {
		const elevation = {
			bottom: setting.get('default-bottom-elevation'),
			top: setting.get('default-top-elevation')
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
	controls.regions.tools.cone.shapeData.angle = setting.get(`${canvas.grid.isHexagonal ? 'hex' : canvas.grid.isSquare ? 'square' : 'gridless'}-cone-template-angle`);
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
	refresh.tokens();
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
	if (effect.statuses.has(CONFIG.specialStatusEffects.DEFEATED) && setting.get('aura-defeated-disable')) {
		refresh.auras();
	}
});

// refresh auras when defeated disable is enabled
Hooks.on('deleteActiveEffect', (effect) => {
	if (effect.statuses.has(CONFIG.specialStatusEffects.DEFEATED) && setting.get('aura-defeated-disable')) {
		refresh.auras();
	}
});
