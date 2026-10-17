#!/bin/sh
# Installs the Claude IDE standalone executable on macOS or Linux:
#
#   curl -fsSL https://raw.githubusercontent.com/goathollow/claude-ide/main/install.sh | sh
#
# macOS only flags files downloaded by browsers, so a copy downloaded here opens
# without the "can't verify this app" warning. Run it again to update.
#
# Environment variables:
#   CLAUDE_IDE_VERSION      release to install, such as v0.2.1 (default: the latest)
#   CLAUDE_IDE_INSTALL_DIR  folder to install into (default: ~/.local/bin)

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
    *) fail "$(uname -s) isn't supported. On Windows, download claude-ide-windows-x64.exe from https://github.com/$REPO/releases/latest" ;;
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
  mv "$tmp/claude-ide" "$dir/claude-ide"
  chmod +x "$dir/claude-ide"
  echo "Installed $dir/claude-ide"

  case ":$PATH:" in
    *":$dir:"*) echo "Run claude-ide to start it." ;;
    *)
      echo "$dir isn't on your PATH. Run $dir/claude-ide to start it, or add this line to your shell profile:"
      echo "  export PATH=\"$dir:\$PATH\""
      ;;
  esac
}

main "$@"
