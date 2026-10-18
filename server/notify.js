import { spawn } from 'node:child_process';

// Desktop notifications sent by the server itself, for when no IDE window is
// open to show them. Each platform has a built-in way to send one: a toast
// shown through PowerShell on Windows, osascript on macOS, and notify-send on
// Linux. Only Windows can open the IDE when one is clicked.

// The toast is named and given an icon by registering an app ID for it. With
// an executable to start, a claude-ide:// link is registered too, so clicking
// the toast starts the IDE, which opens a window onto the copy already running.
const WINDOWS_TOAST = `
try {
  $classes = 'HKEY_CURRENT_USER\\Software\\Classes'
  $app = 'ClaudeIDE'
  [Microsoft.Win32.Registry]::SetValue("$classes\\AppUserModelId\\$app", 'DisplayName', 'Claude IDE')
  if ($env:N_ICON) { [Microsoft.Win32.Registry]::SetValue("$classes\\AppUserModelId\\$app", 'IconUri', $env:N_ICON) }
  if ($env:N_EXE) {
    [Microsoft.Win32.Registry]::SetValue("$classes\\claude-ide", '', 'URL:Claude IDE')
    [Microsoft.Win32.Registry]::SetValue("$classes\\claude-ide", 'URL Protocol', '')
    [Microsoft.Win32.Registry]::SetValue("$classes\\claude-ide\\shell\\open\\command", '', ('"{0}" "%1"' -f $env:N_EXE))
  }
  $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]
  $x = { [System.Security.SecurityElement]::Escape([string]$args[0]) }
  $xml = [Windows.Data.Xml.Dom.XmlDocument]::new()
  $xml.LoadXml("<toast activationType='protocol' launch='$(& $x $env:N_LINK)'><visual><binding template='ToastGeneric'><text>$(& $x $env:N_TITLE)</text><text>$(& $x $env:N_BODY)</text></binding></visual></toast>")
  $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
  # A newer notification about the same session replaces the older one.
  $toast.Tag = $env:N_TAG
  $toast.Group = 'sessions'
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show($toast)
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}`;

// title and body are plain text. tag identifies what the notification is
// about; link is opened when it's clicked, exe is what claude-ide:// links
// start, and icon is a PNG file.
export function notify({ title, body = '', tag, link, exe, icon }) {
  if (process.platform === 'win32') {
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_TOAST, 'utf16le').toString('base64')], {
      N_TITLE: title, N_BODY: body, N_TAG: tag || '', N_LINK: link || '', N_EXE: exe || '', N_ICON: icon || '',
    });
  } else if (process.platform === 'darwin') {
    run('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body]);
  } else {
    // notify-send reads a little HTML in the body.
    const html = body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    run('notify-send', ['--app-name=Claude IDE', ...(icon ? ['--icon', icon] : []), title, html]);
  }
}

// Notifications are a convenience, so a failure is logged once and otherwise ignored.
let reported = false;
function report(message) {
  if (!reported) console.error(`Couldn't show a desktop notification: ${message}`);
  reported = true;
}

function run(cmd, args, env = {}) {
  let stderr = '';
  const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env: { ...process.env, ...env } });
  child.stderr.on('data', d => { stderr += d; });
  child.on('error', e => report(e.code === 'ENOENT' ? `${cmd} isn't installed` : e.message));
  child.on('exit', code => { if (code) report(stderr.trim() || `${cmd} exited with code ${code}`); });
}
