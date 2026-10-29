import { h } from 'preact';
import { useEffect, useReducer, useRef } from 'preact/hooks';
import htm from 'htm';

export const html = htm.bind(h);

// ---------------------------------------------------------------- api

async function request(method, url, body) {
  const headers = { 'X-Claude-IDE': '1' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
  return data;
}

export const api = {
  get: (url, params) => request('GET', params ? `${url}?${new URLSearchParams(params)}` : url),
  post: (url, body) => request('POST', url, body ?? {}),
  put: (url, body) => request('PUT', url, body),
  del: url => request('DELETE', url),
};

// ---------------------------------------------------------------- store

const PERSIST = [
  'tabs', 'activeTab', 'sidebar', 'sidebarOpen', 'sidebarWidth', 'inspectorOpen', 'theme', 'seen', 'notify', 'mdMode', 'expandedGroups',
  'shellOpen', 'shellId', 'shellHeight',
];

function loadPersisted() {
  try { return JSON.parse(localStorage.getItem('ide.state') || '{}'); } catch { return {}; }
}

let state = {
  info: { platform: 'win32', permissionModes: [] },
  connected: false,
  live: [],
  liveLoaded: false,
  terminals: [],
  terminalsLoaded: false,
  shells: [],
  shellOpen: false,
  shellId: null,
  shellHeight: 260,
  shellFocus: 0,
  history: [],
  plans: [],
  recentFolders: [],
  tabs: [{ id: 'home', type: 'home' }],
  activeTab: 'home',
  sidebar: 'sessions',
  sidebarOpen: true,
  sidebarWidth: 300,
  inspectorOpen: true,
  explorerRoot: null,
  theme: 'dark',
  seen: null,
  notify: false,
  mdMode: 'split',
  expandedGroups: null,
  dirty: {},
  draggingTab: null,
  dialog: null,
  toasts: [],
  quit: false,
  ...loadPersisted(),
};
if (!state.tabs.some(t => t.id === 'home')) state.tabs.unshift({ id: 'home', type: 'home' });

const subscribers = new Set();
let persistTimer = null;

function persist() {
  clearTimeout(persistTimer);
  persistTimer = null;
  try {
    localStorage.setItem('ide.state', JSON.stringify(Object.fromEntries(PERSIST.map(k => [k, state[k]]))));
  } catch { /* storage unavailable */ }
}
// Changes made just before the window closes or reloads still count.
window.addEventListener('pagehide', () => persistTimer && persist());

export const getState = () => state;

export function setState(patch) {
  const next = typeof patch === 'function' ? patch(state) : patch;
  if (!next) return;
  state = { ...state, ...next };
  for (const fn of subscribers) fn();
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persist, 250);
}

function shallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(k => Object.is(a[k], b[k]));
}

export function useStore(selector) {
  const [, force] = useReducer(n => n + 1, 0);
  const sel = useRef(selector);
  sel.current = selector;
  const value = selector(state);
  const last = useRef(value);
  last.current = value;
  useEffect(() => {
    const fn = () => {
      if (!shallowEqual(sel.current(state), last.current)) force();
    };
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }, []);
  return value;
}

// ---------------------------------------------------------------- event socket

class EventSocket {
  constructor() {
    this.handlers = new Map();
    this.transcripts = new Map();
    this.files = new Map();
    this.connect();
  }

  connect() {
    const ws = new WebSocket(`ws://${location.host}/ws/events`);
    this.ws = ws;
    ws.onopen = () => {
      setState({ connected: true });
      for (const id of this.transcripts.keys()) this.send({ t: 'watch-transcript', id });
      for (const path of this.files.keys()) this.send({ t: 'watch-file', path });
      this.emit({ t: 'reconnected' });
    };
    ws.onmessage = e => {
      try { this.emit(JSON.parse(e.data)); } catch (err) { console.error(err); }
    };
    ws.onclose = () => {
      setState({ connected: false });
      setTimeout(() => this.connect(), 1500);
    };
  }

  emit(msg) {
    for (const fn of this.handlers.get(msg.t) || []) fn(msg);
  }

  send(msg) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type).delete(fn);
  }

  watch(kind, key) {
    const map = kind === 'transcript' ? this.transcripts : this.files;
    const msgKey = kind === 'transcript' ? 'id' : 'path';
    map.set(key, (map.get(key) || 0) + 1);
    if (map.get(key) === 1) this.send({ t: `watch-${kind}`, [msgKey]: key });
    return () => {
      const n = (map.get(key) || 1) - 1;
      if (n > 0) return map.set(key, n);
      map.delete(key);
      this.send({ t: `unwatch-${kind}`, [msgKey]: key });
    };
  }
}

export const events = new EventSocket();

// ---------------------------------------------------------------- formatting

export function timeAgo(t) {
  if (!t) return '';
  const ms = typeof t === 'number' ? t : Date.parse(t);
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function duration(ms) {
  if (!ms && ms !== 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export const basename = p => (p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
export const dirname = p => (p || '').replace(/[\\/][^\\/]*$/, '');
export const sep = () => (state.info.platform === 'win32' ? '\\' : '/');
export const joinPath = (a, b) => (a.endsWith('\\') || a.endsWith('/') ? a + b : a + sep() + b);

// Resolves "." and ".." segments so the same file always maps to one tab.
export function normalizePath(p) {
  const s = /^[a-z]:/i.test(p) || p.includes('\\') ? '\\' : '/';
  const out = [];
  for (const part of p.split(/[\\/]+/)) {
    if (part === '.' || (part === '' && out.length)) continue;
    if (part === '..') {
      if (out.length > 1) out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join(s) || s;
}

export function shortPath(p) {
  const home = state.info.home;
  if (home && p && p.toLowerCase().startsWith(home.toLowerCase())) return '~' + p.slice(home.length);
  return p || '';
}

export const isMarkdown = p => /\.(md|mdx|markdown)$/i.test(p || '');

// Markdown reduced to readable plain text, for one- or three-line excerpts.
export const plain = s => (s || '')
  .replace(/```[\s\S]*?(```|$)/g, ' ')
  .replace(/`([^`]*)`/g, '$1')
  .replace(/(\*\*|__)(.+?)\1/g, '$2')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/^\s{0,3}#{1,6}\s+/gm, '')
  .replace(/^\s*[-*+]\s+/gm, '• ');
export const money = n => (typeof n === 'number' ? `$${n.toFixed(2)}` : '');
export const shortModel = m => (m || '').replace(/^claude-/, '').replace(/-\d{8}$/, '');

// ---------------------------------------------------------------- session status

const RANK = { needs: 0, ready: 1, working: 2, idle: 3, exited: 4 };

export function attention(s, seen = state.seen || {}) {
  if (!s) return { cls: 'exited', label: 'Not running', rank: RANK.exited };
  switch (s.status) {
    case 'waiting':
      return { cls: 'needs', label: 'Needs you', detail: s.waitingFor, rank: RANK.needs };
    case 'busy':
      return { cls: 'working', label: 'Working', rank: RANK.working };
    case 'shell':
      return { cls: 'working', label: 'Running shell', rank: RANK.working };
    case 'idle':
      return (seen[s.sessionId] || 0) >= (s.statusUpdatedAt || 0)
        ? { cls: 'idle', label: 'Idle', rank: RANK.idle }
        : { cls: 'ready', label: 'Your turn', rank: RANK.ready };
    default:
      return { cls: 'working', label: s.status, rank: RANK.working };
  }
}

export const byAttention = seen => (a, b) =>
  attention(a, seen).rank - attention(b, seen).rank || (b.statusUpdatedAt || 0) - (a.statusUpdatedAt || 0);

// One line describing what a live session is doing or wants.
export function activityLine(s) {
  if (!s) return '';
  const tool = s.lastTool ? `${s.lastTool.name}: ${s.lastTool.summary || ''}` : '';
  const task = s.tasks?.find(t => t.status === 'in_progress');
  switch (s.status) {
    case 'waiting':
      return `Waiting for ${s.waitingFor || 'input'}${tool ? ' · ' + tool : ''}`;
    case 'busy':
    case 'shell':
      return task?.activeForm || tool || 'Working…';
    default:
      return plain(s.lastText?.text).split('\n').find(l => l.trim()) || s.lastUser?.text || 'Ready';
  }
}

// Everything known about a session, merging live status and history.
export function sessionInfo(sessionId, st = state) {
  if (!sessionId) return null;
  const live = st.live.find(s => s.sessionId === sessionId) || null;
  let hist = null, cwd = null;
  for (const g of st.history) {
    const s = g.sessions.find(x => x.sessionId === sessionId);
    if (s) { hist = s; cwd = g.cwd; break; }
  }
  const term = st.terminals.find(t => t.sessionId === sessionId && !t.exited) || null;
  if (!live && !hist && !term) return null;
  return {
    sessionId,
    live,
    hist,
    terminal: term,
    title: live?.title || hist?.title || term?.name || 'New chat',
    cwd: live?.cwd || cwd || term?.cwd || null,
    planFile: live?.planFile || hist?.planFile || null,
    model: live?.model || hist?.model || null,
    costUSD: live?.costUSD ?? hist?.costUSD ?? null,
  };
}

export function sessionIdForTab(tab, st = state) {
  if (!tab) return null;
  if (tab.type === 'transcript') return tab.sessionId;
  if (tab.type === 'terminal') return st.terminals.find(t => t.id === tab.terminalId)?.sessionId || tab.sessionId || null;
  return null;
}

// ---------------------------------------------------------------- misc hooks

export function useInterval(fn, ms) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    const t = setInterval(() => saved.current(), ms);
    return () => clearInterval(t);
  }, [ms]);
}

// Re-render periodically so relative times stay fresh.
export function useTick(ms = 30000) {
  const [, force] = useReducer(n => n + 1, 0);
  useInterval(force, ms);
}
