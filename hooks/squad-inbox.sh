#!/usr/bin/env bash
# squad-inbox.sh — Claude Code PostToolUse / UserPromptSubmit hook: opt-in
# mid-turn inbox delivery.
#
# Installed (as a copy with the two placeholders below substituted) by
# `install.sh --inbox` into the target repo's `.claude/hooks/`, and wired into
# `.claude/settings.json`'s `PostToolUse` and `UserPromptSubmit` hook arrays.
# See README.md "Mid-turn inbox delivery (opt-in)" for what it surfaces, and
# src/inbox.ts / src/inbox-hook.ts for the actual logic — this script is only
# a thin protocol wrapper around `node dist/inbox-hook.js`, plus the
# rate-limit fast path below.
#
# Contract (Claude Code hook protocol):
#   stdin:  JSON { session_id, hook_event_name, cwd, ... }
#   stdout: to surface a notice, prints
#           {"hookSpecificOutput":{"hookEventName":"<event>",
#             "additionalContext":"..."}} and exits 0; to stay silent, prints
#           nothing and exits 0.
#   This script must never exit non-zero and must never print a decision —
#   an unexpected error (missing node, a broken squad build) fails SILENT.
#   It runs on every tool call, so it must also stay cheap: see the fast path.
set -uo pipefail

# Substituted at install time with this squad checkout's absolute
# dist/inbox-hook.js path and the persona this hook watches for (the same
# persona install.sh wrote into .mcp.json's SQUAD_PERSONA, so @mention
# matching uses the right name) — mirrors hooks/squad-reentry.sh.
SQUAD_INBOX_JS="__SQUAD_INBOX_JS__"
: "${SQUAD_PERSONA:=__SQUAD_INBOX_PERSONA__}"
export SQUAD_PERSONA

# Drain stdin with a builtin (no subprocess) so the fast path below can exit
# without leaving Claude Code writing into a closed pipe. `read -d ''` reads to
# EOF and reports failure for the missing delimiter, which is the normal case.
SQUAD_INBOX_INPUT=""
IFS= read -r -d '' SQUAD_INBOX_INPUT || true

if [[ ! -f "$SQUAD_INBOX_JS" ]]; then
  # squad's build is missing (e.g. node_modules wiped, dist/ never built) —
  # stay silent rather than erroring on every tool call.
  exit 0
fi

# Rate-limit fast path. This hook fires on every tool call, where even a bare
# `node` start (tens of milliseconds) is too expensive to pay unconditionally,
# so a freshly-stamped state file short-circuits before node is spawned. It is
# deliberately *skip-only* and conservative: it can only decline to peek, never
# decide to notify, so src/inbox.ts's peekDue() remains the authority (and
# anything unexpected here just falls through to node).
SQUAD_INBOX_SECONDS="${SQUAD_INBOX_INTERVAL_SECONDS:-60}"
SQUAD_INBOX_ROOM="${SQUAD_DIR:-}"
if [[ -z "$SQUAD_INBOX_ROOM" && -n "${CLAUDE_PROJECT_DIR:-}" ]]; then
  SQUAD_INBOX_ROOM="$CLAUDE_PROJECT_DIR/.squad"
fi
SQUAD_INBOX_STATE="$SQUAD_INBOX_ROOM/inbox/$SQUAD_PERSONA.json"
if [[ -n "$SQUAD_INBOX_ROOM" && -f "$SQUAD_INBOX_STATE" &&
      "$SQUAD_INBOX_SECONDS" =~ ^[0-9]+$ && "$SQUAD_INBOX_SECONDS" -gt 0 ]]; then
  SQUAD_INBOX_NOW="$(date +%s 2>/dev/null || echo 0)"
  # `date -r <file>` on BSD/macOS, `stat -c %Y` on GNU; either failing (or a
  # pre-epoch 0) just falls through to the authoritative check in node.
  SQUAD_INBOX_MTIME="$(date -r "$SQUAD_INBOX_STATE" +%s 2>/dev/null ||
    stat -c %Y "$SQUAD_INBOX_STATE" 2>/dev/null || echo 0)"
  if [[ "$SQUAD_INBOX_NOW" =~ ^[0-9]+$ && "$SQUAD_INBOX_MTIME" =~ ^[0-9]+$ &&
        "$SQUAD_INBOX_MTIME" -gt 0 &&
        $((SQUAD_INBOX_NOW - SQUAD_INBOX_MTIME)) -lt "$SQUAD_INBOX_SECONDS" ]]; then
    exit 0
  fi
fi

printf '%s' "$SQUAD_INBOX_INPUT" | node "$SQUAD_INBOX_JS"
exit 0
