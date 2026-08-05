import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SQUAD_DIR = mkdtempSync(join(tmpdir(), "squad-test-"));

const { openDb } = await import("../dist/db.js");
const { Squad } = await import("../dist/core.js");

test.after(() => rmSync(process.env.SQUAD_DIR, { recursive: true, force: true }));

const db = openDb();
const claude = new Squad(db, "claude");
const codex = new Squad(db, "codex");

test("send and read", () => {
  claude.clear();
  claude.send("hello");
  codex.send("hi back");
  const msgs = claude.read();
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].sender, "claude");
  assert.equal(msgs[1].sender, "codex");
});

test("check excludes own messages and consumes", () => {
  claude.clear();
  claude.send("one");
  claude.send("two");
  codex.send("three");
  const unread = claude.check();
  assert.deepEqual(unread.map((m) => m.body), ["three"]);
  assert.equal(claude.check().length, 0, "second check is empty (consumed)");
});

test("peek does not consume", () => {
  claude.clear();
  codex.send("psst");
  assert.equal(claude.check({ peek: true }).length, 1);
  assert.equal(claude.check().length, 1, "still unread after peek");
});

test("join catches up and advances cursor", () => {
  claude.clear();
  codex.send("old news");
  const { members, recent } = claude.join();
  assert.equal(recent.length, 1);
  assert.ok(members.some((m) => m.persona === "claude"));
  assert.equal(claude.check().length, 0, "join marked history read");
});

test("goals announce in chat and complete", () => {
  claude.clear();
  const goal = claude.goalAdd("ship it");
  assert.equal(goal.status, "open");
  const seen = codex.check();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, "system");
  assert.match(seen[0].body, /goal #\d+: ship it/);

  const done = codex.goalDone(goal.id);
  assert.equal(done.status, "done");
  assert.equal(done.done_by, "codex");
  assert.equal(claude.goals().length, 0, "no open goals left");
  assert.equal(claude.goals(true).length, 1);
  assert.match(claude.check().at(-1).body, /marked goal #\d+ done/);
});

test("goalDone on missing id throws", () => {
  assert.throws(() => claude.goalDone(9999), /no goal/);
});

test("checkWait returns promptly when a message lands", async () => {
  claude.clear();
  setTimeout(() => codex.send("late arrival"), 300);
  const t0 = Date.now();
  const msgs = await claude.checkWait(10);
  assert.equal(msgs.length, 1);
  assert.ok(Date.now() - t0 < 5000, "returned well before the deadline");
});

test("checkWait times out empty", async () => {
  claude.clear();
  const msgs = await claude.checkWait(1);
  assert.equal(msgs.length, 0);
});
