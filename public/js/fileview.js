import { useEffect, useRef, useState, useCallback } from 'preact/hooks';
import { html, api, events, useStore, getState, setState, isMarkdown, shortPath, basename, dirname, joinPath, normalizePath } from './lib.js';
import { openFile, reveal } from './actions.js';
import { renderMarkdown } from './markdown.js';
import { Icon } from './icons.js';

// Monaco ships an AMD build that loads without a bundler; fetch it on first use.
let monacoPromise = null;
export function loadMonaco() {
  if (!monacoPromise) {
    monacoPromise = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = '/vendor/monaco/vs/editor/editor.main.css';
      document.head.appendChild(css);
      const script = document.createElement('script');
      script.src = '/vendor/monaco/vs/loader.js';
      script.onerror = reject;
      script.onload = () => {
        window.require.config({ paths: { vs: '/vendor/monaco/vs' } });
        window.require(['vs/editor/editor.main'], () => {
          const m = window.monaco;
          m.editor.defineTheme('ide-dark', { base: 'vs-dark', inherit: true, rules: [], colors: { 'editor.background': '#1a1a1e' } });
          m.editor.defineTheme('ide-light', { base: 'vs', inherit: true, rules: [], colors: { 'editor.background': '#ffffff' } });
          resolve(m);
        }, reject);
      };
      document.head.appendChild(script);
    });
  }
  return monacoPromise;
}

function languageFor(monaco, path) {
  const name = basename(path).toLowerCase();
  const ext = name.includes('.') ? '.' + name.split('.').pop() : '';
  const lang = monaco.languages.getLanguages().find(l => l.extensions?.includes(ext) || l.filenames?.some(f => f.toLowerCase() === name));
  return lang?.id || 'plaintext';
}

export function FileView({ tab, active }) {
  const path = tab.path;
  const md = isMarkdown(path);
  const theme = useStore(s => s.theme);
  const [mode, setModeState] = useState(md ? tab.mode || getState().mdMode || 'split' : 'code');
  const [doc, setDoc] = useState({ loading: true });
  const [source, setSource] = useState('');
  const [dirty, setDirty] = useState(false);
  const [stale, setStale] = useState(false);
  const [saving, setSaving] = useState(false);
  const editorHost = useRef(null);
  const editor = useRef(null);
  const base = useRef({ content: '', mtimeMs: 0 });
  const dirtyRef = useRef(false);
  const previewRef = useRef(null);

  const setMode = m => {
    setModeState(m);
    if (md) setState({ mdMode: m });
  };

  const markDirty = d => {
    dirtyRef.current = d;
    setDirty(d);
    setState(s => ({ dirty: { ...s.dirty, [tab.id]: d } }));
  };

  const load = useCallback(async (keepView = false) => {
    try {
      const r = await api.get('/api/fs/read', { path });
      base.current = { content: r.content, mtimeMs: r.mtimeMs };
      setDoc({ loading: false, mtimeMs: r.mtimeMs, size: r.size });
      setSource(r.content);
      setStale(false);
      markDirty(false);
      const ed = editor.current;
      if (ed && ed.getValue() !== r.content) {
        const view = keepView ? ed.saveViewState() : null;
        ed.setValue(r.content);
        if (view) ed.restoreViewState(view);
      }
    } catch (e) {
      setDoc({ loading: false, error: e.message });
    }
  }, [path]);

  useEffect(() => { load(); }, [load]);

  // Reload when the file changes on disk, unless there are unsaved edits.
  useEffect(() => {
    const unwatch = events.watch('file', path);
    const off = events.on('file-changed', m => {
      if (m.path.toLowerCase() !== path.toLowerCase() || Math.abs((m.mtimeMs || 0) - base.current.mtimeMs) < 1) return;
      if (dirtyRef.current) setStale(true);
      else {
        const scroll = previewRef.current?.scrollTop;
        load(true).then(() => requestAnimationFrame(() => { if (previewRef.current && scroll != null) previewRef.current.scrollTop = scroll; }));
      }
    });
    return () => { unwatch(); off(); };
  }, [path, load]);

  const save = useCallback(async (force = false) => {
    const ed = editor.current;
    if (!ed) return;
    setSaving(true);
    try {
      const content = ed.getValue();
      const r = await api.put('/api/fs/write', { path, content, baseMtimeMs: base.current.mtimeMs, force });
      base.current = { content, mtimeMs: r.mtimeMs };
      setDoc(d => ({ ...d, mtimeMs: r.mtimeMs }));
      setStale(false);
      markDirty(false);
    } catch (e) {
      if (e.status === 409 && confirm('This file changed on disk since you opened it. Overwrite it with your version?')) {
        setSaving(false);
        return save(true);
      }
      if (e.status !== 409) alert(`Save failed: ${e.message}`);
    } finally {
      setSaving(false);
    }
  }, [path]);
  const saveRef = useRef(save);
  saveRef.current = save;

  // Create the editor the first time the code pane is shown.
  const needsEditor = !doc.loading && !doc.error && mode !== 'preview';
  useEffect(() => {
    if (!needsEditor || editor.current) return;
    let disposed = false;
    loadMonaco().then(monaco => {
      if (disposed || !editorHost.current) return;
      const ed = monaco.editor.create(editorHost.current, {
        value: base.current.content,
        language: languageFor(monaco, path),
        theme: getState().theme === 'light' ? 'ide-light' : 'ide-dark',
        automaticLayout: true,
        wordWrap: md ? 'on' : 'off',
        minimap: { enabled: !md },
        fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
        fontSize: 13,
        scrollBeyondLastLine: false,
        renderWhitespace: 'selection',
        unicodeHighlight: { ambiguousCharacters: false },
      });
      ed.onDidChangeModelContent(() => {
        const value = ed.getValue();
        markDirty(value !== base.current.content);
        clearTimeout(ed._previewTimer);
        ed._previewTimer = setTimeout(() => setSource(value), 120);
      });
      ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current());
      editor.current = ed;
    }).catch(e => setDoc(d => ({ ...d, error: `Editor failed to load: ${e.message || e}` })));
    return () => { disposed = true; };
  }, [needsEditor]);

  useEffect(() => () => editor.current?.dispose(), []);

  useEffect(() => {
    window.monaco?.editor.setTheme(theme === 'light' ? 'ide-light' : 'ide-dark');
  }, [theme]);

  useEffect(() => {
    if (active && mode !== 'preview') requestAnimationFrame(() => { editor.current?.layout(); editor.current?.focus(); });
  }, [active, mode]);

  // Relative links in the preview open inside the IDE; web links open a browser tab.
  const onPreviewClick = e => {
    const a = e.target.closest('a');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    e.preventDefault();
    if (/^https?:/i.test(href)) return window.open(href, '_blank', 'noopener');
    if (href.startsWith('#')) {
      document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView();
      return;
    }
    const target = decodeURIComponent(href.split('#')[0]);
    if (!target) return;
    const abs = /^([a-z]:[\\/]|[\\/])/i.test(target) ? target : joinPath(dirname(path), target);
    openFile(normalizePath(abs));
  };

  return html`
    <div class="toolbar">
      <${Icon} name=${md ? 'md' : 'file'} />
      <span class="title">${basename(path)}</span>
      <span class="sub mono" title=${path}>${shortPath(dirname(path))}</span>
      <span class="spacer"></span>
      ${md && html`<div class="seg">
        <button class=${mode === 'code' ? 'on' : ''} onClick=${() => setMode('code')} title="Source"><${Icon} name="code" size=${13} /> Code</button>
        <button class=${mode === 'split' ? 'on' : ''} onClick=${() => setMode('split')} title="Source and preview"><${Icon} name="split" size=${13} /> Split</button>
        <button class=${mode === 'preview' ? 'on' : ''} onClick=${() => setMode('preview')} title="Rendered"><${Icon} name="eye" size=${13} /> Preview</button>
      </div>`}
      <button class="btn sm" disabled=${!dirty || saving} onClick=${() => save()} title="Save (Ctrl+S)"><${Icon} name="save" size=${13} /> Save</button>
      <button class="icon-btn" title="Reload from disk" onClick=${() => (!dirty || confirm('Discard your unsaved changes?')) && load(true)}><${Icon} name="refresh" /></button>
      <button class="icon-btn" title="Show in File Explorer" onClick=${() => reveal(path)}><${Icon} name="external" /></button>
    </div>
    ${stale && html`<div class="notice">
      <${Icon} name="alert" size=${14} /> This file changed on disk while you have unsaved edits.
      <button class="btn sm" onClick=${() => load(true)}>Load disk version</button>
      <button class="btn sm ghost" onClick=${() => setStale(false)}>Keep mine</button>
    </div>`}
    ${doc.loading
      ? html`<div class="center-msg"><${Icon} name="loader" class="spin" /> Loading…</div>`
      : doc.error
        ? html`<div class="center-msg">${doc.error}</div>`
        : html`<div class=${'file-body mode-' + (md ? mode : 'code')}>
            <div class="editor"><div class="monaco-host" ref=${editorHost}></div></div>
            ${md && html`<div class="preview" ref=${previewRef} onClick=${onPreviewClick}>
              <div class="md" dangerouslySetInnerHTML=${{ __html: renderMarkdown(source) }}></div>
            </div>`}
          </div>`}
  `;
}
