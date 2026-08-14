import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

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
-- Presence leases. One row per *connection* (an MCP server process, a CLI
-- invocation), not per persona: a persona may legitimately be in the room
-- twice (Claude Code + a terminal), and a session-keyed table keeps room for
-- future session-scoped state (read cursors, etc.) without another migration.
-- The members table above stays the persona-level identity ledger (stable
-- first_seen); presence/staleness is derived here.
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  persona TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  left_ts TEXT
);
CREATE INDEX IF NOT EXISTS sessions_persona_live ON sessions (persona, left_ts);
CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  persona TEXT NOT NULL,
  created_ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS divergence_rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER,
  topic TEXT NOT NULL,
  opened_by TEXT NOT NULL,
  opened_ts TEXT NOT NULL,
  expected_participants TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  closed_by TEXT,
  closed_ts TEXT
);
CREATE TABLE IF NOT EXISTS divergence_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL,
  persona TEXT NOT NULL,
  body TEXT NOT NULL,
  submitted_ts TEXT NOT NULL,
  UNIQUE(round_id, persona)
);
CREATE TABLE IF NOT EXISTS science_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  question TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'QUESTION',
  claim_kind TEXT NOT NULL DEFAULT 'empirical',
  origin_method TEXT,
  origin_contributors TEXT NOT NULL DEFAULT '[]',
  changed_assumptions TEXT NOT NULL DEFAULT '[]',
  proposed_mechanism TEXT,
  math_model TEXT,
  standard_prediction TEXT,
  discriminating_prediction TEXT,
  decisive_falsifier TEXT,
  cheapest_test TEXT,
  prior_art_status TEXT,
  confidence REAL,
  novelty REAL,
  attempts TEXT NOT NULL DEFAULT '[]',
  attacks TEXT NOT NULL DEFAULT '[]',
  insights TEXT NOT NULL DEFAULT '[]',
  post_mortems TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  created_ts TEXT NOT NULL,
  updated_ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS science_card_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL,
  from_phase TEXT NOT NULL,
  to_phase TEXT NOT NULL,
  persona TEXT NOT NULL,
  ts TEXT NOT NULL,
  note TEXT
);
CREATE TABLE IF NOT EXISTS science_card_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('derivation', 'formal-check', 'simulation', 'experiment', 'literature', 'observation')),
  provenance TEXT NOT NULL,
  body TEXT,
  persona TEXT NOT NULL,
  ts TEXT NOT NULL
);
`;

/** True when `<dir>/.git` is a pointer file, i.e. dir is a linked worktree. */
function isWorktreePointer(dir: string): boolean {
  try {
    return statSync(join(dir, ".git")).isFile();
  } catch {
    return false;
  }
}

/**
 * The primary clone's working tree for a linked worktree at `dir`, or null when
 * it cannot be determined (git missing from PATH, git failure, a submodule, a
 * bare repo). `--git-common-dir` is shared by every worktree of a repo, so its
 * parent is the primary clone's root — that keeps all worktrees in one room.
 */
export function mainWorktreeRoot(dir: string): string | null {
  let commonDir: string;
  try {
    commonDir = execFileSync(
      "git",
      ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return null; // no git on PATH, or not a repo — caller falls back
  }
  // A submodule's common dir is <super>/.git/modules/<name> and a bare repo's
  // is the repo itself; neither has a working tree at dirname(), so require the
  // conventional <root>/.git shape before trusting it.
  if (!commonDir || basename(commonDir) !== ".git") return null;
  const root = dirname(commonDir);
  return existsSync(root) ? root : null;
}

/** Nearest ancestor (including start) that looks like a repo root. */
export function findRepoRoot(start: string): string | null {
  let dir = start;
  for (;;) {
    // An explicit .squad always marks the root — a worktree that wants its own
    // room can opt in by creating one.
    if (existsSync(join(dir, ".squad"))) return dir;
    if (existsSync(join(dir, ".git"))) {
      // In a linked worktree .git is a file pointing at the primary clone's
      // git dir. Resolve back to that clone so every worktree of a repo shares
      // one room instead of silently splitting into private, empty ones.
      if (isWorktreePointer(dir)) return mainWorktreeRoot(dir) ?? dir;
      return dir;
    }
    if (existsSync(join(dir, ".mcp.json"))) return dir;
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
 *     is global — start it inside the repo and it finds the room). A linked
 *     git worktree resolves to the primary clone's root, so every worktree of
 *     a repo shares one room.
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

/**
 * Defense in depth for the split-brain the worktree resolution above prevents:
 * if we still land in an empty room while cwd is inside a linked worktree whose
 * primary clone has a populated room, say so instead of joining in silence.
 * Reachable when the worktree carries its own .squad, or when git is missing
 * from PATH and the walk fell back to the worktree root.
 */
export function roomSplitWarning(dir: string, cwd: string): string | null {
  if (existsSync(join(dir, "squad.db"))) return null; // room already in use
  let wt: string | null = null;
  for (let d = cwd; ; ) {
    if (isWorktreePointer(d)) {
      wt = d;
      break;
    }
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  if (!wt) return null;
  const main = mainWorktreeRoot(wt);
  if (!main) return null;
  const mainRoom = join(main, ".squad");
  if (mainRoom === dir) return null;
  if (!existsSync(join(mainRoom, "squad.db"))) return null;
  return (
    `squad: joining an empty room at ${dir} from the git worktree ${wt}, ` +
    `but the primary clone already has a room at ${mainRoom}. ` +
    `Set SQUAD_DIR=${mainRoom} to join it.`
  );
}

let warnedRoomSplit = false;

export function openDb(): DatabaseSync {
  if (!warnedRoomSplit) {
    warnedRoomSplit = true;
    // stderr only: stdout is the MCP stdio transport.
    const warning = roomSplitWarning(squadDir(), process.cwd());
    if (warning) console.error(warning);
  }
  mkdirSync(squadDir(), { recursive: true });
  const db = new DatabaseSync(dbPath());
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  return db;
}
