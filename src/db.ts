import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'chat',
  body TEXT NOT NULL,
  ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cursors (
  persona TEXT PRIMARY KEY,
  last_seen_id INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_by TEXT NOT NULL,
  created_ts TEXT NOT NULL,
  done_by TEXT,
  done_ts TEXT
);
CREATE TABLE IF NOT EXISTS members (
  persona TEXT PRIMARY KEY,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
`;

/** Nearest ancestor (including start) that looks like a repo root. */
export function findRepoRoot(start: string): string | null {
  let dir = start;
  for (;;) {
    if (
      existsSync(join(dir, ".squad")) ||
      existsSync(join(dir, ".git")) ||
      existsSync(join(dir, ".mcp.json"))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The room is per-repo. Resolution order:
 *  1. SQUAD_DIR env (the installer bakes the repo's .squad path into .mcp.json,
 *     so Claude Code always lands in the right room regardless of cwd)
 *  2. <repo-root>/.squad, walking up from cwd (covers Codex, whose MCP config
 *     is global — start it inside the repo and it finds the room)
 *  3. ~/.squad as a machine-global fallback when run outside any repo
 */
export function squadDir(): string {
  if (process.env.SQUAD_DIR) return process.env.SQUAD_DIR;
  const root = findRepoRoot(process.cwd());
  return root ? join(root, ".squad") : join(homedir(), ".squad");
}

export function dbPath(): string {
  return join(squadDir(), "squad.db");
}

export function openDb(): DatabaseSync {
  mkdirSync(squadDir(), { recursive: true });
  const db = new DatabaseSync(dbPath());
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  return db;
}
