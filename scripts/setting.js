// Caching verions of the base settings interactions

const settingCache = new Map();

export function get(key) {
	if (!settingCache.has(key)) settingCache.set(key, game.settings.get('f2e-grid-enhancements', key));
	return settingCache.get(key);
}

export function set(key, value) {
	settingCache.set(key, value);
	return game.settings.set('f2e-grid-enhancements', key, value);
}

export function rem(key) {
	settingCache.delete(key);
}

export function register(key, type, value, opts = {}) {
	const {onChange, ...options} = opts;
	game.settings.register('f2e-grid-enhancements', key, {
		name: `f2e-grid-enhancements.setting.${key}.name`,
		hint: `f2e-grid-enhancements.setting.${key}.hint`,
		scope: 'world',
		config: true,
		type,
		default: value,
		...options,
		onChange: (...args) => {
			rem(key);
			onChange?.(...args);
		}
	});
}
