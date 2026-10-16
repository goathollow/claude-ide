import { useState } from 'preact/hooks';
import { html, useStore, useTick, sessionInfo, attention, activityLine, timeAgo, shortPath, money, shortModel, basename } from './lib.js';
import { openFile, openTerminal, openTranscript, resumeSession, showFolder, newChatDialog, copyText } from './actions.js';
import { useMarkdownFiles } from './sidebar.js';
import { Icon } from './icons.js';

export function Inspector({ sessionId }) {
  useTick(20000);
  const info = useStore(s => sessionInfo(sessionId, s));
  const activeFile = useStore(s => s.tabs.find(t => t.id === s.activeTab)?.path?.toLowerCase());
  const live = info?.live;
  const [files] = useMarkdownFiles(info?.cwd, live ? 15000 : 0);
  const [showDone, setShowDone] = useState(false);

  if (!info) return html`<aside class="inspector"><div class="empty">Waiting for session details…</div></aside>`;

  const att = attention(live);
  const tasks = live?.tasks || [];
  const done = tasks.filter(t => t.status === 'completed');
  const visibleTasks = showDone ? tasks : tasks.filter(t => t.status !== 'completed');
  const hist = info.hist;

  return html`<aside class="inspector">
    <h3>Status</h3>
    <div style="display:flex; flex-direction:column; gap:8px">
      <div><span class=${'pill ' + att.cls}><span class=${'dot ' + att.cls}></span>${att.label}${att.detail ? ' · ' + att.detail : ''}</span>
        ${live && html`<span style="color:var(--faint); font-size:12px; margin-left:8px">${timeAgo(live.statusUpdatedAt)}</span>`}</div>
      ${live && html`<div style="font-size:12px; color:var(--muted)">${activityLine(live)}</div>`}
      <div style="display:flex; gap:6px; flex-wrap:wrap">
        ${live?.terminalId && html`<button class="btn sm" onClick=${() => openTerminal(live.terminalId)}><${Icon} name="terminal" size=${13} /> Terminal</button>`}
        ${!live && html`<button class="btn sm primary" onClick=${() => resumeSession(sessionId)}><${Icon} name="play" size=${12} /> Resume in IDE</button>`}
        <button class="btn sm" onClick=${() => openTranscript(sessionId)}><${Icon} name="chat" size=${13} /> Transcript</button>
      </div>
    </div>

    ${tasks.length > 0 && html`
      <h3>Tasks <span style="margin-left:auto; text-transform:none; letter-spacing:0">${done.length}/${tasks.length}</span></h3>
      <div class="progress"><div style=${`width:${(done.length / tasks.length) * 100}%`}></div></div>
      <ul class="tasks">
        ${visibleTasks.map(t => html`<li class=${t.status} key=${t.id}>
          <span class="mark">${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : '○'}</span>
          <span>${t.status === 'in_progress' && t.activeForm ? t.activeForm : t.subject}</span>
        </li>`)}
      </ul>
      ${done.length > 0 && html`<button class="btn sm ghost" style="margin-top:4px" onClick=${() => setShowDone(!showDone)}>${showDone ? 'Hide' : 'Show'} ${done.length} completed</button>`}`}

    ${info.planFile && html`
      <h3>Plan</h3>
      <div class=${'item' + (activeFile === info.planFile.toLowerCase() ? ' on' : '')} onClick=${() => openFile(info.planFile, 'preview')}>
        <span class="ico"><${Icon} name="plan" size=${15} /></span>
        <div class="body"><div class="t">${basename(info.planFile)}</div><div class="s">Open the plan for this chat</div></div>
      </div>`}

    ${live?.awaySummary && html`<h3>Recap</h3><div class="recap">${live.awaySummary}</div>`}

    <h3>Details</h3>
    <div class="kv">
      ${info.cwd && html`<span class="k">Folder</span><span class="v"><a href="#" onClick=${e => { e.preventDefault(); showFolder(info.cwd); }} class="mono">${shortPath(info.cwd)}</a></span>`}
      ${hist?.gitBranch && hist.gitBranch !== 'HEAD' && html`<span class="k">Branch</span><span class="v mono">${hist.gitBranch}</span>`}
      ${info.model && html`<span class="k">Model</span><span class="v">${shortModel(info.model)}</span>`}
      ${live?.permissionMode && html`<span class="k">Mode</span><span class="v">${live.permissionMode}</span>`}
      ${info.costUSD != null && html`<span class="k">Cost</span><span class="v">${money(info.costUSD)}</span>`}
      ${live?.name && html`<span class="k">Name</span><span class="v">${live.name}</span>`}
      ${live?.pid && html`<span class="k">PID</span><span class="v">${live.pid}${live.terminalId ? ' (in IDE)' : ' (external)'}</span>`}
      ${(live?.startedAt || hist?.startedAt) && html`<span class="k">Started</span><span class="v">${new Date(live?.startedAt || hist.startedAt).toLocaleString()}</span>`}
      <span class="k">Session</span><span class="v mono"><a href="#" title="Copy" onClick=${e => { e.preventDefault(); copyText(sessionId, 'Session ID copied'); }}>${sessionId.slice(0, 8)}…</a></span>
    </div>
    ${info.cwd && html`<div style="margin-top:10px"><button class="btn sm ghost" onClick=${() => newChatDialog(info.cwd)}><${Icon} name="plus" size=${13} /> New chat in this folder</button></div>`}

    ${info.cwd && html`
      <h3>Project markdown</h3>
      ${files === null && html`<div class="empty">Scanning…</div>`}
      ${files?.length === 0 && html`<div class="empty">No markdown files.</div>`}
      ${files?.slice(0, 15).map(f => html`<div key=${f.path} class=${'item' + (activeFile === f.path.toLowerCase() ? ' on' : '')} onClick=${() => openFile(f.path)} title=${f.path}>
        <span class="ico"><${Icon} name="md" size=${14} /></span>
        <div class="body"><div class="t">${f.rel}</div></div>
        <span class="when">${timeAgo(f.mtimeMs)}</span>
      </div>`)}`}
  </aside>`;
}
