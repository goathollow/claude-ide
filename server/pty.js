import { createRequire } from 'node:module';
import path from 'node:path';

// node-pty is a native module, so the standalone executable can't bundle it.
// There it is loaded from the folder the executable unpacks itself into.
const root = globalThis.__CLAUDE_IDE_ROOT;
const load = createRequire(root ? path.join(root, 'index.cjs') : import.meta.url);

export default load('node-pty');
