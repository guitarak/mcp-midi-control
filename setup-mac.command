#!/bin/bash
# Double-clickable macOS setup for mcp-midi-control.
#
# This file ships INSIDE the git clone, so it is NOT Gatekeeper-quarantined
# (quarantine is only applied to files downloaded via a browser). Double-click
# it in Finder, or run `bash setup-mac.command` in Terminal.
#
# It does the two steps a guitarist would otherwise type by hand:
#   1. npm install      — compiles the node-midi engine locally (no Gatekeeper
#                          prompt: locally-compiled binaries are never quarantined)
#   2. npm run setup-mac — registers the server with Claude Desktop (no JSON editing)
#
# Prerequisites (one-time, see docs/INSTALL-MAC.md):
#   - Node.js (from nodejs.org — the .pkg is Apple-notarized, opens cleanly)
#   - Xcode Command Line Tools: run `xcode-select --install` (free, no Apple ID)

set -e

# cd to this script's own directory so it works no matter where it's launched.
cd "$(dirname "$0")"

echo "==> mcp-midi-control macOS setup"
echo "    working in: $(pwd)"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed."
  echo "Install the LTS macOS Installer (.pkg) from https://nodejs.org, then re-run this."
  exit 1
fi

if ! xcode-select -p >/dev/null 2>&1; then
  echo "Apple's free Command Line Tools are needed to build the MIDI engine."
  echo "A dialog will open — click Install, wait for it to finish, then re-run this."
  xcode-select --install || true
  exit 1
fi

echo "==> Installing dependencies + building (this compiles the MIDI engine locally)…"
npm install
echo
echo "==> Registering with Claude Desktop…"
npm run setup-mac
echo
echo "Done. Fully QUIT Claude Desktop (Cmd+Q), reopen it, plug in your gear by USB,"
echo "and ask Claude to connect."

# Keep the Terminal window open when launched by double-click so the user can read the output.
echo
read -r -p "Press Return to close." _ || true
