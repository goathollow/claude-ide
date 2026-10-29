import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { html, useStore, getState, setState, attention, shortPath, sessionInfo } from './lib.js';
import { closeTab, openTranscript, showFolder, reveal, startChat, endShell } from './actions.js';
import { Icon } from './icons.js';

const PALETTES = {
  dark: {
    black: '#2a2a31', red: '#f06a6a', green: '#3fc58a', yellow: '#e8b45a', blue: '#6aa7ff', magenta: '#c792ea', cyan: '#5fd0dc', white: '#d4d4dc',
    brightBlack: '#6e6e7a', brightRed: '#ff8a8a', brightGreen: '#6be0a8', brightYellow: '#ffd27a', brightBlue: '#94c0ff', brightMagenta: '#dcb0f5', brightCyan: '#8ae6ee', brightWhite: '#ffffff',
  },
  light: {
    black: '#1d1d22', red: '#c62828', green: '#1b7f4b', yellow: '#9a6700', blue: '#1f5fd1', magenta: '#8b3fd1', cyan: '#0b7a8f', white: '#8c8c97',
    brightBlack: '#5d5d68', brightRed: '#e53935', brightGreen: '#2e9d62', brightYellow: '#b07a00', brightBlue: '#2f74ff', brightMagenta: '#a356e8', brightCyan: '#1593a8', brightWhite: '#1d1d22',
  },
};

function xtermTheme(theme) {
  const css = getComputedStyle(document.documentElement);
  const v = name => css.getPropertyValue(name).trim();
  return {
    ...PALETTES[theme === 'light' ? 'light' : 'dark'],
    background: v('--bg'),
    foreground: v('--text'),
    cursor: v('--accent'),
    cursorAccent: v('--bg'),
    selectionBackground: theme === 'light' ? 'rgba(31,111,235,0.22)' : 'rgba(127,180,255,0.28)',
  };
}

// Shows a terminal the server hosts in an xterm inside el, and keeps it
// connected while the terminal exists.
function attachTerminal(el, terminalId, { claude, onSnapshot, onExit }) {
  const xterm = new Terminal({
    fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.15,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    theme: xtermTheme(getState().theme),
  });
  const fit = new FitAddon();
  xterm.loadAddon(fit);
  xterm.loadAddon(new WebLinksAddon((e, uri) => window.open(uri, '_blank', 'noopener')));
  xterm.open(el);

  let ws = null;
  let disposed = false;
  const send = msg => ws?.readyState === 1 && ws.send(JSON.stringify(msg));
  const exists = () => [...getState().terminals, ...getState().shells].some(t => t.id === terminalId);

  const doFit = () => {
    if (disposed || el.offsetParent === null) return;
    try { fit.fit(); } catch { /* not laid out yet */ }
  };

  const connect = () => {
    ws = new WebSocket(`ws://${location.host}/ws/term/${terminalId}`);
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.t === 'snapshot') {
        // Replay at the server's size, then fit to this view (which resizes the pty).
        xterm.resize(m.cols, m.rows);
        xterm.reset();
        xterm.write(m.d, () => {
          doFit();
          send({ t: 'resize', cols: xterm.cols, rows: xterm.rows });
        });
        onSnapshot?.(m);
      } else if (m.t === 'data') {
        xterm.write(m.d);
      } else if (m.t === 'exit') {
        onExit?.(m);
      }
    };
    ws.onclose = () => {
      if (disposed) return;
      setTimeout(() => {
        if (!disposed && exists()) connect();
      }, 1500);
    };
  };
  connect();

  xterm.onData(d => send({ t: 'input', d }));
  xterm.onResize(({ cols, rows }) => send({ t: 'resize', cols, rows }));
  xterm.attachCustomKeyEventHandler(e => {
    if (e.type !== 'keydown') return true;
    const key = e.key.toLowerCase();
    if (e.ctrlKey && !e.shiftKey && key === 'c' && xterm.hasSelection()) {
      navigator.clipboard?.writeText(xterm.getSelection());
      xterm.clearSelection();
      return false;
    }
    // Leave Ctrl+V to the browser so xterm receives a real paste event.
    if (e.ctrlKey && !e.shiftKey && key === 'v') return false;
    // Claude Code reads ESC+CR as "insert newline".
    if (claude && e.shiftKey && e.key === 'Enter') {
      e.preventDefault();
      send({ t: 'input', d: '\x1b\r' });
      return false;
    }
    return true;
  });

  let raf = 0;
  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(doFit);
  });
  ro.observe(el);

  return {
    xterm,
    fit: doFit,
    focus: () => xterm.focus(),
    dispose() {
      disposed = true;
      ro.disconnect();
      ws?.close();
      xterm.dispose();
    },
  };
}

export function TerminalView({ tab, active }) {
  const host = useRef(null);
  const ctl = useRef(null);
  const term = useStore(s => s.terminals.find(t => t.id === tab.terminalId) || null);
  const terminalsLoaded = useStore(s => s.terminalsLoaded);
  const theme = useStore(s => s.theme);
  const sessionId = term?.sessionId || tab.sessionId;
  const live = useStore(s => s.live.find(l => l.sessionId === sessionId) || null);
  const title = useStore(s => sessionInfo(sessionId, s)?.title || term?.name || 'Claude');
  const [exit, setExit] = useState(null);
  const gone = terminalsLoaded && !term;

  useEffect(() => {
    // Wait for the terminal list so a tab restored from a previous run doesn't
    // try to attach to a terminal that no longer exists.
    if (gone || !terminalsLoaded) return;
    const c = attachTerminal(host.current, tab.terminalId, {
      claude: true,
      onSnapshot: m => setExit(m.exited ? { code: m.code } : null),
      onExit: m => setExit({ code: m.code }),
    });
    ctl.current = c;
    return () => {
      c.dispose();
      ctl.current = null;
    };
  }, [tab.terminalId, gone, terminalsLoaded]);

  useEffect(() => {
    if (ctl.current) ctl.current.xterm.options.theme = xtermTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (active && ctl.current) {
      requestAnimationFrame(() => {
        ctl.current?.fit();
        ctl.current?.focus();
      });
    }
  }, [active]);

  const att = attention(live);
  const cwd = term?.cwd || tab.cwd;

  const resumeHere = async () => {
    if (!sessionId || !cwd) return;
    try {
      const t = await startChat({ cwd, resume: sessionId });
      if (t.id !== tab.terminalId) closeTab(tab.id);
    } catch (e) {
      alert(e.message);
    }
  };

  return html`
    <div class="toolbar">
      <${Icon} name="terminal" />
      <span class="title">${title}</span>
      <span class="sub mono">${shortPath(cwd)}</span>
      <span class="spacer"></span>
      ${live && html`<span class=${'pill ' + att.cls}><span class=${'dot ' + att.cls}></span>${att.label}${att.detail ? ' · ' + att.detail : ''}</span>`}
      ${sessionId && html`<button class="btn ghost sm" title="Show this chat as a readable transcript" onClick=${() => openTranscript(sessionId)}><${Icon} name="chat" size=${14} /> Transcript</button>`}
      ${cwd && html`<button class="icon-btn" title="Show folder in the Explorer" onClick=${() => showFolder(cwd)}><${Icon} name="files" /></button>`}
      ${cwd && html`<button class="icon-btn" title="Open folder in File Explorer" onClick=${() => reveal(cwd)}><${Icon} name="external" /></button>`}
    </div>
    ${gone
      ? html`<div class="center-msg">
          <p>This terminal is no longer running (the IDE server was restarted or the terminal was closed).</p>
          ${sessionId && html`<button class="btn primary" onClick=${resumeHere}><${Icon} name="play" size=${14} /> Resume this chat</button>`}
        </div>`
      : terminalsLoaded
        ? html`<div class="term-wrap"><div class="term-host" ref=${host}></div></div>`
        : html`<div class="center-msg"><${Icon} name="loader" class="spin" /> Connecting…</div>`}
    ${exit && !gone && html`
      <div class="term-banner">
        <${Icon} name="stop" size=${14} />
        <span>Claude exited${exit.code ? ` (code ${exit.code})` : ''}.</span>
        <span class="spacer" style="flex:1"></span>
        ${sessionId && html`<button class="btn sm" onClick=${resumeHere}><${Icon} name="play" size=${13} /> Resume</button>`}
        <button class="btn sm ghost" onClick=${() => closeTab(tab.id)}>Close</button>
      </div>`}
  `;
}

// The shell panel under the tabs (Ctrl+`), running your shell. Hiding it leaves
// the shell running.
export function ShellPanel() {
  const panel = useRef(null);
  const host = useRef(null);
  const ctl = useRef(null);
  const returnFocus = useRef(null);
  const shell = useStore(s => s.shells.find(t => t.id === s.shellId) || null);
  const open = useStore(s => s.shellOpen) && !!shell;
  const height = useStore(s => s.shellHeight);
  const focusRequest = useStore(s => s.shellFocus);
  const theme = useStore(s => s.theme);

  useEffect(() => {
    if (!shell) return;
    const c = attachTerminal(host.current, shell.id, {
      onExit: () => setState({ shellOpen: false, shellId: null }),
    });
    ctl.current = c;
    return () => {
      c.dispose();
      ctl.current = null;
    };
  }, [shell?.id]);

  useEffect(() => {
    if (ctl.current) ctl.current.xterm.options.theme = xtermTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (open && focusRequest) {
      requestAnimationFrame(() => {
        ctl.current?.fit();
        ctl.current?.focus();
      });
    }
  }, [focusRequest]);

  // Put the focus back where it came from when the panel hides. Browsers can
  // leave it in the hidden panel, where keys would still reach the shell.
  useLayoutEffect(() => {
    if (open) return;
    const back = returnFocus.current;
    returnFocus.current = null;
    const focused = document.activeElement;
    if (focused && focused !== document.body && !panel.current.contains(focused)) return;
    back?.focus();
    if (panel.current.contains(document.activeElement)) document.activeElement.blur();
  }, [open]);

  const onFocusIn = e => {
    if (e.relatedTarget && !panel.current.contains(e.relatedTarget)) returnFocus.current = e.relatedTarget;
  };

  // Dragging the top edge sets the height, leaving room for the view above.
  const onResize = e => {
    e.preventDefault();
    const work = panel.current.parentElement.getBoundingClientRect();
    const move = ev => setState({ shellHeight: Math.round(Math.max(80, Math.min(work.bottom - ev.clientY, work.height - 120))) });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return html`<div class="shell-panel" ref=${panel} hidden=${!open} style=${`--shell-h:${height}px`} onFocusIn=${onFocusIn}>
    <div class="shell-resize" onPointerDown=${onResize}></div>
    <div class="shell-head">
      <span class="label">Shell</span>
      <span class="name">${shell?.name}</span>
      <span class="spacer"></span>
      <button class="icon-btn" title="End this shell" onClick=${endShell}><${Icon} name="trash" size=${14} /></button>
      <button class="icon-btn" title="Hide (Ctrl+\`)" onClick=${() => setState({ shellOpen: false })}><${Icon} name="chev-down" /></button>
    </div>
    ${shell && html`<div class="term-wrap"><div class="term-host" ref=${host}></div></div>`}
  </div>`;
}
