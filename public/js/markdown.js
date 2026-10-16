import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js';

const escape = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const marked = new Marked({ gfm: true });
marked.use({
  renderer: {
    code({ text, lang }) {
      const language = (lang || '').trim().split(/\s+/)[0];
      let body;
      try {
        body = language && hljs.getLanguage(language) ? hljs.highlight(text, { language }).value : escape(text);
      } catch {
        body = escape(text);
      }
      return `<pre><code class="hljs${language ? ' language-' + escape(language) : ''}">${body}</code></pre>\n`;
    },
  },
});

const cache = new Map();

export function renderMarkdown(src) {
  src = src || '';
  if (cache.has(src)) return cache.get(src);
  const out = DOMPurify.sanitize(marked.parse(src));
  if (src.length < 20000) {
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    cache.set(src, out);
  }
  return out;
}
