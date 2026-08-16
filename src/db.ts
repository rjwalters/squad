import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * Bumped whenever a table is added to (or removed from) SCHEMA / ROOM_TABLES
 * below. Stamped into every db via `PRAGMA user_version` in openDb(), and
 * checked by `Squad.importRoom()` (src/core.ts) to refuse importing an
 * export produced by an incompatible squad build rather than silently
 * merging or corrupting state. The migration strategy for *this* build's own
 * schema stays the existing idempotent `CREATE TABLE IF NOT EXISTS` below --
 * this version number exists purely as an export/import compatibility
 * check, not a migration-ordering mechanism.
 */
export const SCHEMA_VERSION = 1;

/**
 * Parses an env var as a non-negative minute count, falling back to
 * `fallback` when the var is unset, empty, negative, or not a finite
 * number. Shared by presence timing (`staleMinutes()`/`idleMinutes()` in
 * src/core.ts) and the reentry-hook TTL (`SQUAD_REENTRY_TTL_MINUTES` in
 * src/reentry-hook.ts) so the two domains don't reimplement the same
 * parsing rule.
 */
export function envMinutes(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Every room table -- the complete unit of state `Squad.clear()`,
 * `Squad.exportRoom()`, and `Squad.importRoom()` (src/core.ts) all operate
 * over. Single source of truth so those three never drift out of sync with
 * each other or with SCHEMA below. Order is insignificant: no table here
 * declares a SQL `FOREIGN KEY`, so neither DELETE nor INSERT ordering
 * matters.
 */
export const ROOM_TABLES = [
  "messages",
  "goals",
  "claims",
  "cursors",
  "session_cursors",
  "members",
  "sessions",
  "divergence_rounds",
  "divergence_submissions",
  "review_requests",
  "science_cards",
  "science_card_transitions",
  "science_card_evidence",
] as const;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'chat',
  body TEXT NOT NULL,
  ts TEXT NOT NULL
);
-- The persona's durable read high-water mark. No longer the cursor check()
-- reads (session_cursors below is, since #41), but still written on every
-- cursor advance and never pruned: session rows and their cursors are swept
-- after SESSION_RETENTION_HOURS, so this is what a persona returning after a
-- long quiet period seeds its new session from instead of replaying the whole
-- room as unread. It also carries a pre-#41 room forward unchanged.
CREATE TABLE IF NOT EXISTS cursors (
  persona TEXT PRIMARY KEY,
  last_seen_id INTEGER NOT NULL DEFAULT 0
);
-- Session-scoped read cursors (#41). Keyed by session_id (matching the
-- sessions table's key shape) rather than persona, so two live sessions of
-- one persona — e.g. an MCP connection and a CLI invocation — each track
-- their own unread state instead of silently stealing each other's cursor.
-- A brand-new session's cursor is seeded (once, on first read) from the
-- persona's most-advanced other session, or from the persona high-water mark
-- in the cursors table above, rather than starting at 0 — so the common
-- single-session-at-a-time case keeps today's steady-state UX.
CREATE TABLE IF NOT EXISTS session_cursors (
  session_id TEXT PRIMARY KEY,
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
-- Directed review requests: one persona asking a *specific* peer to look at
-- something, with an explicit state machine (pending -> claimed -> resolved,
-- and pending|claimed -> cancelled) instead of an undifferentiated prose
-- message. expires_ts is enforced lazily at read time (like presence
-- staleness) — nothing here is ever mutated by the clock.
CREATE TABLE IF NOT EXISTS review_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  body TEXT NOT NULL,
  refs TEXT NOT NULL DEFAULT '[]',
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'pending',
  created_ts TEXT NOT NULL,
  expires_ts TEXT,
  claimed_by TEXT,
  claimed_ts TEXT,
  resolved_by TEXT,
  resolved_ts TEXT,
  resolution TEXT,
  cancelled_by TEXT,
  cancelled_ts TEXT,
  cancel_reason TEXT
);
CREATE INDEX IF NOT EXISTS review_requests_target_status ON review_requests (target, status);
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
  // Every open of a db by the current build stamps it current: SCHEMA's
  // migration strategy is additive-only (CREATE TABLE IF NOT EXISTS above),
  // so once this build has opened a db it *is* SCHEMA_VERSION, regardless of
  // what it was stamped as before. This pragma exists for export/import
  // compatibility checks (Squad.importRoom(), src/core.ts), not to gate
  // opening a db directly.
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return db;
}
