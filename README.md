# Claude IDE

A local web IDE for keeping track of many Claude Code sessions at once.

- **Dashboard** of every running Claude session, sorted by what needs you: waiting on a
  permission prompt, finished since you last looked, working, or idle. Each card shows what the
  session is doing right now (current tool call or task), its task progress, and its last message.
- **Embedded terminals.** Start a new chat in any folder, or resume a past one, in a real terminal
  tab inside the IDE. Tabs survive a page reload.
- **History** of every past chat, grouped by project, with search, and a readable transcript view
  showing prompts, replies, tool calls (expand for input, output, and edit diffs), and recaps.
- **Plans and markdown** in code, split, or rendered preview (Monaco editor). Files reload
  automatically when Claude edits them, and you can edit and save (Ctrl+S).
- **Notifications** when a session finishes or needs permission: in-app toasts, an optional
  desktop notification (bell icon), and a count in the window title.

## Run it

Requires Node.js 20+ and the `claude` CLI on your PATH.

```
npm install
npm start          # then open http://localhost:4477
npm run app        # same, but opens a standalone Edge/Chrome app window
```

On Windows you can also double-click **`Claude IDE.cmd`**.

> Claude sessions started *inside* the IDE are child processes of the server. Stopping the server
> ends them. Their chats are saved, so you can resume them from History.

## How it works

The IDE reads what Claude Code already writes to `~/.claude` (or `CLAUDE_CONFIG_DIR`):

| Source | Used for |
| --- | --- |
| `sessions/<pid>.json` | Live status of every running session: `busy`, `idle`, `waiting` + `waitingFor` |
| `projects/<folder>/<session>.jsonl` | Transcripts: history, titles, current activity, cost, model |
| `tasks/<session>/*.json` | Task lists shown as progress |
| `plans/*.md` | Plan files, linked to their chat by the session's `slug` |

Sessions running in other terminal windows appear in the dashboard and can be read, but you can
only type into sessions started in the IDE. To move one in, exit it in its terminal, then press
**Resume** in the IDE.

New chats are launched as `claude --session-id <uuid>` (plus `--name`, `--model` and
`--permission-mode` if chosen) and resumed with `claude --resume <id>`, using
[node-pty](https://github.com/microsoft/node-pty). A headless xterm on the server mirrors each
screen, so a reconnecting tab gets the current screen back.

## Security

The server listens on `127.0.0.1` only. It can start processes and write files, so it rejects
requests whose `Host` isn't localhost (DNS rebinding) and mutating or WebSocket requests from any
other origin.

## Configuration

| Env var | Default |
| --- | --- |
| `CLAUDE_IDE_PORT` | `4477` |
| `CLAUDE_IDE_CLAUDE_BIN` | `claude` found on PATH |
| `CLAUDE_CONFIG_DIR` | `~/.claude` |

## Layout

```
server/
  index.js        HTTP + WebSocket server, request guard
  sessions.js     live-session monitor, history, plans, recent folders
  transcripts.js  JSONL parsing (head/tail summaries, incremental full parse)
  terminals.js    node-pty sessions mirrored by a headless xterm
  files.js        directory listing, read/write, markdown search
  processes.js    PID liveness checks
public/
  index.html      import map; no build step
  styles.css
  js/             Preact + htm components (main, sidebar, dashboard, terminal,
                  transcript, fileview, inspector, newchat)
```

## License

MIT. See [LICENSE](LICENSE).
