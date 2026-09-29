import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../scripts/grid/all.js', import.meta.url), 'utf8');

function measure({distance, diagonals, reach, rule = 4, isSquare = true, unit = 5}) {
	class Token {
		document = {getOccupiedGridSpaceOffsets: () => [{i: 0, j: 0}]};
	}

	const context = vm.createContext({
		CONST: {GRID_DIAGONALS: {ALTERNATING_1: 4}},
		CONFIG: {Token: {objectClass: Token}},
		canvas: {grid: {
			isSquare,
			isGridless: false,
			diagonals: rule,
			distance: unit,
			getCenterPoint: () => ({x: 50, y: 50}),
			measurePath: () => ({distance, segments: [{diagonals}]})
		}}
	});
	vm.runInContext(source.replace(/^export /gm, ''), context);
	return context.Token_object_distanceTo(null, new Token(), new Token(), {reach});
}

test('10-foot reach discounts one grid space beyond two diagonals', () => {
	assert.equal(measure({distance: 20, diagonals: 3, reach: 10}), 15);
	assert.equal(measure({distance: 30, diagonals: 4, reach: 10}), 25);
});

test('10-foot reach still covers two diagonals', () => {
	assert.equal(measure({distance: 15, diagonals: 2, reach: 10}), 10);
});

test('reach does not discount straight paths, one diagonal, or other reach values', () => {
	assert.equal(measure({distance: 20, diagonals: 0, reach: 10}), 20);
	assert.equal(measure({distance: 20, diagonals: 1, reach: 10}), 20);
	assert.equal(measure({distance: 20, diagonals: 3, reach: 5}), 20);
	assert.equal(measure({distance: 20, diagonals: 3}), 20);
});

test('alternate diagonal rules and non-square grids keep their measured distance', () => {
	assert.equal(measure({distance: 15, diagonals: 2, reach: 10, rule: 0}), 15);
	assert.equal(measure({distance: 15, diagonals: 2, reach: 10, isSquare: false}), 15);
});

test('the reach discount uses the scene grid distance', () => {
	assert.equal(measure({distance: 30, diagonals: 3, reach: 10, unit: 10}), 20);
});
