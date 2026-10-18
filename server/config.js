import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
export const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
export const PLANS_DIR = path.join(CLAUDE_DIR, 'plans');
export const TASKS_DIR = path.join(CLAUDE_DIR, 'tasks');
export const HISTORY_FILE = path.join(CLAUDE_DIR, 'history.jsonl');

export const HOST = process.env.CLAUDE_IDE_HOST || '127.0.0.1';
export const PORT = Number(process.env.CLAUDE_IDE_PORT || 4477);

export const IS_WIN = process.platform === 'win32';

// Env vars that describe the Claude session the IDE server itself may have been
// launched from. Passing them to child sessions would make those children think
// they are nested inside it, so they are stripped before spawning.
const INHERITED_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SSE_PORT',
  'AI_AGENT',
];

export function childEnv() {
  const env = { ...process.env, COLORTERM: 'truecolor', FORCE_COLOR: '1' };
  for (const k of INHERITED_SESSION_VARS) delete env[k];
  return env;
}

function resolveClaudeBin() {
  if (process.env.CLAUDE_IDE_CLAUDE_BIN) return process.env.CLAUDE_IDE_CLAUDE_BIN;
  try {
    const out = execFileSync(IS_WIN ? 'where' : 'which', ['claude'], { encoding: 'utf8', windowsHide: true });
    const lines = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    // On Windows prefer a real executable over a .cmd shim; ConPTY can't run shims directly.
    const found = (IS_WIN && lines.find(l => /\.exe$/i.test(l))) || lines[0];
    if (found) return found;
  } catch { /* not on PATH */ }
  // Started from the desktop rather than a shell, the IDE may not have the
  // shell's PATH, so also look where Claude's installers put it.
  const home = os.homedir();
  const known = IS_WIN
    ? [path.join(home, '.local', 'bin', 'claude.exe')]
    : [path.join(home, '.local', 'bin', 'claude'), path.join(home, '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  return known.find(p => fs.existsSync(p)) || 'claude';
}

export const CLAUDE_BIN = resolveClaudeBin();
