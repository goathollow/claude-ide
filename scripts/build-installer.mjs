// Builds dist\claude-ide-setup.exe, the Windows installer, from the executable
// npm run build:exe made, using packaging/installer.iss. It needs Inno Setup 6
// (https://jrsoftware.org/isinfo.php). Set ISCC to its ISCC.exe if it isn't
// installed in the usual place.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SETUP = path.join(ROOT, 'dist', 'claude-ide-setup.exe');

if (process.platform !== 'win32') {
  console.error('The Windows installer can only be built on Windows.');
  process.exit(1);
}

const iscc = [
  process.env.ISCC,
  ...['ProgramFiles(x86)', 'ProgramFiles'].map(v => process.env[v] && path.join(process.env[v], 'Inno Setup 6', 'ISCC.exe')),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Inno Setup 6', 'ISCC.exe'),
].find(p => p && fs.existsSync(p));
if (!iscc) {
  console.error("Inno Setup 6 isn't installed. Get it from https://jrsoftware.org/isinfo.php, or set ISCC to its ISCC.exe.");
  process.exit(1);
}

try {
  execFileSync(iscc, ['/Qp', path.join(ROOT, 'packaging', 'installer.iss')], { stdio: 'inherit' });
} catch {
  process.exit(1);
}
console.log(`\nBuilt ${path.relative(ROOT, SETUP)} (${(fs.statSync(SETUP).size / 1048576).toFixed(1)} MB)`);
