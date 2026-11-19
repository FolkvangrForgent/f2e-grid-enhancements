// npm run link [-- <Foundry data folder>] [-- --force]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';

const MODULE_ID = 'f2e-grid-enhancements';
const BUILD_FOLDER = path.resolve('build');
const HOME_FOLDER = os.homedir();

const cliArguments = process.argv.slice(2);
const replaceInstalledCopy = cliArguments.includes('--force');
const dataFolderArgument = cliArguments.find(argument => !argument.startsWith('--'));

function platformDefaultDataFolder() {
	switch (process.platform) {
		case 'win32':
			return path.join(process.env.LOCALAPPDATA ?? path.join(HOME_FOLDER, 'AppData', 'Local'), 'FoundryVTT', 'Data');
		case 'darwin':
			return path.join(HOME_FOLDER, 'Library', 'Application Support', 'FoundryVTT', 'Data');
		default:
			return path.join(process.env.XDG_DATA_HOME ?? path.join(HOME_FOLDER, '.local', 'share'), 'FoundryVTT', 'Data');
	}
}

function expandTilde(pathText) {
	if (pathText === '~') return HOME_FOLDER;
	const startsWithTildeSlash = pathText.startsWith('~/') || pathText.startsWith(`~${path.sep}`);
	return startsWithTildeSlash ? path.join(HOME_FOLDER, pathText.slice(2)) : pathText;
}

function replaceHomeWithTilde(pathText) {
	if (pathText === HOME_FOLDER) return '~';
	return pathText.startsWith(HOME_FOLDER + path.sep) ? `~${pathText.slice(HOME_FOLDER.length)}` : pathText;
}

function exitWithError(message) {
	console.error(message);
	process.exit(1);
}

const modulesFolderIn = dataFolder => path.join(dataFolder, 'modules');
const containsModulesFolder = dataFolder => fs.existsSync(modulesFolderIn(dataFolder));

function isFolderOrLinkToFolder(parentFolder, entry) {
	if (entry.isDirectory()) return true;
	if (!entry.isSymbolicLink()) return false;
	return fs.statSync(path.join(parentFolder, entry.name), {throwIfNoEntry: false})?.isDirectory() ?? false;
}

function completeFolderPath(typedLine) {
	const typedPath = typedLine === '~' ? '~/' : typedLine;
	const lastSeparatorEnd = Math.max(typedPath.lastIndexOf('/'), typedPath.lastIndexOf(path.sep)) + 1;
	const typedParent = typedPath.slice(0, lastSeparatorEnd);
	const typedNameStart = typedPath.slice(lastSeparatorEnd);
	const parentFolder = path.resolve(expandTilde(typedParent || '.'));
	const showHiddenFolders = typedNameStart.startsWith('.');
	let completions = [];
	try {
		completions = fs
			.readdirSync(parentFolder, {withFileTypes: true})
			.filter(entry => entry.name.startsWith(typedNameStart) && (showHiddenFolders || !entry.name.startsWith('.')))
			.filter(entry => isFolderOrLinkToFolder(parentFolder, entry))
			.map(entry => `${typedParent}${entry.name}/`)
			.sort();
	} catch {}
	return [completions, typedLine];
}

async function promptForDataFolder(suggestedFolder) {
	const prompt = readline.createInterface({input: process.stdin, output: process.stdout, completer: completeFolderPath, terminal: true});
	prompt.on('SIGINT', () => {
		prompt.close();
		process.stdout.write('\n');
		process.exit(130);
	});
	try {
		let prefilledText = replaceHomeWithTilde(suggestedFolder);
		for (;;) {
			const pendingAnswer = prompt.question('Foundry data folder (the one holding "modules"): ');
			prompt.write(prefilledText);
			const answer = (await pendingAnswer).trim();
			if (!answer) continue;
			const answeredFolder = path.resolve(expandTilde(answer));
			if (containsModulesFolder(answeredFolder)) return answeredFolder;
			console.error(`No modules folder at ${replaceHomeWithTilde(modulesFolderIn(answeredFolder))}.`);
			prefilledText = answer;
		}
	} finally {
		prompt.close();
	}
}

const runningInTerminal = process.stdin.isTTY && process.stdout.isTTY;
let dataFolder;
if (dataFolderArgument) dataFolder = path.resolve(expandTilde(dataFolderArgument));
else if (runningInTerminal) dataFolder = await promptForDataFolder(platformDefaultDataFolder());
else dataFolder = platformDefaultDataFolder();

const modulesFolder = modulesFolderIn(dataFolder);
if (!fs.existsSync(modulesFolder)) exitWithError(`No modules folder at ${modulesFolder}: pass Foundry's data folder (the one holding "modules").`);
if (!fs.existsSync(path.join(BUILD_FOLDER, 'module.json'))) console.warn('build/ has no module.json yet: run "npm run build:module" before starting Foundry.');

const linkPath = path.join(modulesFolder, MODULE_ID);
const existingEntry = fs.lstatSync(linkPath, {throwIfNoEntry: false});
if (existingEntry?.isSymbolicLink()) {
	const existingLinkTarget = path.resolve(modulesFolder, fs.readlinkSync(linkPath));
	if (existingLinkTarget === BUILD_FOLDER) {
		console.log(`Already linked: ${linkPath} -> ${BUILD_FOLDER}`);
		process.exit(0);
	}
	fs.unlinkSync(linkPath);
} else if (existingEntry) {
	if (!replaceInstalledCopy) exitWithError(`${linkPath} already exists and is not a link (an installed copy?). Remove it, or run again with --force to delete it.`);
	fs.rmSync(linkPath, {recursive: true, force: true});
	console.log(`Deleted ${linkPath}`);
}

fs.mkdirSync(BUILD_FOLDER, {recursive: true});
const windowsJunctionOrFolderLink = process.platform === 'win32' ? 'junction' : 'dir';
fs.symlinkSync(BUILD_FOLDER, linkPath, windowsJunctionOrFolderLink);
console.log(`Linked ${linkPath} -> ${BUILD_FOLDER}`);
