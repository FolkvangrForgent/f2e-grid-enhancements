// A release fills module.json's placeholders before this runs, then zips build/ (.github/workflows/main.yml).
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';

const BUILD_FOLDER = 'build';
const COPIED_FOLDERS = ['scripts', 'languages'];

const gitOutput = (...args) => {
	try {
		return execFileSync('git', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();
	} catch {
		return '';
	}
};

fs.rmSync(BUILD_FOLDER, {recursive: true, force: true});
fs.mkdirSync(BUILD_FOLDER);
execFileSync(process.execPath, ['node_scripts/build-packs.mjs'], {stdio: 'inherit'});
execFileSync(process.execPath, ['node_scripts/build-wasm.mjs'], {stdio: 'inherit'});
for (const path of COPIED_FOLDERS) fs.cpSync(path, `${BUILD_FOLDER}/${path}`, {recursive: true});

// No manifest or download, so Foundry does not offer to update a local build from a release.
const version = (gitOutput('describe', '--tags', '--always', '--dirty') || 'dev').replace(/^v/, '');
const url = gitOutput('remote', 'get-url', 'origin').replace(/\.git$/, '');
const manifest = fs.readFileSync('module.json', 'utf8').replaceAll('#{VERSION}#', version).replaceAll('#{URL}#', url).replaceAll('#{MANIFEST}#', '').replaceAll('#{DOWNLOAD}#', '');
fs.writeFileSync(`${BUILD_FOLDER}/module.json`, manifest);

console.log(`Built f2e-grid-enhancements ${version} in ${BUILD_FOLDER}/`);
