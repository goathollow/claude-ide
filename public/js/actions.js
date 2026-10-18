import { api, getState, setState, sessionInfo, basename, normalizePath } from './lib.js';

// ---------------------------------------------------------------- tabs

export function openTab(tab) {
  setState(s => ({
    tabs: s.tabs.some(t => t.id === tab.id) ? s.tabs.map(t => (t.id === tab.id ? { ...t, ...tab } : t)) : [...s.tabs, tab],
    activeTab: tab.id,
  }));
}

export async function closeTab(id) {
  const st = getState();
  const tab = st.tabs.find(t => t.id === id);
  if (!tab || tab.type === 'home') return;
  if (st.dirty[id] && !confirm(`Discard unsaved changes to ${basename(tab.path)}?`)) return;
  if (tab.type === 'terminal') {
    const term = st.terminals.find(t => t.id === tab.terminalId);
    if (term && !term.exited && !confirm('Close this terminal? The Claude session will be stopped (you can resume it later from History).')) return;
    if (term) await api.del(`/api/terminals/${tab.terminalId}`).catch(() => {});
  }
  setState(s => {
    const i = s.tabs.findIndex(t => t.id === id);
    const tabs = s.tabs.filter(t => t.id !== id);
    const dirty = { ...s.dirty };
    delete dirty[id];
    const activeTab = s.activeTab === id ? (tabs[Math.min(i, tabs.length - 1)] || tabs[0]).id : s.activeTab;
    return { tabs, activeTab, dirty };
  });
}

export function openTerminal(terminalId) {
  const term = getState().terminals.find(t => t.id === terminalId);
  openTab({ id: 'term:' + terminalId, type: 'terminal', terminalId, sessionId: term?.sessionId, cwd: term?.cwd });
}

export function openTranscript(sessionId) {
  openTab({ id: 'chat:' + sessionId, type: 'transcript', sessionId });
}

export function openFile(path, mode) {
  path = normalizePath(path);
  openTab({ id: 'file:' + path.toLowerCase(), type: 'file', path, ...(mode ? { mode } : {}) });
}

// Hosted sessions open their terminal; anything else opens the transcript.
export function openSession(sessionId) {
  const info = sessionInfo(sessionId);
  const termId = info?.live?.terminalId || info?.terminal?.id;
  if (termId) openTerminal(termId);
  else openTranscript(sessionId);
}

export function goHome() {
  setState({ activeTab: 'home' });
}

// Stops the server, which ends the Claude sessions started in the IDE. Closing
// the window instead leaves them running.
export async function quitIde() {
  const n = getState().terminals.filter(t => !t.exited).length;
  const [what, them] = n === 1 ? ['the Claude session', 'it'] : [`the ${n} Claude sessions`, 'them'];
  if (n && !confirm(`Quit Claude IDE? This stops ${what} running in it (you can resume ${them} later from History).\n\nTo leave ${them} running, close the window instead.`)) return;
  await api.post('/api/quit').catch(() => {});
}

// ---------------------------------------------------------------- chats

export async function startChat({ cwd, name, permissionMode, model, resume }) {
  const term = await api.post('/api/terminals', { cwd, name, permissionMode, model, resume });
  setState(s => ({ terminals: s.terminals.some(t => t.id === term.id) ? s.terminals : [...s.terminals, term] }));
  openTerminal(term.id);
  return term;
}

export async function resumeSession(sessionId) {
  const info = sessionInfo(sessionId);
  if (info?.live && !info.live.terminalId) {
    toast({ kind: 'needs', title: 'Already running', text: 'This chat is open in another terminal. Close it there first, then resume it here.' });
    return;
  }
  if (!info?.cwd) {
    toast({ kind: 'needs', title: "Can't resume", text: 'The folder for this chat is unknown.' });
    return;
  }
  try {
    await startChat({ cwd: info.cwd, resume: sessionId });
  } catch (e) {
    toast({ kind: 'needs', title: "Couldn't resume", text: e.message });
  }
}

export function newChatDialog(cwd) {
  setState({ dialog: { type: 'new-chat', cwd: cwd || null } });
}

// ---------------------------------------------------------------- misc

export function showFolder(path) {
  setState({ explorerRoot: path, sidebar: 'files', sidebarOpen: true });
}

export function reveal(path) {
  api.post('/api/reveal', { path }).catch(e => toast({ kind: 'needs', title: "Couldn't open folder", text: e.message }));
}

let toastId = 0;
export function toast({ kind = 'idle', title, text, sessionId, timeout = 6000 }) {
  const id = ++toastId;
  setState(s => ({ toasts: [...s.toasts.slice(-3), { id, kind, title, text, sessionId }] }));
  setTimeout(() => dismissToast(id), timeout);
}

export function dismissToast(id) {
  setState(s => ({ toasts: s.toasts.filter(t => t.id !== id) }));
}

export async function refreshLists() {
  const [history, plans, recentFolders] = await Promise.all([
    api.get('/api/history').catch(() => null),
    api.get('/api/plans').catch(() => null),
    api.get('/api/folders/recent').catch(() => null),
  ]);
  setState(s => ({
    history: history || s.history,
    plans: plans || s.plans,
    recentFolders: recentFolders || s.recentFolders,
  }));
}

export function copyText(text, what = 'Copied') {
  navigator.clipboard?.writeText(text).then(() => toast({ title: what, text, timeout: 2500 }));
}
