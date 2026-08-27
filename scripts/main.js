import * as all from './grid/all.js';
import * as hex from './grid/hex.js';
import * as square from './grid/square.js';
import * as gridless from './grid/gridless.js';

CONFIG.F2e = {
	Token: {
		object: CONFIG.Token.objectClass.prototype,
	},
	Scene: {
		document: CONFIG.Scene.documentClass.prototype,
	},
	Region: {
		layer: CONFIG.Canvas.layers.regions.layerClass.prototype,
		object: CONFIG.Region.objectClass.prototype,
		layerFoundry: Object.getPrototypeOf(CONFIG.Canvas.layers.regions.layerClass).prototype,
	}
}

function patch_function(target_function_name) {
	const split = target_function_name.split('.');
	const base = split[2] + '_' + split[3] + '_' + split[4];
	libWrapper.register('f2e-grid-enhancements', target_function_name, function(wrapped, ...args) {
		if (!canvas?.ready || !canvas?.grid) {
			return wrapped(...args);
		}
		if (canvas.grid.isHexagonal) {
			if (hex[base] !== undefined) {
				return hex[base](wrapped, this, ...args);
			} else {
				if (all[base] !== undefined) {
					return all[base](wrapped, this, ...args);
				} else {
					return wrapped(...args);
				}
			}
		} else if (canvas.grid.isGridless) {
			if (gridless[base] !== undefined) {
				return gridless[base](wrapped, this, ...args);
			} else {
				if (all[base] !== undefined) {
					return all[base](wrapped, this, ...args);
				} else {
					return wrapped(...args);
				}
			}
		} else if (canvas.grid.isSquare) {
			if (square[base] !== undefined) {
				return square[base](wrapped, this, ...args);
			} else {
				if (all[base] !== undefined) {
					return all[base](wrapped, this, ...args);
				} else {
					return wrapped(...args);
				}
			}
		} else {
			if (all[base] !== undefined) {
				return all[base](wrapped, this, ...args);
			} else {
				return wrapped(...args);
			}
		}
	}, 'MIXED');
	console.debug(game.i18n.localize('f2e-grid-enhancements.name') + ' | ' + target_function_name + ' patched for ' + [(hex[base] ? 'hex' : undefined), (gridless[base] ? 'gridless' : undefined), (square[base] ? 'square' : undefined), (all[base] ? 'all' : undefined)].filter(e => e !== undefined));
}

async function review() {
	if (game?.scenes?.active !== undefined) {
		try {
			await game.scenes.active.unview();
			await game.scenes.active.view();
		} catch (e) {}
	}
}

Hooks.once('libWrapper.Ready', () => {
	// [ hex & square & gridless ] Custom distance to measurement for 3D support
	patch_function('CONFIG.F2e.Token.object.distanceTo');
	// [ hex & square & gridless ] Custom chat template placement
	patch_function('CONFIG.F2e.Region.layerFoundry.placeRegion');
	// [ hex & square & gridless ] Custom chat template snap point
	patch_function('CONFIG.F2e.Region.object.snappingMode');
	// [ hex & square & gridless ] Custom region point hacky support & Custom cone and line region rotation snapping
	patch_function('CONFIG.F2e.Region.layerFoundry._onDragLeftMove');
	// [ hex & square & gridless ] Automatic emanation placement
	patch_function('CONFIG.F2e.Region.layer._createDragShapeData');
	// [ gridless ] Fix hover ruler
	patch_function('CONFIG.F2e.Token.object.localShape');
	// [ hex & square & gridless ] Custom flanking
	patch_function('CONFIG.F2e.Token.object.onOppositeSides');
	// Fix for shapes and timing issue when wrapping functions
	if (game.ready) {
		review();
	} else {
		Hooks.once('ready', async function () {
			review();
		});
	}
});

// Module settings
Hooks.once('init', () => {
	// setup settings
	game.settings.register('f2e-grid-enhancements', 'hex-cone-template-angle', {
		name: 'f2e-grid-enhancements.setting.hex-cone-template-angle-name',
		hint: 'f2e-grid-enhancements.setting.hex-cone-template-angle-hint',
		scope: 'world',
		config: true,
		type: new foundry.data.fields.NumberField({nullable: false, min: 0, max: 360, step: 5}),
		default: 60
	});
	game.settings.register('f2e-grid-enhancements', 'square-cone-template-angle', {
		name: 'f2e-grid-enhancements.setting.square-cone-template-angle-name',
		hint: 'f2e-grid-enhancements.setting.square-cone-template-angle-hint',
		scope: 'world',
		config: true,
		type: new foundry.data.fields.NumberField({nullable: false, min: 0, max: 360, step: 5}),
		default: 90
	});
	game.settings.register('f2e-grid-enhancements', 'gridless-cone-template-angle', {
		name: 'f2e-grid-enhancements.setting.gridless-cone-template-angle-name',
		hint: 'f2e-grid-enhancements.setting.gridless-cone-template-angle-hint',
		scope: 'world',
		config: true,
		type: new foundry.data.fields.NumberField({nullable: false, min: 0, max: 360, step: 5}),
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
		default: 1,
		requiresReload: true
	});
	// setup default grid
	game.system.grid = {type: game.settings.get('f2e-grid-enhancements', 'default-grid-type'), distance: 5, units: 'ft', diagonals: 4}
});



// Custom template controls (requires CONFIG.F2e.MeasuredTemplate.layer._onDragLeftStart patch to function properly)
Hooks.on("getSceneControlButtons", (controls) => {
	// ensure canvas is ready and controls contain regions
	if (!canvas?.ready || !controls?.regions?.tools?.cone?.shapeData) {
		return;
	}
	// get and set cone angle from settings
	try {
		if (canvas?.grid?.isGridless) {
			controls.regions.tools.cone.shapeData.angle = game.settings.get('f2e-grid-enhancements', 'gridless-cone-template-angle');
		} else if (canvas?.grid?.isHexagonal) {
			controls.regions.tools.cone.shapeData.angle = game.settings.get('f2e-grid-enhancements', 'hex-cone-template-angle');
		} else if (canvas?.grid?.isSquare) {
			controls.regions.tools.cone.shapeData.angle = game.settings.get('f2e-grid-enhancements', 'square-cone-template-angle');
		} else {
			controls.regions.tools.cone.shapeData.angle = CONFIG.MeasuredTemplate.defaults.angle;
		}
	} catch {
		controls.regions.tools.cone.shapeData.angle = CONFIG.MeasuredTemplate.defaults.angle;
	}
	controls.regions.tools.point = {
		name: "point",
		order: 8,
		creation: true,
		control: !canvas.regions?.templateMode,
		shapeData: {type: "circle", x: 0, y: 0, radius: 0},
		title: canvas.grid.isHexagonal ? "f2e-grid-enhancements.region.hex" : canvas.grid.isSquare ? "f2e-grid-enhancements.region.square" : "f2e-grid-enhancements.region.point",
		icon: canvas.grid.isHexagonal ? "fa-solid fa-hexagon" : canvas.grid.isSquare ? "fa-solid fa-square" : "fa-solid fa-circle",
		toolclip: {
			heading: canvas.grid.isHexagonal ? "f2e-grid-enhancements.region.hex" : canvas.grid.isSquare ? "f2e-grid-enhancements.region.square" : "f2e-grid-enhancements.region.point",
			items: foundry.applications.ui.SceneControls.buildToolclipItems([
				!canvas.regions?.templateMode ? {paragraph: "CONTROLS.RegionShape"} : "",
				"draw",
				!canvas.regions?.templateMode ? {paragraph: "CONTROLS.RegionPerformance"} : ""
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
	// [ hex & gridless ] Aura enable
	patch_function('CONFIG.F2e.Scene.document.canHaveAuras');
}, 100);

// TODO is this the best hook? pretty sure this only happens after canvas ready which is helpfull at least
const aura_finding_hook = Hooks.on("refreshToken", (token, event) => {
	if (token.auras.size > 0) {
		const AuraRenderer = Object.getPrototypeOf(token.auras.entries().next().value[1])
		const TokenAura = Object.getPrototypeOf(token.document.auras.entries().next().value[1])
		if (AuraRenderer && TokenAura) {
			aura_patcher(AuraRenderer, TokenAura);
			Hooks.off("refreshToken", aura_finding_hook);
		}
	} else {
		return;
	}
});

// TODO grid agnostic target helper with v2 application
