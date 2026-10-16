import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { IS_WIN } from './config.js';

const MAX_READ = 10 * 1024 * 1024;
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'target', 'coverage', '.next', '.nuxt', '.cache',
  '.venv', 'venv', '__pycache__', '.idea', '.vs', '.vscode-test', 'obj', 'bin', 'Library', 'Temp',
  'Logs', 'UserSettings', '.gradle', '.terraform', 'vendor',
]);

export class FsError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function resolvePath(p) {
  if (typeof p !== 'string' || !p.trim()) throw new FsError(400, 'path is required');
  // Relative paths (including drive-relative ones like "C:foo") would resolve
  // against the server's own folder, which is never what the user meant.
  if (!path.isAbsolute(p.trim())) throw new FsError(400, `Use a full path (got "${p.trim()}")`);
  return path.resolve(p.trim());
}

export function drives() {
  if (!IS_WIN) return ['/'];
  const out = [];
  for (let c = 65; c <= 90; c++) {
    const d = String.fromCharCode(c) + ':\\';
    try { fs.accessSync(d); out.push(d); } catch { /* not mounted */ }
  }
  return out;
}

export async function listDir(dir) {
  dir = resolvePath(dir);
  let dirents;
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    throw new FsError(e.code === 'ENOENT' ? 404 : 400, `Cannot list ${dir}: ${e.code || e.message}`);
  }
  const entries = [];
  for (const d of dirents) {
    if (d.name === '.git') continue;
    const full = path.join(dir, d.name);
    let isDir = d.isDirectory();
    if (d.isSymbolicLink()) {
      try { isDir = (await fsp.stat(full)).isDirectory(); } catch { continue; }
    }
    entries.push({ name: d.name, path: full, dir: isDir, heavy: isDir && SKIP_DIRS.has(d.name) });
  }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.dir ? -1 : 1));
  const parent = path.dirname(dir);
  return { path: dir, parent: parent === dir ? null : parent, entries };
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export async function readText(file) {
  file = resolvePath(file);
  let st;
  try { st = await fsp.stat(file); } catch { throw new FsError(404, `Not found: ${file}`); }
  if (st.isDirectory()) throw new FsError(400, 'Is a directory');
  if (st.size > MAX_READ) throw new FsError(413, `File is too large to open (${(st.size / 1048576).toFixed(1)} MB)`);
  const buf = await fsp.readFile(file);
  if (looksBinary(buf)) throw new FsError(415, 'Binary file');
  return { path: file, content: buf.toString('utf8'), mtimeMs: st.mtimeMs, size: st.size };
}

export async function writeText(file, content, baseMtimeMs, force) {
  file = resolvePath(file);
  if (typeof content !== 'string') throw new FsError(400, 'content must be a string');
  let st;
  try { st = await fsp.stat(file); } catch { throw new FsError(404, `Not found: ${file}`); }
  if (!force && baseMtimeMs && Math.abs(st.mtimeMs - baseMtimeMs) > 1) {
    throw Object.assign(new FsError(409, 'File changed on disk since it was opened'), { mtimeMs: st.mtimeMs });
  }
  await fsp.writeFile(file, content, 'utf8');
  const after = await fsp.stat(file);
  return { path: file, mtimeMs: after.mtimeMs, size: after.size };
}

export async function makeDir(dir) {
  dir = resolvePath(dir);
  if (!fs.existsSync(path.dirname(dir))) throw new FsError(404, `Parent folder does not exist: ${path.dirname(dir)}`);
  try {
    await fsp.mkdir(dir);
  } catch (e) {
    throw new FsError(e.code === 'EEXIST' ? 409 : 400, e.code === 'EEXIST' ? 'Folder already exists' : e.message);
  }
  return { path: dir };
}

export async function stat(file) {
  try {
    const st = await fsp.stat(resolvePath(file));
    return { exists: true, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return { exists: false };
  }
}

// Markdown files under a project root, most recently modified first.
export async function findMarkdown(root, { maxDepth = 6, maxFiles = 800 } = {}) {
  root = resolvePath(root);
  const out = [];
  let visited = 0;
  const walk = async (dir, depth) => {
    if (depth > maxDepth || out.length >= maxFiles || visited++ > 4000) return;
    let dirents;
    try { dirents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const d of dirents) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(d.name) && !(d.name.startsWith('.') && d.name !== '.claude')) await walk(full, depth + 1);
      } else if (/\.(md|mdx|markdown)$/i.test(d.name)) {
        try {
          const st = await fsp.stat(full);
          out.push({ path: full, rel: path.relative(root, full), mtimeMs: st.mtimeMs, size: st.size });
        } catch { /* vanished */ }
        if (out.length >= maxFiles) return;
      }
    }
  };
  await walk(root, 0);
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}
