const callbacksAwaitingCanvas = new Set();
function awaitCanvas(callback) {
	if (canvas?.ready) return false;
	if (!callbacksAwaitingCanvas.has(callback)) {
		callbacksAwaitingCanvas.add(callback);
		Hooks.once('canvasReady', () => {
			callbacksAwaitingCanvas.delete(callback);
			callback();
		});
	}
	return true;
}

export function tokens() {
	if (awaitCanvas(tokens)) return;
	for (const token of canvas.tokens?.placeables ?? []) {
		if (token.document.auras?.size) token.renderFlags.set({redraw: true});
	}
}

export const auras = foundry.utils.debounce(() => {
	if (awaitCanvas(auras)) return;
	const scene = canvas.scene;
	if (!scene) return;
	for (const tokenDocument of scene.tokens) {
		if (tokenDocument.auras?.size) tokenDocument.object?.renderFlags.set({redraw: true});
	}
	scene.checkAuras?.();
}, 100);
