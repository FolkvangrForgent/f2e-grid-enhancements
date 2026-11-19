// A "Create Shapes from Controlled Tiles" button in the region config's Shapes tab, beside core's Create from Walls. Each
// controlled tile's opaque area is traced into polygons (at an opacity threshold of 0, its whole rectangle), with the
// options asked in a popup, and added to the region
// (keeping unsaved form changes, as core does). The image is checked at a resolution relative to the grid (so a larger
// tile gets more samples, the pixels of a scaled copy) or at every pixel; smoothing is measured in samples, so it means the
// same whatever the grid size or the image's resolution. Transparent areas inside a tile are kept as holes, and pieces and
// holes smaller than a few samples (specks from sampling) are left out.
import {clip} from '../helpers/clipper.js';
import {polyTreeShapes} from './optimize.js';

// the choices made last time, offered again
let lastOptions = null;

// Samples per grid space at each resolution; `full` checks every pixel of the image.
const SAMPLES_PER_SPACE = {low: 16 * 16, medium: 32 * 32, high: 64 * 64};
const RESOLUTIONS = [...Object.keys(SAMPLES_PER_SPACE), 'full'];
// no more than this many samples in all below `full`, so a huge tile stays quick to trace (high keeps its 64 x 64 per space
// up to about 64 x 64 spaces)
const MAXIMUM_SAMPLES = 4096 * 4096;
// pieces and holes smaller than this many samples are specks from sampling, and left out
const SPECK_SAMPLES = 2 * 2;

// The number of pixels in a texture's source image.
const sourcePixels = texture => texture.width * texture.height * texture.resolution ** 2;

// How much a tile's image is scaled for tracing (1 for every pixel): its area in grid spaces times the resolution's
// samples per space, never above its own pixels.
function textureScale(tile, texture, resolution) {
	if (!(resolution in SAMPLES_PER_SPACE)) return 1;
	const spaces = Math.abs(tile.document.width * tile.document.height) / canvas.dimensions.size ** 2 || 0;
	const samples = Math.min(spaces * SAMPLES_PER_SPACE[resolution], MAXIMUM_SAMPLES);
	return Math.min(1, Math.sqrt(samples / sourcePixels(texture)));
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
	const options = await askOptions(tiles);
	if (!options) return;
	lastOptions = options;
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

const localize = key => game.i18n.localize(`f2e-grid-enhancements.general.region.tiles.options.${key}`);

function askOptions(tiles) {
	const defaults = lastOptions ?? {
		threshold: tiles[0].document.texture.alphaThreshold || 0.75,
		resolution: 'medium',
		smoothing: 1
	};
	const field = (name, label, input, hint) =>
		`<div class="form-group"><label>${localize(label)}</label><div class="form-fields">${input}</div>${hint ? `<p class="hint">${localize(hint)}</p>` : ''}</div>`;
	const number = (name, value, attributes) => `<input type="number" name="${name}" value="${value}" ${attributes}>`;
	const content = [
		field(
			'resolution',
			'resolution',
			`<select name="resolution">${RESOLUTIONS.map(resolution => `<option value="${resolution}" ${resolution === defaults.resolution ? 'selected' : ''}>${localize(`resolution-${resolution}`)}</option>`).join('')}</select>`
		),
		field('smoothing', 'smoothing', number('smoothing', defaults.smoothing, 'min="0" step="0.5"'), 'smoothing-hint'),
		field('threshold', 'threshold', `<range-picker name="threshold" value="${defaults.threshold}" min="0" max="1" step="0.01" data-dtype="Number"></range-picker>`, 'threshold-hint')
	].join('');
	return foundry.applications.api.DialogV2.input({
		window: {title: 'f2e-grid-enhancements.general.region.tiles.create', icon: 'fa-solid fa-cubes'},
		content,
		ok: {label: 'f2e-grid-enhancements.general.region.tiles.options.create', icon: 'fa-solid fa-circle-plus'}
	});
}

// A tile's whole rectangle, as core places it: x and y are its anchor (the texture anchor, the centre by default), which it
// rotates around.
export function rectangleShape(tile) {
	const {x, y, width, height, anchorX, anchorY, rotation} = tile.shape;
	return {type: 'rectangle', x, y, width, height, anchorX, anchorY, rotation, hole: false};
}

// The tile's opaque area as polygon shapes, or null when its texture cannot be read. The alpha grid core uses for tile
// hit-testing is traced into outlines, smoothed, mapped into the scene through the tile mesh's transform (so mirroring,
// scaling, fitting and rotation apply), and unioned.
function opaqueShapes(tile, {threshold, resolution, smoothing}) {
	const mesh = tile.mesh;
	const texture = mesh?.texture;
	if (!texture?.valid) return null;
	const alpha = foundry.canvas.TextureLoader.getTextureAlphaData(texture, textureScale(tile, texture, resolution));
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

// The outlines of the solid samples of a grid (rows of `columns` values), as closed loops of [column, row] corners. Each
// solid sample's sides facing a non-solid one are joined into loops going clockwise around the solid area (on screen, y
// down), so holes go the other way. Where two pieces touch at only a corner, the walk turns right, keeping them apart.
export function traceAlphaLoops(data, columns, rows, isSolid) {
	const solid = (column, row) => column >= 0 && row >= 0 && column < columns && row < rows && isSolid(data[row * columns + column]);
	const key = (x, y) => y * (columns + 1) + x;
	const outgoing = new Map();
	const addSide = (x0, y0, x1, y1) => {
		const start = key(x0, y0);
		let sides = outgoing.get(start);
		if (!sides) outgoing.set(start, (sides = []));
		sides.push({x0, y0, x1, y1});
	};
	for (let row = 0; row < rows; row++) {
		for (let column = 0; column < columns; column++) {
			if (!solid(column, row)) continue;
			if (!solid(column, row - 1)) addSide(column, row, column + 1, row);
			if (!solid(column + 1, row)) addSide(column + 1, row, column + 1, row + 1);
			if (!solid(column, row + 1)) addSide(column + 1, row + 1, column, row + 1);
			if (!solid(column - 1, row)) addSide(column, row + 1, column, row);
		}
	}
	const takeSide = (start, side) => {
		const sides = outgoing.get(start);
		sides.splice(sides.indexOf(side), 1);
		if (!sides.length) outgoing.delete(start);
	};
	const loops = [];
	while (outgoing.size) {
		const [startKey, startSides] = outgoing.entries().next().value;
		let side = startSides[0];
		const loop = [];
		for (;;) {
			loop.push([side.x0, side.y0]);
			takeSide(key(side.x0, side.y0), side);
			const endKey = key(side.x1, side.y1);
			if (endKey === startKey) break;
			const next = outgoing.get(endKey);
			if (!next) break;
			// a right turn first, then straight on, then left
			const dx = side.x1 - side.x0;
			const dy = side.y1 - side.y0;
			const turn = candidate => {
				const cx = candidate.x1 - candidate.x0;
				const cy = candidate.y1 - candidate.y0;
				return cx === -dy && cy === dx ? 0 : cx === dx && cy === dy ? 1 : 2;
			};
			side = next.reduce((best, candidate) => (turn(candidate) < turn(best) ? candidate : best));
		}
		if (loop.length >= 3) loops.push(loop);
	}
	return loops;
}

// A closed loop of [x, y] points simplified by Douglas-Peucker: points within `tolerance` of the line between their
// neighbours kept on are dropped (collinear ones always).
export function simplifyLoop(points, tolerance) {
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
	const keep = new Uint8Array(points.length);
	keep[0] = keep[points.length - 1] = 1;
	const ranges = [[0, points.length - 1]];
	while (ranges.length) {
		const [start, end] = ranges.pop();
		const [ax, ay] = points[start];
		const [bx, by] = points[end];
		const length = Math.hypot(bx - ax, by - ay);
		let farthest = -1;
		let farthestDistance = tolerance;
		for (let index = start + 1; index < end; index++) {
			const [px, py] = points[index];
			const distance = length ? Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / length : Math.hypot(px - ax, py - ay);
			if (distance > farthestDistance) {
				farthestDistance = distance;
				farthest = index;
			}
		}
		if (farthest < 0) continue;
		keep[farthest] = 1;
		ranges.push([start, farthest], [farthest, end]);
	}
	return points.filter((point, index) => keep[index]);
}
