import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Round-trip and safety coverage for `squad export`/`squad import` (#46):
// a WAL-safe way to move a room's full history between repos. Exercises the
// `Squad.exportRoom()`/`Squad.importRoom()` pair directly (the same methods
// the CLI's `export`/`import` subcommands call) rather than the CLI, so
// assertions can inspect row counts/content precisely.

const { openDb, ROOM_TABLES, SCHEMA_VERSION } = await import("../dist/db.js");
const { Squad } = await import("../dist/core.js");

const tmpDirs = [];

/** A fresh, isolated room directory + its open Squad(db, persona). */
function freshRoom(persona = "claude") {
  const dir = mkdtempSync(join(tmpdir(), "squad-export-import-"));
  tmpDirs.push(dir);
  process.env.SQUAD_DIR = dir;
  const db = openDb();
  return { dir, db, squad: new Squad(db, persona) };
}

test.after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

test("round-trip export -> import preserves row counts and content across every table", async () => {
  const src = freshRoom("claude");
  const codex = new Squad(src.db, "codex");

  // messages, members, sessions (via send/touch)
  src.squad.send("hello from claude");
  codex.send("hi back from codex");
  // cursors, session_cursors (via check -- advances the reader's cursor)
  src.squad.check();
  codex.check();
  // goals
  const goal = src.squad.goalAdd("prove the lemma");
  src.squad.goalDone(goal.id);
  // claims
  src.squad.claim("src/foo.ts");
  // divergence_rounds, divergence_submissions
  const round = src.squad.divergeOpen("approach", { expectedParticipants: ["claude", "codex"] });
  src.squad.divergeSubmit(round.id, "my independent take");
  // review_requests
  src.squad.reviewOpen("codex", "please check this");
  // science_cards, science_card_transitions, science_card_evidence
  const card = src.squad.cardCreate({ title: "t", question: "does it hold?" });
  src.squad.cardTransition(card.id, "DIVERGE", "moving forward");
  src.squad.cardEvidenceAdd(card.id, "literature", "some-paper", "supports it");

  const beforeCounts = {};
  for (const t of ROOM_TABLES) {
    beforeCounts[t] = src.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    assert.ok(beforeCounts[t] > 0, `expected ${t} to be non-empty before export`);
  }
  const beforeMessages = src.db.prepare("SELECT * FROM messages ORDER BY id").all();
  const beforeCards = src.db.prepare("SELECT * FROM science_cards ORDER BY id").all();

  const exportDir = mkdtempSync(join(tmpdir(), "squad-export-file-"));
  tmpDirs.push(exportDir);
  const exportPath = join(exportDir, "room.db");
  const exportCounts = await src.squad.exportRoom(exportPath);
  assert.ok(existsSync(exportPath), "export file was created");
  assert.deepEqual(exportCounts, beforeCounts, "exportRoom's reported counts match the source room");

  const dest = freshRoom("claude");
  for (const t of ROOM_TABLES) {
    assert.equal(dest.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, `${t} starts empty in a fresh room`);
  }

  const importCounts = dest.squad.importRoom(exportPath);
  assert.deepEqual(importCounts, beforeCounts, "importRoom's reported counts match the source room");

  for (const t of ROOM_TABLES) {
    const n = dest.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    assert.equal(n, beforeCounts[t], `${t} row count preserved after import`);
  }
  const afterMessages = dest.db.prepare("SELECT * FROM messages ORDER BY id").all();
  assert.deepEqual(afterMessages, beforeMessages, "message content (including ids) preserved verbatim");
  const afterCards = dest.db.prepare("SELECT * FROM science_cards ORDER BY id").all();
  assert.deepEqual(afterCards, beforeCards, "science card content preserved verbatim");

  // Imported rows keep their original ids, and AUTOINCREMENT correctly
  // resumes past the imported max id (no collision on a post-import write).
  const newMsg = dest.squad.send("post-import message");
  assert.ok(newMsg.id > beforeMessages[beforeMessages.length - 1].id, "new id is past every imported id");
});

test("export captures pending (uncheckpointed) WAL writes", async () => {
  const src = freshRoom("claude");
  src.squad.send("not yet checkpointed");
  // No explicit PRAGMA wal_checkpoint here -- exportRoom must still see it.
  const exportDir = mkdtempSync(join(tmpdir(), "squad-export-file-"));
  tmpDirs.push(exportDir);
  const exportPath = join(exportDir, "room.db");
  await src.squad.exportRoom(exportPath);

  const copy = new DatabaseSync(exportPath, { readOnly: true });
  const rows = copy.prepare("SELECT body FROM messages").all();
  copy.close();
  assert.deepEqual(
    rows.map((r) => r.body),
    ["not yet checkpointed"],
  );
});

test("export refuses to overwrite an existing file", async () => {
  const src = freshRoom("claude");
  src.squad.send("hi");
  const exportDir = mkdtempSync(join(tmpdir(), "squad-export-file-"));
  tmpDirs.push(exportDir);
  const exportPath = join(exportDir, "room.db");
  await src.squad.exportRoom(exportPath);
  await assert.rejects(() => src.squad.exportRoom(exportPath), /refusing to overwrite/);
});

test("import rejects a missing source file", () => {
  const dest = freshRoom("claude");
  assert.throws(() => dest.squad.importRoom("/no/such/path/room.db"), /no such file/);
});

test("import rejects a source with an incompatible schema version", async () => {
  const src = freshRoom("claude");
  src.squad.send("hi");
  const exportDir = mkdtempSync(join(tmpdir(), "squad-export-file-"));
  tmpDirs.push(exportDir);
  const exportPath = join(exportDir, "room.db");
  await src.squad.exportRoom(exportPath);

  // Tamper with the exported artifact's user_version, simulating an export
  // produced by an older/newer, schema-incompatible squad build.
  const tampered = new DatabaseSync(exportPath);
  tampered.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  tampered.close();

  const dest = freshRoom("claude");
  assert.throws(() => dest.squad.importRoom(exportPath), /schema version mismatch/);
  // Rejected cleanly -- no partial writes.
  for (const t of ROOM_TABLES) {
    assert.equal(dest.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, `${t} untouched after rejected import`);
  }
});

test("import rejects a source missing squad's tables (not a squad export)", () => {
  const dest = freshRoom("claude");
  const notExportDir = mkdtempSync(join(tmpdir(), "squad-not-export-"));
  tmpDirs.push(notExportDir);
  const notExportPath = join(notExportDir, "random.db");
  const random = new DatabaseSync(notExportPath);
  random.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)");
  random.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  random.close();

  assert.throws(() => dest.squad.importRoom(notExportPath), /not a squad export/);
});

test("import rejects a non-empty destination room without touching it", async () => {
  const src = freshRoom("claude");
  src.squad.send("source message");
  const exportDir = mkdtempSync(join(tmpdir(), "squad-export-file-"));
  tmpDirs.push(exportDir);
  const exportPath = join(exportDir, "room.db");
  await src.squad.exportRoom(exportPath);

  const dest = freshRoom("claude");
  dest.squad.send("dest already has a message");

  assert.throws(() => dest.squad.importRoom(exportPath), /non-empty room/);
  const rows = dest.db.prepare("SELECT body FROM messages").all();
  assert.deepEqual(
    rows.map((r) => r.body),
    ["dest already has a message"],
    "destination room left untouched by the rejected import",
  );
});

test("empty (freshly-installed) room exports and imports cleanly", async () => {
  const src = freshRoom("claude");
  const exportDir = mkdtempSync(join(tmpdir(), "squad-export-file-"));
  tmpDirs.push(exportDir);
  const exportPath = join(exportDir, "room.db");
  const exportCounts = await src.squad.exportRoom(exportPath);
  for (const t of ROOM_TABLES) assert.equal(exportCounts[t], 0);

  const dest = freshRoom("claude");
  const importCounts = dest.squad.importRoom(exportPath);
  for (const t of ROOM_TABLES) assert.equal(importCounts[t], 0);
});
