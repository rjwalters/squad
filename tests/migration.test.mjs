import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// This suite verifies squad's idempotent `CREATE TABLE IF NOT EXISTS`
// migration path (src/db.ts's SCHEMA) against a pre-existing database file
// that predates the Science Card tables (issue #29) — i.e. it never opens a
// freshly created db, always one built from an *older* schema fixture first.
// See issue #36: the four earlier Science Card sub-issues (#22-#25) never
// exercised this "upgrade an existing .squad/squad.db in place" path.

const { openDb } = await import("../dist/db.js");

/**
 * The schema as it existed immediately before Science Cards (#29) landed:
 * messages, cursors, goals, members, claims, divergence_rounds,
 * divergence_submissions — no science_cards / science_card_transitions /
 * science_card_evidence tables. Deliberately hand-copied (not imported from
 * db.ts) so this fixture stays a fixed "old schema" snapshot even as the
 * current SCHEMA constant evolves further.
 */
const PRE_SCIENCE_CARD_SCHEMA = `
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'chat',
  body TEXT NOT NULL,
  ts TEXT NOT NULL
);
CREATE TABLE cursors (
  persona TEXT PRIMARY KEY,
  last_seen_id INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_by TEXT NOT NULL,
  created_ts TEXT NOT NULL,
  done_by TEXT,
  done_ts TEXT
);
CREATE TABLE members (
  persona TEXT PRIMARY KEY,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
CREATE TABLE claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  persona TEXT NOT NULL,
  created_ts TEXT NOT NULL
);
CREATE TABLE divergence_rounds (
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
CREATE TABLE divergence_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL,
  persona TEXT NOT NULL,
  body TEXT NOT NULL,
  submitted_ts TEXT NOT NULL,
  UNIQUE(round_id, persona)
);
`;

const SCIENCE_CARD_TABLES = ["science_cards", "science_card_transitions", "science_card_evidence"];
/**
 * Tables added after the fixture above by later features (#38: presence
 * leases; #39: directed review requests; #41: session-scoped read cursors —
 * session_cursors holds the per-session cursor, while the pre-existing
 * persona-keyed `cursors` table stays in PRE_EXISTING_TABLES and keeps the
 * persona's durable high-water mark).
 */
const LATER_TABLES = [...SCIENCE_CARD_TABLES, "sessions", "review_requests", "session_cursors"];
const PRE_EXISTING_TABLES = [
  "messages",
  "cursors",
  "goals",
  "members",
  "claims",
  "divergence_rounds",
  "divergence_submissions",
];

function tableNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name);
}

test("opening an old-schema .squad/squad.db adds the Science Card tables without touching existing tables/data", () => {
  const dir = mkdtempSync(join(tmpdir(), "squad-migration-"));
  const dbFile = join(dir, "squad.db");
  try {
    // 1. Build a pre-Science-Card database and seed it with data, exactly as
    //    a repo that adopted squad before #29 would have on disk.
    const seed = new DatabaseSync(dbFile);
    seed.exec(PRE_SCIENCE_CARD_SCHEMA);
    seed
      .prepare("INSERT INTO messages (sender, kind, body, ts) VALUES (?, ?, ?, ?)")
      .run("claude", "chat", "pre-migration message", "2026-01-01T00:00:00.000Z");
    seed
      .prepare("INSERT INTO goals (body, status, created_by, created_ts) VALUES (?, ?, ?, ?)")
      .run("pre-migration goal", "open", "claude", "2026-01-01T00:00:00.000Z");
    seed
      .prepare("INSERT INTO claims (path, persona, created_ts) VALUES (?, ?, ?)")
      .run("src/legacy.ts", "claude", "2026-01-01T00:00:00.000Z");
    seed
      .prepare("INSERT INTO members (persona, first_seen, last_seen) VALUES (?, ?, ?)")
      .run("claude", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    seed.close();

    // Sanity check the fixture: no Science Card tables exist yet.
    const pre = new DatabaseSync(dbFile);
    const preTables = tableNames(pre);
    pre.close();
    for (const t of LATER_TABLES) {
      assert.ok(!preTables.includes(t), `fixture must predate ${t}`);
    }
    for (const t of PRE_EXISTING_TABLES) {
      assert.ok(preTables.includes(t), `fixture must already have ${t}`);
    }

    // 2. Run the current migration/init path (squad's own openDb()) against
    //    that existing file — this is the exact path every squad CLI/MCP
    //    invocation takes.
    process.env.SQUAD_DIR = dir;
    const db = openDb();

    // 3. The new Science Card tables now exist...
    const afterTables = tableNames(db);
    for (const t of LATER_TABLES) {
      assert.ok(afterTables.includes(t), `${t} must exist after migration`);
    }
    // ...the presence-lease table starts empty: an upgrade does not invent
    // sessions for personas that were merely in the old members table.
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 0);
    // ...and the session-scoped cursor table starts empty too — an upgrade
    // never migrates the old persona-keyed `cursors` rows into it.
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM session_cursors").get().n, 0);
    // ...and the science_cards table is empty (freshly created), not
    // pre-populated with anything.
    const cardCount = db.prepare("SELECT COUNT(*) AS n FROM science_cards").get();
    assert.equal(cardCount.n, 0);

    // 4. Every pre-existing table survived, unaltered...
    for (const t of PRE_EXISTING_TABLES) {
      assert.ok(afterTables.includes(t), `${t} must still exist after migration`);
    }
    // ...and no data loss on the rows seeded before migration.
    const message = db.prepare("SELECT * FROM messages WHERE sender = 'claude'").get();
    assert.equal(message.body, "pre-migration message");
    assert.equal(message.ts, "2026-01-01T00:00:00.000Z");

    const goal = db.prepare("SELECT * FROM goals WHERE created_by = 'claude'").get();
    assert.equal(goal.body, "pre-migration goal");
    assert.equal(goal.status, "open");

    const claim = db.prepare("SELECT * FROM claims WHERE persona = 'claude'").get();
    assert.equal(claim.path, "src/legacy.ts");

    const member = db.prepare("SELECT * FROM members WHERE persona = 'claude'").get();
    assert.equal(member.first_seen, "2026-01-01T00:00:00.000Z");

    db.close();

    // 5. Re-opening again (the idempotent path every subsequent invocation
    //    takes) is a no-op: still one row per pre-existing table, still no
    //    science cards, no errors from re-running CREATE TABLE IF NOT EXISTS.
    const reopened = openDb();
    assert.equal(reopened.prepare("SELECT COUNT(*) AS n FROM messages").get().n, 1);
    assert.equal(reopened.prepare("SELECT COUNT(*) AS n FROM goals").get().n, 1);
    assert.equal(reopened.prepare("SELECT COUNT(*) AS n FROM claims").get().n, 1);
    assert.equal(reopened.prepare("SELECT COUNT(*) AS n FROM science_cards").get().n, 0);
    reopened.close();
  } finally {
    delete process.env.SQUAD_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fresh (never-existed) squad.db gets every table, old and new, on first open", () => {
  const dir = mkdtempSync(join(tmpdir(), "squad-migration-fresh-"));
  try {
    assert.ok(!existsSync(join(dir, "squad.db")), "fixture must not pre-exist");
    process.env.SQUAD_DIR = dir;
    const db = openDb();
    const tables = tableNames(db);
    for (const t of [...PRE_EXISTING_TABLES, ...LATER_TABLES]) {
      assert.ok(tables.includes(t), `${t} must exist on a fresh db`);
    }
    db.close();
  } finally {
    delete process.env.SQUAD_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});
