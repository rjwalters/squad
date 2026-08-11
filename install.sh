#!/usr/bin/env bash
# Install squad into a target repo. Claude Code and Codex are peers: both get
# the same MCP tools, the same room (<repo>/.squad/), and equivalent join/goals
# commands. Safe to re-run; marker-bounded edits are replaced in place.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="."
YES=0
CODEX=1
LINK=1
DRY=0
CLAUDE_PERSONA="${SQUAD_CLAUDE_PERSONA:-claude}"
CODEX_PERSONA="${SQUAD_CODEX_PERSONA:-codex}"

usage() {
  cat <<EOF
usage: ./install.sh [options] [target-repo]

Installs into the target repo (default .):
  .mcp.json                        squad MCP entry for Claude Code, with the
                                   room pinned to <repo>/.squad (persona "$CLAUDE_PERSONA")
  .claude/commands/squad/*.md      /squad:join, /squad:goals, /squad:clear
  .claude/skills/squad/SKILL.md    conventions + tool reference
  .claude/skills/squad/install-metadata.json
                                   installed version + commit (tracked), so
                                   /repo:update-tools can spot a stale install;
                                   source path + timestamp go to a gitignored
                                   .install-local.json sidecar
  CLAUDE.md / AGENTS.md            identical marker-bounded blocks — Claude and
                                   Codex read the same instructions
  .gitignore                       adds .squad/ (the room is ephemeral local state)

Global, with confirmation (skip with --no-codex / --no-link) — these are
one-time-per-machine, not per target repo:
  ~/.codex/prompts/squad-*.md      /squad-join, /squad-goals prompts
  ~/.codex/config.toml             [mcp_servers.squad] (persona "$CODEX_PERSONA"); the server
                                   finds each repo's room from Codex's working
                                   directory, so start codex inside the repo
  squad CLI on PATH                \`npm link\` from $SRC, so the human CLI
                                   (\`squad send|read|tail|goals|claims|claim|release|who|clear|path\`)
                                   works from any target repo. If it's skipped
                                   or npm can't write the global prefix, the
                                   closing output prints the equivalent
                                   \`node $SRC/dist/index.js <cmd>\` form instead.

options:
  -y            non-interactive; assumes yes (including the Codex and CLI-link
                global writes unless --no-codex / --no-link is passed)
  --no-codex    skip all writes outside the target repo
  --no-link     skip \`npm link\`; the closing output uses the node path form
  --dry-run     print every planned write (including any outside the target
                repo) and exit without changing anything
  -h, --help    show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -y) YES=1 ;;
    --no-codex) CODEX=0 ;;
    --no-link) LINK=0 ;;
    --dry-run) DRY=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown option: $1" >&2; usage; exit 1 ;;
    *) TARGET="$1" ;;
  esac
  shift
done

TARGET="$(cd "$TARGET" && pwd)"
echo "squad source: $SRC"
echo "install target: $TARGET"

# VERSION at the source root is the single source of truth for what gets
# recorded in the target's install metadata.
VERSION_VALUE="$(tr -d '[:space:]' < "$SRC/VERSION" 2>/dev/null || true)"
if [[ -z "$VERSION_VALUE" ]]; then
  echo "error: $SRC/VERSION is missing or empty" >&2
  exit 1
fi
COMMIT="$(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo unknown)"

# --- dry run: print the full write plan and stop ---------------------------
if [[ $DRY -eq 1 ]]; then
  echo
  echo "dry-run: planned writes (nothing will be changed)"
  echo
  if [[ ! -f "$SRC/dist/index.js" ]]; then
    echo "source clone ($SRC):"
    echo "  node_modules/, dist/                 install deps + build (dist/index.js is missing)"
    echo
  fi
  echo "target repo ($TARGET):"
  echo "  .claude/commands/squad/*.md          copy /squad:join, /squad:goals, /squad:clear"
  echo "  .claude/skills/squad/SKILL.md        copy skill"
  echo "  .claude/skills/squad/install-metadata.json"
  echo "                                       version $VERSION_VALUE, commit $COMMIT, layout_version 1 (tracked)"
  echo "  .claude/skills/squad/.install-local.json"
  echo "                                       source path + install timestamp (gitignored sidecar)"
  echo "  .mcp.json                            merge squad MCP entry (persona \"$CLAUDE_PERSONA\", room $TARGET/.squad)"
  if ! grep -qxF ".squad/" "$TARGET/.gitignore" 2>/dev/null; then
    echo "  .gitignore                           append .squad/"
  fi
  if ! grep -qxF ".claude/skills/squad/.install-local.json" "$TARGET/.gitignore" 2>/dev/null; then
    echo "  .gitignore                           append .claude/skills/squad/.install-local.json"
  fi
  echo "  CLAUDE.md, AGENTS.md                 replace/append identical marker-bounded squad blocks"
  if [[ $CODEX -eq 1 || $LINK -eq 1 ]]; then
    echo
    echo "outside the target repo (asks first; skip individually with --no-codex / --no-link):"
  fi
  if [[ $CODEX -eq 1 ]]; then
    echo "  ~/.codex/prompts/squad-*.md          copy /squad-join, /squad-goals prompts"
    echo "  ~/.codex/config.toml                 replace/append [mcp_servers.squad] block (persona \"$CODEX_PERSONA\")"
    echo "  ~/.codex/config.toml.squad-backup    backup of config.toml before the edit"
  fi
  if [[ $LINK -eq 1 ]]; then
    echo "  npm link (from $SRC)                 puts the squad CLI on PATH"
  fi
  exit 0
fi

# Build if needed
if [[ ! -f "$SRC/dist/index.js" ]]; then
  echo "building squad..."
  (cd "$SRC" && (pnpm install --silent || npm install --silent) && (pnpm build || npm run build))
fi

confirm() { # confirm "prompt" -> 0/1
  [[ $YES -eq 1 ]] && return 0
  read -r -p "$1 [y/N] " reply
  [[ "$reply" == "y" || "$reply" == "Y" ]]
}

# --- marker-bounded block helper (BEGIN/END SQUAD) -------------------------
write_block() { # write_block <file> <block-content>
  local file="$1" content="$2" begin="<!-- BEGIN SQUAD -->" end="<!-- END SQUAD -->"
  touch "$file"
  if grep -qF "$begin" "$file"; then
    local tmp
    tmp="$(mktemp)"
    awk -v b="$begin" -v e="$end" '
      index($0, b) { skip = 1 }
      !skip { print }
      index($0, e) { skip = 0 }
    ' "$file" > "$tmp"
    mv "$tmp" "$file"
  fi
  { [[ -s "$file" ]] && [[ -n "$(tail -c 1 "$file")" ]] && echo; } >> "$file" || true
  printf '%s\n%s\n%s\n' "$begin" "$content" "$end" >> "$file"
}

# --- target repo: commands + skill -----------------------------------------
mkdir -p "$TARGET/.claude/commands/squad" "$TARGET/.claude/skills/squad"
cp "$SRC"/commands/squad/*.md "$TARGET/.claude/commands/squad/"
cp "$SRC"/skills/squad/SKILL.md "$TARGET/.claude/skills/squad/"
echo "installed .claude/commands/squad/ and .claude/skills/squad/"

# --- target repo: install metadata -----------------------------------------
# Tracked file: byte-identical on every machine (no paths, no timestamps), so
# /repo:update-tools can compare installed vs source version.
cat > "$TARGET/.claude/skills/squad/install-metadata.json" <<EOF
{
  "version": "$VERSION_VALUE",
  "commit": "$COMMIT",
  "layout_version": 1
}
EOF
# Machine-local sidecar: gitignored, never tracked.
cat > "$TARGET/.claude/skills/squad/.install-local.json" <<EOF
{
  "source": "$SRC",
  "installed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
echo "wrote install-metadata.json ($VERSION_VALUE @ $COMMIT) + .install-local.json sidecar"

# --- target repo: .mcp.json merge ------------------------------------------
node - "$TARGET/.mcp.json" "$SRC/dist/index.js" "$CLAUDE_PERSONA" "$TARGET/.squad" <<'EOF'
const fs = require("fs");
const [file, serverPath, persona, squadDir] = process.argv.slice(2);
let cfg = {};
if (fs.existsSync(file)) cfg = JSON.parse(fs.readFileSync(file, "utf8"));
cfg.mcpServers ??= {};
cfg.mcpServers.squad = {
  command: "node",
  args: [serverPath],
  env: { SQUAD_PERSONA: persona, SQUAD_DIR: squadDir },
};
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
console.log(`merged squad server into ${file}`);
EOF

# --- target repo: gitignore the room ---------------------------------------
if ! grep -qxF ".squad/" "$TARGET/.gitignore" 2>/dev/null; then
  echo ".squad/" >> "$TARGET/.gitignore"
  echo "added .squad/ to .gitignore"
fi
if ! grep -qxF ".claude/skills/squad/.install-local.json" "$TARGET/.gitignore" 2>/dev/null; then
  {
    echo
    echo "# squad machine-local install metadata (absolute source path + timestamp)"
    echo ".claude/skills/squad/.install-local.json"
  } >> "$TARGET/.gitignore"
  echo "added .claude/skills/squad/.install-local.json to .gitignore"
fi

# --- target repo: CLAUDE.md + AGENTS.md blocks (identical — both agents are
# peers and read the same conventions) ---------------------------------------
read -r -d '' BLOCK <<EOF || true
## Squad — cross-agent collaboration

This repo has [squad](https://github.com/rjwalters/squad) installed: a chat
room private to this repo (SQLite at \`.squad/squad.db\`) shared by every agent
working here — Claude and Codex are peers with identical tools. Use it to
split work, hand off results, and track shared goals (e.g. divide the lemmas
of a Lean proof and claim them in chat).

Tools (all pull-based; nothing ever wakes you):
- \`squad_join\` — register, get members + open goals + recent history
- \`squad_send\` — post to the room; \`@name\` addresses a teammate
- \`squad_check\` — your unread messages (consumes; \`peek: true\` to look
  without consuming; \`wait_seconds: 25\` long-polls for live conversation)
- \`squad_goals\` / \`squad_goal_add\` / \`squad_goal_done\` /
  \`squad_goal_reopen\` — shared goal board (reopen undoes a mistaken done);
  every change is auto-announced in chat
- \`squad_claims\` / \`squad_claim\` / \`squad_release\` — advisory claims on
  files or areas: claim a path before you edit it, release when done. Every
  change is auto-announced and current claims ride along in \`squad_join\`, so
  a claim is visible before an edit lands. Advisory, never a lock; a claim
  lists as \`stale\` once its holder has been absent, so it can be taken over
- \`squad_clear\` — wipe the room (destructive; needs explicit user intent)

Conventions: claim a goal in chat before working on it; report results when
done; only mark goals done that you verified (in Lean work: it compiles with
no \`sorry\`); never speak as another persona; \`squad_claim\` a file before
editing it and check \`squad_claims\` before touching a shared one; never
delete files you did not create, however scratch-like they look — untracked
≠ yours. At session start, a \`squad_check\` with \`peek: true\` shows whether
a teammate left you a message.

Join commands: \`/squad:join\` (Claude) or \`/squad-join\` (Codex) — then hold
the loop: check(wait 25s) → respond/work → repeat.
EOF
write_block "$TARGET/CLAUDE.md" "$BLOCK"
write_block "$TARGET/AGENTS.md" "$BLOCK"
echo "wrote identical marker blocks in CLAUDE.md and AGENTS.md"

# --- global: Codex ----------------------------------------------------------
if [[ $CODEX -eq 1 ]] && confirm "Register squad with Codex (~/.codex/prompts + config.toml, one-time per machine)?"; then
  mkdir -p "$HOME/.codex/prompts"
  cp "$SRC"/codex/prompts/squad-*.md "$HOME/.codex/prompts/"
  echo "installed ~/.codex/prompts/squad-*.md"

  CODEX_TOML="$HOME/.codex/config.toml"
  touch "$CODEX_TOML"
  if grep -qF "# BEGIN SQUAD MCP" "$CODEX_TOML"; then
    tmp="$(mktemp)"
    awk '
      /# BEGIN SQUAD MCP/ { skip = 1 }
      !skip { print }
      /# END SQUAD MCP/ { skip = 0 }
    ' "$CODEX_TOML" > "$tmp"
    mv "$tmp" "$CODEX_TOML"
  fi
  cp "$CODEX_TOML" "$CODEX_TOML.squad-backup"
  cat >> "$CODEX_TOML" <<EOF

# BEGIN SQUAD MCP
# The squad server resolves each repo's room (<repo>/.squad) from the working
# directory, so one global entry serves every squad-enabled repo — just start
# codex inside the repo. Starting it in a git worktree is fine too: worktrees
# resolve to the primary clone's room, so they join the Claude agents there.
# Add SQUAD_DIR here only to pin a room explicitly (it overrides resolution).
[mcp_servers.squad]
command = "node"
args = ["$SRC/dist/index.js"]
env = { SQUAD_PERSONA = "$CODEX_PERSONA" }
# END SQUAD MCP
EOF
  echo "merged [mcp_servers.squad] into $CODEX_TOML (backup: $CODEX_TOML.squad-backup)"
else
  echo "skipped Codex global setup"
fi

# --- global: link the squad CLI onto PATH -----------------------------------
# `npm link` (not pnpm — npm's global-link mechanism is what puts a bin on
# PATH regardless of which package manager built dist/) creates a symlink
# named `squad` (per package.json's "bin") in npm's global bin dir. That's
# one-time-per-machine, like the Codex registration above, so it's gated the
# same way. If it's declined, unavailable, or the global prefix isn't
# writable, we fall back to the equivalent `node <path>/dist/index.js <cmd>`
# form everywhere below — the two are kept in sync via CLI_CMD.
CLI_CMD="node $SRC/dist/index.js"
if [[ $LINK -eq 1 ]] && command -v npm >/dev/null 2>&1; then
  if confirm "Link the squad CLI onto your PATH (npm link, one-time per machine)?"; then
    if (cd "$SRC" && npm link --silent) >/dev/null 2>&1; then
      if command -v squad >/dev/null 2>&1; then
        CLI_CMD="squad"
        echo "linked squad CLI onto PATH ($(command -v squad))"
      else
        echo "npm link succeeded, but npm's global bin dir isn't on PATH yet"
        echo "  run: export PATH=\"\$(npm config get prefix)/bin:\$PATH\"  (or open a new shell)"
        echo "  until then, use: $CLI_CMD <cmd>"
      fi
    else
      echo "npm link failed (no permission to write npm's global prefix?) — using: $CLI_CMD <cmd>"
    fi
  else
    echo "skipped CLI linking — using: $CLI_CMD <cmd>"
  fi
elif [[ $LINK -eq 0 ]]; then
  echo "skipped CLI linking (--no-link) — using: $CLI_CMD <cmd>"
else
  echo "npm not found — using: $CLI_CMD <cmd>"
fi

echo
echo "done. the flow:"
echo "  cd $TARGET"
echo "  terminal 1: claude → /squad:goals <the mission>  then  /squad:join"
echo "  terminal 2: codex  → /squad-join"
echo "  terminal 3: $CLI_CMD tail    # watch the room"
