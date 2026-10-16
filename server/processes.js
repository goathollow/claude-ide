import { execFile } from 'node:child_process';
import { IS_WIN } from './config.js';

// pid -> image name, refreshed in the background. Used to reject registry files
// whose PID has been reused by an unrelated process after a crash or reboot.
let images = new Map();
let refreshing = false;

function refreshImages() {
  if (!IS_WIN || refreshing) return;
  refreshing = true;
  execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
    refreshing = false;
    if (err) return;
    const next = new Map();
    for (const line of stdout.split(/\r?\n/)) {
      const m = /^"([^"]*)","(\d+)"/.exec(line);
      if (m) next.set(Number(m[2]), m[1].toLowerCase());
    }
    images = next;
  });
}

export function startProcessMonitor() {
  refreshImages();
  const t = setInterval(refreshImages, 4000);
  t.unref();
}

const CLAUDE_IMAGE = /^(claude|node|bun)(\.exe)?$/;

export function isClaudeAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    if (e.code !== 'EPERM') return false;
  }
  // A PID missing from the snapshot is most likely newer than the snapshot.
  const image = images.get(pid);
  return image === undefined || CLAUDE_IMAGE.test(image);
}
