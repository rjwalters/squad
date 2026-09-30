import { adoptNodes } from "./nodes.js";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Bumped whenever a table is added to (or removed from) ROOM_TABLES
 * below, *or* an existing ROOM_TABLES table's column shape changes (e.g. a
 * new column via an `ensure*Column()` migration in openDb()) -- either kind
 * of change can make `Squad.importRoom()`'s `INSERT INTO t SELECT * FROM t2`
 * fail (a positional insert requires matching column counts) or silently
 * misalign columns. Stamped into every db via `PRAGMA user_version` in
 * openDb(), and checked by `Squad.importRoom()` (src/core.ts) to refuse
 * importing an export produced by an incompatible squad build with a clear
 * error rather than a raw SQLite error or silently corrupting state. The
 * migration strategy for *this* build's own schema stays the existing
 * idempotent `CREATE TABLE IF NOT EXISTS` (new tables) plus targeted
 * `ALTER TABLE ADD COLUMN` migrations (new columns on an existing table)
 * below -- this version number exists purely as an export/import
 * compatibility check, not a migration-ordering mechanism.
 *
 * A SCHEMA table deliberately kept *out* of ROOM_TABLES (relay_cursors, #112)
 * is invisible to clear()/exportRoom()/importRoom() and therefore does not
 * move this number: bumping it for such a table would reject every previously
 * produced export for no compatibility gain.
 */
export const SCHEMA_VERSION = 9;

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
 *
 * Not every SCHEMA table belongs here: `relay_cursors` (#112) records what
 * *this host* has already shipped to a remote OTLP endpoint, which is a
 * property of the delivery channel rather than of the room, so it is
 * deliberately excluded -- a `squad clear` or a room import must not silently
 * rewind (or fast-forward) an outbox cursor.
 */
export const ROOM_TABLES = [
  "steward_reminders",
  "outline_publications",
  "node_review_requests",
  "node_reviews",
  "node_review_builds",
  "node_metadata",
  "node_revisions",
  "node_integrations",
  "integration_configs",
  "integration_attempts",
  "integration_events",
  "integration_runners",
  "agent_identities",
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
CREATE TABLE IF NOT EXISTS steward_reminders (
  condition_key TEXT PRIMARY KEY,
  condition TEXT NOT NULL,
  object_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  sends INTEGER NOT NULL,
  last_sent_ms INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  actor TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outline_publications (
  request_key TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  version TEXT NOT NULL,
  content TEXT NOT NULL,
  config_revision INTEGER NOT NULL,
  base_commit TEXT NOT NULL,
  expected_blob TEXT,
  source_commit TEXT NOT NULL,
  attempt_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS node_review_requests (
  request_id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL,
  revision INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS node_review_builds (
  review_id TEXT PRIMARY KEY,
  build_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS node_reviews (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  request_id INTEGER NOT NULL,
  card_id INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  lease_expires INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS node_metadata (
  card_id INTEGER PRIMARY KEY,
  dependencies_json TEXT NOT NULL,
  artifacts_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS node_revisions (
  card_id INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  actor TEXT,
  session_id TEXT,
  ts TEXT NOT NULL,
  origin TEXT NOT NULL,
  PRIMARY KEY(card_id, revision)
);
CREATE TABLE IF NOT EXISTS node_integrations (
  card_id INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  attempt_id TEXT NOT NULL,
  PRIMARY KEY(card_id, attempt_id)
);

CREATE TABLE IF NOT EXISTS integration_attempts (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  submission_json TEXT NOT NULL,
  config_revision INTEGER NOT NULL,
  config_json TEXT NOT NULL,
  submitted_by TEXT NOT NULL,
  created_ts TEXT NOT NULL,
  updated_ts TEXT NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'failed', 'verified'))
);
CREATE TABLE IF NOT EXISTS integration_events (
  attempt_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  ts TEXT NOT NULL,
  event_json TEXT NOT NULL,
  PRIMARY KEY (attempt_id, sequence)
);
CREATE TABLE IF NOT EXISTS integration_runners (
  attempt_id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  run_id TEXT NOT NULL,
  expires_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS integration_configs (
  revision INTEGER PRIMARY KEY AUTOINCREMENT,
  config_json TEXT,
  updated_by TEXT NOT NULL,
  updated_ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_identities (
  identity_id TEXT PRIMARY KEY,
  persona TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'chat',
  body TEXT NOT NULL,
  ts TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 1
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
-- Relay delivery bookkeeping (#112): the outbox high-water mark per remote
-- OTLP target, plus that target's shipping lease. Deliberately NOT in
-- ROOM_TABLES above -- this is local delivery state about *this* host's
-- conversation with *this* endpoint, not room content, so clear()/export/
-- import leave it alone (and SCHEMA_VERSION, which exists solely as an
-- export/import compatibility check over ROOM_TABLES, does not move: neither
-- importRoom()'s positional INSERT ... SELECT nor its missing-table check
-- ever looks at a table outside that set).
--
-- target is the endpoint's scheme://host/path with any query string and
-- userinfo stripped (relayTarget(), src/relay.ts), so a credential passed as
-- a URL parameter can never be persisted here. lease_expires is epoch ms,
-- 0 when free, and is acquired/renewed by the same atomic
-- "UPDATE ... WHERE lease_expires <= ?" shape node_reviews uses (src/core.ts)
-- so two concurrent relays cannot ship the same batch.
--
-- last_error / last_error_at (#113) hold the most recent failed pass's reason
-- for 'squad relay status', cleared by the next pass that reaches the end of
-- the outbox. The reason quotes relayTarget(), never the raw endpoint or any
-- header, so this is no more sensitive than target itself.
CREATE TABLE IF NOT EXISTS relay_cursors (
  target TEXT PRIMARY KEY,
  last_message_id INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  lease_expires INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_error_at TEXT
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
 * Nearest ancestor (including `start`) holding a `.git` entry, i.e. the root of
 * the working tree that literally contains `start`. Deliberately *not*
 * findRepoRoot(): that one also stops at `.squad`/`.mcp.json` markers (right
 * for choosing a room) and resolves a linked worktree back to its primary clone
 * (right for sharing a room). Here we want the checkout whose `git status` a
 * stray room would dirty, which is a strictly git question.
 */
function findGitRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The *common* git directory for the working tree rooted at `root`:
 * `<root>/.git` for a normal clone, and for a linked worktree the primary
 * clone's `.git`, resolved through the pointer file's `commondir` (no git
 * subprocess, so this still works when git is missing from PATH). `info/` lives
 * in the common dir, so `info/exclude` is shared by every worktree of a repo.
 */
function gitCommonDir(root: string): string | null {
  const dotGit = join(root, ".git");
  let st;
  try {
    st = statSync(dotGit);
  } catch {
    return null;
  }
  if (st.isDirectory()) return dotGit;
  if (!st.isFile()) return null;
  let pointer: string;
  try {
    pointer = readFileSync(dotGit, "utf8");
  } catch {
    return null;
  }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(pointer);
  if (!match) return null;
  const gitDir = resolve(root, match[1]);
  try {
    const common = readFileSync(join(gitDir, "commondir"), "utf8").trim();
    if (common) return resolve(gitDir, common);
  } catch {
    // No commondir file: gitDir is itself the common dir (a relocated .git).
  }
  return existsSync(gitDir) ? gitDir : null;
}

/** Every literal spelling of an ignore line that already covers `rel`. */
function ignoreVariants(rel: string): string[] {
  return [rel, `${rel}/`, `/${rel}`, `/${rel}/`];
}

/** True when `path` already contains one of `variants` as a whole line. */
function hasIgnoreLine(path: string, variants: string[]): boolean {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  return text.split(/\r?\n/).some((line) => variants.includes(line.trim()));
}

/** True when git already ignores `path` (broader pattern, global excludes, …). */
function gitIgnores(root: string, path: string): boolean {
  try {
    execFileSync("git", ["-C", root, "check-ignore", "-q", "--", path], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true; // exit 0: ignored
  } catch {
    return false; // exit 1 (not ignored) or git unavailable — assume not
  }
}

const IGNORE_NOTE =
  "# squad: local room state (SQLite db + WAL sidecars), never committed";

/**
 * Keep the room out of the enclosing repo's `git status`.
 *
 * The room is created lazily by openDb(), so any checkout that reached
 * squadDir() without a fresh `install.sh` run (an install predating the
 * installer's own `.gitignore` step, a partial install, a plain `npx squad`)
 * ended up with an untracked, non-ignored `.squad/` — #111. This closes that
 * gap at the one place the directory is actually created, which also means it
 * self-heals an already-affected checkout on the next run.
 *
 * `.git/info/exclude` rather than `.gitignore`: it is local-only, never needs a
 * commit, and cannot surprise a repo by mutating a tracked file — the right
 * trade for an unattended runtime write. The installer's `.gitignore` step is
 * unchanged and still preferred for a repo that wants the ignore shared with
 * the team; this only ever *adds* a line, and only when nothing already covers
 * the room.
 *
 * Returns the exclude file written, or null when nothing needed writing.
 * Never throws: a read-only or exotic checkout must not block opening a room.
 */
export function ensureRoomIgnored(roomDir: string): string | null {
  try {
    const room = resolve(roomDir);
    const root = findGitRoot(dirname(room));
    if (!root) return null; // not inside a working tree (~/.squad, /tmp, …)
    const rel = relative(root, room).split(sep).join("/");
    if (!rel || rel === "." || rel.startsWith("../") || isAbsolute(rel)) return null;
    const common = gitCommonDir(root);
    if (!common) return null;
    const exclude = join(common, "info", "exclude");
    const variants = ignoreVariants(rel);
    // Cheap textual checks first, so the steady state costs two small reads.
    if (hasIgnoreLine(join(root, ".gitignore"), variants)) return null;
    if (hasIgnoreLine(exclude, variants)) return null;
    // Then the authoritative one, which also catches broader patterns, nested
    // .gitignore files and a global core.excludesFile.
    if (gitIgnores(root, room)) return null;
    const entry = rel.includes("/") ? `/${rel}/` : `${rel}/`;
    mkdirSync(dirname(exclude), { recursive: true });
    let text = "";
    try {
      text = readFileSync(exclude, "utf8");
    } catch {
      // No exclude file yet (or unreadable): start one.
    }
    const separator = text && !text.endsWith("\n") ? "\n" : "";
    writeFileSync(exclude, `${text}${separator}${IGNORE_NOTE}\n${entry}\n`);
    return exclude;
  } catch {
    return null;
  }
}

/** Rooms this process has already checked, so openDb() stays cheap to re-call. */
const ignoreChecked = new Set<string>();

/**
 * Defense in depth for the split-brain the worktree resolution above prevents:
 * if we still land in an empty room while cwd is inside a linked worktree whose
 * primary clone has a populated room, say so instead of joining in silence.
 * Reachable when the worktree carries its own .squad, or when git is missing
 * from PATH and the walk fell back to the worktree root.
 *
 * Only meaningful for the *unintentional* split: a caller who explicitly set
 * `SQUAD_DIR` (checked here, not by the caller, so every callsite gets this
 * for free) has already stated which room they want, so the "Set SQUAD_DIR="
 * suggestion would be advising a choice they deliberately overrode -- skip it.
 */
export function roomSplitWarning(dir: string, cwd: string): string | null {
  if (process.env.SQUAD_DIR) return null; // caller stated intent explicitly
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

/**
 * `CREATE TABLE IF NOT EXISTS` (SCHEMA above) never adds a column to a table
 * that already exists, so a db written before `occurrences` was added to
 * `messages` (#59, system-message dedup) needs an explicit `ALTER TABLE` on
 * open. Idempotent: checked via `PRAGMA table_info`, so re-running against an
 * already-migrated db (or a freshly created one, which already has the
 * column from SCHEMA) is a no-op.
 */
function ensureMessagesOccurrencesColumn(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(messages)").all() as unknown as Array<{
    name: string;
  }>;
  if (!cols.some((c) => c.name === "occurrences")) {
    db.exec("ALTER TABLE messages ADD COLUMN occurrences INTEGER NOT NULL DEFAULT 1");
  }
}

/**
 * Same idea for `relay_cursors.last_error`/`last_error_at` (#113), added after
 * the table first shipped (#112). relay_cursors is outside ROOM_TABLES, so this
 * does not move SCHEMA_VERSION.
 */
function ensureRelayErrorColumns(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(relay_cursors)").all() as unknown as Array<{
    name: string;
  }>;
  if (!cols.some((c) => c.name === "last_error"))
    db.exec("ALTER TABLE relay_cursors ADD COLUMN last_error TEXT");
  if (!cols.some((c) => c.name === "last_error_at"))
    db.exec("ALTER TABLE relay_cursors ADD COLUMN last_error_at TEXT");
}

export function openDb(): DatabaseSync {
  if (!warnedRoomSplit) {
    warnedRoomSplit = true;
    // stderr only: stdout is the MCP stdio transport.
    const warning = roomSplitWarning(squadDir(), process.cwd());
    if (warning) console.error(warning);
  }
  const dir = squadDir();
  mkdirSync(dir, { recursive: true });
  // Creating the room is also the moment to make sure the enclosing repo
  // ignores it (#111) — once per process per room, since the answer only
  // changes when we ourselves change it.
  if (!ignoreChecked.has(dir)) {
    ignoreChecked.add(dir);
    ensureRoomIgnored(dir);
  }
  const db = new DatabaseSync(dbPath());
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  ensureMessagesOccurrencesColumn(db);
  ensureRelayErrorColumns(db);
  adoptNodes(db);
  // Every open of a db by the current build stamps it current: SCHEMA's
  // migration strategy is additive-only (CREATE TABLE IF NOT EXISTS above,
  // plus the narrow ALTER TABLE ADD COLUMN migrations like
  // ensureMessagesOccurrencesColumn() for columns added to an existing
  // table), so once this build has opened a db it *is* SCHEMA_VERSION,
  // regardless of what it was stamped as before. This pragma exists for
  // export/import compatibility checks (Squad.importRoom(), src/core.ts), not
  // to gate opening a db directly.
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return db;
}

/** Observe an existing room without creating, adopting, or migrating its state. */
export function openDbReadOnly(): DatabaseSync {
  const db = new DatabaseSync(dbPath(), { readOnly: true });
  try {
    const version = db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version.user_version !== SCHEMA_VERSION)
      throw new Error(`Room schema ${version.user_version} cannot be inspected by this build (expected ${SCHEMA_VERSION}). Use a compatible Squad build or upgrade the room explicitly before retrying doctor --room.`);
    db.exec("PRAGMA busy_timeout = 5000");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
