const cachedValuesByKey = new Map();

export function get(key) {
	if (!cachedValuesByKey.has(key)) cachedValuesByKey.set(key, game.settings.get('f2e-grid-enhancements', key));
	return cachedValuesByKey.get(key);
}

export function set(key, value) {
	rem(key);
	return game.settings.set('f2e-grid-enhancements', key, value);
}

function rem(key) {
	cachedValuesByKey.delete(key);
}

export function register(key, type, options = {}) {
	const {onChange, ...config} = options;
	game.settings.register('f2e-grid-enhancements', key, {
		name: `f2e-grid-enhancements.setting.${key}.name`,
		hint: `f2e-grid-enhancements.setting.${key}.hint`,
		scope: 'world',
		config: true,
		type,
		...config,
		onChange: (...args) => {
			rem(key);
			onChange?.(...args);
		}
	});
}
