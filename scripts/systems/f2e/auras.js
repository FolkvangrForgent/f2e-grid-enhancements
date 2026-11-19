import {clip} from '../../helpers/clipper.js';
import {gridIsFeet, gridIsMeter, gridUnitPixels} from '../../helpers/grid.js';
import * as setting from '../../helpers/setting.js';
import {tokenAuraPolygons, tokenCenterBottom, tokenCenterTop, tokenHeight, tokenSurfacePoints, tokenWidth} from '../../helpers/token.js';
import * as raycast from '../../raycast/index.js';

function isSuppressedByDefeat(token) {
	return setting.get('f2e.aura.defeated-disable') && !!(token.actor?.isDead || token.document.combatant?.defeated || token.actor?.statuses.has(CONFIG.specialStatusEffects.DEFEATED));
}

function restrictionTypesOf(traits) {
	const restrictionTypes = [];
	if (traits.includes('auditory')) restrictionTypes.push('sound');
	if (traits.includes('visual')) restrictionTypes.push('sight');
	if (!traits.includes('auditory') && !traits.includes('visual')) restrictionTypes.push('move');
	return restrictionTypes;
}

export function Scene_document_canHaveAuras(wrapped, scene) {
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
	Aura_renderer_repositionTexture(null, renderer);
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

export function Aura_renderer_repositionTexture(wrapped, renderer) {
	if (!renderer.textureContainer || renderer.textureContainer.destroyed) return;
	renderer.textureContainer.position.set(renderer.token.position.x + renderer.x, renderer.token.position.y + renderer.y);
}

export function Aura_renderer_draw(wrapped, renderer, showBorder) {
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
	return drawAuraTexture(renderer).catch(error => console.warn(`${game.i18n.localize('f2e-grid-enhancements.name')} | aura texture failed`, error));
}

export function Aura_token_containsToken(wrapped, tokenAura, token) {
	if (tokenAura.token.hidden || token.hidden || !tokenAura.token.object || !token.object) return false;
	if (isSuppressedByDefeat(tokenAura.token.object)) return false;
	if (token === tokenAura.token) return true;
	if (tokenAura.token.object.distanceTo(token.object) > tokenAura.radius) return false;
	const scene = tokenAura.token.object.scene;
	const auraRadius = tokenAura.radius * gridUnitPixels(scene.grid);
	const hits = {tokens: false, levels: false};
	const reachableCenter = (tokenObject, restrictionType) => {
		const top = tokenCenterTop(tokenObject);
		const bottom = tokenCenterBottom(tokenObject);
		const center = {...(raycast.raycast(scene, bottom, top, {elevationBias: 'below', edgeRestrictionType: restrictionType, stop: true, hits}).find(hit => hit.blocking)?.point ?? top)};
		center.elevation = (center.elevation + bottom.elevation) / 2;
		return center;
	};
	const centers = restrictionTypesOf(tokenAura.traits).map(restrictionType => ({
		restrictionType,
		aura: reachableCenter(tokenAura.token.object, restrictionType),
		target: reachableCenter(token.object, restrictionType)
	}));
	const surfacePoints = [...tokenSurfacePoints(token.object)];
	for (let index = surfacePoints.length - 1; index > 0; index--) {
		const swapIndex = Math.floor(Math.random() * (index + 1));
		[surfacePoints[index], surfacePoints[swapIndex]] = [surfacePoints[swapIndex], surfacePoints[index]];
	}
	for (const surfacePoint of surfacePoints) {
		for (const {restrictionType, aura: auraCenterPoint, target: targetCenter} of centers) {
			let testPoint = surfacePoint;
			const blocker = raycast.raycast(scene, targetCenter, surfacePoint, {edgeRestrictionType: restrictionType, stop: true, hits}).find(hit => hit.blocking);
			if (blocker) {
				testPoint = {
					x: blocker.point.x + (targetCenter.x - blocker.point.x) * 0.1,
					y: blocker.point.y + (targetCenter.y - blocker.point.y) * 0.1,
					elevation: blocker.point.elevation + (targetCenter.elevation - blocker.point.elevation) * 0.1
				};
			}
			const isBlocked = raycast.raycast(scene, auraCenterPoint, testPoint, {edgeRestrictionType: restrictionType, stop: true, hits, radius: auraRadius}).some(hit => hit.blocking);
			if (!isBlocked) return true;
		}
	}
	return false;
}

// Bumped whenever something the highlight's wall sweeps depend on changes (walls and doors, regions, levels, the scene), so
// cached highlight geometry is recomputed.
let sceneGeometryVersion = 0;
for (const event of ['create', 'update', 'delete']) {
	for (const documentName of ['Wall', 'Region', 'RegionBehavior', 'Level']) Hooks.on(`${event}${documentName}`, () => sceneGeometryVersion++);
}
Hooks.on('updateScene', () => sceneGeometryVersion++);
Hooks.on('canvasReady', () => sceneGeometryVersion++);

// What a visual aura's sweep also depends on: the darkness sources, which restrict sight.
function darknessSignature() {
	let signature = '';
	for (const source of canvas.effects?.darknessSources ?? []) {
		signature += `${source.sourceId}:${source.active}:${source.data.x},${source.data.y},${source.data.elevation},${source.radius};`;
	}
	return signature;
}

// Everything an aura's highlight geometry depends on: when this changes, the geometry is recomputed.
function highlightKey(renderer) {
	const showsCollisions = setting.get('f2e.aura.collisions-highlight');
	const collisionInputs = showsCollisions ? [sceneGeometryVersion, setting.get('general.elevation-visualization'), renderer.traits.includes('visual') ? darknessSignature() : ''] : '';
	return [
		auraShapeKey(renderer),
		renderer.token.document.x,
		renderer.token.document.y,
		renderer.token.document.elevation,
		renderer.token.document.level,
		renderer.token.document.depth,
		renderer.traits.join(','),
		showsCollisions,
		collisionInputs
	].join('|');
}

// The shapes an aura's highlight draws: with collisions, the area in reach of the token (`visible`) and the area walls cut
// off (`occluded`); otherwise the aura's cells or emanation (`polygons`, the first an outline and the rest holes). Null
// when there is nothing to draw.
function computeHighlightGeometry(renderer) {
	const polygons = tokenAuraPolygons(renderer.token, renderer.radius, true);
	if (polygons.length === 0) return null;
	if (!setting.get('f2e.aura.collisions-highlight')) return {polygons};
	const origin = tokenCenterBottom(renderer.token);
	const sweepRadius =
		renderer.radius * gridUnitPixels(renderer.token.document.scene.grid) + Math.max(tokenWidth(renderer.token), tokenHeight(renderer.token)) * renderer.token.document.scene.grid.size;
	// the walls of the token's level, else of the levels its elevation is in, else of no particular level
	let levels = [renderer.token.document.scene.levels.get(renderer.token.document.level)].filter(level => level !== undefined);
	if (!levels.length) levels = renderer.token.document.scene.levels.contents.filter(level => origin.elevation >= level.elevation.bottom && origin.elevation < level.elevation.top);
	if (!levels.length) levels = [null];
	// for each restriction type, the area reachable on every one of those levels
	const reachablePathsByType = [];
	for (const restrictionType of restrictionTypesOf(renderer.traits)) {
		let reachablePaths = null;
		for (const level of levels) {
			const sweep = CONFIG.Canvas.polygonBackends[restrictionType].create(origin, {
				level,
				type: restrictionType,
				radius: sweepRadius,
				useThreshold: true
			});
			const levelPaths = [sweep.toClipperPoints({scalingFactor: CONST.CLIPPER_SCALING_FACTOR})];
			reachablePaths = reachablePaths === null ? levelPaths : clip(reachablePaths, levelPaths, ClipperLib.ClipType.ctIntersection, []);
		}
		reachablePathsByType.push(reachablePaths);
	}
	const reachablePaths = reachablePathsByType.flat();
	const auraPaths = polygons.map(polygon => polygon.toClipperPoints({scalingFactor: CONST.CLIPPER_SCALING_FACTOR}));
	return {
		visible: foundry.data.PolygonTree.fromClipperPolyTree(clip(reachablePaths, auraPaths, ClipperLib.ClipType.ctIntersection, new ClipperLib.PolyTree())),
		occluded: foundry.data.PolygonTree.fromClipperPolyTree(clip(auraPaths, reachablePaths, ClipperLib.ClipType.ctDifference, new ClipperLib.PolyTree()))
	};
}

// Highlight the area an aura covers. The system redraws every token's auras on every visibility refresh, which is every
// frame while a token moves, so the geometry (wall sweeps and clipping) is computed only when something it depends on
// changes, and otherwise the cached shapes are drawn again.
export function Aura_renderer_highlight(wrapped, renderer) {
	const layer = renderer.highlightLayer;
	if (!layer || isSuppressedByDefeat(renderer.token)) return;
	const geometryKey = highlightKey(renderer);
	if (renderer.f2eHighlightKey !== geometryKey) {
		renderer.f2eHighlightKey = geometryKey;
		renderer.f2eHighlightGeometry = computeHighlightGeometry(renderer);
	}
	const geometry = renderer.f2eHighlightGeometry;
	if (!geometry) return;
	const {color, alpha} = renderer.appearance.highlight;
	if (geometry.polygons) {
		const [outline, ...holes] = geometry.polygons;
		layer.beginFill(color, alpha);
		layer.drawShape(outline);
		for (const hole of holes) {
			layer.beginHole();
			layer.drawShape(hole);
			layer.endHole();
		}
		layer.endFill();
		return;
	}
	layer.beginFill(color, alpha);
	geometry.visible.drawShape(layer);
	layer.endFill();
	layer.beginFill(0x000000, alpha);
	geometry.occluded.drawShape(layer);
	layer.endFill();
}
