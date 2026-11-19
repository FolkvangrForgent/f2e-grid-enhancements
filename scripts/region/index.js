// Core's Draw Grid Spaces region tool for gridless scenes, where core hides it, with its icon and text, working as it does
// on square and hex grids: each click adds a one-space point (a circle) where it is, a preview point follows the pointer,
// a double-click finishes and a right-click removes the last point. It runs through core's drawing workflow (preview, adding to a selected region, the hole tool), with the
// points kept in the interaction data and turned into the preview's shapes.
import * as patch from '../helpers/patch.js';
import './optimize.js';
import './tile.js';
import './barrier.js';

const TOOL = 'gridPoint';
const isGridPointTool = () => game.activeTool === TOOL && !!canvas.grid?.isGridless;
const pointRadius = () => canvas.dimensions.size / 2;

Hooks.once('init', () => {
	const target = 'foundry.canvas.layers.RegionLayer.prototype';
	patch.add(`${target}._onClickLeft`, onClickLeft);
	patch.add(`${target}._onClickLeft2`, onClickLeft2);
	patch.add(`${target}._onDragLeftStart`, onDragLeftStart);
	patch.add(`${target}._onDragLeftMove`, onDragLeftMove);
	patch.add(`${target}._onDragLeftDrop`, onDragLeftDrop);
	patch.add(`${target}._onDragLeftCancel`, onDragLeftCancel);
	patch.add(`${target}._updateDragPreview`, updateDragPreview);
});

// The Draw Grid Spaces tool's icon is one space of the scene's grid: a square, a hex, or on gridless scenes a circle.
Hooks.on('getSceneControlButtons', controls => {
	const tools = controls?.regions?.tools;
	if (!tools || !canvas?.grid) return;
	if (!canvas.grid.isGridless) {
		if (tools.grid) tools.grid.icon = canvas.grid.isHexagonal ? 'fa-solid fa-hexagon' : 'fa-solid fa-square';
		return;
	}
	if (canvas.regions?.templateMode) return;
	tools[TOOL] = {
		name: TOOL,
		order: tools.grid?.order ?? 11,
		title: 'CONTROLS.RegionGrid',
		icon: 'fa-solid fa-circle',
		control: true,
		creation: true,
		shapeData: {type: 'circle', x: 0, y: 0, radius: 0},
		toolclip: {
			heading: 'CONTROLS.RegionGrid',
			items: foundry.applications.ui.SceneControls.buildToolclipItems([
				{paragraph: 'CONTROLS.RegionShape'},
				{heading: 'CONTROLS.CommonDraw', content: 'CONTROLS.RegionGridP'},
				{paragraph: 'CONTROLS.RegionPerformance'}
			])
		}
	};
});

// The points' circles, with the last point (the one following the pointer) included.
function pointShapes(interaction) {
	const hole = interaction.shape.hole;
	return interaction.gridPoints.map(({x, y}) => ({type: 'circle', x, y, radius: pointRadius(), hole}));
}

function addPoint(layer, event, point) {
	const points = event.interactionData.gridPoints;
	points.splice(-1, 0, {x: point.x, y: point.y});
	layer._updateDragPreview(event);
}

// The last fixed point, before the one following the pointer.
const lastFixedPoint = interaction => interaction.gridPoints.at(-2);

function onClickLeft(wrapped, layer, event) {
	const interaction = event.interactionData;
	if (interaction.gridPoints) {
		const last = lastFixedPoint(interaction);
		const {destination} = interaction;
		if (!last || last.x !== destination.x || last.y !== destination.y) addPoint(layer, event, destination);
		return;
	}
	// start drawing at once, as core does for Draw Grid
	if (layer.active && isGridPointTool()) {
		canvas.mouseInteractionManager._instantDrag = true;
		return;
	}
	return wrapped(event);
}

function onClickLeft2(wrapped, layer, event) {
	if (event.interactionData.gridPoints) {
		event.interactionData.cancelled = true;
		return;
	}
	return wrapped(event);
}

function onDragLeftStart(wrapped, layer, event) {
	if (!isGridPointTool()) return wrapped(event);
	const interaction = event.interactionData;
	const {x, y} = interaction.origin;
	// the first point, and the point that follows the pointer
	interaction.gridPoints = [
		{x, y},
		{x, y}
	];
	const result = wrapped(event);
	interaction.shape.updateSource({x, y, radius: pointRadius()});
	interaction.cancelled = false;
	layer._updateDragPreview(event);
	return result;
}

// The preview point follows the pointer; only clicks add points, as with grid spaces.
function onDragLeftMove(wrapped, layer, event) {
	const interaction = event.interactionData;
	if (!interaction.gridPoints) return wrapped(event);
	const {destination} = interaction;
	interaction.gridPoints.splice(-1, 1, {x: destination.x, y: destination.y});
	layer._updateDragPreview(event);
}

function onDragLeftDrop(wrapped, layer, event) {
	const interaction = event.interactionData;
	if (!interaction.gridPoints) return wrapped(event);
	if (!interaction.cancelled) {
		event.preventDefault();
		return;
	}
	// drop the point following the pointer
	interaction.gridPoints.splice(-1, 1);
	layer._updateDragPreview(event);
	return wrapped(event);
}

function onDragLeftCancel(wrapped, layer, event) {
	const interaction = event.interactionData;
	if (interaction.gridPoints && !interaction.cancelled && interaction.gridPoints.length > 2) {
		event.preventDefault();
		interaction.gridPoints.splice(-2, 1);
		layer._updateDragPreview(event);
		return;
	}
	return wrapped(event);
}

// The preview's shapes: those of the region being added to (if any), then the points.
function updateDragPreview(wrapped, layer, event) {
	const interaction = event.interactionData;
	if (!interaction.gridPoints) return wrapped(event);
	const shapes = interaction.preview._original?.document.toObject().shapes ?? [];
	shapes.push(...pointShapes(interaction));
	interaction.preview.document.updateSource({shapes});
	interaction.preview.renderFlags.set({refreshShapes: true});
}
