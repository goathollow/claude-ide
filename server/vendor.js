// Browser libraries served at /vendor/<name>, as paths under node_modules.
// Shared with scripts/build-exe.mjs so the executable embeds the same files.
export const VENDOR = {
  preact: 'preact',
  htm: 'htm/dist',
  xterm: '@xterm/xterm',
  'xterm-fit': '@xterm/addon-fit/lib',
  'xterm-links': '@xterm/addon-web-links/lib',
  monaco: 'monaco-editor/min',
  marked: 'marked/lib',
  dompurify: 'dompurify/dist',
  hljs: '@highlightjs/cdn-assets',
};
