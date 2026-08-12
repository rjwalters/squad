#!/usr/bin/env node
import { runCli, knownCommand, HELP } from "./cli.js";

const argv = process.argv.slice(2);

/**
 * mcp.js is imported lazily (and only here) because it is the only module
 * that reaches into node_modules (@modelcontextprotocol/sdk, zod) — every
 * CLI command, including `squad doctor`, is built on db.js/core.js, which
 * use nothing but Node built-ins. That split means a missing/broken
 * node_modules only ever breaks MCP-server startup, never the CLI: a human
 * or agent can still run `squad doctor` (or even a bare `squad`) to find out
 * what's wrong instead of the whole binary refusing to load.
 */
async function startMcpServer(): Promise<void> {
  let runMcpServer: () => Promise<void>;
  try {
    ({ runMcpServer } = await import("./mcp.js"));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`squad: MCP server failed to start — runtime dependencies are not installed`);
    console.error(`squad:   ${detail}`);
    console.error(
      `squad: run 'pnpm install' (or 'npm install') in the squad source clone, then restart the host`,
    );
    console.error(`squad: run 'squad doctor' for a full diagnostic`);
    await leaveStartupFailureBreadcrumb(detail);
    process.exit(1);
    return;
  }
  await runMcpServer().catch((err) => {
    console.error(`squad: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}

/**
 * The failure above is otherwise silent to every other agent in the room:
 * this persona just never shows up with squad_* tools, and nothing
 * distinguishes "no room configured here" from "the room is broken". Leave a
 * system message any teammate already joined will see on their next check —
 * using only db.js/core.js, which (like this function) have no dependency on
 * the package that just failed to resolve. Best-effort: if the DB itself is
 * unreachable too, there is nothing more we can do from here.
 */
async function leaveStartupFailureBreadcrumb(detail: string): Promise<void> {
  try {
    const { openDb, dbPath } = await import("./db.js");
    const { Squad } = await import("./core.js");
    const persona = process.env.SQUAD_PERSONA ?? "agent";
    const squad = new Squad(openDb(), persona);
    squad.send(
      `${persona}'s squad MCP server failed to start on this host: runtime dependencies are ` +
        `missing (${detail}). This persona has no squad_* tools until 'pnpm install' is run ` +
        `and the host is restarted.`,
      "system",
    );
    console.error(`squad: left a diagnostic message in the room (${dbPath()})`);
  } catch {
    // DB unreachable too (e.g. node:sqlite itself broken) — nothing more we
    // can do; the stderr diagnostics above are all that's left.
  }
}

if (knownCommand(argv[0])) {
  runCli(argv).catch((err) => {
    console.error(`squad: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
} else if (argv.length > 0) {
  runCli(argv).catch(() => process.exit(1)); // unknown command → help + exit 1
} else if (process.stdin.isTTY) {
  // A bare `squad` on an interactive terminal is a human asking for help,
  // not an MCP host connecting over pipes.
  process.stdout.write(HELP);
} else {
  startMcpServer();
}
