import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import pty from './pty.js';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import { CLAUDE_BIN, IS_WIN, childEnv } from './config.js';
import { isSessionId } from './transcripts.js';

// Claude sessions started from the IDE, and the shells in its shell panel, run
// in pseudo-terminals owned by this server. A headless xterm mirrors each
// screen so a browser tab that reconnects gets the current screen back instead
// of a garbled replay of raw output.

const { Terminal } = headless;
const { SerializeAddon } = serialize;

export const PERMISSION_MODES = ['manual', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions'];

export const events = new EventEmitter();
const terminals = new Map();

class HostedTerminal {
  constructor({ kind = 'claude', file = CLAUDE_BIN, args, env = childEnv(), cwd, sessionId, name, cols, rows }) {
    this.id = crypto.randomUUID().slice(0, 8);
    this.kind = kind;
    this.cwd = cwd;
    this.sessionId = sessionId;
    this.name = name || null;
    this.osTitle = null;
    this.createdAt = Date.now();
    this.exited = false;
    this.exitCode = null;
    this.clients = new Set();

    this.screen = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    this.screen.loadAddon(this.serializer);
    this.screen.onTitleChange(t => {
      this.osTitle = t;
      events.emit('changed');
    });

    this.pty = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd, env });
    this.pid = this.pty.pid;
    this.pty.onData(d => {
      this.screen.write(d);
      this.broadcast({ t: 'data', d });
    });
    this.pty.onExit(({ exitCode }) => {
      this.exited = true;
      this.exitCode = exitCode;
      this.broadcast({ t: 'exit', code: exitCode });
      events.emit('changed');
    });
  }

  broadcast(msg) {
    const json = JSON.stringify(msg);
    for (const c of this.clients) {
      if (c.pending) c.pending.push(json);
      else if (c.ws.readyState === 1) c.ws.send(json);
    }
  }

  attach(ws) {
    // Output that arrives while the snapshot is being taken is held back and
    // sent after it, so nothing is lost or duplicated.
    const client = { ws, pending: [] };
    this.clients.add(client);
    this.screen.write('', () => {
      if (ws.readyState !== 1) return;
      ws.send(JSON.stringify({
        t: 'snapshot',
        d: this.serializer.serialize({ scrollback: 2000 }),
        cols: this.screen.cols,
        rows: this.screen.rows,
        exited: this.exited,
        code: this.exitCode,
      }));
      for (const json of client.pending) ws.send(json);
      client.pending = null;
    });
    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.t === 'input' && typeof msg.d === 'string' && !this.exited) this.pty.write(msg.d);
      if (msg.t === 'resize') this.resize(msg.cols, msg.rows);
    });
    ws.on('close', () => this.clients.delete(client));
  }

  resize(cols, rows) {
    if (this.exited || !Number.isInteger(cols) || !Number.isInteger(rows)) return;
    cols = Math.max(20, Math.min(cols, 500));
    rows = Math.max(5, Math.min(rows, 200));
    if (cols === this.screen.cols && rows === this.screen.rows) return;
    try {
      this.pty.resize(cols, rows);
      this.screen.resize(cols, rows);
    } catch { /* exited between checks */ }
  }

  kill() {
    if (!this.exited) {
      try { this.pty.kill(); } catch { /* already gone */ }
    }
    for (const c of this.clients) c.ws.close();
    this.screen.dispose();
  }

  info() {
    return {
      id: this.id,
      kind: this.kind,
      cwd: this.cwd,
      sessionId: this.sessionId,
      name: this.name,
      title: this.osTitle,
      pid: this.pid,
      createdAt: this.createdAt,
      exited: this.exited,
      exitCode: this.exitCode,
    };
  }
}

export function createTerminal({ cwd, resume, name, permissionMode, model, cols = 120, rows = 32 }) {
  cwd = String(cwd || '').trim();
  if (!path.isAbsolute(cwd)) throw Object.assign(new Error(`Use a full folder path (got "${cwd}")`), { status: 400 });
  cwd = path.resolve(cwd);
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw Object.assign(new Error(`Not a folder: ${cwd}`), { status: 400 });
  if (resume && !isSessionId(resume)) throw Object.assign(new Error('Invalid session id'), { status: 400 });
  if (resume) {
    const running = [...terminals.values()].find(t => !t.exited && t.sessionId === resume);
    if (running) return running.info();
  }

  const sessionId = resume || crypto.randomUUID();
  const args = resume ? ['--resume', resume] : ['--session-id', sessionId];
  if (name) args.push('--name', String(name).slice(0, 80));
  if (permissionMode && PERMISSION_MODES.includes(permissionMode)) args.push('--permission-mode', permissionMode);
  if (model && /^[\w.\-[\]]+$/.test(model)) args.push('--model', model);

  const term = new HostedTerminal({ cwd, args, sessionId, name, cols, rows });
  terminals.set(term.id, term);
  events.emit('changed');
  return term.info();
}

// The shell panel's shell: CLAUDE_IDE_SHELL, or PowerShell on Windows (7 if
// it's installed) and your login shell elsewhere.
function shellCommand() {
  if (process.env.CLAUDE_IDE_SHELL) return { file: process.env.CLAUDE_IDE_SHELL, args: [] };
  if (IS_WIN) {
    const pwsh = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
      .map(dir => path.join(dir, 'pwsh.exe')).find(p => fs.existsSync(p));
    return { file: pwsh || 'powershell.exe', args: ['-NoLogo'] };
  }
  const file = [process.env.SHELL, '/bin/bash', '/bin/sh'].find(p => p && fs.existsSync(p));
  // Like Terminal, start a login shell on macOS.
  return { file, args: process.platform === 'darwin' ? ['-l'] : [] };
}

export function createShell({ cwd, cols = 120, rows = 16 }) {
  cwd = String(cwd || '').trim();
  if (!path.isAbsolute(cwd) || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) cwd = os.homedir();
  const { file, args } = shellCommand();
  // FORCE_COLOR suits Claude, but would put colour codes in the output of
  // programs piped to one another in the shell.
  const env = childEnv();
  if (!('FORCE_COLOR' in process.env)) delete env.FORCE_COLOR;
  const term = new HostedTerminal({ kind: 'shell', file, args, env, cwd: path.resolve(cwd), name: path.basename(file, '.exe'), cols, rows });
  // A shell that has exited is of no further use.
  term.pty.onExit(() => closeTerminal(term.id));
  terminals.set(term.id, term);
  events.emit('changed');
  return term.info();
}

export const getTerminal = id => terminals.get(id) || null;
export const listTerminals = () => [...terminals.values()].filter(t => t.kind === 'claude').map(t => t.info());
export const listShells = () => [...terminals.values()].filter(t => t.kind === 'shell').map(t => t.info());

export function closeTerminal(id) {
  const t = terminals.get(id);
  if (!t) return false;
  t.kill();
  terminals.delete(id);
  events.emit('changed');
  return true;
}

// The registry reports which session a PID is running; that changes after
// /clear or /resume inside the terminal, so follow it.
export function syncSessionIds(live) {
  let changed = false;
  for (const t of terminals.values()) {
    const s = live.find(l => l.pid === t.pid);
    if (s && s.sessionId !== t.sessionId) {
      t.sessionId = s.sessionId;
      changed = true;
    }
  }
  if (changed) events.emit('changed');
}

export function shutdownAll() {
  for (const t of terminals.values()) t.kill();
  terminals.clear();
}
