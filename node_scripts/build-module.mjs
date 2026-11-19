// Build the module into build/: the compendiums (compiled from packs/ by build-packs.mjs), the scripts and languages, and
// module.json with its release placeholders filled in (a release fills them first, then zips build/; see
// .github/workflows/main.yml). build/ can be copied or linked into Foundry's modules folder as f2e-grid-enhancements.
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';

const BUILD = 'build';
const SHIPPED = ['scripts', 'languages'];

const git = (...args) => {
	try {
		return execFileSync('git', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();
	} catch {
		return '';
	}
};

fs.rmSync(BUILD, {recursive: true, force: true});
fs.mkdirSync(BUILD);
execFileSync(process.execPath, ['node_scripts/build-packs.mjs'], {stdio: 'inherit'});
for (const path of SHIPPED) fs.cpSync(path, `${BUILD}/${path}`, {recursive: true});

// a local build: the version from git (the latest tag, plus commits since it), the repository's page, and no manifest or
// download, so Foundry does not offer to update it from a release
const version = (git('describe', '--tags', '--always', '--dirty') || 'dev').replace(/^v/, '');
const url = git('remote', 'get-url', 'origin').replace(/\.git$/, '');
const manifest = fs.readFileSync('module.json', 'utf8').replaceAll('#{VERSION}#', version).replaceAll('#{URL}#', url).replaceAll('#{MANIFEST}#', '').replaceAll('#{DOWNLOAD}#', '');
fs.writeFileSync(`${BUILD}/module.json`, manifest);

console.log(`Built f2e-grid-enhancements ${version} in ${BUILD}/`);
