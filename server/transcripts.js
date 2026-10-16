import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PROJECTS_DIR, PLANS_DIR } from './config.js';

// Claude Code writes one JSONL transcript per session at
// ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl. Files can exceed 100MB,
// so listings only read the head and tail, and the full view parses
// incrementally from the last byte offset it reached.

export const isSessionId = id => typeof id === 'string' && /^[0-9a-f-]{8,64}$/i.test(id);

// ---------------------------------------------------------------- locating

const fileById = new Map();
let lastScan = 0;

export async function scanTranscriptFiles() {
  const out = [];
  let dirs = [];
  try { dirs = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(PROJECTS_DIR, d.name);
    let names = [];
    try { names = await fsp.readdir(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const id = name.slice(0, -'.jsonl'.length);
      const file = path.join(dir, name);
      fileById.set(id, file);
      out.push({ id, file, projectDir: d.name });
    }
  }
  lastScan = Date.now();
  return out;
}

export async function transcriptPath(sessionId) {
  if (!isSessionId(sessionId)) return null;
  const known = fileById.get(sessionId);
  if (known && fs.existsSync(known)) return known;
  if (Date.now() - lastScan > 1500) await scanTranscriptFiles();
  return fileById.get(sessionId) || null;
}

// ---------------------------------------------------------------- raw reads

async function readRange(file, start, length) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

function parseLines(text, dropFirst, dropLast) {
  const lines = text.split('\n');
  if (dropFirst) lines.shift();
  if (dropLast) lines.pop();
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* partial or corrupt line */ }
  }
  return out;
}

async function readHead(file, size, bytes) {
  const buf = await readRange(file, 0, Math.min(size, bytes));
  return parseLines(buf.toString('utf8'), false, size > bytes);
}

async function readTail(file, size, bytes) {
  const start = Math.max(0, size - bytes);
  const buf = await readRange(file, start, size - start);
  return parseLines(buf.toString('utf8'), start > 0, false);
}

// ---------------------------------------------------------------- record helpers

const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');
const firstLine = s => (s || '').split(/\r?\n/).find(l => l.trim()) || '';

function blocksText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(b => (b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
}

const TAG = /^\s*<([a-z][\w-]*)>/i;
const tagBody = (s, tag) => {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(s);
  return m ? m[1].trim() : '';
};

// Classifies a user record: a typed prompt, a slash command, command output,
// or null for tool results and injected/meta content.
function classifyUser(rec) {
  if (rec.type !== 'user' || rec.isSidechain) return null;
  const c = rec.message?.content;
  if (Array.isArray(c) && c.some(b => b.type === 'tool_result')) return null;
  if (rec.isMeta) return null;
  const text = blocksText(c);
  if (!text.trim()) return null;
  const tag = TAG.exec(text)?.[1];
  if (!tag) return { k: 'user', text };
  if (tag === 'command-name' || tag === 'command-message') {
    const name = tagBody(text, 'command-name') || tagBody(text, 'command-message');
    const args = tagBody(text, 'command-args');
    return { k: 'cmd', text: `${name.startsWith('/') ? name : '/' + name}${args ? ' ' + args : ''}` };
  }
  if (tag === 'bash-input') return { k: 'cmd', text: '! ' + tagBody(text, 'bash-input') };
  if (tag === 'local-command-stdout' || tag === 'bash-stdout' || tag === 'bash-stderr') {
    const body = text.replace(/<\/?[a-z-]+>/gi, '').trim();
    return body ? { k: 'out', text: body } : null;
  }
  return null; // system-reminder, task-notification and similar injected content
}

export function toolSummary(name, input = {}) {
  const pick = (...keys) => keys.map(k => input[k]).find(v => typeof v === 'string' && v);
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return input.description || firstLine(input.command);
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return pick('file_path', 'notebook_path');
    case 'Grep':
      return `${input.pattern}${input.path ? ' in ' + input.path : ''}`;
    case 'Glob':
      return input.pattern;
    case 'WebFetch':
      return input.url;
    case 'WebSearch':
      return input.query;
    case 'Agent':
    case 'Task':
      return pick('description', 'prompt');
    case 'TaskCreate':
    case 'TaskUpdate':
      return pick('subject', 'activeForm', 'status', 'taskId');
    case 'Skill':
      return input.skill;
    case 'ExitPlanMode':
      return 'Plan ready for review';
    default:
      return firstLine(pick(...Object.keys(input)) || '');
  }
}

// Updates session-level facts that any record may carry.
function applyMeta(meta, rec) {
  if (rec.cwd && !meta.cwd) meta.cwd = rec.cwd;
  if (rec.gitBranch) meta.gitBranch = rec.gitBranch;
  if (rec.version) meta.version = rec.version;
  if (rec.slug) meta.slug = rec.slug;
  if (rec.timestamp) {
    if (!meta.startedAt) meta.startedAt = rec.timestamp;
    meta.lastTs = rec.timestamp;
  }
  switch (rec.type) {
    case 'ai-title': meta.aiTitle = rec.aiTitle; break;
    case 'custom-title': meta.customTitle = rec.customTitle || rec.title; break;
    case 'agent-name': meta.agentName = rec.agentName; break;
    case 'last-prompt': meta.lastPrompt = clip(rec.lastPrompt, 300); break;
    case 'permission-mode': meta.permissionMode = rec.permissionMode; break;
    case 'cost-state': meta.costUSD = rec.totalCostUSD; break;
    case 'assistant':
      if (!rec.isSidechain && rec.message?.model && !rec.message.model.startsWith('<')) meta.model = rec.message.model;
      break;
    case 'system':
      if (rec.subtype === 'away_summary' && rec.content) meta.awaySummary = rec.content;
      break;
  }
}

function finishMeta(meta) {
  meta.title = meta.customTitle || meta.aiTitle || clip(firstLine(meta.firstPrompt), 100) || meta.agentName || '(untitled)';
  if (meta.slug) {
    const plan = path.join(PLANS_DIR, meta.slug + '.md');
    if (fs.existsSync(plan)) meta.planFile = plan;
  }
  return meta;
}

// ---------------------------------------------------------------- listing summaries

const summaryCache = new Map(); // file -> { size, mtimeMs, summary }

export async function summarizeTranscript(id, file) {
  let st;
  try { st = await fsp.stat(file); } catch { return null; }
  const cached = summaryCache.get(file);
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.summary;

  const meta = { sessionId: id, file, size: st.size, updatedAt: st.mtimeMs, prompts: 0 };
  const head = await readHead(file, st.size, 256 * 1024);
  for (const rec of head) {
    applyMeta(meta, rec);
    const u = classifyUser(rec);
    if (u?.k === 'user' && !meta.firstPrompt) meta.firstPrompt = clip(u.text, 300);
  }
  if (st.size > 256 * 1024) {
    for (const rec of await readTail(file, st.size, 512 * 1024)) applyMeta(meta, rec);
  }
  if (!meta.lastPrompt) meta.lastPrompt = meta.firstPrompt;
  const summary = finishMeta(meta);
  summaryCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, summary });
  return summary;
}

// ---------------------------------------------------------------- live activity

// What a live session is doing right now, from the tail of its transcript.
export async function recentActivity(file) {
  let st;
  try { st = await fsp.stat(file); } catch { return null; }
  for (const bytes of [256 * 1024, 4 * 1024 * 1024]) {
    const recs = await readTail(file, st.size, bytes);
    const meta = {};
    for (const rec of recs) applyMeta(meta, rec);
    let lastTool = null, lastText = null, lastUser = null;
    for (let i = recs.length - 1; i >= 0 && !(lastTool && lastText && lastUser); i--) {
      const rec = recs[i];
      if (rec.isSidechain) continue;
      if (rec.type === 'assistant' && Array.isArray(rec.message?.content)) {
        for (const b of rec.message.content) {
          if (b.type === 'tool_use' && !lastTool) lastTool = { name: b.name, summary: clip(toolSummary(b.name, b.input), 200), ts: rec.timestamp };
          if (b.type === 'text' && b.text.trim() && !lastText) lastText = { text: clip(b.text.trim(), 600), ts: rec.timestamp };
        }
      } else if (!lastUser) {
        const u = classifyUser(rec);
        if (u?.k === 'user') lastUser = { text: clip(u.text, 300), ts: rec.timestamp };
      }
    }
    if (lastTool || lastText || lastUser || bytes >= st.size) {
      return { ...finishMeta(meta), lastTool, lastText, lastUser, size: st.size, mtimeMs: st.mtimeMs };
    }
  }
  return null;
}

// ---------------------------------------------------------------- full transcript

const PREVIEW = 1500;

function resultText(block) {
  const c = block.content;
  if (typeof c === 'string') return c;
  return blocksText(c);
}

class TranscriptIndex {
  constructor(id, file) {
    this.id = id;
    this.file = file;
    this.offset = 0;
    this.leftover = null;
    this.entries = [];
    this.toolAt = new Map(); // tool_use id -> entry index
    this.meta = { sessionId: id, file, prompts: 0 };
    this.size = 0;
    this.lastChange = -1;
    this.lastAccess = Date.now();
    this.updating = null;
  }

  reset() {
    Object.assign(this, new TranscriptIndex(this.id, this.file));
  }

  // Parses anything appended since the last call. Returns the index of the
  // first entry that changed (appended or updated with a tool result), or -1.
  update() {
    this.lastAccess = Date.now();
    if (!this.updating) this.updating = this._update().finally(() => { this.updating = null; });
    return this.updating;
  }

  async _update() {
    let st;
    try { st = await fsp.stat(this.file); } catch { return -1; }
    if (st.size < this.offset) this.reset();
    if (st.size === this.offset) return -1;

    const before = this.entries.length;
    let firstChanged = Infinity;
    // Reading restarts at the last complete line, so a partial line from a
    // previous pass is re-read rather than carried over.
    this.leftover = null;
    const stream = fs.createReadStream(this.file, { start: this.offset, end: st.size - 1, highWaterMark: 1 << 20 });
    for await (const chunk of stream) {
      let buf = this.leftover ? Buffer.concat([this.leftover, chunk]) : chunk;
      this.leftover = null;
      let start = 0;
      for (let nl = buf.indexOf(10, start); nl !== -1; nl = buf.indexOf(10, start)) {
        const lineOffset = this.offset;
        const line = buf.toString('utf8', start, nl);
        this.offset += nl - start + 1;
        start = nl + 1;
        if (!line.trim()) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        const changed = this.ingest(rec, lineOffset);
        if (changed !== -1 && changed < firstChanged) firstChanged = changed;
      }
      if (start < buf.length) this.leftover = buf.subarray(start);
    }
    this.size = st.size;
    finishMeta(this.meta);
    if (this.entries.length > before && before < firstChanged) firstChanged = before;
    if (firstChanged === Infinity) return -1;
    // Accumulates until the watcher loop pushes it to subscribers.
    this.lastChange = this.lastChange === -1 ? firstChanged : Math.min(this.lastChange, firstChanged);
    return firstChanged;
  }

  push(entry) {
    this.entries.push(entry);
    return this.entries.length - 1;
  }

  ingest(rec, off) {
    applyMeta(this.meta, rec);
    if (rec.isSidechain) return -1;
    const ts = rec.timestamp;

    if (rec.type === 'user') {
      const c = rec.message?.content;
      if (Array.isArray(c)) {
        let changed = -1;
        for (const b of c) {
          if (b.type !== 'tool_result') continue;
          const at = this.toolAt.get(b.tool_use_id);
          if (at === undefined) continue;
          const e = this.entries[at];
          const text = resultText(b);
          e.result = clip(text, PREVIEW);
          e.resultFull = text.length > PREVIEW;
          e.resOff = off;
          e.error = !!b.is_error;
          e.done = true;
          if (changed === -1 || at < changed) changed = at;
        }
        if (changed !== -1) return changed;
      }
      const u = classifyUser(rec);
      if (!u) return -1;
      if (u.k === 'user') {
        this.meta.prompts++;
        if (!this.meta.firstPrompt) this.meta.firstPrompt = clip(u.text, 300);
      }
      return this.push({ ...u, ts });
    }

    if (rec.type === 'attachment' && rec.attachment?.type === 'queued_command' && rec.attachment.commandMode === 'prompt') {
      this.meta.prompts++;
      return this.push({ k: 'user', text: rec.attachment.prompt || '', ts, queued: true });
    }

    if (rec.type === 'assistant' && Array.isArray(rec.message?.content)) {
      let first = -1;
      for (const b of rec.message.content) {
        let i = -1;
        if (b.type === 'text' && b.text.trim()) {
          i = this.push({ k: 'text', text: b.text, ts });
        } else if (b.type === 'tool_use') {
          const input = JSON.stringify(b.input ?? {}, null, 2);
          i = this.push({
            k: 'tool', id: b.id, name: b.name, summary: clip(toolSummary(b.name, b.input), 240),
            input: clip(input, PREVIEW), inputFull: input.length > PREVIEW, inOff: off, ts,
          });
          this.toolAt.set(b.id, i);
        }
        if (first === -1) first = i;
      }
      return first;
    }

    if (rec.type === 'system') {
      switch (rec.subtype) {
        case 'away_summary': return this.push({ k: 'note', sub: 'summary', text: rec.content, ts });
        case 'compact_boundary': return this.push({ k: 'note', sub: 'compact', text: 'Conversation compacted', ts });
        case 'turn_duration': return this.push({ k: 'turn', ms: rec.durationMs, ts });
        case 'api_error': return this.push({ k: 'note', sub: 'error', text: clip(rec.content || 'API error', 500), ts });
        case 'informational':
        case 'local_command':
          return rec.content ? this.push({ k: 'note', sub: 'info', text: clip(String(rec.content).replace(/<\/?[a-z-]+>/gi, ''), 500), ts }) : -1;
      }
    }
    return -1;
  }
}

const indexes = new Map();

export async function transcriptIndex(sessionId) {
  const file = await transcriptPath(sessionId);
  if (!file) return null;
  let idx = indexes.get(sessionId);
  if (!idx || idx.file !== file) {
    idx = new TranscriptIndex(sessionId, file);
    indexes.set(sessionId, idx);
  }
  await idx.update();
  return idx;
}

export function peekIndex(sessionId) {
  return indexes.get(sessionId) || null;
}

// Drop parsed transcripts nobody has looked at in a while.
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, idx] of indexes) if (idx.lastAccess < cutoff) indexes.delete(id);
}, 60 * 1000).unref();

// Full input/result for one tool call, re-read from the recorded byte offsets.
export async function fullToolCall(sessionId, toolId, inOff, resOff) {
  const file = await transcriptPath(sessionId);
  if (!file) return null;
  const readRecord = async off => {
    if (!Number.isInteger(off) || off < 0) return null;
    const fh = await fsp.open(file, 'r');
    try {
      const chunks = [];
      let pos = off;
      for (;;) {
        const buf = Buffer.alloc(1 << 20);
        const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
        if (!bytesRead) break;
        const nl = buf.subarray(0, bytesRead).indexOf(10);
        if (nl !== -1) { chunks.push(buf.subarray(0, nl)); break; }
        chunks.push(buf.subarray(0, bytesRead));
        pos += bytesRead;
        if (pos - off > 64 * 1024 * 1024) break;
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return null;
    } finally {
      await fh.close();
    }
  };
  const out = {};
  const inRec = await readRecord(inOff);
  const use = inRec?.message?.content?.find?.(b => b.type === 'tool_use' && b.id === toolId);
  if (use) out.input = JSON.stringify(use.input ?? {}, null, 2);
  const resRec = await readRecord(resOff);
  const res = resRec?.message?.content?.find?.(b => b.type === 'tool_result' && b.tool_use_id === toolId);
  if (res) out.result = resultText(res);
  const cap = s => (s && s.length > 500_000 ? s.slice(0, 500_000) + '\n… (truncated)' : s);
  return { input: cap(out.input), result: cap(out.result) };
}
