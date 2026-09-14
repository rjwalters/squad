#!/usr/bin/env bash
# Install/update both runtime adapters using ownership-aware receipts.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SRC/scripts/install-lifecycle.mjs" install "$@"
