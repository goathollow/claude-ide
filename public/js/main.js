import { render } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import {
  html, api, events, useStore, getState, setState, attention, sessionInfo, sessionIdForTab, basename, shortPath, plain,
} from './lib.js';
import { closeTab, openSession, newChatDialog, refreshLists, toast, dismissToast, goHome } from './actions.js';
import { ActivityBar, Sidebar } from './sidebar.js';
import { Dashboard } from './dashboard.js';
import { TerminalView } from './terminal.js';
import { TranscriptView } from './transcript.js';
import { FileView } from './fileview.js';
import { Inspector } from './inspector.js';
import { NewChatDialog, OpenFolderDialog } from './newchat.js';
import { Icon } from './icons.js';

// ---------------------------------------------------------------- tabs

function tabLabel(tab, s) {
  switch (tab.type) {
    case 'home': return 'Sessions';
    case 'file': return basename(tab.path);
    case 'transcript': return sessionInfo(tab.sessionId, s)?.title || 'Chat';
    case 'terminal': {
      const t = s.terminals.find(x => x.id === tab.terminalId);
      const sid = t?.sessionId || tab.sessionId;
      return sessionInfo(sid, s)?.title || t?.name || basename(t?.cwd || tab.cwd) || 'Terminal';
    }
  }
  return '';
}

// Dragging a tab sideways reorders it. The tab follows the pointer, and the
// order changes as the pointer crosses the middle of a neighbouring tab.
// Sessions stays first; Escape puts everything back.
function startTabDrag(e, id, bar) {
  if (e.button !== 0 || id === 'home' || e.target.closest('.x')) return;
  const el = e.currentTarget;
  const startX = e.clientX;
  const grabOffset = startX - el.getBoundingClientRect().left;
  const original = getState().tabs;
  let x = startX, dx = 0, dragging = false, raf = 0;

  const reorder = () => {
    const others = [...bar.querySelectorAll('.tab')].filter(t => t !== el);
    const at = Math.max(1, others.filter(t => {
      const r = t.getBoundingClientRect();
      return r.left + r.width / 2 < x;
    }).length);
    const ids = others.map(t => t.dataset.tab);
    ids.splice(at, 0, id);
    const tabs = getState().tabs;
    if (ids.join('\n') === tabs.map(t => t.id).join('\n')) return;
    const byId = new Map(tabs.map(t => [t.id, t]));
    const next = ids.map(i => byId.get(i)).filter(Boolean);
    for (const t of tabs) if (!ids.includes(t.id)) next.push(t);
    setState({ tabs: next });
  };

  // Offset the tab from its slot so it stays under the pointer, within the bar
  // and never covering the pinned Sessions tab.
  const follow = () => {
    const r = el.getBoundingClientRect();
    const b = bar.getBoundingClientRect();
    const home = bar.querySelector('[data-tab="home"]')?.getBoundingClientRect();
    const min = Math.max(b.left, home ? home.right : b.left);
    const left = Math.min(Math.max(x - grabOffset, min), b.right - r.width);
    dx = left - (r.left - dx);
    el.style.transform = `translateX(${dx}px)`;
  };

  const frame = () => {
    const b = bar.getBoundingClientRect();
    if (x < b.left + 40) bar.scrollLeft -= 10;
    else if (x > b.right - 40) bar.scrollLeft += 10;
    reorder();
    // Measure after Preact has applied any new order (its render is a queued microtask).
    queueMicrotask(follow);
    raf = requestAnimationFrame(frame);
  };

  const end = cancel => {
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onUp, true);
    window.removeEventListener('keydown', onKey, true);
    cancelAnimationFrame(raf);
    if (!dragging) return;
    if (cancel) setState({ tabs: original });
    else reorder();
    document.body.classList.remove('tab-dragging');
    queueMicrotask(() => {
      el.style.transition = 'transform 120ms ease-out';
      el.style.transform = '';
      setTimeout(() => {
        el.style.transition = '';
        setState({ draggingTab: null });
      }, 130);
    });
  };

  const onMove = ev => {
    if (ev.buttons === 0) return end(false); // released outside the window
    x = ev.clientX;
    if (!dragging && Math.abs(x - startX) > 4) {
      dragging = true;
      document.body.classList.add('tab-dragging');
      setState({ draggingTab: id });
      raf = requestAnimationFrame(frame);
    }
  };
  const onUp = () => end(false);
  const onKey = ev => {
    if (ev.key !== 'Escape' || !dragging) return;
    ev.preventDefault();
    ev.stopPropagation();
    end(true);
  };

  // Capture phase, so views that stop propagation (terminal, editor) can't swallow the drag.
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onUp, true);
  window.addEventListener('keydown', onKey, true);
}

function Tab({ tab, onGrab }) {
  const active = useStore(s => s.activeTab === tab.id);
  const dragging = useStore(s => s.draggingTab === tab.id);
  const label = useStore(s => tabLabel(tab, s));
  const dirty = useStore(s => !!s.dirty[tab.id]);
  const status = useStore(s => {
    const sid = sessionIdForTab(tab, s);
    if (!sid) return null;
    const live = s.live.find(l => l.sessionId === sid);
    if (tab.type === 'terminal' && !live) {
      const t = s.terminals.find(x => x.id === tab.terminalId);
      return !t || t.exited ? 'exited' : null;
    }
    return live ? attention(live, s.seen).cls : null;
  });
  const icon = { home: 'home', terminal: 'terminal', transcript: 'chat', file: /\.(md|mdx|markdown)$/i.test(tab.path || '') ? 'md' : 'file' }[tab.type];

  return html`<div class=${'tab' + (active ? ' on' : '') + (dragging ? ' dragging' : '')} title=${tab.path || label} data-tab=${tab.id}
      onClick=${() => setState({ activeTab: tab.id })}
      onPointerDown=${onGrab}
      onMouseDown=${e => { if (e.button === 1) { e.preventDefault(); closeTab(tab.id); } }}>
    ${status ? html`<span class=${'dot ' + status}></span>` : html`<${Icon} name=${icon} size=${14} />`}
    <span class=${'label' + (dirty ? ' dirty' : '')}>${label}</span>
    ${tab.type !== 'home' && html`<button class="x" title="Close" onClick=${e => { e.stopPropagation(); closeTab(tab.id); }}><${Icon} name="x" size=${13} /></button>`}
  </div>`;
}

function TabBar() {
  const tabs = useStore(s => s.tabs);
  const activeTab = useStore(s => s.activeTab);
  const bar = useRef(null);

  // A regular mouse wheel only scrolls vertically; scroll the tabs sideways instead.
  useEffect(() => {
    const el = bar.current;
    const onWheel = e => {
      if (!e.deltaY || Math.abs(e.deltaX) > Math.abs(e.deltaY) || el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY * (e.deltaMode === 1 ? 16 : 1);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Keep the active tab visible when it changes or a new tab opens off-screen.
  useEffect(() => {
    bar.current?.querySelector('.tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTab, tabs.length]);

  const grab = (e, id) => startTabDrag(e, id, bar.current);
  return html`<div class="tabbar" ref=${bar}>${tabs.map(t => html`<${Tab} key=${t.id} tab=${t} onGrab=${e => grab(e, t.id)} />`)}</div>`;
}

function View({ tab, active }) {
  switch (tab.type) {
    case 'home': return html`<${Dashboard} />`;
    case 'terminal': return html`<${TerminalView} tab=${tab} active=${active} />`;
    case 'transcript': return html`<${TranscriptView} tab=${tab} active=${active} />`;
    case 'file': return html`<${FileView} tab=${tab} active=${active} />`;
  }
  return null;
}

// ---------------------------------------------------------------- chrome

function TopBar() {
  const counts = useStore(s => {
    const c = { needs: [], ready: [] };
    for (const l of s.live) {
      const a = attention(l, s.seen).cls;
      if (c[a]) c[a].push(l.sessionId);
    }
    return { needs: c.needs.join(), ready: c.ready.join() };
  });
  const needs = counts.needs ? counts.needs.split(',') : [];
  const ready = counts.ready ? counts.ready.split(',') : [];
  const inspectorOpen = useStore(s => s.inspectorOpen);

  return html`<header class="topbar">
    <div class="brand" onClick=${goHome} style="cursor:pointer"><img src="/icon.svg" alt="" />Claude IDE</div>
    <div class="attention">
      ${needs.length > 0 && html`<span class="pill needs clickable" title="Open the next session that needs you" onClick=${() => openSession(needs[0])}>
        <span class="dot needs"></span>${needs.length} need${needs.length === 1 ? 's' : ''} you</span>`}
      ${ready.length > 0 && html`<span class="pill ready clickable" title="Open the next finished session" onClick=${() => openSession(ready[0])}>
        <span class="dot ready"></span>${ready.length} ready</span>`}
    </div>
    <span class="spacer"></span>
    <button class=${'icon-btn' + (inspectorOpen ? ' on' : '')} title="Toggle session details panel" onClick=${() => setState(s => ({ inspectorOpen: !s.inspectorOpen }))}><${Icon} name="panel" /></button>
    <button class="btn primary sm" onClick=${() => newChatDialog()}><${Icon} name="plus" size=${13} /> New chat</button>
  </header>`;
}

function StatusBar() {
  const connected = useStore(s => s.connected);
  const live = useStore(s => s.live.length);
  const working = useStore(s => s.live.filter(l => l.status === 'busy' || l.status === 'shell').length);
  const hosted = useStore(s => s.terminals.filter(t => !t.exited).length);
  const claudeDir = useStore(s => s.info.claudeDir);
  return html`<footer class="statusbar">
    <span class="seg-item"><span class=${'dot ' + (connected ? 'working' : 'needs')} style="animation:none"></span>${connected ? 'Connected' : 'Reconnecting…'}</span>
    <span class="seg-item">${live} running · ${working} working</span>
    <span class="seg-item"><${Icon} name="terminal" size=${12} /> ${hosted} in IDE</span>
    <span class="spacer"></span>
    <span class="seg-item mono">${shortPath(claudeDir)}</span>
  </footer>`;
}

function Toasts() {
  const toasts = useStore(s => s.toasts);
  return html`<div class="toasts">${toasts.map(t => html`<div class="toast" key=${t.id}
      onClick=${() => { dismissToast(t.id); if (t.sessionId) openSession(t.sessionId); }}>
    <span class=${'dot ' + t.kind}></span>
    <div class="body"><div class="t">${t.title}</div>${t.text && html`<div class="s" title=${t.text}>${t.text}</div>`}</div>
  </div>`)}</div>`;
}

// ---------------------------------------------------------------- app

function App() {
  const tabs = useStore(s => s.tabs);
  const activeTab = useStore(s => s.activeTab);
  const sidebarOpen = useStore(s => s.sidebarOpen);
  const sidebarWidth = useStore(s => s.sidebarWidth);
  const inspectorOpen = useStore(s => s.inspectorOpen);
  const dialog = useStore(s => s.dialog);
  const quit = useStore(s => s.quit);
  const activeSid = useStore(s => sessionIdForTab(s.tabs.find(t => t.id === s.activeTab), s));
  const activeCwd = useStore(s => sessionInfo(activeSid, s)?.cwd || null);
  const liveSig = useStore(s => s.live.map(l => l.sessionId + l.statusUpdatedAt).join());

  // Viewing a session counts as having seen its latest status.
  useEffect(() => {
    const mark = () => {
      if (document.visibilityState !== 'visible' || !activeSid) return;
      const live = getState().live.find(l => l.sessionId === activeSid);
      if (live && getState().seen?.[activeSid] !== live.statusUpdatedAt) {
        setState(s => ({ seen: { ...s.seen, [activeSid]: live.statusUpdatedAt } }));
      }
    };
    mark();
    document.addEventListener('visibilitychange', mark);
    return () => document.removeEventListener('visibilitychange', mark);
  }, [activeSid, liveSig]);

  // The explorer follows whichever session you're looking at.
  useEffect(() => {
    if (activeCwd) setState({ explorerRoot: activeCwd });
  }, [activeCwd]);

  if (!tabs.some(t => t.id === activeTab)) setTimeout(() => setState({ activeTab: 'home' }));

  return html`<div class="shell">
    <${TopBar} />
    <div class="main" style=${`--sidebar-w:${sidebarOpen ? sidebarWidth : 0}px`}>
      <${ActivityBar} />
      ${sidebarOpen ? html`<${Sidebar} />` : html`<div></div>`}
      <section class="work">
        <${TabBar} />
        <div class="content">
          <div class="views">
            ${tabs.map(t => html`<div class="view" key=${t.id} hidden=${t.id !== activeTab}><${View} tab=${t} active=${t.id === activeTab} /></div>`)}
          </div>
          ${inspectorOpen && activeSid && html`<${Inspector} sessionId=${activeSid} />`}
        </div>
      </section>
    </div>
    <${StatusBar} />
    ${dialog?.type === 'new-chat' && html`<${NewChatDialog} cwd=${dialog.cwd} />`}
    ${dialog?.type === 'open-folder' && html`<${OpenFolderDialog} cwd=${dialog.cwd} />`}
    <${Toasts} />
    ${quit && html`<div class="scrim"><div class="dialog small">
      <header>Claude IDE has quit</header>
      <div class="body">You can close this window. Start Claude IDE again to pick up where you left off.</div>
      <footer></footer>
    </div></div>`}
  </div>`;
}

// ---------------------------------------------------------------- live events & notifications

let previous = null;

function notifyTransitions(live) {
  const st = getState();
  if (previous) {
    for (const s of live) {
      const before = previous.get(s.sessionId);
      if (!before || before === s.status) continue;
      let kind = null, title = null;
      if (s.status === 'waiting') { kind = 'needs'; title = `${s.title} needs you`; }
      else if (s.status === 'idle' && (before === 'busy' || before === 'shell')) { kind = 'ready'; title = `${s.title} finished`; }
      if (!kind) continue;
      const watching = document.visibilityState === 'visible' && sessionIdForTab(st.tabs.find(t => t.id === st.activeTab), st) === s.sessionId;
      if (watching) continue;
      const text = kind === 'needs'
        ? `Waiting for ${s.waitingFor || 'input'}${s.lastTool ? ` · ${s.lastTool.name}: ${s.lastTool.summary}` : ''}`
        : plain(s.lastText?.text).split('\n').find(l => l.trim()) || '';
      toast({ kind, title, text, sessionId: s.sessionId, timeout: 9000 });
      if (st.notify && document.visibilityState !== 'visible' && 'Notification' in window && Notification.permission === 'granted') {
        const n = new Notification(title, { body: text, tag: s.sessionId, icon: '/icon.svg' });
        n.onclick = () => { window.focus(); openSession(s.sessionId); n.close(); };
      }
    }
  }
  previous = new Map(live.map(s => [s.sessionId, s.status]));
}

events.on('live', m => {
  notifyTransitions(m.sessions);
  setState(s => {
    // On first run, treat whatever is already idle as seen so only new finishes stand out.
    const seen = s.seen ?? Object.fromEntries(m.sessions.map(l => [l.sessionId, l.statusUpdatedAt]));
    return { live: m.sessions, liveLoaded: true, seen };
  });
  const known = new Set(getState().history.flatMap(g => g.sessions.map(x => x.sessionId)));
  if (m.sessions.some(l => !known.has(l.sessionId))) refreshLists();
});

// A window opened from a notification goes to its session once the server has
// said which sessions are running (it sends them before the terminals).
let linkedSession = /^#session=([\w-]+)$/.exec(location.hash)?.[1];
if (linkedSession) history.replaceState(null, '', location.pathname);

events.on('terminals', m => {
  setState({ terminals: m.terminals, terminalsLoaded: true });
  if (linkedSession) openSession(linkedSession);
  linkedSession = null;
});
events.on('reconnected', () => {
  setState({ quit: false });
  refreshLists();
});

// Quitting closes every window. Browsers only let a script close a window that
// hasn't navigated, so one that stays open says the IDE has quit.
events.on('quit', () => {
  setState({ quit: true });
  window.close();
});

// Window title shows how many sessions want attention.
setInterval(() => {
  const st = getState();
  const n = st.live.filter(l => ['needs', 'ready'].includes(attention(l, st.seen).cls)).length;
  const title = n ? `(${n}) Claude IDE` : 'Claude IDE';
  if (document.title !== title) document.title = title;
}, 1000);

// ---------------------------------------------------------------- boot

api.get('/api/info').then(info => setState({ info })).catch(() => {});
refreshLists();
setInterval(refreshLists, 20000);

render(html`<${App} />`, document.getElementById('app'));
