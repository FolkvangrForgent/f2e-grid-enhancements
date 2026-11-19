// At an opacity threshold of 0 a tile gives its whole rectangle. Unsaved form changes are kept, as core does. The image is checked at a resolution relative to the grid (so a larger
// tile gets more samples, the pixels of a scaled copy) or at every pixel; smoothing is measured in samples, so it means the
// same whatever the grid size or the image's resolution. Transparent areas inside a tile are kept as holes, and pieces and
// holes smaller than a few samples (specks from sampling) are left out.
import {clip} from '../helpers/clipper.js';
import {polyTreeShapes} from './optimize.js';

let lastChosenOptions = null;

// full checks every pixel of the image.
const SAMPLES_PER_SPACE = {low: 16 * 16, medium: 32 * 32, high: 64 * 64};
const RESOLUTIONS = [...Object.keys(SAMPLES_PER_SPACE), 'full'];
// So a huge tile stays quick to trace (high keeps its 64 x 64 per space up to about 64 x 64 spaces).
const MAXIMUM_SAMPLES = 4096 * 4096;
// Smaller pieces and holes are specks from sampling.
const SPECK_SAMPLES = 2 * 2;

const sourceImagePixelCount = texture => texture.width * texture.height * texture.resolution ** 2;

// Never above the image's own pixels.
function textureScaleForTracing(tile, texture, resolution) {
	if (!(resolution in SAMPLES_PER_SPACE)) return 1;
	const spaces = Math.abs(tile.document.width * tile.document.height) / canvas.dimensions.size ** 2 || 0;
	const samples = Math.min(spaces * SAMPLES_PER_SPACE[resolution], MAXIMUM_SAMPLES);
	return Math.min(1, Math.sqrt(samples / sourceImagePixelCount(texture)));
}

Hooks.on('renderRegionConfig', (sheet, element) => {
	if (!game.user.isGM || !sheet.isEditable) return;
	const controls = element.querySelector('section[data-tab="shapes"] > header .region-element-controls');
	if (!controls || controls.querySelector('.f2e-grid-enhancements-from-tiles')) return;
	const button = document.createElement('button');
	button.type = 'button';
	button.className = 'ui-control create-from-walls fa-stack f2e-grid-enhancements-from-tiles';
	button.dataset.tooltip = '';
	button.ariaLabel = game.i18n.localize('f2e-grid-enhancements.general.region.tiles.create');
	button.innerHTML = '<i class="fa-solid fa-cubes fa-stack-2x" inert></i><i class="fa-duotone fa-circle-plus fa-stack-1x plus" inert></i>';
	button.addEventListener('click', event => createShapesFromTiles(sheet, event));
	const wallsButton = controls.querySelector('[data-action="shapeCreateFromWalls"]');
	if (wallsButton) wallsButton.after(button);
	else controls.prepend(button);
});

async function createShapesFromTiles(sheet, event) {
	event.preventDefault();
	event.stopPropagation();
	if (!canvas.ready || event.detail > 1) return;
	const tiles = canvas.tiles.controlled;
	if (!tiles.length) {
		if (canvas.tiles.active) ui.notifications.error('f2e-grid-enhancements.general.region.tiles.none', {localize: true});
		else {
			canvas.tiles.activate({tool: 'select'});
			ui.notifications.info('f2e-grid-enhancements.general.region.tiles.control', {localize: true});
		}
		return;
	}
	const options = await askTracingOptions(tiles);
	if (!options) return;
	lastChosenOptions = options;
	const shapes = tiles.flatMap(tile => (options.threshold > 0 ? (opaqueShapes(tile, options) ?? []) : [rectangleShape(tile.document)]));
	if (!shapes.length) {
		ui.notifications.warn('f2e-grid-enhancements.general.region.tiles.empty', {localize: true});
		return;
	}
	const form = sheet.element;
	const submitData = sheet._prepareSubmitData(event, form, new foundry.applications.ux.FormDataExtended(form), {
		shapes: [...sheet.document._source.shapes, ...shapes]
	});
	await sheet.document.update(submitData);
}

const localizeOption = key => game.i18n.localize(`f2e-grid-enhancements.general.region.tiles.options.${key}`);

function askTracingOptions(tiles) {
	const defaults = lastChosenOptions ?? {
		threshold: tiles[0].document.texture.alphaThreshold || 0.75,
		resolution: 'medium',
		smoothing: 1
	};
	const formGroup = (label, input, hint) =>
		`<div class="form-group"><label>${localizeOption(label)}</label><div class="form-fields">${input}</div>${hint ? `<p class="hint">${localizeOption(hint)}</p>` : ''}</div>`;
	const numberInput = (name, value, attributes) => `<input type="number" name="${name}" value="${value}" ${attributes}>`;
	const content = [
		formGroup(
			'resolution',
			`<select name="resolution">${RESOLUTIONS.map(resolution => `<option value="${resolution}" ${resolution === defaults.resolution ? 'selected' : ''}>${localizeOption(`resolution-${resolution}`)}</option>`).join('')}</select>`
		),
		formGroup('smoothing', numberInput('smoothing', defaults.smoothing, 'min="0" step="0.5"'), 'smoothing-hint'),
		formGroup('threshold', `<range-picker name="threshold" value="${defaults.threshold}" min="0" max="1" step="0.01" data-dtype="Number"></range-picker>`, 'threshold-hint')
	].join('');
	return foundry.applications.api.DialogV2.input({
		window: {title: 'f2e-grid-enhancements.general.region.tiles.create', icon: 'fa-solid fa-cubes'},
		content,
		ok: {label: 'f2e-grid-enhancements.general.region.tiles.options.create', icon: 'fa-solid fa-circle-plus'}
	});
}

// x and y are its anchor (the texture anchor, the centre by default), which it
// rotates around.
function rectangleShape(tile) {
	const {x, y, width, height, anchorX, anchorY, rotation} = tile.shape;
	return {type: 'rectangle', x, y, width, height, anchorX, anchorY, rotation, hole: false};
}

// Null when the texture cannot be read. The alpha grid core uses for tile
// hit-testing is traced into outlines, smoothed, mapped into the scene through the tile mesh's transform (so mirroring,
// scaling, fitting and rotation apply), and unioned.
function opaqueShapes(tile, {threshold, resolution, smoothing}) {
	const mesh = tile.mesh;
	const texture = mesh?.texture;
	if (!texture?.valid) return null;
	const alpha = foundry.canvas.TextureLoader.getTextureAlphaData(texture, textureScaleForTracing(tile, texture, resolution));
	if (!alpha?.data.length) return [];
	const columns = alpha.maxX - alpha.minX;
	const rows = alpha.maxY - alpha.minY;
	const minimumAlpha = Math.ceil(threshold * 255);
	const loops = traceAlphaLoops(alpha.data, columns, rows, value => value >= minimumAlpha);
	// texture pixels per alpha sample, and the scene area of one sample (the transform's determinant scales areas)
	const sampleX = texture.width / alpha.width;
	const sampleY = texture.height / alpha.height;
	const transform = mesh.canvasTransform;
	const sampleArea = sampleX * sampleY * Math.abs(transform.a * transform.d - transform.b * transform.c);
	const {x: anchorX, y: anchorY} = mesh.anchor;
	const scale = CONST.CLIPPER_SCALING_FACTOR;
	const paths = loops.map(loop =>
		simplifyLoop(loop, smoothing).map(([column, row]) => {
			const local = {
				x: (column + alpha.minX) * sampleX - anchorX * texture.width,
				y: (row + alpha.minY) * sampleY - anchorY * texture.height
			};
			const point = transform.apply(local);
			return {X: Math.round(point.x * scale), Y: Math.round(point.y * scale)};
		})
	);
	const tree = clip(paths, [], ClipperLib.ClipType.ctUnion, new ClipperLib.PolyTree());
	return polyTreeShapes(tree, {minimumArea: SPECK_SAMPLES * sampleArea});
}

// Closed loops of [column, row] corners. Each solid sample's sides facing a non-solid one are joined into loops going clockwise around the solid area (on screen, y
// down), so holes go the other way. Where two pieces touch at only a corner, the walk turns right, keeping them apart.
function traceAlphaLoops(data, columns, rows, isSolid) {
	const isSolidSample = (column, row) => column >= 0 && row >= 0 && column < columns && row < rows && isSolid(data[row * columns + column]);
	const cornerKey = (x, y) => y * (columns + 1) + x;
	const outgoingSidesByCorner = new Map();
	const addSide = (x0, y0, x1, y1) => {
		const start = cornerKey(x0, y0);
		let sides = outgoingSidesByCorner.get(start);
		if (!sides) outgoingSidesByCorner.set(start, (sides = []));
		sides.push({x0, y0, x1, y1});
	};
	for (let row = 0; row < rows; row++) {
		for (let column = 0; column < columns; column++) {
			if (!isSolidSample(column, row)) continue;
			if (!isSolidSample(column, row - 1)) addSide(column, row, column + 1, row);
			if (!isSolidSample(column + 1, row)) addSide(column + 1, row, column + 1, row + 1);
			if (!isSolidSample(column, row + 1)) addSide(column + 1, row + 1, column, row + 1);
			if (!isSolidSample(column - 1, row)) addSide(column, row + 1, column, row);
		}
	}
	const removeSide = (start, side) => {
		const sides = outgoingSidesByCorner.get(start);
		sides.splice(sides.indexOf(side), 1);
		if (!sides.length) outgoingSidesByCorner.delete(start);
	};
	const loops = [];
	while (outgoingSidesByCorner.size) {
		const [startKey, startSides] = outgoingSidesByCorner.entries().next().value;
		let side = startSides[0];
		const loop = [];
		for (;;) {
			loop.push([side.x0, side.y0]);
			removeSide(cornerKey(side.x0, side.y0), side);
			const endKey = cornerKey(side.x1, side.y1);
			if (endKey === startKey) break;
			const next = outgoingSidesByCorner.get(endKey);
			if (!next) break;
			// a right turn first, then straight on, then left
			const dx = side.x1 - side.x0;
			const dy = side.y1 - side.y0;
			const turnPreference = candidate => {
				const candidateX = candidate.x1 - candidate.x0;
				const candidateY = candidate.y1 - candidate.y0;
				return candidateX === -dy && candidateY === dx ? 0 : candidateX === dx && candidateY === dy ? 1 : 2;
			};
			side = next.reduce((best, candidate) => (turnPreference(candidate) < turnPreference(best) ? candidate : best));
		}
		if (loop.length >= 3) loops.push(loop);
	}
	return loops;
}

// Douglas-Peucker; collinear points are always dropped.
function simplifyLoop(points, tolerance) {
	if (points.length < 4) return points;
	// split at the first point and the point farthest from it, and simplify both halves
	let farthest = 0;
	let farthestDistance = -1;
	for (let index = 1; index < points.length; index++) {
		const distance = (points[index][0] - points[0][0]) ** 2 + (points[index][1] - points[0][1]) ** 2;
		if (distance > farthestDistance) {
			farthestDistance = distance;
			farthest = index;
		}
	}
	const first = simplifyLine(points.slice(0, farthest + 1), tolerance);
	const second = simplifyLine([...points.slice(farthest), points[0]], tolerance);
	return [...first.slice(0, -1), ...second.slice(0, -1)];
}

function simplifyLine(points, tolerance) {
	const isKept = new Uint8Array(points.length);
	isKept[0] = isKept[points.length - 1] = 1;
	const ranges = [[0, points.length - 1]];
	while (ranges.length) {
		const [start, end] = ranges.pop();
		const [ax, ay] = points[start];
		const [bx, by] = points[end];
		const length = Math.hypot(bx - ax, by - ay);
		let farthest = -1;
		let farthestDistance = tolerance;
		for (let index = start + 1; index < end; index++) {
			const [pointX, pointY] = points[index];
			const distance = length ? Math.abs((bx - ax) * (ay - pointY) - (ax - pointX) * (by - ay)) / length : Math.hypot(pointX - ax, pointY - ay);
			if (distance > farthestDistance) {
				farthestDistance = distance;
				farthest = index;
			}
		}
		if (farthest < 0) continue;
		isKept[farthest] = 1;
		ranges.push([start, farthest], [farthest, end]);
	}
	return points.filter((point, index) => isKept[index]);
}
