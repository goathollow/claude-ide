import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';

import { HOST, PORT, CLAUDE_DIR, CLAUDE_BIN, IS_WIN } from './config.js';
import { startProcessMonitor } from './processes.js';
import * as sessions from './sessions.js';
import * as terminals from './terminals.js';
import * as files from './files.js';
import { notify } from './notify.js';
import { transcriptIndex, fullToolCall, isSessionId } from './transcripts.js';
import { VENDOR } from './vendor.js';

// The standalone executable sets __CLAUDE_IDE_ROOT to the folder it unpacked into.
const ROOT = globalThis.__CLAUDE_IDE_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nm = p => path.join(ROOT, 'node_modules', p);

// The standalone executable has no console window to stop it with, so when it
// opens the IDE's window itself (or the Mac app does, with --mac-app), it quits
// once its last window has closed and the Claude sessions started in it have ended.
const QUIT_WHEN_CLOSED = Boolean(globalThis.__CLAUDE_IDE_ROOT) && !process.argv.includes('--no-open');

// ---------------------------------------------------------------- request guard
// The server can start processes and write files, so only this machine's
// browser tabs on this exact origin may use it. The Host check blocks DNS
// rebinding; the Origin and custom-header checks block cross-site requests.

const allowedHosts = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
const allowedOrigin = origin => !origin || allowedHosts.has(origin.replace(/^https?:\/\//, ''));

function guard(req, res, next) {
  if (!allowedHosts.has(req.headers.host)) return res.status(403).send('Forbidden host');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (!allowedOrigin(req.headers.origin) || req.headers['x-claude-ide'] !== '1') {
      return res.status(403).json({ error: 'Forbidden' });
    }
  }
  next();
}

// ---------------------------------------------------------------- app

const app = express();
app.disable('x-powered-by');
app.use(guard);
app.use(express.json({ limit: '25mb' }));

app.use(express.static(path.join(ROOT, 'public')));
for (const [name, dir] of Object.entries(VENDOR)) app.use(`/vendor/${name}`, express.static(nm(dir), { maxAge: '1h' }));

const api = express.Router();

api.get('/info', (req, res) => {
  res.json({
    claudeDir: CLAUDE_DIR,
    claudeBin: CLAUDE_BIN,
    platform: process.platform,
    home: process.env.USERPROFILE || process.env.HOME,
    permissionModes: terminals.PERMISSION_MODES,
  });
});

api.get('/live', (req, res) => res.json(liveView()));
api.get('/history', async (req, res) => res.json(await sessions.listHistory()));
api.get('/plans', async (req, res) => res.json(await sessions.listPlans()));
api.get('/folders/recent', async (req, res) => res.json(await sessions.recentFolders()));

api.get('/transcripts/:id', async (req, res) => {
  const idx = await transcriptIndex(req.params.id);
  if (!idx) return res.status(404).json({ error: 'Transcript not found' });
  const total = idx.entries.length;
  const limit = Math.min(Number(req.query.limit) || 400, 5000);
  const before = req.query.before !== undefined ? Math.min(Number(req.query.before), total) : total;
  const start = Math.max(0, before - limit);
  res.json({ meta: idx.meta, total, start, entries: idx.entries.slice(start, before) });
});

api.get('/transcripts/:id/tool', async (req, res) => {
  const { toolId, inOff, resOff } = req.query;
  const full = await fullToolCall(req.params.id, String(toolId), Number(inOff), resOff === undefined ? -1 : Number(resOff));
  if (!full) return res.status(404).json({ error: 'Not found' });
  res.json(full);
});

api.get('/fs/drives', (req, res) => res.json(files.drives()));
api.get('/fs/list', async (req, res) => res.json(await files.listDir(req.query.path)));
api.get('/fs/read', async (req, res) => res.json(await files.readText(req.query.path)));
api.get('/fs/stat', async (req, res) => res.json(await files.stat(req.query.path)));
api.get('/fs/markdown', async (req, res) => res.json(await files.findMarkdown(req.query.root)));
api.post('/fs/mkdir', async (req, res) => res.json(await files.makeDir(req.body?.path)));
api.put('/fs/write', async (req, res) => {
  const { path: p, content, baseMtimeMs, force } = req.body || {};
  res.json(await files.writeText(p, content, baseMtimeMs, !!force));
});

api.post('/reveal', (req, res) => {
  const p = files.resolvePath(req.body?.path);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'Not found' });
  const isDir = fs.statSync(p).isDirectory();
  if (IS_WIN) launch('explorer.exe', isDir ? [p] : [`/select,${p}`]);
  else launch(process.platform === 'darwin' ? 'open' : 'xdg-open', [isDir ? p : path.dirname(p)]);
  res.json({ ok: true });
});

api.get('/terminals', (req, res) => res.json(terminals.listTerminals()));
api.post('/terminals', (req, res) => {
  const { resume } = req.body || {};
  if (resume) {
    // Two processes appending to one transcript would corrupt it.
    const live = sessions.liveSessions().find(s => s.sessionId === resume);
    const hosted = terminals.listTerminals().some(t => !t.exited && t.sessionId === resume);
    if (live && !hosted) return res.status(409).json({ error: `This chat is already running in another terminal (PID ${live.pid}). Close it there first.` });
  }
  res.json(terminals.createTerminal(req.body || {}));
});
api.delete('/terminals/:id', (req, res) => res.json({ ok: terminals.closeTerminal(req.params.id) }));
api.post('/shells', (req, res) => res.json(terminals.createShell(req.body || {})));

// Quitting ends the Claude sessions started in the IDE. Every window is told
// first so it can close as well.
api.post('/quit', (req, res) => {
  res.json({ ok: true });
  broadcast({ t: 'quit' });
  setTimeout(shutdown, 200);
});

app.use('/api', api);
app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown endpoint' }));
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message, mtimeMs: err.mtimeMs });
});

// ---------------------------------------------------------------- live state

function liveView() {
  const terms = terminals.listTerminals().filter(t => !t.exited);
  return sessions.liveSessions().map(s => ({
    ...s,
    terminalId: terms.find(t => t.pid === s.pid || t.sessionId === s.sessionId)?.id || null,
  }));
}

// ---------------------------------------------------------------- websockets

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const eventClients = new Set();

server.on('upgrade', (req, socket, head) => {
  if (!allowedHosts.has(req.headers.host) || !req.headers.origin || !allowedOrigin(req.headers.origin)) {
    socket.destroy();
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const term = /^\/ws\/term\/([\w-]+)$/.exec(url.pathname);
  if (url.pathname === '/ws/events') {
    wss.handleUpgrade(req, socket, head, ws => onEventsSocket(ws));
  } else if (term && terminals.getTerminal(term[1])) {
    wss.handleUpgrade(req, socket, head, ws => terminals.getTerminal(term[1])?.attach(ws));
  } else {
    socket.destroy();
  }
});

const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
const broadcast = msg => { for (const ws of eventClients) send(ws, msg); };

function onEventsSocket(ws) {
  ws.transcripts = new Set();
  ws.files = new Set();
  eventClients.add(ws);
  send(ws, { t: 'live', sessions: liveView() });
  send(ws, { t: 'terminals', terminals: terminals.listTerminals(), shells: terminals.listShells() });
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.t === 'watch-transcript' && isSessionId(msg.id)) ws.transcripts.add(msg.id);
    if (msg.t === 'unwatch-transcript') ws.transcripts.delete(msg.id);
    if (msg.t === 'watch-file' && typeof msg.path === 'string') ws.files.add(path.resolve(msg.path));
    if (msg.t === 'unwatch-file' && typeof msg.path === 'string') ws.files.delete(path.resolve(msg.path));
  });
  ws.on('close', () => eventClients.delete(ws));
}

sessions.events.on('live', live => {
  terminals.syncSessionIds(live);
  broadcast({ t: 'live', sessions: liveView() });
});
terminals.events.on('changed', () => {
  broadcast({ t: 'terminals', terminals: terminals.listTerminals(), shells: terminals.listShells() });
  broadcast({ t: 'live', sessions: liveView() });
});

// ---------------------------------------------------------------- notifications
// An open window notifies you itself. With none open, the server tells you
// when a Claude session started in the IDE needs you or has finished.

const lastStatus = new Map();
sessions.events.on('live', () => {
  const live = liveView();
  for (const s of live) {
    const before = lastStatus.get(s.sessionId);
    if (eventClients.size || !s.terminalId || !before || before === s.status) continue;
    const name = s.title || path.basename(s.cwd);
    if (s.status === 'waiting') {
      notifySession(s, `${name} needs you`, `Waiting for ${s.waitingFor || 'input'}${s.lastTool ? ` · ${s.lastTool.name}: ${s.lastTool.summary}` : ''}`);
    } else if (s.status === 'idle' && (before === 'busy' || before === 'shell')) {
      notifySession(s, `${name} finished`, firstLine(s.lastText?.text));
    }
  }
  lastStatus.clear();
  for (const s of live) lastStatus.set(s.sessionId, s.status);
});

function notifySession(s, title, body) {
  // The executable registers claude-ide:// links to start itself. Run from
  // source, there's nothing to register, so the link is the page itself.
  const exe = globalThis.__CLAUDE_IDE_ROOT ? process.execPath : null;
  notify({
    title,
    body: body.slice(0, 200),
    tag: s.sessionId,
    link: exe ? `claude-ide://session/${s.sessionId}` : `${URL_}/#session=${s.sessionId}`,
    exe,
    icon: path.join(ROOT, 'public', 'icon.png'),
  });
}

// The first line of a Markdown reply, without the most common markup.
const firstLine = md => (md || '')
  .replace(/```[\s\S]*?(```|$)/g, ' ')
  .replace(/`|\*\*|^\s*#+\s+/gm, '')
  .split('\n').map(l => l.trim()).find(Boolean) || '';

// Push transcript growth and file changes to whoever is watching them.
const fileStamps = new Map();
let watching = false;
setInterval(async () => {
  if (watching) return;
  watching = true;
  try {
    const ids = new Set(), paths = new Set();
    for (const ws of eventClients) {
      ws.transcripts.forEach(id => ids.add(id));
      ws.files.forEach(p => paths.add(p));
    }
    for (const id of ids) {
      const idx = await transcriptIndex(id);
      if (!idx) continue;
      // transcriptIndex() already pulled in new lines; report what changed.
      const from = idx.lastChange;
      idx.lastChange = -1;
      if (from === -1) continue;
      const msg = { t: 'transcript', id, from, total: idx.entries.length, meta: idx.meta, entries: idx.entries.slice(from) };
      for (const ws of eventClients) if (ws.transcripts.has(id)) send(ws, msg);
    }
    for (const p of paths) {
      const st = await files.stat(p);
      const stamp = st.exists ? st.mtimeMs : 0;
      if (fileStamps.has(p) && fileStamps.get(p) !== stamp) {
        for (const ws of eventClients) if (ws.files.has(p)) send(ws, { t: 'file-changed', path: p, mtimeMs: st.mtimeMs, exists: st.exists });
      }
      fileStamps.set(p, stamp);
    }
    for (const p of fileStamps.keys()) if (!paths.has(p)) fileStamps.delete(p);
  } catch (e) {
    console.error('watch tick failed:', e);
  } finally {
    watching = false;
  }
}, 1000).unref();

// ---------------------------------------------------------------- start

startProcessMonitor();
sessions.startSessionMonitor();

const URL_ = `http://localhost:${PORT}`;
// Clicking a notification on Windows starts the executable with a
// claude-ide://session/<id> link, and the window opens on that session.
const linkedSession = process.argv.map(a => /^claude-ide:\/\/session\/([\w-]+)/i.exec(a)?.[1]).find(isSessionId);
const openRequested = () => {
  const url = linkedSession ? `${URL_}/#session=${linkedSession}` : URL_;
  if (process.argv.includes('--app')) openWindow(url, true);
  else if (process.argv.includes('--open')) openWindow(url, false);
};

server.on('error', async err => {
  if (err.code !== 'EADDRINUSE') throw err;
  // Launching again (say, double-clicking the executable twice) opens the running IDE.
  const running = await fetch(`${URL_}/api/info`, { signal: AbortSignal.timeout(2000) }).then(r => r.ok, () => false);
  if (running) {
    // The Mac app reads the address from this line, or the one in listen() below.
    console.log(`Claude IDE is already running at ${URL_}`);
    openRequested();
    setTimeout(() => process.exit(0), 300);
  } else {
    const message = `Port ${PORT} is in use by another program. Set CLAUDE_IDE_PORT to pick a different port.`;
    console.error(message);
    globalThis.__CLAUDE_IDE_ALERT?.(message);
    setTimeout(() => process.exit(1), 300);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Claude IDE running at ${URL_}`);
  console.log(`  claude binary: ${CLAUDE_BIN}`);
  console.log(`  claude data:   ${CLAUDE_DIR}`);
  openRequested();
  globalThis.__CLAUDE_IDE_CLEANUP?.();
});

if (QUIT_WHEN_CLOSED) {
  // Give the browser time to start, then quit once no window has been connected
  // for 15 seconds, which leaves time to reload the page. Claude sessions keep
  // running in the background with no window open, and starting the IDE again
  // opens a window onto them. The shell panel's shells don't keep it running.
  let lastSeen = Date.now() + 45000;
  setInterval(() => {
    if (eventClients.size || terminals.listTerminals().some(t => !t.exited)) lastSeen = Date.now();
    else if (Date.now() - lastSeen > 15000) shutdown();
  }, 1000).unref();

  // On macOS and Linux it runs in the terminal it was started from. Closing that
  // terminal shouldn't close the IDE or end its sessions, so ignore the hangup
  // and the errors from writing to a terminal that's gone.
  if (!IS_WIN) {
    process.on('SIGHUP', () => {});
    process.stdout.on('error', () => {});
    process.stderr.on('error', () => {});
  }
}

// A Chromium-based browser, which can show the IDE in a window of its own
// without tabs or an address bar.
function appBrowser() {
  if (IS_WIN) {
    return [
      path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
      path.join(process.env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe'),
      path.join(process.env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'),
    ].find(b => fs.existsSync(b));
  }
  if (process.platform === 'darwin') {
    return ['Google Chrome', 'Microsoft Edge', 'Chromium', 'Brave Browser']
      .flatMap(app => ['/Applications', path.join(os.homedir(), 'Applications')]
        .map(dir => path.join(dir, `${app}.app`, 'Contents', 'MacOS', app)))
      .find(b => fs.existsSync(b));
  }
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']
    .flatMap(name => dirs.map(dir => path.join(dir, name)))
    .find(b => fs.existsSync(b));
}

// The executable inside the Mac app, which shows the IDE in windows of its own.
const MAC_APP = process.platform === 'darwin' && globalThis.__CLAUDE_IDE_ROOT
  && /^(.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(process.execPath)?.[1];

function openWindow(url, appMode) {
  // Opening the app brings up its window, or opens one if it has none.
  if (appMode && MAC_APP) return launch('open', [MAC_APP]);
  const browser = appMode && appBrowser();
  if (browser) launch(browser, [`--app=${url}`]);
  else if (IS_WIN) launch('cmd', ['/c', 'start', '', url], { windowsHide: true });
  else launch(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
}

// Starts a program that runs on its own. One that can't be found is logged
// instead of taking the server down.
function launch(cmd, args, options = {}) {
  spawn(cmd, args, { detached: true, stdio: 'ignore', ...options })
    .on('error', e => console.error(`Couldn't start ${cmd}: ${e.message}`))
    .unref();
}

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  terminals.shutdownAll();
  // On Windows, node-pty finishes closing a terminal about a second after
  // killing it. Exiting before then can leave the process stuck, unable to exit.
  setTimeout(() => process.exit(0), IS_WIN ? 1500 : 0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
