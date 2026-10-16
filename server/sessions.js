import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { SESSIONS_DIR, TASKS_DIR, PLANS_DIR, HISTORY_FILE } from './config.js';
import { isClaudeAlive } from './processes.js';
import { transcriptPath, recentActivity, scanTranscriptFiles, summarizeTranscript } from './transcripts.js';

// Every running Claude Code process keeps ~/.claude/sessions/<pid>.json up to
// date with its status: busy, idle, or waiting (plus waitingFor). The monitor
// polls that registry and enriches each entry with what the transcript and
// task list say the session is doing.

export const events = new EventEmitter();

let live = [];
let liveJson = '';
const registryCache = new Map(); // file name -> last record that parsed
const activityCache = new Map(); // sessionId -> { size, mtimeMs, activity }
const tasksCache = new Map(); // sessionId -> { sig, tasks }

async function readRegistry() {
  let names = [];
  try { names = await fsp.readdir(SESSIONS_DIR); } catch { return []; }
  const files = new Set(names.filter(n => n.endsWith('.json')));
  for (const n of registryCache.keys()) if (!files.has(n)) registryCache.delete(n);
  await Promise.all([...files].map(async n => {
    try {
      registryCache.set(n, JSON.parse(await fsp.readFile(path.join(SESSIONS_DIR, n), 'utf8')));
    } catch {
      // Caught mid-write; keep the previous value.
    }
  }));
  return [...registryCache.values()].filter(r => r?.sessionId && isClaudeAlive(r.pid));
}

async function activityFor(sessionId) {
  const file = await transcriptPath(sessionId);
  if (!file) return null;
  let st;
  try { st = await fsp.stat(file); } catch { return null; }
  const cached = activityCache.get(sessionId);
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.activity;
  const activity = await recentActivity(file);
  activityCache.set(sessionId, { size: st.size, mtimeMs: st.mtimeMs, activity });
  return activity;
}

async function tasksFor(sessionId) {
  const dir = path.join(TASKS_DIR, sessionId);
  let names;
  try { names = (await fsp.readdir(dir)).filter(n => n.endsWith('.json')); } catch { return []; }
  const stats = await Promise.all(names.map(n => fsp.stat(path.join(dir, n)).then(s => `${n}:${s.mtimeMs}`, () => n)));
  const sig = stats.join('|');
  const cached = tasksCache.get(sessionId);
  if (cached?.sig === sig) return cached.tasks;
  const tasks = [];
  await Promise.all(names.map(async n => {
    try {
      const t = JSON.parse(await fsp.readFile(path.join(dir, n), 'utf8'));
      tasks.push({ id: t.id, subject: t.subject, activeForm: t.activeForm, status: t.status });
    } catch { /* mid-write */ }
  }));
  tasks.sort((a, b) => Number(a.id) - Number(b.id) || String(a.id).localeCompare(String(b.id)));
  tasksCache.set(sessionId, { sig, tasks });
  return tasks;
}

async function poll() {
  const registry = await readRegistry();
  const next = await Promise.all(registry.map(async r => {
    const [a, tasks] = await Promise.all([activityFor(r.sessionId), tasksFor(r.sessionId)]);
    return {
      pid: r.pid,
      sessionId: r.sessionId,
      cwd: r.cwd,
      name: r.name,
      kind: r.kind,
      status: r.status || 'unknown',
      waitingFor: r.waitingFor || null,
      startedAt: r.startedAt,
      statusUpdatedAt: r.statusUpdatedAt || r.updatedAt,
      version: r.version,
      title: a?.customTitle || a?.aiTitle || r.name,
      model: a?.model || null,
      permissionMode: a?.permissionMode || null,
      costUSD: a?.costUSD ?? null,
      planFile: a?.planFile || null,
      awaySummary: a?.awaySummary || null,
      lastTool: a?.lastTool || null,
      lastText: a?.lastText || null,
      lastUser: a?.lastUser || null,
      transcriptUpdatedAt: a?.mtimeMs || null,
      tasks,
    };
  }));
  next.sort((x, y) => (y.statusUpdatedAt || 0) - (x.statusUpdatedAt || 0));
  const json = JSON.stringify(next);
  if (json !== liveJson) {
    live = next;
    liveJson = json;
    events.emit('live', live);
  }
}

export function startSessionMonitor() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await poll(); } catch (e) { console.error('session poll failed:', e); } finally { running = false; }
  };
  tick();
  setInterval(tick, 1000).unref();
}

export const liveSessions = () => live;

// ---------------------------------------------------------------- history

export async function listHistory() {
  const files = await scanTranscriptFiles();
  const summaries = (await Promise.all(files.map(f => summarizeTranscript(f.id, f.file))))
    .filter(s => s && (s.firstPrompt || s.aiTitle || s.customTitle));
  const liveIds = new Set(live.map(s => s.sessionId));
  const groups = new Map();
  for (const s of summaries) {
    const key = s.cwd || path.dirname(s.file);
    if (!groups.has(key)) groups.set(key, { cwd: key, name: path.basename(key), sessions: [], updatedAt: 0 });
    const g = groups.get(key);
    g.sessions.push({
      sessionId: s.sessionId,
      title: s.title,
      agentName: s.agentName || null,
      firstPrompt: s.firstPrompt || null,
      lastPrompt: s.lastPrompt || null,
      startedAt: s.startedAt || null,
      updatedAt: s.updatedAt,
      size: s.size,
      model: s.model || null,
      costUSD: s.costUSD ?? null,
      gitBranch: s.gitBranch || null,
      planFile: s.planFile || null,
      live: liveIds.has(s.sessionId),
    });
    g.updatedAt = Math.max(g.updatedAt, s.updatedAt);
  }
  const out = [...groups.values()];
  for (const g of out) g.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

// ---------------------------------------------------------------- plans

export async function listPlans() {
  let names = [];
  try { names = (await fsp.readdir(PLANS_DIR)).filter(n => /\.md$/i.test(n)); } catch { return []; }
  const history = await listHistory();
  const bySlug = new Map();
  for (const g of history) for (const s of g.sessions) {
    if (s.planFile) bySlug.set(path.basename(s.planFile, '.md'), { ...s, cwd: g.cwd });
  }
  const plans = await Promise.all(names.map(async n => {
    const file = path.join(PLANS_DIR, n);
    const st = await fsp.stat(file);
    let title = n.replace(/\.md$/i, '');
    try {
      const head = (await fsp.readFile(file, 'utf8')).slice(0, 4096);
      const h = /^#{1,2}\s+(.+)$/m.exec(head);
      if (h) title = h[1].trim();
    } catch { /* unreadable */ }
    const session = bySlug.get(n.replace(/\.md$/i, ''));
    return {
      path: file,
      name: n,
      title,
      updatedAt: st.mtimeMs,
      size: st.size,
      sessionId: session?.sessionId || null,
      sessionTitle: session?.title || null,
      cwd: session?.cwd || null,
    };
  }));
  plans.sort((a, b) => b.updatedAt - a.updatedAt);
  return plans;
}

// ---------------------------------------------------------------- recent folders

export async function recentFolders() {
  const seen = new Map();
  const add = (p, t) => {
    if (!p) return;
    const key = p.toLowerCase();
    if (!seen.has(key) || seen.get(key).t < t) seen.set(key, { path: p, t });
  };
  for (const s of live) add(s.cwd, Date.now());
  for (const g of await listHistory()) add(g.cwd, g.updatedAt);
  try {
    const lines = (await fsp.readFile(HISTORY_FILE, 'utf8')).split('\n').slice(-2000);
    for (const line of lines) {
      try { const h = JSON.parse(line); add(h.project, h.timestamp || 0); } catch { /* skip */ }
    }
  } catch { /* no history file */ }
  return [...seen.values()]
    .filter(f => fs.existsSync(f.path))
    .sort((a, b) => b.t - a.t)
    .map(f => ({ path: f.path, name: path.basename(f.path), usedAt: f.t }));
}
