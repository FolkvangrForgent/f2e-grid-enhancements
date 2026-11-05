// Refresh logic with canvas ready defering

const refreshQueue = new Set();
function defer(callback) {
	if (canvas?.ready) {
		return false;
	}
	if (!refreshQueue.has(callback)) {
		refreshQueue.add(callback);
		Hooks.once('canvasReady', () => {
			refreshQueue.delete(callback);
			callback();
		});
	}
	return true;
}

export function regions() {
	if (defer(regions)) return;
	for (const region of canvas.regions?.placeables ?? []) {
		region.renderFlags.set({redraw: true});
	}
}

export function tokens() {
	if (defer(tokens)) return;
	for (const token of canvas.tokens?.placeables ?? []) {
		if (token.document.auras?.size) {
			token.renderFlags.set({redraw: true});
		}
	}
}

let aurasRunning = false;
let aurasPending = false;
export const auras = foundry.utils.debounce(async () => {
	if (defer(auras)) return;
	if (!canvas.scene) return;
	if (aurasRunning) {
		aurasPending = true;
		return;
	} else {
		aurasRunning = true;
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
		aurasRunning = false;
		if (aurasPending) {
			aurasPending = false;
			auras();
		}
	}
}, 100);
