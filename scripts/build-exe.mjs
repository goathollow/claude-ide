// Builds dist/claude-ide (claude-ide.exe on Windows): a copy of the Node runtime
// running this script, with the IDE embedded as a single executable application
// (https://nodejs.org/api/single-executable-applications.html).
// The result runs on machines without Node installed. It's built for the
// platform this runs on; .github/workflows/build.yml builds all of them.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { inject } from 'postject';
import { VENDOR } from '../server/vendor.js';

const { platform, arch } = process;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const WORK = path.join(DIST, 'build');
const EXE = path.join(DIST, platform === 'win32' ? 'claude-ide.exe' : 'claude-ide');
const PTY = 'node_modules/node-pty';

if (!['win32', 'darwin', 'linux'].includes(platform)) {
  console.error(`build:exe doesn't support ${platform}.`);
  process.exit(1);
}

// node-pty loads its native code from the first of these folders that has it
// (see node-pty/lib/utils.js). It ships prebuilt binaries for Windows and macOS.
// On Linux npm install compiles them into build/Release.
const ptyNative = ['build/Release', 'build/Debug', `prebuilds/${platform}-${arch}`]
  .map(d => `${PTY}/${d}`)
  .find(d => fs.existsSync(path.join(ROOT, d, 'pty.node')));
if (!ptyNative) {
  console.error(`node-pty isn't built for ${platform}-${arch}. Run npm install first` +
    (platform === 'linux' ? '; on Linux it needs python3, make and a C++ compiler.' : '.'));
  process.exit(1);
}

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, 'assets'), { recursive: true });

// 1. Bundle the server and its dependencies, except native node-pty, into one CommonJS file.
const main = path.join(WORK, 'main.cjs');
await esbuild.build({
  entryPoints: [path.join(ROOT, 'packaging', 'sea-main.cjs')],
  outfile: main,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: `node${process.versions.node.split('.')[0]}`,
  external: ['bufferutil', 'utf-8-validate'], // optional speedups for ws
  logOverride: { 'empty-import-meta': 'silent' },
  logLevel: 'warning',
});

// 2. Gather the files the executable unpacks: the web UI, the browser libraries
//    it serves, and node-pty with its native binaries for this platform.
const SKIP = /\.(map|ts|mts|cts|pdb|md)$|\.test\.js$/i;
const files = new Map(); // relative path in the app folder -> source file
function addTree(rel, keep = () => true) {
  const dir = path.join(ROOT, rel);
  for (const d of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!d.isFile() || SKIP.test(d.name)) continue;
    const full = path.join(d.parentPath, d.name);
    const key = path.relative(ROOT, full).split(path.sep).join('/');
    if (keep(key)) files.set(key, full);
  }
}
addTree('public');
for (const dir of Object.values(VENDOR)) addTree(path.join('node_modules', dir));
files.set(`${PTY}/package.json`, path.join(ROOT, PTY, 'package.json'));
addTree(`${PTY}/lib`, key => key.endsWith('.js'));
addTree(ptyNative, key => /\.(node|dll|exe)$|\/spawn-helper$/.test(key));

// 3. Compress them as SEA assets, keyed "app/<path>", plus an id for this build.
const hash = crypto.createHash('sha256').update(fs.readFileSync(main));
const assets = {};
let raw = 0, packed = 0, n = 0;
for (const [key, src] of [...files].sort()) {
  const data = fs.readFileSync(src);
  hash.update(key).update(data);
  const gz = zlib.gzipSync(data, { level: 9 });
  const out = path.join(WORK, 'assets', `${n++}.gz`);
  fs.writeFileSync(out, gz);
  assets[`app/${key}`] = out;
  raw += data.length;
  packed += gz.length;
}
const buildId = hash.digest('hex').slice(0, 12);
fs.writeFileSync(path.join(WORK, 'build-id'), buildId);
assets['build-id'] = path.join(WORK, 'build-id');

// 4. Produce the blob with this Node binary, then inject it into a copy of the binary.
const blob = path.join(WORK, 'sea-prep.blob');
const config = path.join(WORK, 'sea-config.json');
fs.writeFileSync(config, JSON.stringify({ main, output: blob, disableExperimentalSEAWarning: true, assets }, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' });

try {
  // Deleting first lets macOS and Linux replace a copy that's running.
  fs.rmSync(EXE, { force: true });
  fs.copyFileSync(process.execPath, EXE);
} catch (e) {
  if (e.code === 'EBUSY' || e.code === 'EPERM') {
    console.error(`\n${EXE} is in use. Close the running Claude IDE and build again.`);
    process.exit(1);
  }
  throw e;
}
// Explorer, Task Manager and the Start menu show the executable's icon and
// description, so replace Node's with the IDE's.
if (platform === 'win32') {
  const { rcedit } = await import('rcedit');
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  await rcedit(EXE, {
    icon: path.join(ROOT, 'packaging', 'icon.ico'),
    'file-version': version,
    'product-version': version,
    'version-string': {
      FileDescription: 'Claude IDE',
      ProductName: 'Claude IDE',
      CompanyName: 'Steve Preston',
      InternalName: 'claude-ide',
      OriginalFilename: 'claude-ide.exe',
      LegalCopyright: 'Copyright (c) 2026 Steve Preston. Includes Node.js, copyright Node.js contributors.',
    },
  });
}
// macOS only runs signed code: drop Node's signature before changing the
// binary, then sign the result ad hoc.
if (platform === 'darwin') execFileSync('codesign', ['--remove-signature', EXE], { stdio: 'inherit' });
await inject(EXE, 'NODE_SEA_BLOB', fs.readFileSync(blob), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(platform === 'darwin' && { machoSegmentName: 'NODE_SEA' }),
});
if (platform === 'darwin') execFileSync('codesign', ['--sign', '-', EXE], { stdio: 'inherit' });
// Windows gives console programs a console window, so mark this one as a GUI
// program. Node then discards console output, and errors go to the log file.
if (platform === 'win32') setWindowsSubsystem(EXE, 2);

// Sets the Subsystem field of a PE executable's header: 2 for a GUI program,
// 3 for a console program.
function setWindowsSubsystem(file, subsystem) {
  const fd = fs.openSync(file, 'r+');
  try {
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0x3c);
    const pe = buf.readUInt32LE(0);
    fs.readSync(fd, buf, 0, 4, pe);
    const signature = buf.toString('latin1');
    // The field is 68 bytes into the optional header, which follows the
    // 4-byte "PE\0\0" signature and the 20-byte file header.
    const at = pe + 4 + 20 + 68;
    fs.readSync(fd, buf, 0, 2, at);
    if (signature !== 'PE\0\0' || ![2, 3].includes(buf.readUInt16LE(0))) {
      throw new Error(`${file} doesn't look like a Windows executable`);
    }
    buf.writeUInt16LE(subsystem, 0);
    fs.writeSync(fd, buf, 0, 2, at);
  } finally {
    fs.closeSync(fd);
  }
}

const mb = b => `${(b / 1048576).toFixed(1)} MB`;
console.log(`\nBuilt ${path.relative(ROOT, EXE)} (${mb(fs.statSync(EXE).size)}) for ${platform}-${arch}, build ${buildId}`);
console.log(`  embedded ${files.size} files: ${mb(raw)} -> ${mb(packed)} compressed`);
console.log(`  Node runtime ${process.version}`);
