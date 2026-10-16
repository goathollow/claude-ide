import http from 'node:http';
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
import { transcriptIndex, fullToolCall, isSessionId } from './transcripts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nm = p => path.join(ROOT, 'node_modules', p);

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
const vendor = {
  preact: nm('preact'),
  htm: nm('htm/dist'),
  xterm: nm('@xterm/xterm'),
  'xterm-fit': nm('@xterm/addon-fit/lib'),
  'xterm-links': nm('@xterm/addon-web-links/lib'),
  monaco: nm('monaco-editor/min'),
  marked: nm('marked/lib'),
  dompurify: nm('dompurify/dist'),
  hljs: nm('@highlightjs/cdn-assets'),
};
for (const [name, dir] of Object.entries(vendor)) app.use(`/vendor/${name}`, express.static(dir, { maxAge: '1h' }));

const api = express.Router();

api.get('/info', (req, res) => {
  res.json({ claudeDir: CLAUDE_DIR, claudeBin: CLAUDE_BIN, platform: process.platform, home: process.env.USERPROFILE || process.env.HOME, permissionModes: terminals.PERMISSION_MODES });
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
  if (IS_WIN) spawn('explorer.exe', isDir ? [p] : [`/select,${p}`], { detached: true, stdio: 'ignore' }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [isDir ? p : path.dirname(p)], { detached: true, stdio: 'ignore' }).unref();
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
  send(ws, { t: 'terminals', terminals: terminals.listTerminals() });
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
  broadcast({ t: 'terminals', terminals: terminals.listTerminals() });
  broadcast({ t: 'live', sessions: liveView() });
});

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

server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Claude IDE running at ${url}`);
  console.log(`  claude binary: ${CLAUDE_BIN}`);
  console.log(`  claude data:   ${CLAUDE_DIR}`);
  if (process.argv.includes('--app')) openWindow(url, true);
  else if (process.argv.includes('--open')) openWindow(url, false);
});

function openWindow(url, appMode) {
  const browsers = IS_WIN
    ? [
        path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
        path.join(process.env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe'),
        path.join(process.env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'),
      ]
    : [];
  const browser = appMode && browsers.find(b => fs.existsSync(b));
  if (browser) spawn(browser, [`--app=${url}`], { detached: true, stdio: 'ignore' }).unref();
  else if (IS_WIN) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

function shutdown() {
  terminals.shutdownAll();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
