#!/bin/bash
set -uo pipefail

LOG_FILE="/tmp/sifty-native-host.log"
exec 2>>"$LOG_FILE"

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR" || exit 1

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
# stdout carries the native messaging protocol, so nvm's output goes to stderr.
nvm use >&2

exec "$PROJECT_DIR/node_modules/.bin/tsx" scripts/sifty-native-host.ts
