import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { html, api, events, useStore, sessionInfo, attention, shortPath, duration, timeAgo } from './lib.js';
import { openFile, openTerminal, resumeSession, showFolder, copyText } from './actions.js';
import { renderMarkdown } from './markdown.js';
import { Icon } from './icons.js';

const PAGE = 400;

export function TranscriptView({ tab, active }) {
  const id = tab.sessionId;
  const [data, setData] = useState({ entries: [], start: 0, total: 0, meta: null, loading: true, error: null });
  const scroller = useRef(null);
  const stick = useRef(true);
  const info = useStore(s => sessionInfo(id, s));

  useEffect(() => {
    let cancelled = false;
    api.get(`/api/transcripts/${id}`, { limit: PAGE })
      .then(r => !cancelled && setData({ ...r, loading: false, error: null }))
      .catch(e => !cancelled && setData(d => ({ ...d, loading: false, error: e.message })));

    const unwatch = events.watch('transcript', id);
    const off = events.on('transcript', m => {
      if (m.id !== id) return;
      setData(d => {
        if (d.loading) return d;
        const keep = d.entries.slice(0, Math.max(0, m.from - d.start));
        const add = m.entries.slice(Math.max(0, d.start - m.from));
        return { ...d, entries: keep.concat(add), total: m.total, meta: m.meta };
      });
    });
    return () => {
      cancelled = true;
      unwatch();
      off();
    };
  }, [id]);

  // Follow new output while scrolled to the bottom.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [data.entries]);

  useEffect(() => {
    const el = scroller.current;
    if (active && el && stick.current) el.scrollTop = el.scrollHeight;
  }, [active]);

  const onScroll = e => {
    const el = e.currentTarget;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const loadEarlier = async () => {
    const el = scroller.current;
    const prevHeight = el.scrollHeight;
    const r = await api.get(`/api/transcripts/${id}`, { before: data.start, limit: PAGE });
    stick.current = false;
    setData(d => ({ ...d, start: r.start, entries: r.entries.concat(d.entries) }));
    requestAnimationFrame(() => { el.scrollTop = el.scrollHeight - prevHeight; });
  };

  const meta = data.meta;
  const live = info?.live;
  const att = attention(live);
  const cwd = info?.cwd || meta?.cwd;
  const planFile = info?.planFile || meta?.planFile;

  return html`
    <div class="toolbar">
      <${Icon} name="chat" />
      <span class="title">${info?.title || meta?.title || 'Chat'}</span>
      <span class="sub mono">${shortPath(cwd)}</span>
      <span class="spacer"></span>
      ${live && html`<span class=${'pill ' + att.cls}><span class=${'dot ' + att.cls}></span>${att.label}</span>`}
      ${live?.terminalId
        ? html`<button class="btn sm primary" onClick=${() => openTerminal(live.terminalId)}><${Icon} name="terminal" size=${14} /> Open terminal</button>`
        : live
          ? html`<span class="tag" title="This chat is running in a terminal outside the IDE">external terminal</span>`
          : html`<button class="btn sm primary" onClick=${() => resumeSession(id)}><${Icon} name="play" size=${13} /> Resume in IDE</button>`}
      ${planFile && html`<button class="btn sm ghost" onClick=${() => openFile(planFile, 'preview')}><${Icon} name="plan" size=${14} /> Plan</button>`}
      ${cwd && html`<button class="icon-btn" title="Show folder in the Explorer" onClick=${() => showFolder(cwd)}><${Icon} name="files" /></button>`}
      <button class="icon-btn" title="Copy session ID" onClick=${() => copyText(id, 'Session ID copied')}><${Icon} name="copy" /></button>
    </div>
    <div class="transcript" ref=${scroller} onScroll=${onScroll}>
      <div class="inner">
        ${data.loading && html`<div class="center-msg"><${Icon} name="loader" class="spin" /> Loading transcript…</div>`}
        ${data.error && html`<div class="center-msg">${data.error}</div>`}
        ${data.start > 0 && html`<div class="load-earlier"><button class="btn sm" onClick=${loadEarlier}>Load ${Math.min(PAGE, data.start)} earlier entries (${data.start} hidden)</button></div>`}
        ${data.entries.map((e, i) => html`<${Entry} key=${data.start + i} e=${e} sessionId=${id} />`)}
        ${!data.loading && !data.error && data.entries.length === 0 && html`<div class="center-msg">No messages yet.</div>`}
      </div>
    </div>
  `;
}

function Entry({ e, sessionId }) {
  switch (e.k) {
    case 'user':
      return html`<div class="msg-user"><div class="who"><span>You${e.queued ? ' (queued)' : ''}</span><span>${timeAgo(e.ts)}</span></div>${e.text}</div>`;
    case 'cmd':
      return html`<div class="msg-cmd">${e.text}</div>`;
    case 'out':
      return html`<pre class="msg-out">${e.text}</pre>`;
    case 'text':
      return html`<div class="msg-text md" dangerouslySetInnerHTML=${{ __html: renderMarkdown(e.text) }}></div>`;
    case 'tool':
      return html`<${ToolCall} e=${e} sessionId=${sessionId} />`;
    case 'turn':
      return html`<div class="msg-turn">Turn finished${e.ms ? ` · ${duration(e.ms)}` : ''}</div>`;
    case 'note':
      return e.sub === 'summary'
        ? html`<div class="msg-note"><b>Recap · </b>${e.text}</div>`
        : html`<div class=${'msg-note ' + e.sub}>${e.text}</div>`;
    default:
      return null;
  }
}

function parseJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function EditDiff({ input }) {
  const edits = input.edits || [{ old_string: input.old_string, new_string: input.new_string }];
  return html`<div class="diff mono">
    <div class="file">${input.file_path}</div>
    ${edits.map(ed => html`
      ${(ed.old_string || '').split('\n').map(l => html`<div class="del">- ${l}</div>`)}
      ${(ed.new_string || '').split('\n').map(l => html`<div class="add">+ ${l}</div>`)}
    `)}
  </div>`;
}

function ToolCall({ e, sessionId }) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(null);
  const input = full?.input ?? e.input;
  const result = full?.result ?? e.result;
  const parsed = open ? parseJson(input) : null;
  const truncated = !full && (e.inputFull || e.resultFull);

  const loadFull = async () => {
    const r = await api.get(`/api/transcripts/${sessionId}/tool`, { toolId: e.id, inOff: e.inOff, ...(e.resOff !== undefined ? { resOff: e.resOff } : {}) });
    setFull(r);
  };

  const state = !e.done ? html`<span class="state run" title="No result yet">…</span>`
    : e.error ? html`<span class="state err" title="Error">✕</span>`
    : html`<span class="state ok">✓</span>`;

  return html`<div class=${'tool' + (open ? ' open' : '')}>
    <div class="row" onClick=${() => setOpen(!open)}>
      ${state}
      <span class="name">${e.name}</span>
      <span class="sum">${e.summary}</span>
    </div>
    ${open && html`<div class="detail">
      ${parsed && (e.name === 'Edit' || e.name === 'MultiEdit') && parsed.file_path
        ? html`<${EditDiff} input=${parsed} />`
        : parsed && e.name === 'Bash' && parsed.command
          ? html`<pre class="pre mono">${parsed.command}</pre>`
          : html`<div class="lbl">Input</div><pre class="pre mono">${input}</pre>`}
      ${e.done && html`<div class="lbl">Result</div><pre class=${'pre mono' + (e.error ? ' err' : '')}>${result || '(empty)'}</pre>`}
      ${parsed?.file_path && html`<div><button class="btn sm ghost" onClick=${() => openFile(parsed.file_path)}><${Icon} name="file" size=${13} /> Open ${parsed.file_path.split(/[\\/]/).pop()}</button></div>`}
      ${truncated && html`<div><button class="btn sm" onClick=${loadFull}>Show full input and result</button></div>`}
    </div>`}
  </div>`;
}
