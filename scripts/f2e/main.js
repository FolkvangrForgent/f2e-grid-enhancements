import * as grid from './grid.js';
import * as refresh from './refresh.js';
import * as setting from '../setting.js';
import * as patch from '../patch.js';

CONFIG.F2e = {
	Token: {
		object: CONFIG.Token.objectClass.prototype,
		document: CONFIG.Token.documentClass.prototype,
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
		patch.add(target_function_name, grid[base]);
	} else {
		console.warn(`${game.i18n.localize('f2e-grid-enhancements.name')} | ${target_function_name} does not have patch function in grid.`);
	}
}

function patchRefresh(func) {
	patch.defer(() => {func()});
}

export function initialize() {
	// setting
	setting.register('f2e.hex.cone-template-angle', new foundry.data.fields.AngleField({
		required: true,
		persisted: true,
		nullable: false,
		initial: 60
	}));
	setting.register('f2e.square.cone-template-angle', new foundry.data.fields.AngleField({
		required: true,
		persisted: true,
		nullable: false,
		initial: 90
	}));
	setting.register('f2e.gridless.cone-template-angle', new foundry.data.fields.AngleField({
		required: true,
		persisted: true,
		nullable: false,
		initial: 90
	}));
	setting.register('f2e.hex.cone-snapping-angle', new foundry.data.fields.AngleField({
		required: true,
		persisted: true,
		nullable: false,
		initial: 30
	}));
	setting.register('f2e.square.cone-snapping-angle', new foundry.data.fields.AngleField({
		required: true,
		persisted: true,
		nullable: false,
		initial: 45
	}));
	setting.register('f2e.gridless.cone-snapping-angle', new foundry.data.fields.AngleField({
		required: true,
		persisted: true,
		nullable: false,
		initial: 15
	}));
	setting.register('f2e.aura.collisions-highlight', new foundry.data.fields.BooleanField({
		required: true,
		persisted: true,
		nullable: false,
		initial: true
	}), {onChange: () => refresh.tokens()});
	setting.register('f2e.aura.defeated-disable', new foundry.data.fields.BooleanField({
		required: true,
		persisted: true,
		nullable: false,
		initial: true
	}), {onChange: () => refresh.auras()});
	setting.register('f2e.square.line-region-padding',  new foundry.data.fields.BooleanField({
		required: true,
		persisted: true,
		nullable: false,
		initial: false
	}), {onChange: () => refresh.regions()});
	setting.register('f2e.square.line-region-rectilinear-corners',  new foundry.data.fields.BooleanField({
		required: true,
		persisted: true,
		nullable: false,
		initial: false
	}), {onChange: () => refresh.regions()});
	setting.register('f2e.reach-exception',  new foundry.data.fields.BooleanField({
		required: true,
		persisted: true,
		nullable: false,
		initial: true
	}));
	// TODO remove?
	setting.register('f2e.flanking.angle', new foundry.data.fields.AngleField({
		required: true,
		persisted: true,
		nullable: false,
		initial: 135
	}));
	setting.register('f2e.flanking.gridless-override',  new foundry.data.fields.BooleanField({
		required: true,
		persisted: true,
		nullable: false,
		initial: false
	}));
	setting.register('f2e.flanking.hex-override',  new foundry.data.fields.BooleanField({
		required: true,
		persisted: true,
		nullable: false,
		initial: false
	}));
	setting.register('f2e.flanking.square-override',  new foundry.data.fields.BooleanField({
		required: true,
		persisted: true,
		nullable: false,
		initial: false
	}));
	// hook
	// [ hex & square & gridless ] Custom flanking
	patchFunction('CONFIG.F2e.Token.object.onOppositeSides');
	// [ hex & square & gridless ] Custom distance to measurement for 3D support
	patchFunction('CONFIG.F2e.Token.object.distanceTo');
	// [ hex & square & gridless ] Reach enforcement support
	patchFunction('CONFIG.F2e.Token.object._onClickLeft2');
	// [ hex ] Tiny token snap points
	patchFunction('CONFIG.F2e.Token.document.getSnappedPosition');
	// [ hex & square & gridless ] Chat template snap point
	patchFunction('CONFIG.F2e.Region.object.snappingMode');
	// [ hex & square ] Rules accurate lines
	patchFunction('CONFIG.F2e.Region.object._getCoveredGridSpaceOffsets');
	// [ hex & square & gridless ] Chat template placement
	patchFunction('CONFIG.F2e.Region.layer.placeRegion');
	// [ hex & square & gridless ] Region cone and line rotation snapping & point support
	patchFunction('CONFIG.F2e.Region.layer._onDragLeftMove');
	// Refresh regions created before wrapping
	patchRefresh(refresh.regions);


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
		patchRefresh(refresh.tokens);
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
		if (effect.statuses.has(CONFIG.specialStatusEffects.DEFEATED) && setting.get('f2e.aura.defeated-disable')) {
			refresh.auras();
		}
	});

	// refresh auras when defeated disable is enabled
	Hooks.on('deleteActiveEffect', (effect) => {
		if (effect.statuses.has(CONFIG.specialStatusEffects.DEFEATED) && setting.get('f2e.aura.defeated-disable')) {
			refresh.auras();
		}
	});

	Hooks.on('getSceneControlButtons', (controls) => {
		// ensure canvas is ready and controls contain regions
		if (!canvas?.ready || !controls?.regions?.tools?.cone?.shapeData) {
			return;
		}
		// get and set cone angle from settings
		controls.regions.tools.cone.shapeData.angle = setting.get(`f2e.${canvas.grid.isHexagonal ? 'hex' : canvas.grid.isSquare ? 'square' : 'gridless'}.cone-template-angle`);
		const point = canvas.grid.isHexagonal ? 'hex' : canvas.grid.isSquare ? 'square' : 'point';
		controls.regions.tools.point = {
			name: 'point',
			order: 8,
			creation: true,
			control: !canvas.regions?.templateMode,
			shapeData: {type: 'circle', x: 0, y: 0, radius: 0},
			title: `f2e-grid-enhancements.f2e.region.${point}`,
			icon: {hex: 'fa-solid fa-hexagon', square: 'fa-solid fa-square', point: 'fa-solid fa-circle'}[point],
			toolclip: {
				heading: `f2e-grid-enhancements.f2e.region.${point}`,
				items: foundry.applications.ui.SceneControls.buildToolclipItems([
					!canvas.regions?.templateMode ? {paragraph: 'CONTROLS.RegionShape'} : '',
					'draw',
					!canvas.regions?.templateMode ? {paragraph: 'CONTROLS.RegionPerformance'} : ''
				])
			}
		}
	});
}
