import {gridIsFeet, gridIsMeter, gridUnitPixels} from '../helpers/grid.js';
import * as log from '../helpers/log.js';
import * as setting from '../helpers/setting.js';
import {tokenAuraPolygons, tokenCenterBottom, tokenCenterTop, tokenHeight, tokenSurfacePoints, tokenWidth} from '../helpers/token.js';
import {isWasmReady} from '../helpers/wasm.js';
import {firstBlock, isBlocked} from '../raycast/index.js';

const callbacksAwaitingCanvas = new Set();
// Returns whether the callback was deferred until the canvas is ready.
function deferUntilCanvasReady(callback) {
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

export function redrawTokensWithAuras() {
	if (deferUntilCanvasReady(redrawTokensWithAuras)) return;
	for (const token of canvas.tokens?.placeables ?? []) {
		if (token.document.auras?.size) token.renderFlags.set({redraw: true});
	}
}

export const redrawAuras = foundry.utils.debounce(() => {
	if (deferUntilCanvasReady(redrawAuras)) return;
	const scene = canvas.scene;
	if (!scene) return;
	for (const tokenDocument of scene.tokens) {
		if (tokenDocument.auras?.size) tokenDocument.object?.renderFlags.set({redraw: true});
	}
	scene.checkAuras?.();
}, 100);

// A blocked surface point is pulled this far back toward the target's centre, so it is tested just inside the barrier.
const STEP_BACK_FROM_BLOCKER = 0.1;

function isSuppressedByDefeat(token) {
	return setting.get('f2e.aura.defeated-disable') && !!(token.actor?.isDead || token.document.combatant?.defeated || token.actor?.statuses.has(CONFIG.specialStatusEffects.DEFEATED));
}

// Visual auras are blocked by sight walls, auditory ones by sound walls, others by movement walls.
function restrictionTypesOf(traits) {
	const restrictionTypes = [];
	if (traits.includes('auditory')) restrictionTypes.push('sound');
	if (traits.includes('visual')) restrictionTypes.push('sight');
	if (!traits.includes('auditory') && !traits.includes('visual')) restrictionTypes.push('move');
	return restrictionTypes;
}

export function allowAuras(wrapped, scene) {
	return gridIsFeet(scene.grid) || gridIsMeter(scene.grid);
}

function auraCenter(renderer) {
	const {width, height} = renderer.token.mechanicalBounds;
	const topLeft = renderer.token.document.scene.grid.isGridless
		? renderer.token.document.getSnappedPosition()
		: renderer.token.document.scene.grid.getTopLeftPoint(
				renderer.token.document._positionToGridOffset({
					width: tokenWidth(renderer.token),
					height: tokenHeight(renderer.token)
				})
			);
	return {x: topLeft.x + width / 2, y: topLeft.y + height / 2};
}

function auraShapeKey(renderer) {
	return `${renderer.radius}|${renderer.token.document.shape}|${renderer.token.document.width}|${renderer.token.document.height}`;
}

function auraShapePolygons(renderer) {
	const center = auraCenter(renderer);
	return tokenAuraPolygons(renderer.token, renderer.radius, false).map(polygon => new PIXI.Polygon(polygon.points.map((coordinate, index) => coordinate - (index % 2 === 0 ? center.x : center.y))));
}

async function loadAuraTexture(textureData) {
	const texture = await foundry.canvas.loadTexture(textureData.src, {fallback: 'icons/svg/hazard.svg'});
	if (!(texture instanceof PIXI.Texture)) return null;
	const isVideo = foundry.helpers.media.VideoHelper.hasVideoExtension(textureData.src);
	const sharedVideo = isVideo ? game.video.getVideoSource(texture) : null;
	if (!sharedVideo) return texture;
	texture.destroy();
	const videoTexture = await game.video.cloneTexture(sharedVideo);
	const video = game.video.getVideoSource(videoTexture) ?? sharedVideo;
	video.playbackRate = textureData.playbackRate;
	game.video.play(video, {
		volume: 0,
		offset: textureData.loop ? Math.random() * video.duration : 0,
		loop: textureData.loop
	});
	return videoTexture;
}

async function drawAuraTexture(renderer) {
	const textureData = renderer.appearance.texture;
	if (!textureData || renderer.token.isPreview) return;
	const shapeKey = auraShapeKey(renderer);
	if (!renderer.textureContainer) {
		renderer.textureContainer = new PIXI.Graphics();
		canvas.interface.grid.addChild(renderer.textureContainer);
	}
	const container = renderer.textureContainer;
	container.visible = true;
	positionAuraTexture(null, renderer);
	if (renderer.f2eTextureKey === shapeKey) return;
	renderer.f2eTextureKey = shapeKey;
	renderer.f2eTexture ??= loadAuraTexture(textureData);
	const texture = await renderer.f2eTexture;
	if (!texture || container.destroyed || renderer.f2eTextureKey !== shapeKey) return;
	const [outline, ...holes] = auraShapePolygons(renderer);
	if (!outline) return;
	const bounds = outline.getBounds();
	const size = textureData.scale * Math.max(bounds.width, bounds.height);
	const matrix = new PIXI.Matrix(size / texture.width, 0, 0, size / texture.height, size / 2, size / 2);
	container.clear().beginTextureFill({texture, alpha: textureData.alpha, matrix}).drawShape(outline);
	for (const hole of holes) container.beginHole().drawShape(hole).endHole();
	container.endFill();
}

export function positionAuraTexture(wrapped, renderer) {
	if (!renderer.textureContainer || renderer.textureContainer.destroyed) return;
	renderer.textureContainer.position.set(renderer.token.position.x + renderer.x, renderer.token.position.y + renderer.y);
}

export function drawAura(wrapped, renderer, showBorder) {
	const isHidden = renderer.token.document.hidden && !renderer.token.visible;
	if (isHidden || isSuppressedByDefeat(renderer.token)) {
		renderer.border.visible = false;
		if (renderer.textureContainer) renderer.textureContainer.visible = false;
		return;
	}
	const center = auraCenter(renderer);
	const snapped = renderer.token.document.getSnappedPosition();
	const shapeKey = auraShapeKey(renderer);
	if (renderer.f2eBorderKey !== shapeKey) {
		renderer.f2eBorderKey = shapeKey;
		renderer.border.clear();
	}
	const borderStyle = renderer.appearance.border;
	const isBorderDrawn = renderer.border.geometry.graphicsData.length > 0;
	if (!isBorderDrawn && borderStyle?.color != null && borderStyle?.alpha != null) {
		const [outline] = auraShapePolygons(renderer);
		if (outline) renderer.border.lineStyle(renderer.token.document.scene.grid.thickness, borderStyle.color, borderStyle.alpha).drawShape(outline);
	}
	renderer.x = center.x - snapped.x;
	renderer.y = center.y - snapped.y;
	renderer.border.visible = showBorder;
	if (!renderer.appearance.texture) return;
	return drawAuraTexture(renderer).catch(error => log.warn('aura texture failed', error));
}

export function auraContainsToken(wrapped, tokenAura, token) {
	if (!isWasmReady()) return wrapped(token);
	if (tokenAura.token.hidden || token.hidden || !tokenAura.token.object || !token.object) return false;
	if (isSuppressedByDefeat(tokenAura.token.object)) return false;
	if (token === tokenAura.token) return true;
	if (tokenAura.token.object.distanceTo(token.object) > tokenAura.radius) return false;
	const scene = tokenAura.token.object.scene;
	const auraRadius = tokenAura.radius * gridUnitPixels(scene.grid);
	// The centre between its bottom and the lowest barrier above its bottom, so a token under a low ceiling is tested beneath it.
	const reachableCenter = (tokenObject, restrictionType) => {
		const top = tokenCenterTop(tokenObject);
		const bottom = tokenCenterBottom(tokenObject);
		const center = {...(firstBlock(scene, bottom, top, {elevationBias: 'below', edgeRestrictionType: restrictionType})?.point ?? top)};
		center.elevation = (center.elevation + bottom.elevation) / 2;
		return center;
	};
	const centers = restrictionTypesOf(tokenAura.traits).map(restrictionType => ({
		restrictionType,
		aura: reachableCenter(tokenAura.token.object, restrictionType),
		target: reachableCenter(token.object, restrictionType)
	}));
	// shuffled, so a reachable point tends to turn up early
	const surfacePoints = [...tokenSurfacePoints(token.object)];
	for (let index = surfacePoints.length - 1; index > 0; index--) {
		const swapIndex = Math.floor(Math.random() * (index + 1));
		[surfacePoints[index], surfacePoints[swapIndex]] = [surfacePoints[swapIndex], surfacePoints[index]];
	}
	for (const surfacePoint of surfacePoints) {
		for (const {restrictionType, aura: auraCenterPoint, target: targetCenter} of centers) {
			let testPoint = surfacePoint;
			const blocker = firstBlock(scene, targetCenter, surfacePoint, {edgeRestrictionType: restrictionType});
			if (blocker) {
				testPoint = {
					x: blocker.point.x + (targetCenter.x - blocker.point.x) * STEP_BACK_FROM_BLOCKER,
					y: blocker.point.y + (targetCenter.y - blocker.point.y) * STEP_BACK_FROM_BLOCKER,
					elevation: blocker.point.elevation + (targetCenter.elevation - blocker.point.elevation) * STEP_BACK_FROM_BLOCKER
				};
			}
			if (!isBlocked(scene, auraCenterPoint, testPoint, {edgeRestrictionType: restrictionType, radius: auraRadius})) return true;
		}
	}
	return false;
}

function highlightShapeKey(renderer) {
	return [auraShapeKey(renderer), renderer.token.document.x, renderer.token.document.y].join('|');
}

// The first polygon is the outline; the rest are holes (the token's own spaces).
const highlightPolygons = renderer => tokenAuraPolygons(renderer.token, renderer.radius, true);

// As the system decides it before highlighting (AuraRenderer#highlight): a familiar through its master.
function isInEncounter(renderer) {
	const actor = renderer.token.actor;
	return !!(actor?.isOfType('familiar') ? actor.master?.combatant?.encounter.active : renderer.token.combatant?.encounter.active);
}

// Only during an active encounter, as the system does. The system redraws every token's auras on every visibility refresh, which is every frame while a token moves,
// so the shape is worked out only when it changes, and otherwise drawn again.
export function highlightAura(wrapped, renderer) {
	const layer = renderer.highlightLayer;
	if (!layer || isSuppressedByDefeat(renderer.token) || !isInEncounter(renderer)) return;
	const shapeKey = highlightShapeKey(renderer);
	if (renderer.f2eHighlightKey !== shapeKey) {
		renderer.f2eHighlightKey = shapeKey;
		renderer.f2eHighlightPolygons = highlightPolygons(renderer);
	}
	const [outline, ...holes] = renderer.f2eHighlightPolygons;
	if (!outline) return;
	const {color, alpha} = renderer.appearance.highlight;
	layer.beginFill(color, alpha);
	layer.drawShape(outline);
	for (const hole of holes) {
		layer.beginHole();
		layer.drawShape(hole);
		layer.endHole();
	}
	layer.endFill();
}
