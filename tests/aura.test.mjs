import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../scripts/grid/all.js', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(source.replace(/^export /gm, ''), context);
const containsToken = (aura, token) => context.Aura_token_containsToken(null, aura, token);

function fixture() {
	const target = {hidden: false, object: {}};
	const aura = {
		token: {hidden: false, object: {distanceTo: () => 10}},
		radius: 15,
		traits: ['visual']
	};
	return {aura, target};
}

test('an undrawn aura source does not contain other tokens', () => {
	const {aura, target} = fixture();
	aura.token.object = null;
	assert.equal(containsToken(aura, target), false);
});

test('an undrawn target is excluded before measuring distance', () => {
	const {aura, target} = fixture();
	target.object = null;
	aura.token.object.distanceTo = () => assert.fail('undrawn target was measured');
	assert.equal(containsToken(aura, target), false);
});

test('an undrawn emitter does not contain itself', () => {
	const {aura} = fixture();
	aura.token.object = null;
	assert.equal(containsToken(aura, aura.token), false);
});

test('drawn tokens retain self-containment, radius, and collision checks', () => {
	const {aura, target} = fixture();
	assert.equal(containsToken(aura, aura.token), true);
	assert.equal(containsToken(aura, target), true);
	aura.token.object.distanceTo = (object, options) => {
		assert.equal(object, target.object);
		assert.deepEqual(Array.from(options.collision_types), ['sight']);
		return Infinity;
	};
	assert.equal(containsToken(aura, target), false);
});

test('hidden sources and targets stay excluded', () => {
	const {aura, target} = fixture();
	target.hidden = true;
	assert.equal(containsToken(aura, target), false);
	target.hidden = false;
	aura.token.hidden = true;
	assert.equal(containsToken(aura, target), false);
});
