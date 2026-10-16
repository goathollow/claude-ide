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

On Windows you can also double-click **`Claude IDE.cmd`**. On Linux, `npm install` compiles
node-pty, which needs `python3`, `make` and a C++ compiler (`sudo apt install build-essential
python3` on Debian or Ubuntu). Windows and macOS use prebuilt binaries.

> Claude sessions started *inside* the IDE are child processes of the server. Stopping the server
> ends them. Their chats are saved, so you can resume them from History.

## Standalone executable

To run the IDE on a machine without Node.js, build it into a single executable:

```
npm install
npm run build:exe   # writes dist/claude-ide, or dist\claude-ide.exe on Windows
```

That builds for the system you run it on. To build for every platform, run the **Build
executables** workflow from the repo's Actions tab. It builds on GitHub's machines for Windows
(x64), macOS (Apple silicon and Intel) and Linux (x64 and ARM), and puts the files on the run's
page. Pushing a version tag such as `v0.2.0` also attaches them to that GitHub release.

The executable is a [Node single executable application](https://nodejs.org/api/single-executable-applications.html):
a copy of the Node runtime with the server, web UI and node-pty embedded. It's 100-130 MB, almost
all of it the Node runtime. It doesn't use Electron. The app window is your installed Chrome, Edge,
Chromium or Brave in app mode, or your default browser if none of those is installed.

- **Windows:** double-click `claude-ide.exe`. The console window that opens with it is the server.
  Closing it stops the IDE and any Claude sessions started in it.
- **macOS:** double-click `claude-ide` in Finder, which runs it in Terminal, or run it from a
  terminal. The build isn't signed by a registered Apple developer, so macOS blocks a downloaded
  copy. Run `xattr -d com.apple.quarantine claude-ide` once to allow it.
- **Linux:** run `./claude-ide` from a terminal. Builds from the workflow are made on Ubuntu
  22.04 and need a distribution at least that recent.
- If the IDE is already running, starting it again just opens another window.
- `--open` opens a browser tab instead of an app window, and `--no-open` opens nothing.
- The first run of each build unpacks about 35 MB to `%LOCALAPPDATA%\claude-ide` (Windows),
  `~/Library/Caches/claude-ide` (macOS) or `~/.cache/claude-ide` (Linux), then removes folders left
  by older builds.
- The `claude` CLI still has to be installed.
- On Windows the executable isn't code-signed, so SmartScreen may warn the first time you run it.

The build embeds the Node version that runs `npm run build:exe`. On Linux that has to be an
official build from nodejs.org (or nvm, fnm, etc.), not a distribution's `nodejs` package.

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
  pty.js          loads node-pty (from the unpacked folder in the executable)
  vendor.js       browser libraries served from node_modules
packaging/
  sea-main.cjs    entry point of the standalone executable
scripts/
  build-exe.mjs   builds the standalone executable
.github/workflows/
  build.yml       builds it for every platform
public/
  index.html      import map; no build step
  styles.css
  js/             Preact + htm components (main, sidebar, dashboard, terminal,
                  transcript, fileview, inspector, newchat)
```

## License

MIT. See [LICENSE](LICENSE).
