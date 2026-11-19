import {gridString} from '../helpers/grid.js';
import * as setting from '../helpers/setting.js';

export function templateSnappingMode(wrapped, region) {
	const {CENTER, EDGE_MIDPOINT, VERTEX} = CONST.GRID_SNAPPING_MODES;
	switch (region.areaShape) {
		case 'point':
			return CENTER;
		case 'emanation':
			return CENTER | VERTEX;
		case 'burst':
			return VERTEX;
		case 'cone':
			return CENTER | EDGE_MIDPOINT | VERTEX;
		case 'line':
			return EDGE_MIDPOINT | VERTEX;
		default:
			return wrapped();
	}
}

const LINE_ROTATION_SNAP_DEGREES = 5;
const NEGLIGIBLE_ROTATION_DEGREES = 1e-6;

function isAimable(type) {
	return type === 'cone' || type === 'line';
}

function rotationSnapDegrees(type, grid) {
	return type === 'cone' ? setting.get(`f2e.${gridString(grid)}.cone-snapping-angle`) : LINE_ROTATION_SNAP_DEGREES;
}

function isFreeRotation(event, snapDegrees) {
	return event.ctrlKey || event.metaKey || snapDegrees === 0;
}

export function placeChatTemplate(wrapped, layer, data, options = {}) {
	if (!data.displayMeasurements || data.highlightMode !== 'coverage') {
		return foundry.canvas.layers.RegionLayer.prototype.placeRegion.call(layer, data, options);
	}
	const placementData = data.shapes
		? {
				...data,
				shapes: data.shapes.map(shape => (shape.type !== 'cone' || shape.angle !== 90 ? shape : {...shape, angle: setting.get(`f2e.${gridString(canvas?.grid)}.cone-template-angle`)}))
			}
		: data;
	const placementOptions = {...options};
	const placement = {isAiming: false};
	placementOptions.onMove = function (...args) {
		const {event, position, preview, shape, snap, document} = args[0];
		if (placement.isAiming && isAimable(shape.type)) {
			const angle = rotationSnapDegrees(shape.type, document.parent.grid);
			const rotation = Math.toDegrees(Math.atan2(position.y - shape.y, position.x - shape.x));
			shape.updateSource({rotation: isFreeRotation(event, angle) ? rotation : rotation.toNearest(angle)});
			return false;
		}
		if (snap) {
			const {x, y} = document.parent.grid.getSnappedPoint(position, {mode: preview.snappingMode});
			position.x = x;
			position.y = y;
		}
		return typeof options.onMove === 'function' ? options.onMove.apply(this, args) : undefined;
	};
	placementOptions.onRotate = function (...args) {
		const {event, shape, document} = args[0];
		if (isAimable(shape.type)) {
			const angle = rotationSnapDegrees(shape.type, document.parent.grid);
			const isFree = isFreeRotation(event, angle);
			const step = isFree ? 1 : angle;
			const rotation = shape.rotation + step * Math.sign(event.deltaY);
			shape.updateSource({rotation: isFree ? rotation : rotation.toNearest(step)});
			return false;
		}
		return typeof options.onRotate === 'function' ? options.onRotate.apply(this, args) : undefined;
	};
	placementOptions.preConfirm = function (...args) {
		const {event, shape} = args[0];
		if (!placement.isAiming && isAimable(shape.type) && !event.shiftKey) {
			placement.isAiming = true;
			return false;
		}
		return typeof options.preConfirm === 'function' ? options.preConfirm.apply(this, args) : undefined;
	};
	placementOptions.preSkip = function (...args) {
		if (placement.isAiming) {
			placement.isAiming = false;
			return false;
		}
		return typeof options.preSkip === 'function' ? options.preSkip.apply(this, args) : undefined;
	};
	return foundry.canvas.layers.RegionLayer.prototype.placeRegion.call(layer, placementData, placementOptions);
}

export function snapTemplateRotation(wrapped, layer, event) {
	foundry.canvas.layers.RegionLayer.prototype._onDragLeftMove.call(layer, event);
	const shape = event.interactionData.shape;
	if (layer.templateMode && isAimable(shape?.type)) {
		const angle = rotationSnapDegrees(shape.type, canvas.scene.grid);
		const pointer = event.getLocalPosition(layer);
		const pointerRotation = Math.toDegrees(Math.atan2(pointer.y - shape.y, pointer.x - shape.x));
		const rotation = isFreeRotation(event, angle) ? pointerRotation : pointerRotation.toNearest(angle);
		const rotationChange = Math.abs(((((rotation - shape.rotation + 180) % 360) + 360) % 360) - 180);
		if (rotationChange >= NEGLIGIBLE_ROTATION_DEGREES) {
			shape.updateSource({rotation});
			layer._updateDragPreview(event);
		}
	}
}
