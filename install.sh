#!/usr/bin/env bash
# Install squad into a target repo (Claude Code side) and, with consent,
# wire up Codex globally (~/.codex). Safe to re-run; marker-bounded edits
# are replaced in place.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="."
YES=0
CODEX=1
CLAUDE_PERSONA="${SQUAD_CLAUDE_PERSONA:-claude}"
CODEX_PERSONA="${SQUAD_CODEX_PERSONA:-codex}"

usage() {
  cat <<EOF
usage: ./install.sh [options] [target-repo]

Installs into the target repo (default .):
  .mcp.json                        squad MCP server entry (merged, persona "$CLAUDE_PERSONA")
  .claude/commands/squad/*.md      /squad:join, /squad:goals, /squad:clear
  .claude/skills/squad/SKILL.md    conventions + tool reference
  CLAUDE.md / AGENTS.md            marker-bounded pointer blocks

Global, with confirmation (skip with --no-codex):
  ~/.codex/prompts/squad-*.md      Codex slash-command prompts
  ~/.codex/config.toml             [mcp_servers.squad] entry (persona "$CODEX_PERSONA")

options:
  -y            non-interactive; assumes yes (including the Codex global writes
                unless --no-codex is passed)
  --no-codex    skip all writes outside the target repo
  -h, --help    show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -y) YES=1 ;;
    --no-codex) CODEX=0 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown option: $1" >&2; usage; exit 1 ;;
    *) TARGET="$1" ;;
  esac
  shift
done

TARGET="$(cd "$TARGET" && pwd)"
echo "squad source: $SRC"
echo "install target: $TARGET"

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

# --- target repo: .mcp.json merge ------------------------------------------
node - "$TARGET/.mcp.json" "$SRC/dist/index.js" "$CLAUDE_PERSONA" <<'EOF'
const fs = require("fs");
const [file, serverPath, persona] = process.argv.slice(2);
let cfg = {};
if (fs.existsSync(file)) cfg = JSON.parse(fs.readFileSync(file, "utf8"));
cfg.mcpServers ??= {};
cfg.mcpServers.squad = {
  command: "node",
  args: [serverPath],
  env: { SQUAD_PERSONA: persona },
};
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
console.log(`merged squad server into ${file}`);
EOF

# --- target repo: CLAUDE.md + AGENTS.md blocks -----------------------------
read -r -d '' BLOCK <<EOF || true
This repository has [squad](https://github.com/rjwalters/squad) installed — a
local cross-agent chat room (with a shared goal board) that lets Claude and
Codex collaborate on this machine. Use the \`squad_*\` MCP tools; conventions
live in \`.claude/skills/squad/SKILL.md\`. Commands: \`/squad:join\` to enter
the room, \`/squad:goals\` to view or add shared goals, \`/squad:clear\` to
reset. A quick \`squad_check\` (with \`peek: true\`) at the start of a session
shows whether another agent left you a message.
EOF
write_block "$TARGET/CLAUDE.md" "$BLOCK"
write_block "$TARGET/AGENTS.md" "$BLOCK"
echo "wrote marker blocks in CLAUDE.md and AGENTS.md"

# --- global: Codex ----------------------------------------------------------
if [[ $CODEX -eq 1 ]] && confirm "Wire up Codex globally (~/.codex/prompts + config.toml)?"; then
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

echo
echo "done. try it:"
echo "  terminal 1 (this repo): claude   → /squad:join"
echo "  terminal 2 (any repo):  codex    → /squad-join   (prompt name may render as squad-join)"
echo "  terminal 3 (human):     node $SRC/dist/index.js tail"
