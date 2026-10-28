import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Read-only answer to "can each runtime in this repo actually hear the room?"
 * (#204). A room can exist without the repo ever running install.sh -- Codex's
 * global MCP registration creates one in whatever repo it starts in -- and
 * then a Claude Code session there has no squad tools and no inbox notice,
 * yet every send still succeeds. Nothing here writes, joins, or renews
 * presence; it only looks at the files install.sh would have written.
 */
export interface RuntimeWiring {
  runtime: "claude" | "codex";
  /** squad_* MCP tools are configured for sessions started in this repo. */
  tools: boolean;
  /** How a waiting message reaches a running session. */
  notice: "hook" | "none" | "pull-only";
  detail: string;
  /** Exact command that closes the gap, when there is one. */
  fix?: string;
}

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

function hasSquadMcpEntry(path: string): boolean {
  const text = readText(path);
  if (!text) return false;
  try {
    const servers = (JSON.parse(text) as { mcpServers?: Record<string, unknown> }).mcpServers;
    return !!servers && Object.hasOwn(servers, "squad");
  } catch {
    return false;
  }
}

/**
 * A line scan rather than a TOML parse: the CLI must keep running with no
 * node_modules (see checkDeps in cli.ts), and install.sh writes the plain
 * `[mcp_servers.squad]` table this matches.
 */
function hasCodexSquadServer(path: string): boolean {
  const text = readText(path);
  return !!text && /^\s*\[\s*mcp_servers\s*\.\s*(?:squad|"squad")\s*\]/m.test(text);
}

/** The install command for this squad checkout, quoted for a shell. */
export function installCommand(repo: string, flags = "--inbox"): string {
  const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  return `SQUAD_CLAUDE_PERSONA=<name> bash '${join(source, "install.sh")}' ${flags} '${repo}'`;
}

/** The repository a room belongs to: the parent of its `.squad` directory. */
export function roomRepo(roomDir: string): string {
  return dirname(resolve(roomDir));
}

export function inspectRuntimeWiring(
  repo: string,
  codexHome: string = process.env.CODEX_HOME || join(homedir(), ".codex"),
): RuntimeWiring[] {
  const claudeTools = hasSquadMcpEntry(join(repo, ".mcp.json"));
  const settings = ["settings.json", "settings.local.json"]
    .map((name) => readText(join(repo, ".claude", name)) ?? "")
    .join("\n");
  const claudeHook = /squad-(?:inbox|reentry)\.sh/.test(settings);
  const claude: RuntimeWiring = claudeTools
    ? claudeHook
      ? { runtime: "claude", tools: true, notice: "hook", detail: ".mcp.json squad entry and an inbox/reentry hook" }
      : {
          runtime: "claude",
          tools: true,
          notice: "none",
          detail: "squad tools configured, but no inbox/reentry hook: waiting messages appear only when the session checks",
          fix: installCommand(repo),
        }
    : {
        runtime: "claude",
        tools: false,
        notice: claudeHook ? "hook" : "none",
        detail: "no squad entry in .mcp.json: Claude Code sessions here get no squad tools and are never told about messages",
        fix: installCommand(repo),
      };
  const codexGlobal = hasCodexSquadServer(join(codexHome, "config.toml"));
  const codexLocal = hasCodexSquadServer(join(repo, ".codex", "config.toml"));
  const codex: RuntimeWiring =
    codexGlobal || codexLocal
      ? {
          runtime: "codex",
          tools: true,
          notice: "pull-only",
          detail:
            `squad tools via ${codexLocal ? "repo .codex/config.toml" : `global ${join(codexHome, "config.toml")}`}; ` +
            "Codex has no mid-turn notice, so it sees messages when it checks (or via 'squad codex-reentry' / 'squad waker')",
        }
      : {
          runtime: "codex",
          tools: false,
          notice: "pull-only",
          detail: "no squad MCP server in the Codex config: Codex sessions here get no squad tools",
          fix: installCommand(repo, "-y"),
        };
  return [claude, codex];
}

/** Env markers that show a Claude Code session is driving this CLI. */
const CLAUDE_HARNESS_MARKERS = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"];

/**
 * One stderr line for `squad send` / `squad read` run by a Claude Code
 * session whose repo cannot deliver replies to it. Null when the session is
 * not Claude's, the room does not exist, or the wiring is complete.
 */
export function unwiredHarnessWarning(
  roomDir: string,
  env: NodeJS.ProcessEnv = process.env,
  codexHome?: string,
): string | null {
  if (!CLAUDE_HARNESS_MARKERS.some((k) => env[k])) return null;
  if (!existsSync(join(roomDir, "squad.db"))) return null;
  const repo = roomRepo(roomDir);
  const claude = inspectRuntimeWiring(repo, codexHome).find((w) => w.runtime === "claude")!;
  if (claude.tools && claude.notice === "hook") return null;
  return (
    `squad: warning -- ${claude.detail}. ` +
    "Replies to you will sit unread until you run 'squad read --unread'. " +
    `Fix: ${claude.fix}\n`
  );
}
