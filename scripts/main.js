import * as all from './grid/all.js';
import * as hex from './grid/hex.js';
import * as square from './grid/square.js';
import * as gridless from './grid/gridless.js';

CONFIG.F2e = {
	Token: {
		object: CONFIG.Token.objectClass.prototype,
		document: CONFIG.Token.documentClass.prototype
	},
	Scene: {
		document: CONFIG.Scene.documentClass.prototype
	},
	MeasuredTemplate: {
		layer: CONFIG.Canvas.layers.templates.layerClass.prototype,
		layerFoundry: Object.getPrototypeOf(CONFIG.Canvas.layers.templates.layerClass.prototype),
		object: CONFIG.MeasuredTemplate.objectClass.prototype
	},
}

function compatibility_warning() {
	if (game?.user?.isGM) {
		if (!((game.system.id === "pf2e" && game.system.version === "7.2.0" || game.system.id === "sf2e" && game.system.version === "7.2.0") && game.version === "13.345")) {
			ui.notifications.warn(game.i18n.localize('f2e-grid-enhancements.name') + ' | ' + game.i18n.localize('f2e-grid-enhancements.compatibility-warning') + ' ' + (game?.version ?? '?') + ' or ' + (game?.system?.title ?? '?') + ' ' + (game?.system?.version  ?? '?') + '', {console: false});
		}
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
			if (hex[base]) {
				return hex[base](wrapped, this, ...args);
			} else {
				if (all[base]) {
					return all[base](wrapped, this, ...args);
				} else {
					return wrapped(...args);
				}
			}
		} else if (canvas.grid.isGridless) {
			if (gridless[base]) {
				return gridless[base](wrapped, this, ...args);
			} else {
				if (all[base]) {
					return all[base](wrapped, this, ...args);
				} else {
					return wrapped(...args);
				}
			}
		} else if (canvas.grid.isSquare) {
			if (square[base]) {
				return square[base](wrapped, this, ...args);
			} else {
				if (all[base]) {
					return all[base](wrapped, this, ...args);
				} else {
					return wrapped(...args);
				}
			}
		} else {
			if (all[base]) {
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
		await game.scenes.active.unview();
		await game.scenes.active.view();
	}
}

Hooks.once('libWrapper.Ready', () => {
	// Return more accurate distance measurement
	patch_function('CONFIG.F2e.Token.object.distanceTo');
	// Custom gridless elipse shape (generation)
	patch_function('CONFIG.F2e.Token.object.getShape');
	// Custom gridless elipse shape (rotation)
	patch_function('CONFIG.F2e.Token.document._onUpdate');
	// Simulate hex gridTemplates as to not interfere with base system setting & custom line hex template shape
	patch_function('CONFIG.F2e.MeasuredTemplate.object._computeShape');
	// Simulate hex gridTemplates as to not interfere with base system setting
	patch_function('CONFIG.F2e.MeasuredTemplate.object._refreshShape');
	// Custom cone angle (use Foundry  to hijack template preview logic)
	patch_function('CONFIG.F2e.MeasuredTemplate.layerFoundry._onDragLeftStart');
	// Simulate hex gridTemplates as to not interfere with base system setting & Rotation of new hex templetes & Point max distance
	patch_function('CONFIG.F2e.MeasuredTemplate.layer._onDragLeftMove');
	// Rotation of placed hex templetes
	patch_function('CONFIG.F2e.MeasuredTemplate.layer._onMouseWheel');
	// Snap point of hex & square templates (remove snap)
	patch_function('CONFIG.F2e.MeasuredTemplate.layer.getSnappedPoint');
	// Snap point of hex & square templates (add snap)
	patch_function('CONFIG.F2e.MeasuredTemplate.object._refreshPosition');
	// Custom rendering for templates
	patch_function('CONFIG.F2e.MeasuredTemplate.object._refreshTemplate');
	// Custom hex line rendering for templates
	patch_function('CONFIG.F2e.MeasuredTemplate.object._getGridHighlightPositions');
	// Custom ruler text
	patch_function('CONFIG.F2e.MeasuredTemplate.object._refreshRulerText');
	// Fix for shapes and timing issue when wrapping functions
	if (game.ready) {
		review();
		compatibility_warning();
	} else {
		Hooks.once('ready', async function () {
			review();
			compatibility_warning();
		});
	}
});

// Module settings
Hooks.once('init', () => {
	game.settings.register('f2e-grid-enhancements', 'hex-cone-template-angle', {
		name: 'f2e-grid-enhancements.setting.hex-cone-template-angle-name',
		hint: 'f2e-grid-enhancements.setting.hex-cone-template-angle-hint',
		scope: 'world',
		config: true,
		type: Number,
		default: 60
	});
	game.settings.register('f2e-grid-enhancements', 'square-cone-template-angle', {
		name: 'f2e-grid-enhancements.setting.square-cone-template-angle-name',
		hint: 'f2e-grid-enhancements.setting.square-cone-template-angle-hint',
		scope: 'world',
		config: true,
		type: Number,
		default: 90
	});
	game.settings.register('f2e-grid-enhancements', 'gridless-cone-template-angle', {
		name: 'f2e-grid-enhancements.setting.gridless-cone-template-angle-name',
		hint: 'f2e-grid-enhancements.setting.gridless-cone-template-angle-hint',
		scope: 'world',
		config: true,
		type: Number,
		default: 90
	});
});

// Custom template controls (requires CONFIG.F2e.MeasuredTemplate.layer._onDragLeftStart patch to function properly)
Hooks.on("getSceneControlButtons", (controls) => {
	// ensure canvas is ready and controls contain template
	if (!canvas?.ready || !controls?.templates) {
		return;
	}
	// setup edited controls (just replacing tools and setting active didn't work nor did naming this templates...)
	delete controls.templates;
	controls.template = {
		name: "template",
		order: 2,
		title: "CONTROLS.GroupMeasure",
		icon: "fa-solid fa-ruler-combined",
		visible: game.user.can("TEMPLATE_CREATE"),
		onChange: (event, active) => {
			if ( active ) canvas.templates.activate();
		},
		onToolChange: () => canvas.templates.setAllRenderFlags({refreshState: true}),
		tools: {
			point: {
				name: "point",
				order: 1,
				title: canvas.grid.isHexagonal ? "f2e-grid-enhancements.template.hex" : canvas.grid.isSquare ? "f2e-grid-enhancements.template.square" : "f2e-grid-enhancements.template.point",
				icon: canvas.grid.isHexagonal ? "fa-solid fa-hexagon" : canvas.grid.isSquare ? "fa-solid fa-square" : "fa-solid fa-circle",
				// toolclip: {
				// 	src: "/modules/f2e-grid-enhancements/src/media/rect.webm",
				// 	heading: canvas.grid.isHexagonal ? "f2e-grid-enhancements.template.hex" : canvas.grid.isSquare ? "f2e-grid-enhancements.template.square" : "f2e-grid-enhancements.template.point",
				// 	items: SceneControls.buildToolclipItems(["create", "move", "edit", "hide", "delete"])
				// }
			},
			emanation: {
				name: "emanation",
				order: 2,
				title: "f2e-grid-enhancements.template.emanation",
				icon: canvas.grid.isHexagonal ? "fa-regular fa-hexagon-xmark" : "fa-regular fa-circle-x",
				// toolclip: {
				// 	src: "/modules/f2e-grid-enhancements/src/media/rect.webm",
				// 	heading: "f2e-grid-enhancements.template.emanation",
				// 	items: SceneControls.buildToolclipItems(["create", "move", "edit", "hide", "delete"])
				// }
			},
			"burst": {
				name: "burst",
				order: 3,
				title: "f2e-grid-enhancements.template.burst",
				icon: canvas.grid.isHexagonal ? "fa-regular fa-hexagon" : "fa-regular fa-circle",
				// toolclip: {
				// 	src: "/modules/f2e-grid-enhancements/src/media/rect.webm",
				// 	heading: "f2e-grid-enhancements.template.burst",
				// 	items: SceneControls.buildToolclipItems(["create", "move", "edit", "hide", "delete"])
				// }
			},
			cone: {
				name: "cone",
				order: 4,
				title: "f2e-grid-enhancements.template.cone",
				icon: "fa-regular fa-rotate-270 fa-triangle",
				// toolclip: {
				// 	src: "/modules/f2e-grid-enhancements/src/media/rect.webm",
				// 	heading: "f2e-grid-enhancements.template.cone",
				// 	items: SceneControls.buildToolclipItems(["create", "move", "edit", "hide", "delete", "rotate"])
				// }
			},
			line: {
				name: "line",
				order: 5,
				title: "f2e-grid-enhancements.template.line",
				icon: "fa-regular fa-rotate-90 fa-pipe",
				// toolclip: {
				// 	src: "/modules/f2e-grid-enhancements/src/media/rect.webm",
				// 	heading: "f2e-grid-enhancements.template.line",
				// 	items: SceneControls.buildToolclipItems(["create", "move", "edit", "hide", "delete", "rotate"])
				// }
			},
			clear: {
				name: "clear",
				order: 6,
				title: "CONTROLS.MeasureClear",
				icon: "fa-solid fa-trash",
				visible: game.user.isGM,
				onChange: () => canvas.templates.deleteAll(),
				button: true
			}
		},
		activeTool: "point"
	}
});

const aura_patcher = foundry.utils.debounce((AuraRenderer, TokenAura) => {
	CONFIG.F2e.Aura = {
		renderer: AuraRenderer,
		token: TokenAura
	}
	patch_function('CONFIG.F2e.Aura.renderer.highlight');
	patch_function('CONFIG.F2e.Aura.renderer.draw');
	patch_function('CONFIG.F2e.Aura.token.containsToken');
	// Overwrite for hex and griddless enabling auras on those grids
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