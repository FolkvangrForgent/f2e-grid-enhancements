import {tokenShapeAlternate} from './helpers/token.js';

const SHAPE_NAMES_BY_VALUE = foundry.utils.invertObject(CONST.TOKEN_SHAPES);

Hooks.on('renderTokenHUD', (hud, element) => {
	const alternateShape = tokenShapeAlternate(hud.document);
	if (!hud.document.isOwner) return;
	const button = document.createElement('button');
	button.type = 'button';
	button.className = 'control-icon';
	button.dataset.tooltip = '';
	button.ariaLabel = game.i18n.format('f2e-grid-enhancements.general.token.alternate', {
		shape: game.i18n.localize(`TOKEN.SHAPES.${SHAPE_NAMES_BY_VALUE[alternateShape]}.label`)
	});
	button.innerHTML = '<i class="fa-solid fa-shapes" inert></i>';
	button.addEventListener('click', () => {
		const tokens = new Set([hud.document, ...(canvas.tokens?.controlled.map(controlled => controlled.document) ?? [])]);
		const updates = [];
		for (const tokenDocument of tokens) {
			const shape = tokenShapeAlternate(tokenDocument);
			if (tokenDocument.isOwner) {
				updates.push({_id: tokenDocument.id, shape, ...positionSnappedForShape(tokenDocument, shape)});
			}
		}
		if (updates.length) {
			hud.document.parent.updateEmbeddedDocuments('Token', updates);
		}
	});
	element.querySelector('.col.left')?.append(button);
});

// Only for a token already snapped to the grid; otherwise its position is left as it is.
function positionSnappedForShape(tokenDocument, shape) {
	if (tokenDocument.width < 1 || tokenDocument.height < 1 || tokenDocument.parent.grid.isGridless) return {};
	const snapped = tokenDocument.getSnappedPosition();
	if (Math.abs(snapped.x - tokenDocument.x) >= 0.5 || Math.abs(snapped.y - tokenDocument.y) >= 0.5) return {};
	const {x, y} = tokenDocument._gridOffsetToPosition(tokenDocument._positionToGridOffset(), {shape});
	return {x, y};
}
