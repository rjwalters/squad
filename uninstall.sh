#!/usr/bin/env bash
# Remove squad from a target repo, and optionally the global Codex wiring.
set -euo pipefail

TARGET="${1:-.}"
TARGET="$(cd "$TARGET" && pwd)"

rm -rf "$TARGET/.claude/commands/squad" "$TARGET/.claude/skills/squad"
echo "removed .claude/commands/squad and .claude/skills/squad"

if [[ -f "$TARGET/.mcp.json" ]]; then
  node - "$TARGET/.mcp.json" <<'EOF'
const fs = require("fs");
const file = process.argv[2];
const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
if (cfg.mcpServers) {
  delete cfg.mcpServers.squad;
  if (Object.keys(cfg.mcpServers).length === 0) delete cfg.mcpServers;
}
if (Object.keys(cfg).length === 0) fs.unlinkSync(file);
else fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
console.log(`removed squad entry from ${file}`);
EOF
fi

strip_block() { # strip_block <file> <begin> <end>
  local file="$1" begin="$2" end="$3"
  [[ -f "$file" ]] || return 0
  grep -qF "$begin" "$file" || return 0
  local tmp
  tmp="$(mktemp)"
  awk -v b="$begin" -v e="$end" '
    index($0, b) { skip = 1 }
    !skip { print }
    index($0, e) { skip = 0 }
  ' "$file" > "$tmp"
  mv "$tmp" "$file"
  echo "removed squad block from $file"
}

strip_block "$TARGET/CLAUDE.md" "<!-- BEGIN SQUAD -->" "<!-- END SQUAD -->"
strip_block "$TARGET/AGENTS.md" "<!-- BEGIN SQUAD -->" "<!-- END SQUAD -->"

# --- opt-in re-entry hook (installed by `install.sh --reentry`) ------------
if [[ -f "$TARGET/.claude/hooks/squad-reentry.sh" ]]; then
  rm -f "$TARGET/.claude/hooks/squad-reentry.sh"
  echo "removed .claude/hooks/squad-reentry.sh"
fi
if [[ -f "$TARGET/.claude/settings.json" ]]; then
  node - "$TARGET/.claude/settings.json" <<'EOF'
const fs = require("fs");
const file = process.argv[2];
const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
const command = "${CLAUDE_PROJECT_DIR}/.claude/hooks/squad-reentry.sh";
if (cfg.hooks?.Stop) {
  cfg.hooks.Stop = cfg.hooks.Stop
    .map((entry) => ({
      ...entry,
      hooks: Array.isArray(entry.hooks) ? entry.hooks.filter((h) => h.command !== command) : entry.hooks,
    }))
    .filter((entry) => !Array.isArray(entry.hooks) || entry.hooks.length > 0);
  if (cfg.hooks.Stop.length === 0) delete cfg.hooks.Stop;
  if (Object.keys(cfg.hooks).length === 0) delete cfg.hooks;
}
if (Object.keys(cfg).length === 0) fs.unlinkSync(file);
else fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
console.log(`removed squad-reentry Stop hook entry from ${file}`);
EOF
fi

reply=""
read -r -p "Also remove global Codex wiring (~/.codex/prompts/squad-*, config.toml block)? [y/N] " reply || true
if [[ "$reply" == "y" || "$reply" == "Y" ]]; then
  rm -f "$HOME"/.codex/prompts/squad-*.md
  strip_block "$HOME/.codex/config.toml" "# BEGIN SQUAD MCP" "# END SQUAD MCP"
  echo "removed Codex prompts and config block"
fi

echo "done. this repo's chat data (if any) remains at $TARGET/.squad — delete with: rm -rf $TARGET/.squad"
