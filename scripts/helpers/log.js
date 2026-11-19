const withModulePrefix = message => `${game.i18n.localize('f2e-grid-enhancements.name')} | ${message}`;

export const info = (message, ...details) => console.info(withModulePrefix(message), ...details);
export const warn = (message, ...details) => console.warn(withModulePrefix(message), ...details);
export const error = (message, ...details) => console.error(withModulePrefix(message), ...details);
