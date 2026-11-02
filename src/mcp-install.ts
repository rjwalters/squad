import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface McpInstallEntry {
  /** Where the configured runtime was found, for the report. */
  source: string;
  /** Absolute path of the configured `dist/index.js`. */
  runtime: string;
}

export interface McpInstallCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** Packages mcp.ts imports at startup; a configured install must resolve all of them. */
export const RUNTIME_PACKAGES = ["@modelcontextprotocol/sdk", "zod"];

/** Project `.mcp.json` SQUAD_RUNTIME and the Codex `[mcp_servers.squad]` entry. */
export function configuredEntries(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): McpInstallEntry[] {
  const entries: McpInstallEntry[] = [];
  const mcpPath = join(cwd, ".mcp.json");
  if (existsSync(mcpPath)) {
    try {
      const runtime = JSON.parse(readFileSync(mcpPath, "utf8"))?.mcpServers?.squad?.env?.SQUAD_RUNTIME;
      if (typeof runtime === "string" && runtime)
        entries.push({ source: mcpPath, runtime: resolve(dirname(mcpPath), runtime) });
    } catch {
      /* unparseable config is not this check's finding */
    }
  }
  const codexPath = join(env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
  if (existsSync(codexPath)) {
    const section = readFileSync(codexPath, "utf8").match(/^\[mcp_servers\.squad\]\s*\n((?:(?!\[).*\n?)*)/m);
    const arg = section?.[1]?.match(/^args\s*=\s*\[\s*"((?:[^"\\]|\\.)*)"/m)?.[1];
    if (arg) {
      const runtime = JSON.parse(`"${arg}"`) as string;
      if (isAbsolute(runtime)) entries.push({ source: codexPath, runtime });
    }
  }
  return entries;
}

/** Same walk-up Node does for a bare specifier from a module in `dir`. */
function resolvesPackage(dir: string, pkg: string): boolean {
  for (let d = dir; ; ) {
    if (existsSync(join(d, "node_modules", pkg, "package.json"))) return true;
    const parent = dirname(d);
    if (parent === d) return false;
    d = parent;
  }
}

/**
 * Check what the configured MCP entries point at (#168): the path must exist
 * and resolve its dependencies, and pointing at a git clone is a warning
 * because a cleanup or checkout there breaks every agent using it.
 */
export function checkMcpInstall(entries: McpInstallEntry[]): McpInstallCheck {
  const name = "mcp-install";
  if (entries.length === 0)
    return { name, ok: true, detail: "no configured squad MCP entry found (.mcp.json SQUAD_RUNTIME, Codex config.toml)" };
  const problems: string[] = [];
  const warnings: string[] = [];
  for (const { source, runtime } of entries) {
    if (!existsSync(runtime)) {
      problems.push(`${source}: runtime ${runtime} does not exist`);
      continue;
    }
    const missing = RUNTIME_PACKAGES.filter((p) => !resolvesPackage(dirname(runtime), p));
    if (missing.length)
      problems.push(`${source}: runtime ${runtime} cannot resolve ${missing.join(", ")} -- reinstall that squad install`);
    if (existsSync(join(dirname(dirname(runtime)), ".git")))
      warnings.push(
        `${source}: runtime ${runtime} is a development clone; a cleanup or checkout there breaks every agent -- ` +
          `use scripts/release-install.sh and reinstall from its 'current' path`,
      );
  }
  if (problems.length) return { name, ok: false, detail: problems.join("; ") };
  const ok = `${entries.length} configured entr${entries.length === 1 ? "y" : "ies"} resolve`;
  return { name, ok: true, detail: warnings.length ? `warning: ${warnings.join("; ")}` : ok };
}
