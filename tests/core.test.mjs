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

test("goalReopen resets a done goal and announces", () => {
  claude.clear();
  const goal = claude.goalAdd("prove the bound");
  codex.goalDone(goal.id);
  const reopened = claude.goalReopen(goal.id);
  assert.equal(reopened.status, "open");
  assert.equal(reopened.done_by, null);
  assert.equal(reopened.done_ts, null);
  const board = claude.goals(true);
  assert.equal(board.length, 1);
  assert.equal(board[0].status, "open", "reopen persisted");
  assert.equal(board[0].done_by, null);
  assert.match(codex.check().at(-1).body, /reopened goal #\d+/);
});

test("goalReopen on an open goal is a silent no-op", () => {
  claude.clear();
  const goal = claude.goalAdd("still open");
  codex.check();
  const same = claude.goalReopen(goal.id);
  assert.equal(same.status, "open");
  assert.equal(codex.check().length, 0, "no announcement for a no-op");
});

test("goalReopen on missing id throws", () => {
  assert.throws(() => claude.goalReopen(9999), /no goal/);
});

test("claim announces in chat and appears in claims()", () => {
  claude.clear();
  const c = claude.claim("src/core.ts");
  assert.equal(c.path, "src/core.ts");
  assert.equal(c.persona, "claude");

  const seen = codex.check();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, "system");
  assert.match(seen[0].body, /claude claimed src\/core\.ts/);

  const listed = codex.claims();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].path, "src/core.ts");
  assert.equal(listed[0].persona, "claude");
  assert.equal(listed[0].stale, false, "a just-claimed path is not stale");
});

test("claiming your own path twice is idempotent and silent", () => {
  claude.clear();
  const first = claude.claim("docs/README.md");
  codex.check();
  const second = claude.claim("docs/README.md");
  assert.equal(second.id, first.id);
  assert.equal(codex.claims().length, 1, "no duplicate row");
  assert.equal(codex.check().length, 0, "no second announcement");
});

test("claiming a path a peer holds is allowed and names the holder", () => {
  claude.clear();
  claude.claim("src/mcp.ts");
  codex.check();
  codex.claim("src/mcp.ts");
  const seen = claude.check();
  assert.equal(seen.length, 1);
  assert.match(seen.at(-1).body, /codex claimed src\/mcp\.ts .*already claimed by claude/);
  assert.equal(claude.claims().length, 2, "advisory: both claims are visible");
});

test("release removes the claim and announces", () => {
  claude.clear();
  claude.claim("src/cli.ts");
  codex.check();
  const released = claude.release("src/cli.ts");
  assert.equal(released.length, 1);
  assert.equal(released[0].path, "src/cli.ts");
  assert.equal(claude.claims().length, 0);
  assert.match(codex.check().at(-1).body, /claude released src\/cli\.ts/);
});

test("releasing a nonexistent claim is a silent no-op", () => {
  claude.clear();
  codex.check();
  const released = claude.release("nothing/here.ts");
  assert.deepEqual(released, []);
  assert.equal(codex.check().length, 0, "no announcement for a no-op");
});

test("release takes over a peer's claim when you hold none", () => {
  claude.clear();
  claude.claim("src/db.ts");
  codex.check();
  const released = codex.release("src/db.ts");
  assert.equal(released.length, 1);
  assert.equal(released[0].persona, "claude");
  assert.equal(codex.claims().length, 0);
  assert.match(claude.check().at(-1).body, /codex released src\/db\.ts \(held by claude\)/);
});

test("release drops only your own claim when a peer also holds the path", () => {
  claude.clear();
  claude.claim("shared.ts");
  codex.claim("shared.ts");
  const released = codex.release("shared.ts");
  assert.equal(released.length, 1);
  assert.equal(released[0].persona, "codex");
  const left = claude.claims();
  assert.equal(left.length, 1);
  assert.equal(left[0].persona, "claude", "peer's claim survives");
});

test("join includes current claims", () => {
  claude.clear();
  claude.claim("tests/core.test.mjs");
  const { claims } = codex.join();
  assert.equal(claims.length, 1);
  assert.equal(claims[0].path, "tests/core.test.mjs");
  assert.equal(claims[0].persona, "claude");
});

test("a claim goes stale with its holder's last_seen", () => {
  claude.clear();
  claude.claim("stale/target.ts");
  assert.equal(codex.claims()[0].stale, false);

  // touch() always stamps real time, so age the holder's presence directly.
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  db.prepare("UPDATE members SET last_seen = ? WHERE persona = ?").run(old, "claude");

  const listed = codex.claims();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].persona, "claude");
  assert.equal(listed[0].last_seen, old);
  assert.equal(listed[0].stale, true, "an absent holder's claim lists as stale");
});

test("clear wipes claims along with everything else", () => {
  claude.clear();
  claude.claim("wiped.ts");
  claude.goalAdd("also wiped");
  assert.equal(claude.claims().length, 1);
  codex.clear();
  assert.equal(codex.claims().length, 0);
  assert.equal(codex.goals(true).length, 0);
  assert.equal(codex.read().length, 0);
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
