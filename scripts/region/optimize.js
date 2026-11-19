// Core builds a region from its shapes in order (runs of solid shapes unioned in, runs of holes cut out, holes before the
// first solid ignored), so the result is written in nesting order: outlines as solids, their holes, islands inside those
// holes, and so on, which core builds back into exactly the same area. Wall restriction is applied by core on top, so it is
// left out here.

import {clip} from '../helpers/clipper.js';

Hooks.on('renderRegionConfig', (sheet, element) => {
	const controls = element.querySelector('section[data-tab="shapes"] > header .region-element-controls');
	if (!controls || !sheet.isEditable || controls.querySelector('.f2e-grid-enhancements-optimize')) return;
	const button = document.createElement('button');
	button.type = 'button';
	button.className = 'ui-control icon fa-solid fa-wand-magic-sparkles f2e-grid-enhancements-optimize';
	button.dataset.tooltip = '';
	button.ariaLabel = game.i18n.localize('f2e-grid-enhancements.general.region.optimize');
	button.addEventListener('click', () => optimizeShapes(sheet.document));
	controls.prepend(button);
});

// A region of one shape has nothing to optimize (a polygon would only be a copy, and a circle or rectangle is already simpler
// than one), unless it is a Draw Grid Spaces shape, which holds every space it covers.
async function optimizeShapes(region) {
	const {shapes} = region;
	if (!shapes.length || (shapes.length === 1 && shapes[0].type !== 'grid')) {
		ui.notifications.info('f2e-grid-enhancements.general.region.optimized-already', {localize: true});
		return;
	}
	await region.update({shapes: optimizedShapes(shapes)});
}

function optimizedShapes(shapes) {
	let index = shapes.findIndex(shape => !shape.hole);
	if (index < 0) return [];
	let accumulatedArea = [];
	const tree = new ClipperLib.PolyTree();
	while (index < shapes.length) {
		const isHole = shapes[index].hole;
		const paths = [];
		while (index < shapes.length && shapes[index].hole === isHole) paths.push(...shapes[index++].clipperPaths);
		const clipType = isHole ? ClipperLib.ClipType.ctDifference : ClipperLib.ClipType.ctUnion;
		// the last run writes the tree
		accumulatedArea = clip(accumulatedArea, paths, clipType, index < shapes.length ? [] : tree);
	}
	return polyTreeShapes(tree);
}

// In nesting order: even depths as solids, odd depths as holes. Outlines smaller than minimumAreaSquarePixels are left out with
// everything inside them.
export function polyTreeShapes(tree, {holes = true, minimumArea: minimumAreaSquarePixels = 0} = {}) {
	const scale = CONST.CLIPPER_SCALING_FACTOR;
	const contoursByDepth = [];
	const collect = (node, nestingDepth) => {
		for (const child of node.Childs()) {
			const contour = child.Contour();
			if (Math.abs(ClipperLib.Clipper.Area(contour)) < minimumAreaSquarePixels * scale * scale) continue;
			(contoursByDepth[nestingDepth] ??= []).push(contour);
			if (holes) collect(child, nestingDepth + 1);
		}
	};
	collect(tree, 0);
	return contoursByDepth.flatMap((contours, nestingDepth) =>
		contours.map(contour => ({
			type: 'polygon',
			points: contour.flatMap(point => [point.X / scale, point.Y / scale]),
			hole: nestingDepth % 2 === 1
		}))
	);
}
