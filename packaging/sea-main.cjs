'use strict';
// Entry point of the standalone executable, a Node "single executable
// application". The executable carries the browser files and node-pty (which is
// native and can't be bundled) as embedded assets. They are unpacked once per
// build into <cache folder>/claude-ide/app-<build id>, and the server runs from there.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createRequire } = require('node:module');
const sea = require('node:sea');

// On Windows, node-pty runs lib/conpty_console_list_agent.js with
// child_process.fork(), which uses this executable as the Node runtime. Run
// that script instead of starting a second IDE.
function runPtyHelper() {
  const i = process.argv.findIndex(a => /conpty_console_list_agent(\.js)?$/.test(a));
  if (i === -1) return false;
  const script = process.argv[i];
  process.argv = [process.execPath, script, ...process.argv.slice(i + 1)];
  createRequire(script)(script);
  return true;
}

function cacheDir() {
  const home = os.homedir();
  if (process.platform === 'win32') return process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Caches');
  return process.env.XDG_CACHE_HOME || path.join(home, '.cache');
}

function unpack() {
  const id = sea.getAsset('build-id', 'utf8').trim();
  const base = path.join(cacheDir(), 'claude-ide');
  const root = path.join(base, `app-${id}`);

  // Remove folders left by older builds. Called once this copy is serving, so a
  // folder still in use can only belong to a copy on another port; its locked
  // files make the rename fail and it is left alone.
  globalThis.__CLAUDE_IDE_CLEANUP = () => {
    for (const name of fs.readdirSync(base)) {
      if (!name.startsWith('app-') || name === path.basename(root)) continue;
      const doomed = path.join(base, `trash-${name}`);
      try {
        fs.renameSync(path.join(base, name), doomed);
        fs.rmSync(doomed, { recursive: true, force: true });
      } catch { /* in use */ }
    }
  };

  if (fs.existsSync(path.join(root, '.complete'))) return root;
  const tmp = `${root}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const key of sea.getAssetKeys()) {
    if (!key.startsWith('app/')) continue;
    const dest = path.join(tmp, key.slice('app/'.length));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // On macOS node-pty starts each terminal through its spawn-helper program,
    // which has to be executable. Assets don't keep file modes.
    const mode = path.basename(dest) === 'spawn-helper' ? 0o755 : 0o644;
    fs.writeFileSync(dest, zlib.gunzipSync(Buffer.from(sea.getRawAsset(key))), { mode });
  }
  fs.writeFileSync(path.join(tmp, '.complete'), id);
  try {
    fs.renameSync(tmp, root);
  } catch (e) {
    // Another copy starting at the same moment unpacked it first.
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!fs.existsSync(path.join(root, '.complete'))) throw e;
  }
  return root;
}

if (!runPtyHelper()) {
  process.title = 'Claude IDE';
  globalThis.__CLAUDE_IDE_ROOT = unpack();
  // Double-clicking the executable should open the app window.
  if (!process.argv.some(a => a === '--app' || a === '--open' || a === '--no-open')) process.argv.push('--app');
  require('../server/index.js');
}
