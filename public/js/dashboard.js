import { html, useStore, useTick, attention, activityLine, byAttention, timeAgo, basename, shortPath, money, shortModel, plain } from './lib.js';
import { openSession, openFile, showFolder, newChatDialog, resumeSession, openTranscript } from './actions.js';
import { Icon } from './icons.js';

export function Dashboard() {
  useTick(20000);
  const live = useStore(s => s.live);
  const seen = useStore(s => s.seen);
  const history = useStore(s => s.history);
  const liveLoaded = useStore(s => s.liveLoaded);

  const sorted = [...live].sort(byAttention(seen));
  const groups = { needs: [], ready: [], working: [], idle: [] };
  for (const s of sorted) groups[attention(s, seen).cls]?.push(s);

  const liveIds = new Set(live.map(s => s.sessionId));
  const recent = history
    .flatMap(g => g.sessions.map(s => ({ ...s, cwd: g.cwd })))
    .filter(s => !liveIds.has(s.sessionId))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 10);

  const summary = [
    groups.needs.length && `${groups.needs.length} waiting on you`,
    groups.ready.length && `${groups.ready.length} finished and ready for you`,
    groups.working.length && `${groups.working.length} working`,
    groups.idle.length && `${groups.idle.length} idle`,
  ].filter(Boolean).join(' · ');

  return html`<div class="dash">
    <div style="display:flex; align-items:flex-start; gap:12px">
      <div style="flex:1">
        <h1>Sessions</h1>
        <p class="lede">${!liveLoaded ? 'Loading…' : live.length ? `${live.length} running · ${summary}` : 'No Claude sessions are running right now.'}</p>
      </div>
      <button class="btn primary" onClick=${() => newChatDialog()}><${Icon} name="plus" size=${14} /> New chat</button>
    </div>

    ${[
      ['needs', 'Needs you', 'Waiting on a permission prompt or a question'],
      ['ready', 'Your turn', 'Finished since you last looked'],
      ['working', 'Working', null],
      ['idle', 'Idle', null],
    ].map(([key, label, hint]) => groups[key].length > 0 && html`
      <h2><span class=${'dot ' + key}></span>${label}<span style="font-weight:400; text-transform:none; letter-spacing:0">${hint ? ' — ' + hint : ''}</span></h2>
      <div class="cards">${groups[key].map(s => html`<${SessionCard} key=${s.sessionId} s=${s} seen=${seen} />`)}</div>
    `)}

    ${recent.length > 0 && html`
      <h2><${Icon} name="history" size=${13} /> Recent chats</h2>
      <div class="recent">
        ${recent.map(s => html`<div class="item" key=${s.sessionId} onClick=${() => openTranscript(s.sessionId)}>
          <span class="ico"><${Icon} name="chat" size=${15} /></span>
          <div class="body">
            <div class="t">${s.title}</div>
            <div class="s">${basename(s.cwd)}${s.gitBranch && s.gitBranch !== 'HEAD' ? ' · ' + s.gitBranch : ''}</div>
          </div>
          <span class="when">${timeAgo(s.updatedAt)}</span>
          <div class="actions">
            <button class="icon-btn" title="Resume in the IDE" onClick=${e => { e.stopPropagation(); resumeSession(s.sessionId); }}><${Icon} name="play" size=${14} /></button>
          </div>
        </div>`)}
      </div>`}
  </div>`;
}

function SessionCard({ s, seen }) {
  const att = attention(s, seen);
  const tasks = s.tasks || [];
  const done = tasks.filter(t => t.status === 'completed').length;
  const current = tasks.find(t => t.status === 'in_progress');
  const showDoing = att.cls === 'needs' || att.cls === 'working';
  const said = plain(s.lastText?.text);

  return html`<div class=${'card ' + att.cls} onClick=${() => openSession(s.sessionId)}>
    <div class="head">
      <span class=${'dot ' + att.cls}></span>
      <span class="title" title=${s.title}>${s.title}</span>
      <span class=${'pill ' + att.cls}>${att.label}</span>
    </div>
    <div class="meta">
      <span class="mono" title=${s.cwd}>${shortPath(s.cwd)}</span>
      ${s.model && html`<span>· ${shortModel(s.model)}</span>`}
      ${s.costUSD != null && html`<span>· ${money(s.costUSD)}</span>`}
      <span>· ${timeAgo(s.statusUpdatedAt)}</span>
      ${s.terminalId ? html`<span class="tag"><${Icon} name="terminal" size=${11} /> in IDE</span>` : html`<span class="tag" title="Running in a terminal outside the IDE">external</span>`}
    </div>
    ${showDoing && html`<div class="doing"><b>${att.cls === 'needs' ? 'Asks:' : 'Doing:'}</b><span class="what" title=${activityLine(s)}>${activityLine(s)}</span></div>`}
    ${tasks.length > 0 && html`<div>
      <div class="progress" title=${`${done} of ${tasks.length} tasks done`}><div style=${`width:${(done / tasks.length) * 100}%`}></div></div>
      <div class="meta">${done}/${tasks.length} tasks${current ? html` · <span style="color:var(--text)">${current.subject}</span>` : ''}</div>
    </div>`}
    ${said && html`<div class="said">${said}</div>`}
    <div class="foot" onClick=${e => e.stopPropagation()}>
      <button class="btn sm" onClick=${() => openSession(s.sessionId)}>
        <${Icon} name=${s.terminalId ? 'terminal' : 'chat'} size=${13} /> ${s.terminalId ? 'Open terminal' : 'View chat'}
      </button>
      ${s.planFile && html`<button class="btn sm ghost" onClick=${() => openFile(s.planFile, 'preview')}><${Icon} name="plan" size=${13} /> Plan</button>`}
      <button class="btn sm ghost" onClick=${() => showFolder(s.cwd)}><${Icon} name="files" size=${13} /> Files</button>
    </div>
  </div>`;
}
