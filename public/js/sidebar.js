import { useEffect, useState, useRef } from 'preact/hooks';
import {
  html, api, useStore, useTick, getState, setState, attention, activityLine, byAttention, timeAgo, basename,
  shortPath, isMarkdown, sessionIdForTab,
} from './lib.js';
import {
  openSession, openTerminal, openFile, newChatDialog, resumeSession, closeTab, reveal, refreshLists, toast,
} from './actions.js';
import { Icon } from './icons.js';

// ---------------------------------------------------------------- activity bar

export function ActivityBar() {
  const sidebar = useStore(s => s.sidebar);
  const open = useStore(s => s.sidebarOpen);
  const theme = useStore(s => s.theme);
  const notify = useStore(s => s.notify);
  const counts = useStore(s => {
    let needs = 0, ready = 0;
    for (const l of s.live) {
      const c = attention(l, s.seen).cls;
      if (c === 'needs') needs++;
      if (c === 'ready') ready++;
    }
    return { needs, ready };
  });

  const pick = name => setState(s => (s.sidebar === name ? { sidebarOpen: !s.sidebarOpen } : { sidebar: name, sidebarOpen: true }));
  const item = (name, icon, title, badge) => html`
    <button class=${'act' + (sidebar === name && open ? ' on' : '')} title=${title} onClick=${() => pick(name)}>
      <${Icon} name=${icon} size=${20} />${badge}
    </button>`;

  const toggleNotify = async () => {
    if (notify) return setState({ notify: false });
    if (!('Notification' in window)) return toast({ title: 'Notifications are not supported in this browser' });
    const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (perm === 'granted') {
      setState({ notify: true });
      toast({ title: 'Desktop notifications on', text: "You'll be notified when a session finishes or needs you." });
    } else {
      toast({ kind: 'needs', title: 'Notifications blocked', text: 'Allow notifications for this site in your browser settings.' });
    }
  };

  const toggleTheme = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('ide.theme', next); } catch { /* storage unavailable */ }
    setState({ theme: next });
  };

  return html`<nav class="activitybar">
    ${item('sessions', 'pulse', 'Live sessions', counts.needs
      ? html`<span class="badge">${counts.needs}</span>`
      : counts.ready ? html`<span class="badge ready">${counts.ready}</span>` : null)}
    ${item('history', 'history', 'Chat history')}
    ${item('plans', 'plan', 'Plans and markdown')}
    ${item('files', 'files', 'Explorer')}
    <div class="grow"></div>
    <button class=${'act' + (notify ? ' on' : '')} title=${notify ? 'Desktop notifications on' : 'Turn on desktop notifications'} onClick=${toggleNotify}>
      <${Icon} name=${notify ? 'bell' : 'bell-off'} size=${18} />
    </button>
    <button class="act" title="Toggle light/dark theme" onClick=${toggleTheme}>
      <${Icon} name=${theme === 'light' ? 'moon' : 'sun'} size=${18} />
    </button>
  </nav>`;
}

// ---------------------------------------------------------------- sidebar shell

export function Sidebar() {
  const which = useStore(s => s.sidebar);
  const onResize = e => {
    e.preventDefault();
    const move = ev => setState({ sidebarWidth: Math.max(200, Math.min(640, ev.clientX - 46)) });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return html`<aside class="sidebar">
    ${which === 'sessions' && html`<${SessionsPanel} />`}
    ${which === 'history' && html`<${HistoryPanel} />`}
    ${which === 'plans' && html`<${PlansPanel} />`}
    ${which === 'files' && html`<${ExplorerPanel} />`}
    <div class="sidebar-resize" onPointerDown=${onResize}></div>
  </aside>`;
}

const activeSessionId = s => sessionIdForTab(s.tabs.find(t => t.id === s.activeTab), s);

// ---------------------------------------------------------------- sessions

function SessionsPanel() {
  useTick(20000);
  const live = useStore(s => s.live);
  const seen = useStore(s => s.seen);
  const terminals = useStore(s => s.terminals);
  const activeSid = useStore(activeSessionId);
  const liveLoaded = useStore(s => s.liveLoaded);

  const sorted = [...live].sort(byAttention(seen));
  const tracked = t => live.some(l => l.pid === t.pid || l.sessionId === t.sessionId);
  const starting = terminals.filter(t => !t.exited && !tracked(t));
  const ended = terminals.filter(t => t.exited);

  return html`
    <div class="side-head">Sessions<span class="spacer"></span>
      <button class="icon-btn" title="New chat" onClick=${() => newChatDialog()}><${Icon} name="plus" /></button>
    </div>
    <div class="side-body">
      <div class="side-section">
        <div class="label">Running<span class="count">${live.length}</span></div>
        ${liveLoaded && live.length === 0 && starting.length === 0 && html`<div class="empty">No Claude sessions running. Start one with <b>New chat</b>.</div>`}
        ${sorted.map(s => {
          const att = attention(s, seen);
          return html`<div key=${s.sessionId} class=${'item' + (activeSid === s.sessionId ? ' on' : '')} onClick=${() => openSession(s.sessionId)} title=${`${s.title}\n${s.cwd}\n${att.label}${att.detail ? ': ' + att.detail : ''}`}>
            <span class="ico"><span class=${'dot ' + att.cls}></span></span>
            <div class="body">
              <div class="t">${s.title}</div>
              <div class="s">${att.cls === 'needs' ? html`<span style="color:var(--needs)">${att.label} · </span>` : ''}${activityLine(s)}</div>
            </div>
            <span class="when">${s.terminalId ? html`<${Icon} name="terminal" size=${12} />` : ''} ${timeAgo(s.statusUpdatedAt)}</span>
          </div>`;
        })}
        ${starting.map(t => html`<div key=${t.id} class="item" onClick=${() => openTerminal(t.id)}>
          <span class="ico"><${Icon} name="loader" size=${14} class="spin" /></span>
          <div class="body"><div class="t">${t.name || basename(t.cwd)}</div><div class="s">Starting…</div></div>
        </div>`)}
      </div>
      ${ended.length > 0 && html`<div class="side-section">
        <div class="label">Ended in IDE<span class="count">${ended.length}</span></div>
        ${ended.map(t => html`<div key=${t.id} class="item" onClick=${() => openTerminal(t.id)}>
          <span class="ico"><span class="dot exited"></span></span>
          <div class="body"><div class="t">${t.name || basename(t.cwd)}</div><div class="s">Exited${t.exitCode ? ` (code ${t.exitCode})` : ''} · ${shortPath(t.cwd)}</div></div>
          <div class="actions">
            ${t.sessionId && html`<button class="icon-btn" title="Resume" onClick=${e => { e.stopPropagation(); closeTab('term:' + t.id); resumeSession(t.sessionId); }}><${Icon} name="play" size=${13} /></button>`}
            <button class="icon-btn" title="Dismiss" onClick=${e => { e.stopPropagation(); api.del(`/api/terminals/${t.id}`); closeTab('term:' + t.id); }}><${Icon} name="x" size=${13} /></button>
          </div>
        </div>`)}
      </div>`}
    </div>`;
}

// ---------------------------------------------------------------- history

function HistoryPanel() {
  useTick(30000);
  const history = useStore(s => s.history);
  const expanded = useStore(s => s.expandedGroups);
  const activeSid = useStore(activeSessionId);
  const liveStatus = useStore(s => Object.fromEntries(s.live.map(l => [l.sessionId, attention(l, s.seen).cls])));
  const [q, setQ] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const query = q.trim().toLowerCase();
  const groups = history
    .map(g => ({
      ...g,
      sessions: query
        ? g.sessions.filter(s => [s.title, s.firstPrompt, s.lastPrompt, s.agentName, g.cwd].some(v => v?.toLowerCase().includes(query)))
        : g.sessions,
    }))
    .filter(g => g.sessions.length);

  const isOpen = (g, i) => (query ? true : expanded ? expanded.includes(g.cwd) : i < 4);
  const toggle = g => setState(s => {
    const current = s.expandedGroups || s.history.slice(0, 4).map(x => x.cwd);
    return { expandedGroups: current.includes(g.cwd) ? current.filter(c => c !== g.cwd) : [...current, g.cwd] };
  });

  const refresh = async () => {
    setRefreshing(true);
    await refreshLists();
    setRefreshing(false);
  };

  return html`
    <div class="side-head">History<span class="spacer"></span>
      <button class="icon-btn" title="Refresh" onClick=${refresh}><${Icon} name="refresh" class=${refreshing ? 'spin' : ''} /></button>
    </div>
    <input class="filter" placeholder="Filter chats…" value=${q} onInput=${e => setQ(e.currentTarget.value)} />
    <div class="side-body">
      ${groups.length === 0 && html`<div class="empty">${query ? 'No matching chats.' : 'No chats found.'}</div>`}
      ${groups.map((g, i) => html`<div key=${g.cwd}>
        <div class="group-head" onClick=${() => toggle(g)} title=${g.cwd}>
          <${Icon} name=${isOpen(g, i) ? 'chev-down' : 'chev-right'} size=${14} />
          <span>${g.name}</span><span class="n">${g.sessions.length}</span>
          <span class="spacer"></span>
          <button class="icon-btn hover-only" title=${`New chat in ${g.name}`} onClick=${e => { e.stopPropagation(); newChatDialog(g.cwd); }}><${Icon} name="plus" size=${14} /></button>
        </div>
        ${isOpen(g, i) && html`<div class="group-items">
          ${g.sessions.map(s => html`<div key=${s.sessionId} class=${'item' + (activeSid === s.sessionId ? ' on' : '')} onClick=${() => openSession(s.sessionId)}
              title=${`${s.title}\n\n${s.firstPrompt || ''}`}>
            <span class="ico">${liveStatus[s.sessionId] ? html`<span class=${'dot ' + liveStatus[s.sessionId]}></span>` : html`<${Icon} name="chat" size=${14} />`}</span>
            <div class="body">
              <div class="t">${s.title}</div>
              <div class="s">${s.lastPrompt || s.firstPrompt || ''}</div>
            </div>
            <span class="when">${timeAgo(s.updatedAt)}</span>
            <div class="actions">
              ${!liveStatus[s.sessionId] && html`<button class="icon-btn" title="Resume in the IDE" onClick=${e => { e.stopPropagation(); resumeSession(s.sessionId); }}><${Icon} name="play" size=${13} /></button>`}
            </div>
          </div>`)}
        </div>`}
      </div>`)}
    </div>`;
}

// ---------------------------------------------------------------- plans & markdown

function useContextFolder() {
  return useStore(s => s.explorerRoot || s.recentFolders[0]?.path || null);
}

export function useMarkdownFiles(root, refreshMs = 0) {
  const [files, setFiles] = useState(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!root) return setFiles(null);
    let cancelled = false;
    api.get('/api/fs/markdown', { root }).then(r => !cancelled && setFiles(r)).catch(() => !cancelled && setFiles([]));
    return () => { cancelled = true; };
  }, [root, nonce]);
  useEffect(() => {
    if (!refreshMs) return;
    const t = setInterval(() => setNonce(n => n + 1), refreshMs);
    return () => clearInterval(t);
  }, [refreshMs]);
  return [files, () => setNonce(n => n + 1)];
}

function PlansPanel() {
  useTick(30000);
  const plans = useStore(s => s.plans);
  const activeFile = useStore(s => s.tabs.find(t => t.id === s.activeTab)?.path?.toLowerCase());
  const root = useContextFolder();
  const [files, reload] = useMarkdownFiles(root, 20000);

  return html`
    <div class="side-head">Plans & Markdown<span class="spacer"></span>
      <button class="icon-btn" title="Refresh" onClick=${() => { refreshLists(); reload(); }}><${Icon} name="refresh" /></button>
    </div>
    <div class="side-body">
      <div class="side-section">
        <div class="label" title="~/.claude/plans">Claude plans<span class="count">${plans.length}</span></div>
        ${plans.length === 0 && html`<div class="empty">No plans yet. Plans appear here when a session uses plan mode.</div>`}
        ${plans.map(p => html`<div key=${p.path} class=${'item' + (activeFile === p.path.toLowerCase() ? ' on' : '')} onClick=${() => openFile(p.path, 'preview')} title=${p.path}>
          <span class="ico"><${Icon} name="plan" size=${15} /></span>
          <div class="body">
            <div class="t">${p.title}</div>
            <div class="s">${p.cwd ? basename(p.cwd) : p.name}${p.sessionTitle ? ' · ' + p.sessionTitle : ''}</div>
          </div>
          <span class="when">${timeAgo(p.updatedAt)}</span>
        </div>`)}
      </div>
      <div class="side-section">
        <div class="label" title=${root || ''}>Markdown in ${root ? basename(root) : '…'}<span class="count">${files ? files.length : ''}</span></div>
        ${!root && html`<div class="empty">Open a session or pick a folder in the Explorer.</div>`}
        ${root && files === null && html`<div class="empty"><${Icon} name="loader" size=${12} class="spin" /> Scanning…</div>`}
        ${files && files.length === 0 && html`<div class="empty">No markdown files found.</div>`}
        ${files && files.slice(0, 200).map(f => html`<div key=${f.path} class=${'item' + (activeFile === f.path.toLowerCase() ? ' on' : '')} onClick=${() => openFile(f.path)} title=${f.path}>
          <span class="ico"><${Icon} name="md" size=${15} /></span>
          <div class="body"><div class="t">${basename(f.path)}</div><div class="s mono">${f.rel}</div></div>
          <span class="when">${timeAgo(f.mtimeMs)}</span>
        </div>`)}
      </div>
    </div>`;
}

// ---------------------------------------------------------------- explorer

function ExplorerPanel() {
  const root = useContextFolder();
  const recent = useStore(s => s.recentFolders);
  const [nonce, setNonce] = useState(0);

  const choose = e => {
    const v = e.currentTarget.value;
    if (v === '__open__') {
      setState({ dialog: { type: 'open-folder', cwd: root } });
      e.currentTarget.value = root || '';
    } else {
      setState({ explorerRoot: v });
    }
  };

  const options = recent.some(f => f.path === root) || !root ? recent : [{ path: root, name: basename(root) }, ...recent];

  return html`
    <div class="side-head">Explorer<span class="spacer"></span>
      ${root && html`
        <button class="icon-btn" title="New chat in this folder" onClick=${() => newChatDialog(root)}><${Icon} name="plus" /></button>
        <button class="icon-btn" title="Refresh" onClick=${() => setNonce(n => n + 1)}><${Icon} name="refresh" /></button>
        <button class="icon-btn" title="Open in File Explorer" onClick=${() => reveal(root)}><${Icon} name="external" /></button>`}
    </div>
    <div style="padding: 0 10px 6px">
      <select class="text" value=${root || ''} onChange=${choose} title=${root || ''}>
        ${!root && html`<option value="">Choose a folder…</option>`}
        ${options.map(f => html`<option value=${f.path}>${f.name} — ${shortPath(f.path)}</option>`)}
        <option value="__open__">Open another folder…</option>
      </select>
    </div>
    <div class="side-body">
      ${root && html`<${TreeDir} key=${root + nonce} path=${root} depth=${0} initiallyOpen=${true} />`}
    </div>`;
}

function TreeDir({ path, depth, initiallyOpen }) {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    api.get('/api/fs/list', { path }).then(r => setEntries(r.entries)).catch(e => setError(e.message));
  }, [path]);
  if (error) return html`<div class="empty" style=${`padding-left:${depth * 12 + 22}px`}>${error}</div>`;
  if (!entries) return html`<div class="empty" style=${`padding-left:${depth * 12 + 22}px`}>Loading…</div>`;
  if (!entries.length && depth > 0) return html`<div class="empty" style=${`padding-left:${depth * 12 + 22}px`}>Empty</div>`;
  return entries.map(e => (e.dir
    ? html`<${TreeFolder} key=${e.path} entry=${e} depth=${depth} />`
    : html`<${TreeFile} key=${e.path} entry=${e} depth=${depth} />`));
}

function TreeFolder({ entry, depth }) {
  const [open, setOpen] = useState(false);
  return html`
    <div class=${'tree-row' + (entry.heavy ? ' heavy' : '')} style=${`padding-left:${depth * 12 + 4}px`} onClick=${() => setOpen(!open)} title=${entry.path}>
      <span class="chev"><${Icon} name=${open ? 'chev-down' : 'chev-right'} size=${12} /></span>
      <span class="ico"><${Icon} name="folder" size=${14} /></span>
      <span class="name">${entry.name}</span>
    </div>
    ${open && html`<${TreeDir} path=${entry.path} depth=${depth + 1} />`}`;
}

function TreeFile({ entry, depth }) {
  const on = useStore(s => s.activeTab === 'file:' + entry.path.toLowerCase());
  const md = isMarkdown(entry.name);
  return html`<div class=${'tree-row' + (on ? ' on' : '') + (entry.name.startsWith('.') ? ' dim' : '')} style=${`padding-left:${depth * 12 + 18}px`}
      onClick=${() => openFile(entry.path)} title=${entry.path}>
    <span class=${'ico' + (md ? ' md' : '')}><${Icon} name=${md ? 'md' : 'file'} size=${14} /></span>
    <span class="name">${entry.name}</span>
  </div>`;
}
