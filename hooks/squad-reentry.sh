#!/usr/bin/env bash
# squad-reentry.sh — Claude Code Stop hook: opt-in bounded re-entry adapter.
#
# Installed (as a copy with the two placeholders below substituted) by
# `install.sh --reentry` into the target repo's `.claude/hooks/`, and wired
# into `.claude/settings.json`'s `Stop` hooks array. See README.md
# "Re-entry (opt-in)" for the backoff/TTL/operator-stop behavior this drives,
# and src/reentry.ts / src/reentry-hook.ts for the actual decision logic —
# this script is only a thin protocol wrapper around `node dist/reentry-hook.js`.
#
# Contract (Claude Code Stop hook protocol):
#   stdin:  JSON { session_id, transcript_path, stop_hook_active, cwd, ... }
#   stdout: to block-and-continue (re-enter), prints
#           {"decision":"block","reason":"..."} and exits 0; to allow the
#           session to stop, prints nothing and exits 0.
#   This script must never exit non-zero — an unexpected error (missing
#   node, a broken squad build) fails OPEN (allows the stop) rather than
#   wedging the session.
set -uo pipefail

# Substituted at install time with this squad checkout's absolute
# dist/reentry-hook.js path (mirrors how install.sh embeds an absolute
# dist/index.js path into .mcp.json) and the persona this hook watches for
# (the same persona install.sh wrote into .mcp.json's SQUAD_PERSONA, so
# directed-work detection matches @mentions against the right name).
SQUAD_REENTRY_JS="__SQUAD_REENTRY_JS__"
: "${SQUAD_PERSONA:=__SQUAD_REENTRY_PERSONA__}"
export SQUAD_PERSONA

if [[ ! -f "$SQUAD_REENTRY_JS" ]]; then
  # squad's build is missing (e.g. node_modules wiped, dist/ never built) —
  # fail open rather than blocking every stop attempt on a broken hook.
  exit 0
fi

node "$SQUAD_REENTRY_JS"
exit 0
