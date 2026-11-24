#!/bin/bash
# Started by Chrome for the Sifty Server extension's native messaging. Chrome
# gives it a minimal environment, so this selects the project's pinned Node
# (.nvmrc) the same way run-and-notify.sh does — better-sqlite3 is compiled for
# that Node ABI. stdout belongs to the protocol, so everything else goes to the
# log file.
set -uo pipefail

LOG_FILE="/tmp/sifty-native-host.log"
exec 2>>"$LOG_FILE"

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR" || exit 1

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm use >&2

exec "$PROJECT_DIR/node_modules/.bin/tsx" scripts/sifty-native-host.ts
