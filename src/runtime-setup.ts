import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { findRepoRoot, squadDir } from "./db.js";

/** What one runtime has wired up for a repo. `null` means unknown (unreadable or malformed). */
export interface RuntimeSetup {
  tools: boolean | null;
  notice: boolean | null;
}

export interface RepoRuntimeSetup {
  repo: string;
  claude: RuntimeSetup;
  codex: RuntimeSetup;
}

const HOOK_SCRIPTS = ["squad-inbox.sh", "squad-reentry.sh"];

/** Read and parse a JSON file: undefined when absent, null when unreadable or malformed. */
function readJson(path: string): Record<string, any> | null | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

function claudeSetup(repo: string): RuntimeSetup {
  const mcp = readJson(join(repo, ".mcp.json"));
  const tools = mcp === null ? null : Boolean(mcp?.mcpServers?.squad);
  const settings = readJson(join(repo, ".claude", "settings.json"));
  let notice: boolean | null;
  if (settings === null) notice = null;
  else if (settings === undefined) notice = false;
  else {
    const hooks = settings.hooks;
    notice =
      hooks && typeof hooks === "object"
        ? HOOK_SCRIPTS.some((s) => JSON.stringify(hooks).includes(s))
        : false;
  }
  return { tools, notice };
}

function codexSetup(): RuntimeSetup {
  const path = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
  // Codex has no mid-turn hook event, so it never gets a new-message notice.
  if (!existsSync(path)) return { tools: false, notice: false };
  try {
    const tools = /^\s*\[\s*mcp_servers\s*\.\s*"?squad"?\s*\]/m.test(readFileSync(path, "utf8"));
    return { tools, notice: false };
  } catch {
    return { tools: null, notice: false };
  }
}

/** The repo a room belongs to: the parent of `.squad`, else the repo around the cwd. */
export function roomRepo(): string | null {
  const dir = squadDir();
  if (basename(dir) === ".squad") return dirname(dir);
  return findRepoRoot(process.cwd());
}

/** Per-runtime setup for the current room's repo. Read-only file checks. */
export function detectRuntimeSetup(repo: string | null = roomRepo()): RepoRuntimeSetup | null {
  if (!repo) return null;
  return { repo, claude: claudeSetup(repo), codex: codexSetup() };
}

/** What Claude Code is missing in this repo (empty when complete or unknown). */
export function claudeGaps(setup: RepoRuntimeSetup): string[] {
  const gaps: string[] = [];
  if (setup.claude.tools === false) gaps.push("squad tools (no squad entry in .mcp.json)");
  if (setup.claude.notice === false) gaps.push("a new-message notice (no inbox/reentry hook in .claude/settings.json)");
  return gaps;
}

export function installFix(repo: string): string {
  return `install.sh --inbox ${repo}`;
}

/**
 * One stderr line when an agent harness is driving the CLI in a room whose repo
 * cannot deliver replies to Claude Code; null when complete, unknown or no harness.
 */
export function replyGapWarning(markers: string[], setup: RepoRuntimeSetup | null = detectRuntimeSetup()): string | null {
  if (!setup || !markers.some((k) => process.env[k])) return null;
  const gaps = claudeGaps(setup);
  if (gaps.length === 0) return null;
  return `squad: Claude Code in this repo is missing ${gaps.join(" and ")}, so replies may go unseen -- run '${installFix(setup.repo)}'\n`;
}

/** Informational doctor lines for this room's repo. */
export function runtimeSetupLines(setup: RepoRuntimeSetup | null = detectRuntimeSetup()): string[] {
  if (!setup) return ["[info] runtime setup: no repo found for this room; skipped"];
  const yn = (v: boolean | null) => (v === null ? "unknown" : v ? "yes" : "no");
  const claudeGap = claudeGaps(setup);
  const lines = [
    `[info] claude code: tools ${yn(setup.claude.tools)} (.mcp.json), notice ${yn(setup.claude.notice)} (inbox/reentry hook)` +
      (claudeGap.length ? ` -- fix: ${installFix(setup.repo)}` : ""),
    `[info] codex: tools ${yn(setup.codex.tools)} (~/.codex/config.toml), notice none, by design` +
      (setup.codex.tools === false ? " -- fix: install.sh (without --no-codex)" : ""),
  ];
  return lines;
}
