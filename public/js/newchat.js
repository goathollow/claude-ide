import { useEffect, useRef, useState } from 'preact/hooks';
import { html, api, useStore, setState, getState, joinPath, shortPath, basename } from './lib.js';
import { startChat } from './actions.js';
import { Icon } from './icons.js';

const close = () => setState({ dialog: null });

function useEscape(fn) {
  useEffect(() => {
    const onKey = e => e.key === 'Escape' && fn();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export function FolderPicker({ value, onChange }) {
  const [listing, setListing] = useState(null);
  const [error, setError] = useState(null);
  const [drives, setDrives] = useState([]);
  const [creating, setCreating] = useState(null);
  const timer = useRef(null);

  useEffect(() => { api.get('/api/fs/drives').then(setDrives).catch(() => {}); }, []);

  useEffect(() => {
    clearTimeout(timer.current);
    if (!value) return;
    timer.current = setTimeout(() => {
      api.get('/api/fs/list', { path: value })
        .then(r => { setListing(r); setError(null); })
        .catch(e => setError(e.message));
    }, 150);
  }, [value]);

  const mkdir = async () => {
    const name = (creating || '').trim();
    if (!name || !listing) return;
    try {
      const r = await api.post('/api/fs/mkdir', { path: joinPath(listing.path, name) });
      setCreating(null);
      onChange(r.path);
    } catch (e) {
      setError(e.message);
    }
  };

  const dirs = listing?.entries.filter(e => e.dir) || [];
  return html`<div class="picker">
    <div class="bar">
      <button class="icon-btn" title="Up one level" disabled=${!listing?.parent} onClick=${() => listing?.parent && onChange(listing.parent)}><${Icon} name="up" /></button>
      ${drives.length > 1 && html`<select class="text" style="width:auto; padding:2px 4px" value="" onChange=${e => e.currentTarget.value && onChange(e.currentTarget.value)}>
        <option value="">Drive</option>
        ${drives.map(d => html`<option value=${d}>${d}</option>`)}
      </select>`}
      <span class="path" title=${listing?.path}>${listing?.path || ''}</span>
      <button class="btn sm ghost" title="Create a folder here" onClick=${() => setCreating('')}><${Icon} name="folder-plus" size=${14} /> New folder</button>
    </div>
    ${creating !== null && html`<div class="bar">
      <input class="text" autofocus placeholder="New folder name" value=${creating}
        onInput=${e => setCreating(e.currentTarget.value)}
        onKeyDown=${e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); mkdir(); } if (e.key === 'Escape') { e.stopPropagation(); setCreating(null); } }} />
      <button class="btn sm primary" onClick=${mkdir}>Create</button>
      <button class="btn sm ghost" onClick=${() => setCreating(null)}>Cancel</button>
    </div>`}
    <div class="list">
      ${error && html`<div class="error-text" style="padding:6px 8px">${error}</div>`}
      ${!error && dirs.length === 0 && html`<div class="empty">No subfolders.</div>`}
      ${dirs.map(d => html`<div key=${d.path} class=${'tree-row' + (d.heavy || d.name.startsWith('.') ? ' dim' : '')} style="padding-left:6px" onClick=${() => onChange(d.path)}>
        <span class="ico"><${Icon} name="folder" size=${14} /></span><span class="name">${d.name}</span>
      </div>`)}
    </div>
  </div>`;
}

export function NewChatDialog({ cwd: initial }) {
  const recent = useStore(s => s.recentFolders);
  const info = useStore(s => s.info);
  const [cwd, setCwd] = useState(initial || recent[0]?.path || info.home || '');
  const [name, setName] = useState('');
  const [mode, setMode] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEscape(close);

  const start = async () => {
    if (!cwd.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await startChat({ cwd: cwd.trim(), name: name.trim() || undefined, permissionMode: mode || undefined, model: model || undefined });
      close();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  return html`<div class="scrim" onMouseDown=${e => e.target === e.currentTarget && close()}>
    <div class="dialog" onKeyDown=${e => e.key === 'Enter' && e.ctrlKey && start()}>
      <header>New chat</header>
      <div class="body">
        <div class="field">
          <label>Folder</label>
          <input class="text mono" value=${cwd} onInput=${e => setCwd(e.currentTarget.value)} placeholder="C:\\dev\\my-project" />
          ${recent.length > 0 && html`<div class="chips" style="margin-top:4px">
            ${recent.slice(0, 10).map(f => html`<button class=${'chip' + (f.path.toLowerCase() === cwd.toLowerCase() ? ' on' : '')} title=${f.path} onClick=${() => setCwd(f.path)}>
              <${Icon} name="folder" size=${12} />${f.name}
            </button>`)}
          </div>`}
        </div>
        <${FolderPicker} value=${cwd} onChange=${setCwd} />
        <div class="row2">
          <div class="field">
            <label>Name <span style="font-weight:400">(optional)</span></label>
            <input class="text" value=${name} onInput=${e => setName(e.currentTarget.value)} placeholder=${basename(cwd) || 'my-feature'} />
          </div>
          <div class="field">
            <label>Model</label>
            <select class="text" value=${model} onChange=${e => setModel(e.currentTarget.value)}>
              <option value="">Default</option>
              <option value="opus">Opus</option>
              <option value="sonnet">Sonnet</option>
              <option value="haiku">Haiku</option>
              <option value="fable">Fable</option>
            </select>
          </div>
        </div>
        <div class="field">
          <label>Permission mode</label>
          <select class="text" value=${mode} onChange=${e => setMode(e.currentTarget.value)}>
            <option value="">Default (from your Claude settings)</option>
            ${(info.permissionModes || []).map(m => html`<option value=${m}>${m}</option>`)}
          </select>
          <span class="hint">Use <b>plan</b> to have Claude write a plan for review before touching files.</span>
        </div>
        ${error && html`<div class="error-text">${error}</div>`}
      </div>
      <footer>
        <button class="btn ghost" onClick=${close}>Cancel</button>
        <button class="btn primary" disabled=${!cwd.trim() || busy} onClick=${start}>
          <${Icon} name=${busy ? 'loader' : 'play'} size=${13} class=${busy ? 'spin' : ''} /> Start chat in ${basename(cwd) || 'folder'}
        </button>
      </footer>
    </div>
  </div>`;
}

export function OpenFolderDialog({ cwd: initial }) {
  const info = useStore(s => s.info);
  const [cwd, setCwd] = useState(initial || info.home || '');
  useEscape(close);
  const open = () => {
    setState({ explorerRoot: cwd, dialog: null, sidebar: 'files', sidebarOpen: true });
  };
  return html`<div class="scrim" onMouseDown=${e => e.target === e.currentTarget && close()}>
    <div class="dialog">
      <header>Open folder</header>
      <div class="body">
        <input class="text mono" value=${cwd} onInput=${e => setCwd(e.currentTarget.value)} />
        <${FolderPicker} value=${cwd} onChange=${setCwd} />
      </div>
      <footer>
        <button class="btn ghost" onClick=${close}>Cancel</button>
        <button class="btn primary" disabled=${!cwd.trim()} onClick=${open}>Open ${shortPath(cwd)}</button>
      </footer>
    </div>
  </div>`;
}
