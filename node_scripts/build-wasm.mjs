// scripts/helpers/wasm.js loads the output (the raycast, the scene store and the floor lighting); the module needs it, so the
// build fails without Rust. It is copied beside the crate too, so the module runs (and is tested) from the source folder.
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';

const BUILT_PATH = 'wasm/target/wasm32-unknown-unknown/release/f2e_grid.wasm';
const OUTPUT_PATHS = ['build/wasm/f2e_grid.wasm', 'wasm/f2e_grid.wasm'];
try {
	execFileSync('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown', '--manifest-path', 'wasm/Cargo.toml'], {stdio: 'inherit'});
} catch (error) {
	console.error(
		`Could not build the WebAssembly module (${error.message.split('\n')[0]}). It needs Rust with the wasm32-unknown-unknown target: https://rustup.rs, then rustup target add wasm32-unknown-unknown.`
	);
	process.exit(1);
}
fs.mkdirSync('build/wasm', {recursive: true});
for (const outputPath of OUTPUT_PATHS) fs.copyFileSync(BUILT_PATH, outputPath);
console.log(`Built the WebAssembly module in ${OUTPUT_PATHS.join(' and ')}`);
