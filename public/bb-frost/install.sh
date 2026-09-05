#!/usr/bin/env bash
# Frost for Blackboard Ultra — macOS installer.
#   curl -fsSL https://frostdev.io/bb-frost/install.sh | bash
# Downloads the extension into Application Support, copies that path to the clipboard and opens
# chrome://extensions. Chrome has no CLI for loading an unpacked extension, so the last step is
# three clicks in that tab; the path on the clipboard makes the file dialog a paste.
# Re-run to update, then press ↻ on the extension's card.
set -euo pipefail

URL="https://frostdev.io/bb-frost/bb-frost.zip"
DEST="$HOME/Library/Application Support/frostdev/bb-frost"

[[ "$(uname -s)" == "Darwin" ]] || { echo "This installer is for macOS." >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "==> downloading $URL"
curl -fsSL "$URL" -o "$tmp/bb-frost.zip"

mkdir -p "$DEST"
find "$DEST" -mindepth 1 -delete
unzip -qo "$tmp/bb-frost.zip" -d "$DEST"

version="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$DEST/manifest.json")"
printf '%s' "$DEST" | pbcopy
open -a "Google Chrome" "chrome://extensions" 2>/dev/null || true

cat <<EOF
==> Frost for Blackboard Ultra v$version is at:
    $DEST
    (that path is on your clipboard)

In the chrome://extensions tab that just opened:
  1. Turn on "Developer mode" (top right)
  2. Click "Load unpacked"
  3. In the file dialog press ⌘⇧G, paste (⌘V), Enter, then "Select"

Already installed? Press ↻ on the extension's card instead.
Settings live behind the extension's toolbar icon (pin it from the puzzle-piece menu).
EOF
