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
		layer: CONFIG.Region.layerClass.prototype,
	},
	functions: {
		placeRegion: foundry.canvas.layers.RegionLayer.prototype.placeRegion,
		_onDragLeftMove: foundry.canvas.layers.RegionLayer.prototype._onDragLeftMove,
	}
}

function patch_function(target_function_name) {
	const split = target_function_name.split('.');
	const base = split[2] + '_' + split[3] + '_' + split[4];
	libWrapper.register('f2e-grid-enhancements', target_function_name, function(wrapped, ...args) {
		if (grid[base] !== undefined) {
			return grid[base](wrapped, this, ...args);
		} else {
			return wrapped(...args);
		}
	}, 'MIXED');
	console.debug(game.i18n.localize('f2e-grid-enhancements.name') + ' | ' + target_function_name + (grid[base] !== undefined ? ' patched' : ' unpatched'));
}

async function review() {
	if (canvas?.ready && canvas.scene) {
		try {
			await canvas.draw(canvas.scene);
		} catch {}
	}
}

Hooks.once('libWrapper.Ready', () => {
	// [ hex & square & gridless ] Custom distance to measurement for 3D support
	patch_function('CONFIG.F2e.Token.object.distanceTo');
	// [ hex & square & gridless ] Custom chat template placement
	patch_function('CONFIG.F2e.Region.layer.placeRegion');
	// [ hex & square & gridless ] Custom chat template snap point
	patch_function('CONFIG.F2e.Region.object.snappingMode');
	// [ hex & square ] Rules accurate lines
	patch_function('CONFIG.F2e.Region.object._getCoveredGridSpaceOffsets');
	// [ hex & square & gridless ] Custom region point hacky support & Custom cone and line region rotation snapping
	patch_function('CONFIG.F2e.Region.layer._onDragLeftMove');
	// [ hex & square & gridless ] Custom flanking
	patch_function('CONFIG.F2e.Token.object.onOppositeSides');
	// [ hex & square & gridless ] Custom Reach enforcement support
	patch_function('CONFIG.F2e.Token.object._onClickLeft2');
	// Fix for shapes and timing issue when wrapping functions
	game.ready ? review() : Hooks.once('ready', review);
});

Hooks.once('init', () => {
	// setup settings
	game.settings.register('f2e-grid-enhancements', 'hex-cone-template-angle', {
		name: 'f2e-grid-enhancements.setting.hex-cone-template-angle-name',
		hint: 'f2e-grid-enhancements.setting.hex-cone-template-angle-hint',
		scope: 'world',
		config: true,
		type: new foundry.data.fields.NumberField({nullable: false, min: 5, max: 360, step: 5}),
		default: 60
	});
	game.settings.register('f2e-grid-enhancements', 'square-cone-template-angle', {
		name: 'f2e-grid-enhancements.setting.square-cone-template-angle-name',
		hint: 'f2e-grid-enhancements.setting.square-cone-template-angle-hint',
		scope: 'world',
		config: true,
		type: new foundry.data.fields.NumberField({nullable: false, min: 5, max: 360, step: 5}),
		default: 90
	});
	game.settings.register('f2e-grid-enhancements', 'gridless-cone-template-angle', {
		name: 'f2e-grid-enhancements.setting.gridless-cone-template-angle-name',
		hint: 'f2e-grid-enhancements.setting.gridless-cone-template-angle-hint',
		scope: 'world',
		config: true,
		type: new foundry.data.fields.NumberField({nullable: false, min: 5, max: 360, step: 5}),
		default: 90
	});
	game.settings.register('f2e-grid-enhancements', 'hex-cone-snapping-angle', {
		name: 'f2e-grid-enhancements.setting.hex-cone-snapping-angle-name',
		hint: 'f2e-grid-enhancements.setting.hex-cone-snapping-angle-hint',
		scope: 'world',
		config: true,
		type: new foundry.data.fields.NumberField({nullable: false, min: 0, max: 360, step: 5}),
		default: 30
	});
	game.settings.register('f2e-grid-enhancements', 'square-cone-snapping-angle', {
		name: 'f2e-grid-enhancements.setting.square-cone-snapping-angle-name',
		hint: 'f2e-grid-enhancements.setting.square-cone-snapping-angle-hint',
		scope: 'world',
		config: true,
		type: new foundry.data.fields.NumberField({nullable: false, min: 0, max: 360, step: 5}),
		default: 45
	});
	game.settings.register('f2e-grid-enhancements', 'gridless-cone-snapping-angle', {
		name: 'f2e-grid-enhancements.setting.gridless-cone-snapping-angle-name',
		hint: 'f2e-grid-enhancements.setting.gridless-cone-snapping-angle-hint',
		scope: 'world',
		config: true,
		type: new foundry.data.fields.NumberField({nullable: false, min: 0, max: 360, step: 5}),
		default: 15
	});
	game.settings.register('f2e-grid-enhancements', 'aura-collisions-highlight', {
		name: 'f2e-grid-enhancements.setting.aura-collisions-highlight-name',
		hint: 'f2e-grid-enhancements.setting.aura-collisions-highlight-hint',
		scope: 'world',
		config: true,
		type: new foundry.data.fields.BooleanField(),
		default: true
	});
	game.settings.register('f2e-grid-enhancements', 'line-region-padding', {
		name: 'f2e-grid-enhancements.setting.line-region-padding-name',
		hint: 'f2e-grid-enhancements.setting.line-region-padding-hint',
		scope: 'world',
		config: true,
		type: new foundry.data.fields.BooleanField(),
		default: false,
		requiresReload: true
	});
	game.settings.register('f2e-grid-enhancements', 'line-region-rectilinear-corners', {
		name: 'f2e-grid-enhancements.setting.line-region-rectilinear-corners-name',
		hint: 'f2e-grid-enhancements.setting.line-region-rectilinear-corners-hint',
		scope: 'world',
		config: true,
		type: new foundry.data.fields.BooleanField(),
		default: false,
		requiresReload: true
	});
	game.settings.register('f2e-grid-enhancements', 'default-grid-type', {
		name: 'f2e-grid-enhancements.setting.default-grid-type-name',
		hint: 'f2e-grid-enhancements.setting.default-grid-type-hint',
		scope: 'world',
		config: true,
		type: Number,
		choices: {
			0: 'SCENE.GridGridless',
			1: 'SCENE.GridSquare',
			2: 'SCENE.GridHexOddR',
			3: 'SCENE.GridHexEvenR',
			4: 'SCENE.GridHexOddQ',
			5: 'SCENE.GridHexEvenQ'
		},
		default: 1
	});
	game.settings.register('f2e-grid-enhancements', 'default-top-elevation', {
		name: 'f2e-grid-enhancements.setting.default-top-elevation-name',
		hint: 'f2e-grid-enhancements.setting.default-top-elevation-hint',
		scope: 'world',
		config: true,
		type: new foundry.data.fields.NumberField({nullable: true}),
		default: null
	});
	game.settings.register('f2e-grid-enhancements', 'default-bottom-elevation', {
		name: 'f2e-grid-enhancements.setting.default-bottom-elevation-name',
		hint: 'f2e-grid-enhancements.setting.default-bottom-elevation-hint',
		scope: 'world',
		config: true,
		type: new foundry.data.fields.NumberField({nullable: true}),
		default: null
	});
	game.settings.register('f2e-grid-enhancements', 'reach-exception', {
		name: 'f2e-grid-enhancements.setting.reach-exception-name',
		hint: 'f2e-grid-enhancements.setting.reach-exception-hint',
		scope: 'world',
		config: true,
		type: new foundry.data.fields.BooleanField(),
		default: true
	});
	game.settings.register('f2e-grid-enhancements', 'flanking-angle', {
		name: 'f2e-grid-enhancements.setting.flanking-angle-name',
		hint: 'f2e-grid-enhancements.setting.flanking-angle-hint',
		scope: 'world',
		config: true,
		type: new foundry.data.fields.NumberField({nullable: false, min: 0, max: 360, step: 5}),
		default: 135
	});
	game.settings.register('f2e-grid-enhancements', 'flanking-gridless-override', {
		name: 'f2e-grid-enhancements.setting.flanking-gridless-override-name',
		hint: 'f2e-grid-enhancements.setting.flanking-gridless-override-hint',
		scope: 'world',
		config: true,
		type: new foundry.data.fields.BooleanField(),
		default: false
	});
	game.settings.register('f2e-grid-enhancements', 'flanking-hex-override', {
		name: 'f2e-grid-enhancements.setting.flanking-hex-override-name',
		hint: 'f2e-grid-enhancements.setting.flanking-hex-override-hint',
		scope: 'world',
		config: true,
		type: new foundry.data.fields.BooleanField(),
		default: false
	});
	game.settings.register('f2e-grid-enhancements', 'flanking-square-override', {
		name: 'f2e-grid-enhancements.setting.flanking-square-override-name',
		hint: 'f2e-grid-enhancements.setting.flanking-square-override-hint',
		scope: 'world',
		config: true,
		type: new foundry.data.fields.BooleanField(),
		default: false
	});
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

// Custom template controls
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

const aura_patcher = foundry.utils.debounce((AuraRenderer, TokenAura) => {
	CONFIG.F2e.Aura = {
		renderer: AuraRenderer,
		token: TokenAura
	}
	// [ hex & gridless ] Aura highlighting
	patch_function('CONFIG.F2e.Aura.renderer.highlight');
	// [ hex & square & gridless ] Aura drawing
	patch_function('CONFIG.F2e.Aura.renderer.draw');
	// [ hex & square & gridless ] Aura contain token
	patch_function('CONFIG.F2e.Aura.token.containsToken');
	// [ hex & square & gridless ] Aura enable
	patch_function('CONFIG.F2e.Scene.document.canHaveAuras');
	// Fix for stale auras after wrapping functions
	review();
}, 100);

const aura_finding_hook = Hooks.on('refreshToken', (token, event) => {
	if (token.auras?.size > 0) {
		const aura = token.auras?.values().next().value;
		const document_aura = token.document.auras?.values().next().value;
		if (aura && document_aura) {
			aura_patcher(Object.getPrototypeOf(aura), Object.getPrototypeOf(document_aura));
			Hooks.off('refreshToken', aura_finding_hook);
		}
	}
});
