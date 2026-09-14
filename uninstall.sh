#!/usr/bin/env bash
# Repo removal is local; --global separately removes managed Codex wiring.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SRC/scripts/install-lifecycle.mjs" uninstall "$@"
