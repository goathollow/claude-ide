'use strict';
// Entry point of the standalone executable, a Node "single executable
// application". The executable carries the browser files and node-pty (which is
// native and can't be bundled) as embedded assets. They are unpacked once per
// build into <cache folder>/claude-ide/app-<build id>, and the server runs from there.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const util = require('node:util');
const zlib = require('node:zlib');
const { spawn, spawnSync } = require('node:child_process');
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

// A console window opened by double-clicking closes as soon as the process
// exits, taking any error message with it, so errors also go to a log file.
function logErrors(base) {
  const file = path.join(base, 'claude-ide.log');
  fs.mkdirSync(base, { recursive: true });
  try { if (fs.statSync(file).size > 1 << 20) fs.rmSync(file); } catch { /* no log yet */ }
  const write = text => {
    try { fs.appendFileSync(file, `[${new Date().toISOString()}] ${text}\n`); } catch { /* best effort */ }
  };
  const consoleError = console.error;
  console.error = (...args) => {
    write(util.format(...args));
    consoleError(...args);
  };
  process.on('uncaughtExceptionMonitor', (err, origin) => {
    write(`${origin}: ${err?.stack || err}`);
    alertBox(`Claude IDE stopped because of an error:\n\n${err?.message || err}\n\nDetails are in ${file}`);
  });
  write(`started pid ${process.pid}: ${process.argv.slice(1).join(' ')}`);
}

// The Windows build runs without a console, so problems that stop the IDE from
// opening are shown in a message box. Elsewhere the terminal shows them.
function alertBox(message) {
  if (process.platform !== 'win32') return;
  const script = "Add-Type -AssemblyName PresentationFramework; [void][System.Windows.MessageBox]::Show($env:CLAUDE_IDE_MESSAGE, 'Claude IDE', 'OK', 'Warning')";
  // Not detached: PowerShell started without any console exits without showing
  // the box. It still outlives this process.
  spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, CLAUDE_IDE_MESSAGE: message },
  }).on('error', () => {}).unref();
}

// Started from the Dock or Finder, the Mac app gets a bare environment instead
// of the one your shell sets up, so PATH lacks Homebrew, npm and ~/.local/bin,
// which Claude and the tools it runs need. Take the environment a login shell
// sets up, as a terminal would.
function loadShellEnv() {
  const shell = process.env.SHELL || '/bin/zsh';
  // The shell writes it to a file: startup files can print to stdout, and a
  // program one of them leaves running would hold a pipe open.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ide-env-'));
  const file = path.join(dir, 'env');
  try {
    const { error } = spawnSync(shell, ['-l', '-i', '-c', '/usr/bin/env -0 > "$CLAUDE_IDE_ENV_FILE"'], {
      env: { ...process.env, CLAUDE_IDE_ENV_FILE: file },
      stdio: 'ignore',
      timeout: 10000,
      // Interactive shells ignore SIGTERM.
      killSignal: 'SIGKILL',
    });
    if (error?.code === 'ETIMEDOUT') throw new Error(`${shell} took more than 10 seconds to start`);
    if (error) throw error;
    if (!fs.existsSync(file)) throw new Error(`${shell} didn't run the command`);
    for (const entry of fs.readFileSync(file, 'utf8').split('\0')) {
      const i = entry.indexOf('=');
      const name = entry.slice(0, i);
      if (i > 0 && !['_', 'SHLVL', 'PWD', 'OLDPWD', 'CLAUDE_IDE_ENV_FILE'].includes(name)) process.env[name] = entry.slice(i + 1);
    }
  } catch (e) {
    console.error(`Couldn't read your shell's environment, so the IDE may not find the programs on your PATH: ${e.message}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function unpack(base) {
  const id = sea.getAsset('build-id', 'utf8').trim();
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
  const base = path.join(cacheDir(), 'claude-ide');
  logErrors(base);
  globalThis.__CLAUDE_IDE_ALERT = alertBox;
  globalThis.__CLAUDE_IDE_ROOT = unpack(base);
  // The Mac app (packaging/macos) runs this with --mac-app and shows the IDE
  // in its own windows.
  if (process.platform === 'darwin' && process.argv.includes('--mac-app')) loadShellEnv();
  // Double-clicking the executable should open the app window.
  if (!process.argv.some(a => ['--app', '--open', '--no-open', '--mac-app'].includes(a))) process.argv.push('--app');
  require('../server/index.js');
}
