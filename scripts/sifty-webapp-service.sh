#!/bin/bash
# Run by launchd (ai.openclaw.sifty-webapp) to keep the Sifty dev server up.
# launchd's PATH points at Homebrew's global node, not the project's pinned
# version (.nvmrc); better-sqlite3 is compiled for a specific Node ABI, so this
# selects the pinned one first, as run-and-notify.sh and the native host do.
# Output goes to the log file named in the plist (/tmp/sifty-webapp.log).
set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR" || exit 1

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm use

# exec so launchd's stop signal reaches the dev server itself, not a shell.
exec "$PROJECT_DIR/node_modules/.bin/vite"
