#!/bin/sh
# Installs Claude IDE on macOS or Linux:
#
#   curl -fsSL https://raw.githubusercontent.com/goathollow/claude-ide/main/install.sh | sh
#
# On macOS it installs the Claude IDE app in /Applications (or ~/Applications if
# you can't write to /Applications), and links the claude-ide command to the
# executable inside it. On Linux it installs the claude-ide executable. macOS
# only flags files downloaded by browsers, so a copy downloaded here opens
# without the "can't verify this app" warning. Run it again to update.
#
# Environment variables:
#   CLAUDE_IDE_VERSION      release to install, such as v0.2.1 (default: the latest)
#   CLAUDE_IDE_INSTALL_DIR  folder for the claude-ide command (default: ~/.local/bin)
#   CLAUDE_IDE_APP_DIR      folder for the Mac app (default: /Applications)

set -eu

REPO=goathollow/claude-ide

fail() {
  echo "claude-ide install: $*" >&2
  exit 1
}

# Everything runs from here, so a partly downloaded script does nothing.
main() {
  case "$(uname -s)" in
    Darwin) os=macos ;;
    Linux) os=linux ;;
    *) fail "$(uname -s) isn't supported. On Windows, download and run claude-ide-windows-x64-setup.exe from https://github.com/$REPO/releases/latest" ;;
  esac

  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) fail "$(uname -m) processors aren't supported" ;;
  esac
  # A shell running under Rosetta reports x86_64 on Apple silicon.
  if [ "$os" = macos ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2> /dev/null)" = 1 ]; then
    arch=arm64
  fi

  version=${CLAUDE_IDE_VERSION:-latest}
  if [ "$version" = latest ]; then
    url="https://github.com/$REPO/releases/latest/download/claude-ide-$os-$arch.tar.gz"
  else
    url="https://github.com/$REPO/releases/download/$version/claude-ide-$os-$arch.tar.gz"
  fi
  dir=${CLAUDE_IDE_INSTALL_DIR:-$HOME/.local/bin}

  command -v curl > /dev/null || fail "curl is required"
  command -v tar > /dev/null || fail "tar is required"

  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  echo "Downloading $url"
  curl -fL --progress-bar "$url" -o "$tmp/claude-ide.tar.gz" || fail "download failed"
  tar -xzf "$tmp/claude-ide.tar.gz" -C "$tmp"

  mkdir -p "$dir"
  # Removing the old copy first lets this replace one that's running.
  rm -f "$dir/claude-ide"
  app=
  if [ -d "$tmp/Claude IDE.app" ]; then
    apps=${CLAUDE_IDE_APP_DIR:-}
    if [ -z "$apps" ]; then
      # Update the copy already installed, wherever it is.
      if [ -d "$HOME/Applications/Claude IDE.app" ] && [ ! -d "/Applications/Claude IDE.app" ]; then
        apps=$HOME/Applications
      elif [ -w /Applications ]; then
        apps=/Applications
      else
        apps=$HOME/Applications
      fi
    fi
    app="$apps/Claude IDE.app"
    mkdir -p "$apps"
    rm -rf "$app"
    mv "$tmp/Claude IDE.app" "$app"
    ln -s "$app/Contents/MacOS/claude-ide" "$dir/claude-ide"
    echo "Installed $app, and linked $dir/claude-ide to it"
  else
    # Older releases had only the executable, on macOS too.
    mv "$tmp/claude-ide" "$dir/claude-ide"
    chmod +x "$dir/claude-ide"
    echo "Installed $dir/claude-ide"
  fi

  case ":$PATH:" in
    *":$dir:"*) cmd=claude-ide ;;
    *) cmd=$dir/claude-ide ;;
  esac
  if [ -n "$app" ]; then
    echo "Open Claude IDE from $apps or Spotlight, or run $cmd in a terminal."
  else
    echo "Run $cmd to start it."
  fi
  if [ "$cmd" != claude-ide ]; then
    echo "$dir isn't on your PATH. To run it as just claude-ide, add this line to your shell profile:"
    echo "  export PATH=\"$dir:\$PATH\""
  fi
  if curl -fs -m 2 "http://localhost:${CLAUDE_IDE_PORT:-4477}/api/info" > /dev/null 2>&1; then
    echo "Claude IDE is running. The new version starts once it quits: use Quit (the power button), or close its windows and wait for its Claude sessions to end."
  fi
}

main "$@"
