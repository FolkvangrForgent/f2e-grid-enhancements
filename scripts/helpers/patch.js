import * as log from './log.js';

let libWrapperReady = false;
const callbacksWaitingForLibWrapper = [];
Hooks.once('libWrapper.Ready', () => {
	libWrapperReady = true;
	for (const callback of callbacksWaitingForLibWrapper) {
		callback();
	}
	callbacksWaitingForLibWrapper.length = 0;
});

export function defer(callback) {
	if (libWrapperReady) {
		callback();
	} else {
		callbacksWaitingForLibWrapper.push(callback);
	}
}

export function add(target, wrapper) {
	defer(() => {
		try {
			libWrapper.register('f2e-grid-enhancements', target, function (wrapped, ...args) {
				try {
					return wrapper(wrapped, this, ...args);
				} catch (error) {
					log.warn(`${target} errored`, error);
					return wrapped(...args);
				}
			});
			log.info(`${target} patched`);
		} catch (error) {
			log.error(`${target} libWrapper.register failed`, error);
		}
	});
}

// For methods no global path reaches, so libWrapper cannot. Wrapping the same method of the same object again does nothing.
const wrappedMethodNamesByObject = new WeakMap();
export function method(object, methodName, consoleLabel, wrapper) {
	let wrappedNames = wrappedMethodNamesByObject.get(object);
	if (wrappedNames?.has(methodName)) return;
	const original = object[methodName];
	if (typeof original !== 'function') {
		log.error(`${consoleLabel} is not a method`);
		return;
	}
	object[methodName] = function (...args) {
		const wrapped = (...wrappedArgs) => original.apply(this, wrappedArgs);
		try {
			return wrapper(wrapped, this, ...args);
		} catch (error) {
			log.warn(`${consoleLabel} errored`, error);
			return wrapped(...args);
		}
	};
	if (!wrappedNames) wrappedMethodNamesByObject.set(object, (wrappedNames = new Set()));
	wrappedNames.add(methodName);
	log.info(`${consoleLabel} patched`);
}
