import * as distance from '../../distance/index.js';
import {gridIsFeet} from '../../helpers/grid.js';
import * as setting from '../../helpers/setting.js';
import {tokenCenterMiddle, tokenDepth, tokenHeight, tokenWidth} from '../../helpers/token.js';

const ALTERNATING_DIAGONALS = [CONST.GRID_DIAGONALS.ALTERNATING_1, CONST.GRID_DIAGONALS.ALTERNATING_2];

function reachDiscount(grid, path) {
	if (grid.distance === 5 && path.diagonals > 1 && ALTERNATING_DIAGONALS.includes(grid.diagonals) && gridIsFeet(grid)) {
		return path.distance - grid.distance;
	}
	return path.distance;
}

export function Token_object_distanceTo(wrapped, token, target, options) {
	const discount = options?.reach === 10 && setting.get('f2e.reach-exception') ? reachDiscount : undefined;
	if (!(target instanceof foundry.canvas.placeables.Token)) target = {...tokenCenterMiddle(token), ...target};
	return Math.max(0, Math.round(distance.distance(token.scene.grid, token, target, discount) * 10) / 10);
}

export function Token_object__onClickLeft2(wrapped, token, event) {
	const reachEnforcement = (game.pf2e ?? game.sf2e)?.settings?.automation?.reachEnforcement;
	const requiresReach = reachEnforcement?.has(token.actor?.isOfType('loot') ? (token.actor.isLoot ? 'loot' : 'merchants') : 'corpses');
	if (!token.document.isSecret && requiresReach && !token.document.isOwner && token.actor?.isLootableBy(game.user)) {
		const userTokens = [...new Set([token.layer.controlled, game.user.character?.getActiveTokens(true, false) ?? []].flat())];
		const isInReach = userTokens.some(
			userToken => userToken.actor?.isOwner && userToken.actor.isOfType('creature', 'party') && userToken.distanceTo(token) <= userToken.actor.system.attributes.reach.manipulate
		);
		if (!isInReach) {
			const isCreature = token.actor.isOfType('creature');
			const name = token.document.playersCanSeeName ? token.document.name : game.i18n.localize(`PF2E.Token.Mystified.The${isCreature ? 'Creature' : 'Object'}`);
			ui.notifications.warn('PF2E.Token.OutOfReach', {format: {token: name}});
			return;
		}
	}
	return wrapped(event);
}

export function Token_document_getSnappedPosition(wrapped, tokenDocument, data) {
	const snapped = wrapped(data);
	const {x, y, width, height} = {
		x: tokenDocument.x,
		y: tokenDocument.y,
		width: tokenDocument.width,
		height: tokenDocument.height,
		...data
	};
	const grid = tokenDocument.scene?.grid;
	if (!grid?.isHexagonal || width >= 1 || height >= 1) return snapped;
	const halfWidth = (width * grid.size) / 2;
	const halfHeight = (height * grid.size) / 2;
	const tokenCenterPoint = {x: x + halfWidth, y: y + halfHeight};
	const cellCenter = grid.getCenterPoint(tokenCenterPoint);
	const squaredDistanceToToken = point => (point.x - tokenCenterPoint.x) ** 2 + (point.y - tokenCenterPoint.y) ** 2;
	let nearest = cellCenter;
	let nearestSquaredDistance = squaredDistanceToToken(cellCenter);
	for (const corner of grid.getVertices(tokenCenterPoint)) {
		const candidate = {x: (cellCenter.x + corner.x) / 2, y: (cellCenter.y + corner.y) / 2};
		const candidateSquaredDistance = squaredDistanceToToken(candidate);
		if (candidateSquaredDistance < nearestSquaredDistance) {
			nearest = candidate;
			nearestSquaredDistance = candidateSquaredDistance;
		}
	}
	return {...snapped, x: nearest.x - halfWidth, y: nearest.y - halfHeight};
}

export function initialize() {
	Hooks.on('preCreateToken', preCreateToken);
}

function moduleSizes(token, data) {
	const merged = {...token._source, ...data, scene: token.parent};
	const sizes = {};
	if (typeof data.width === 'number') sizes.width = tokenWidth(merged);
	if (typeof data.height === 'number') sizes.height = tokenHeight(merged);
	if (typeof data.depth === 'number') sizes.depth = tokenDepth(merged);
	return sizes;
}

function sizeChanges(token, data) {
	const changes = {};
	for (const [key, size] of Object.entries(moduleSizes(token, data))) {
		if (size !== data[key]) changes[key] = size;
	}
	if ('width' in changes || 'height' in changes) {
		const position = {...token._source, ...data};
		const snapped = token.getSnappedPosition({...position, ...changes});
		if (snapped.x !== position.x) changes.x = snapped.x;
		if (snapped.y !== position.y) changes.y = snapped.y;
	}
	return changes;
}

function preCreateToken(token, data, options, userId) {
	if (game.user.id !== userId) return;
	const changes = sizeChanges(token, token._source);
	if (!foundry.utils.isEmpty(changes)) token.updateSource(changes);
}

export function Token_document_applyActiveEffects(wrapped, token, phase) {
	const result = wrapped(phase);
	if (token.overrides) Object.assign(token.overrides, moduleSizes(token, token.overrides));
	return result;
}

export function Token_document__preUpdate(wrapped, token, changed, options, user) {
	if (user.id === game.user.id) Object.assign(changed, sizeChanges(token, changed));
	return wrapped(changed, options, user);
}
