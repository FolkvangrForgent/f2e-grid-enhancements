import * as setting from '../../helpers/setting.js';
import * as refresh from './refresh.js';

function angle(key, initial) {
	setting.register(key, new foundry.data.fields.AngleField({required: true, persisted: true, nullable: false, initial}));
}

function boolean(key, initial, onChange) {
	setting.register(key, new foundry.data.fields.BooleanField({required: true, persisted: true, nullable: false, initial}), onChange ? {onChange} : undefined);
}

export function register() {
	angle('f2e.hex.cone-template-angle', 60);
	angle('f2e.square.cone-template-angle', 90);
	angle('f2e.gridless.cone-template-angle', 90);
	angle('f2e.hex.cone-snapping-angle', 30);
	angle('f2e.square.cone-snapping-angle', 45);
	angle('f2e.gridless.cone-snapping-angle', 15);
	boolean('f2e.aura.collisions-highlight', true, () => refresh.tokens());
	boolean('f2e.aura.defeated-disable', true, () => refresh.auras());
	boolean('f2e.reach-exception', true);
}
