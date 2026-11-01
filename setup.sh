#!/usr/bin/env bash
# One-time setup: stores your App Store Connect key safely and registers
# this server with Claude Code (all projects).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
KEY_DIR="$HOME/.config/appstore-connect-mcp"

read -rp "Key ID (e.g. ABC123DEF4): " KEY_ID
read -rp "Issuer ID (UUID shown above the keys table): " ISSUER_ID
read -rp "Path to the downloaded .p8 file: " P8_PATH
P8_PATH="${P8_PATH/#\~/$HOME}"

if [[ ! -f "$P8_PATH" ]]; then
  echo "File not found: $P8_PATH" >&2
  exit 1
fi

mkdir -p "$KEY_DIR"
chmod 700 "$KEY_DIR"
DEST="$KEY_DIR/AuthKey_${KEY_ID}.p8"
cp "$P8_PATH" "$DEST"
chmod 600 "$DEST"

if [[ ! -f "$REPO_DIR/dist/index.js" ]]; then
  (cd "$REPO_DIR" && npm install && npm run build)
fi

claude mcp remove --scope user appstore-connect >/dev/null 2>&1 || true
claude mcp add --scope user appstore-connect \
  -e APPLE_KEY_ID="$KEY_ID" \
  -e APPLE_ISSUER_ID="$ISSUER_ID" \
  -e APPLE_PRIVATE_KEY_PATH="$DEST" \
  -- node "$REPO_DIR/dist/index.js"

echo
echo "Done. Key stored at $DEST (only you can read it)."
echo "You can now delete the original download: $P8_PATH"
echo "Start a new Claude Code session and ask: \"List my App Store Connect apps\""
