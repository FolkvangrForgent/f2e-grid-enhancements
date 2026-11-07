// Patching at anytime

let libWrapperReady = false;
const libWrapperQueue = [];
Hooks.once('libWrapper.Ready', () => {
	libWrapperReady = true;
	for (const libWrapperFunc of libWrapperQueue) {
		libWrapperFunc()
	}
	libWrapperQueue.length = 0;
});

export function defer(callback) {
	if (libWrapperReady) {
		callback();
	} else {
		libWrapperQueue.push(callback);
	}
}

export function add(target, func) {
	defer(() => {
		try {
			libWrapper.register('f2e-grid-enhancements', target, function(wrapped, ...args) {
				try {
					return func(wrapped, this, ...args);
				} catch (error) {
					console.warn(`${game.i18n.localize('f2e-grid-enhancements.name')} | ${target} errored`, error);
					return wrapped(...args);
				}
			});
			console.info(`${game.i18n.localize('f2e-grid-enhancements.name')} | ${target} patched`);
		} catch (error) {
			console.error(`${game.i18n.localize('f2e-grid-enhancements.name')} | ${target} libWrapper.register failed`, error);
		}
	});

}

export function del(target) {
	defer(() => {
		try {
			libWrapper.unregister('f2e-grid-enhancements', target);
			console.info(`${game.i18n.localize('f2e-grid-enhancements.name')} | ${target} unpatched`);
		} catch (error) {
			console.error(`${game.i18n.localize('f2e-grid-enhancements.name')} | ${target} libWrapper.unregister failed`, error);
		}
	});
}