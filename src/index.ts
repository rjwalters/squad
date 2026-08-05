#!/usr/bin/env node
import { runCli, knownCommand, HELP } from "./cli.js";
import { runMcpServer } from "./mcp.js";

const argv = process.argv.slice(2);

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
  runMcpServer().catch((err) => {
    console.error(`squad: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
