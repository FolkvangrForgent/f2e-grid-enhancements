import * as all from './grid/all.js';
import * as hex from './grid/hex.js';
import * as square from './grid/square.js';
import * as gridless from './grid/gridless.js';

// yolo just override the layer class for now until pf2e devs tell me why this would be bad
CONFIG.MeasuredTemplate.layerClass = CONFIG.Canvas.layers.templates.layerClass;

function compatibility_warning_message() {
	if (game?.user?.isGM) {
		ui.notifications.warn(game.i18n.localize('f2e-grid-enhancements.name') + ' | ' + game.i18n.localize('f2e-grid-enhancements.compatibility-warning') + ' ' + (game?.version ?? '?') + ' or ' + (game?.system?.title ?? '?') + ' ' + (game?.system?.version  ?? '?') + '', {console: false});
	}
}

let compatibility_warning = foundry.utils.debounce(() => {
	if (game.ready) {
		compatibility_warning_message();
	} else {
		Hooks.once('ready', () => {
			compatibility_warning_message();
		});
	}
}, 1000)

function patch(target_function_name, target_function_known_hash, patch_function) {
	const target_function_string = eval(target_function_name).toString();
	const target_function_calculated_hash = SparkMD5.hash(target_function_string);
	let match = (target_function_calculated_hash == target_function_known_hash);
	if (!match) {
		console.debug(game.i18n.localize('f2e-grid-enhancements.name') + ' | ' + target_function_name + ' changed ( ' + target_function_known_hash + ' > ' + target_function_calculated_hash + ' ).\n\n' + target_function_string);
		compatibility_warning();
	}
	libWrapper.register('f2e-grid-enhancements', target_function_name, patch_function, 'MIXED');
	return match;
}

function patch_function(target_function_name, target_function_crc) {
	const split = target_function_name.split('.');
	const base = split[1] + '_' + split[2].substring(0, (split[2].length - 5)) + '_' + split[4];
	patch(target_function_name, target_function_crc, function(wrapped, ...args) {
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
	});
	console.debug(game.i18n.localize('f2e-grid-enhancements.name') + ' | ' + target_function_name + ' patched for ' + [(hex[base] ? 'hex' : undefined), (gridless[base] ? 'gridless' : undefined), (square[base] ? 'square' : undefined), (all[base] ? 'all' : undefined)].filter(e => e !== undefined));
}

async function review() {
	await game.scenes.active.unview();
	await game.scenes.active.view();
}

Hooks.once('libWrapper.Ready', () => {
	// Return more accurate distance measurement
	patch_function('CONFIG.Token.objectClass.prototype.distanceTo', 'c8ce3c052f4fb329d769495ecce53706');
	// Custom gridless elipse shape (generation)
	patch_function('CONFIG.Token.objectClass.prototype.getShape', '7c0ca540d43ec90bbf0ccd59860d8b9f');
	// Custom gridless elipse shape (rotation)
	patch_function('CONFIG.Token.objectClass.prototype._refreshRotation', '990e9966a5be374839afd587a27a8daa');
	// Simulate hex gridTemplates as to not interfere with base system setting & custom line hex template shape
	patch_function('CONFIG.MeasuredTemplate.objectClass.prototype._computeShape', 'c1b3474ea4ecd5e0ed6d2c432605a1de');
	// Simulate hex gridTemplates as to not interfere with base system setting
	patch_function('CONFIG.MeasuredTemplate.objectClass.prototype._refreshShape', 'aa7bece01f67f75253aabb78bf247916');
	// Custom cone angle
	patch_function('CONFIG.MeasuredTemplate.layerClass.prototype._onDragLeftStart', '3936597ef14b90fbb067c4aa6677236c');
	// Simulate hex gridTemplates as to not interfere with base system setting & Rotation of new hex templetes & Point max distance
	patch_function('CONFIG.MeasuredTemplate.layerClass.prototype._onDragLeftMove', 'd1a2a952333c135fe8762b13421f5669');
	// Rotation of placed hex templetes
	patch_function('CONFIG.MeasuredTemplate.layerClass.prototype._onMouseWheel', '18f463b0bd532a26be871942353b571c');
	// Snap point of hex & square templates (remove snap)
	patch_function('CONFIG.MeasuredTemplate.layerClass.prototype.getSnappedPoint', '4f15d2ca963123d1e768ef95242f06c0');
	// Snap point of hex & square templates (add snap)
	patch_function('CONFIG.MeasuredTemplate.objectClass.prototype._refreshPosition', '26f381059b38b3cf06d0253c627813e1');
	// Custom rendering for templates
	patch_function('CONFIG.MeasuredTemplate.objectClass.prototype._refreshTemplate', 'f872e30f9c8ed78c99460b1aa12bbfaa');
	// Custom hex line rendering for templates
	patch_function('CONFIG.MeasuredTemplate.objectClass.prototype._getGridHighlightPositions', 'e611e2584d920c7079856e8122a9bf69');
	// Custom ruler text
	patch_function('CONFIG.MeasuredTemplate.objectClass.prototype._refreshRulerText', '98930494eae3446edf4b869caeffdc0e');
	// Fix for shapes and timing issue when wrapping functions
	if (game.ready) {
		review();
	} else {
		Hooks.once('ready', async function () {
			review();
		});
	}
});

// Module settings (requires CONFIG.MeasuredTemplate.layerClass.prototype._onDragLeftStart patch for custom cone angles)
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

// Custom template controls (requires CONFIG.MeasuredTemplate.layerClass.prototype._onDragLeftStart patch to function properly)
Hooks.on("getSceneControlButtons", (controls) => {
	// ensure canvas is ready and controls contain template
	if (!canvas?.ready || !controls?.templates) {
		return;
	}
	// setup edited controls
	controls.templates.activeTool = "point"
	controls.templates.tools = {
		point: {
			name: "point",
			order: 0,
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
			// 	items: SceneControls.buildToolclipItems(["create", "move", "edit", "hide", "delete", "rotate"])
			// }
		},
		burst: {
			name: "burst",
			order: 3,
			title: "f2e-grid-enhancements.template.burst",
			icon: canvas.grid.isHexagonal ? "fa-regular fa-hexagon" : "fa-regular fa-circle",
			// toolclip: {
			// 	src: "/modules/f2e-grid-enhancements/src/media/rect.webm",
			// 	heading: "f2e-grid-enhancements.template.burst",
			// 	items: SceneControls.buildToolclipItems(["create", "move", "edit", "hide", "delete", "rotate"])
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
	}
});

// TODO grid agnostic target helper
