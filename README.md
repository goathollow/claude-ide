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
  desktop notification (bell icon), and a count in the window title. While no IDE window is open,
  the IDE sends desktop notifications itself for the sessions running in it.

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

> Claude sessions started *inside* the IDE are child processes of the server. They keep running
> while the IDE's window is closed, but stopping the server ends them. Their chats are saved, so you
> can resume them from History. Stop the server with Ctrl+C in its console, or with **Quit** (the
> power button at the bottom left).

## Standalone executable

The IDE also comes as a single executable that runs without Node.js. Each
[release](https://github.com/goathollow/claude-ide/releases) has one for Windows, macOS and Linux.
On macOS and Linux, this installs the latest one to `~/.local/bin` (run it again to update):

```
curl -fsSL https://raw.githubusercontent.com/goathollow/claude-ide/main/install.sh | sh
```

Set `CLAUDE_IDE_VERSION` (such as `v0.2.1`) or `CLAUDE_IDE_INSTALL_DIR` to change what it installs
or where.

To build it yourself:

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

- **Windows:** double-click `claude-ide.exe`. It opens only the IDE's window, with no console.
  Problems that keep it from starting, like the port being taken, appear in a message box.
- **macOS:** run `claude-ide` in a terminal, or double-click it in Finder, which runs it in
  Terminal. Closing that terminal doesn't stop the IDE. The build isn't notarized by Apple, so
  macOS refuses to open a copy downloaded with a browser and offers to move it to the Trash. The
  install command above avoids that. For a browser download, run
  `xattr -d com.apple.quarantine claude-ide` once, or click **Open Anyway** under System Settings >
  Privacy & Security after the first attempt.
- **Linux:** run `claude-ide` in a terminal. Closing that terminal doesn't stop the IDE. Release
  builds are made on Ubuntu 22.04 and need a distribution at least that recent.
- Closing the IDE's last window leaves the Claude sessions started in it running in the
  background, and it notifies you when one needs you or finishes (see
  [How it works](#how-it-works)). Start the IDE again to open a window onto them. Once none are running and no window
  has been open for 15 seconds, it quits by itself.
- **Quit** (the power button at the bottom left) quits right away, ending those sessions. It asks
  first while any are running.
- If the IDE is already running, starting it again just opens another window.
- `--open` opens a browser tab instead of an app window, and otherwise works the same way.
  `--no-open` opens nothing and keeps the server running until it's stopped with **Quit** (or, on
  macOS and Linux, Ctrl+C).
- The first run of each build unpacks about 35 MB to `%LOCALAPPDATA%\claude-ide` (Windows),
  `~/Library/Caches/claude-ide` (macOS) or `~/.cache/claude-ide` (Linux), then removes folders left
  by older builds. Errors are also written to `claude-ide.log` in that folder.
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

With no IDE window open, the server itself notifies you when a session started in the IDE needs
you or finishes. It uses a toast shown through PowerShell on Windows, `osascript` on macOS, and
`notify-send` on Linux (in the `libnotify-bin` package on Debian and Ubuntu).

- **Windows:** the IDE registers a notification app ID under
  `HKEY_CURRENT_USER\Software\Classes\AppUserModelId\ClaudeIDE`, so its notifications show its name
  and icon, and you can turn them off under Settings > System > Notifications. The standalone
  executable also registers `claude-ide://` links there, so clicking a notification opens the IDE
  at that session. Run from source, a click opens the IDE in your browser instead.
- **macOS:** notifications sent this way belong to Script Editor, so clicking one opens Script
  Editor rather than the IDE.

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
  notify.js       desktop notifications sent while no window is open
  pty.js          loads node-pty (from the unpacked folder in the executable)
  vendor.js       browser libraries served from node_modules
packaging/
  sea-main.cjs    entry point of the standalone executable
scripts/
  build-exe.mjs   builds the standalone executable
.github/workflows/
  build.yml       builds it for every platform
install.sh        installs a release build on macOS or Linux
public/
  index.html      import map; no build step
  styles.css
  js/             Preact + htm components (main, sidebar, dashboard, terminal,
                  transcript, fileview, inspector, newchat)
```

## License

MIT. See [LICENSE](LICENSE).
