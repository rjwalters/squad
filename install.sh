#!/usr/bin/env bash
# Install/update both runtime adapters using ownership-aware receipts.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Keep a symlinked release path (…/current) rather than its resolved target.
export SQUAD_SOURCE="${SQUAD_SOURCE:-$SRC}"
exec node "$SRC/scripts/install-lifecycle.mjs" install "$@"
