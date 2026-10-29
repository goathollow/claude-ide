// Builds dist/Claude IDE.app, the macOS app, around the executable npm run
// build:exe made. The app (packaging/macos/ClaudeIDE.swift) shows the IDE in
// windows of its own and runs the executable as its server. It needs Xcode or
// its command line tools (xcode-select --install) for swiftc.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'packaging', 'macos');
const EXE = path.join(ROOT, 'dist', 'claude-ide');
const APP = path.join(ROOT, 'dist', 'Claude IDE.app');
const CONTENTS = path.join(APP, 'Contents');

if (process.platform !== 'darwin') {
  console.error('The Mac app can only be built on macOS.');
  process.exit(1);
}
if (!fs.existsSync(EXE)) {
  console.error('Run npm run build:exe first.');
  process.exit(1);
}

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
// The app runs on the macOS versions that the Node runtime inside it supports.
const minMacOS = /\bminos\s+([\d.]+)/.exec(execFileSync('otool', ['-l', EXE], { encoding: 'utf8' }))?.[1];
if (!minMacOS) throw new Error(`Couldn't tell which macOS versions ${EXE} supports`);
const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';

fs.rmSync(APP, { recursive: true, force: true });
fs.mkdirSync(path.join(CONTENTS, 'MacOS'), { recursive: true });
fs.mkdirSync(path.join(CONTENTS, 'Resources'));

run('xcrun', [
  '--sdk', 'macosx', 'swiftc', '-O', '-swift-version', '5', '-parse-as-library',
  '-target', `${arch}-apple-macos${minMacOS}`,
  '-o', path.join(CONTENTS, 'MacOS', 'Claude IDE'),
  path.join(SRC, 'ClaudeIDE.swift'),
]);
fs.copyFileSync(EXE, path.join(CONTENTS, 'MacOS', 'claude-ide'));
fs.chmodSync(path.join(CONTENTS, 'MacOS', 'claude-ide'), 0o755);
fs.copyFileSync(path.join(SRC, 'AppIcon.icns'), path.join(CONTENTS, 'Resources', 'AppIcon.icns'));
fs.writeFileSync(path.join(CONTENTS, 'Info.plist'), fs.readFileSync(path.join(SRC, 'Info.plist'), 'utf8')
  .replace(/^<!--.*-->\n/m, '')
  .replaceAll('${VERSION}', version)
  .replaceAll('${MIN_MACOS}', minMacOS));
fs.writeFileSync(path.join(CONTENTS, 'PkgInfo'), 'APPL????');

// macOS only runs signed code. build:exe signed claude-ide ad hoc; sign the
// app the same way, which also seals its other files.
run('codesign', ['--force', '--sign', '-', APP]);
run('codesign', ['--verify', '--strict', '--deep', APP]);

console.log(`\nBuilt ${path.relative(ROOT, APP)} ${version} for ${arch}, macOS ${minMacOS} and later`);
