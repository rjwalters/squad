import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SQUAD_DIR = mkdtempSync(join(tmpdir(), "squad-test-diverge-"));

const { openDb } = await import("../dist/db.js");
const { Squad } = await import("../dist/core.js");

test.after(() => rmSync(process.env.SQUAD_DIR, { recursive: true, force: true }));

const db = openDb();
const claude = new Squad(db, "claude");
const codex = new Squad(db, "codex");

test("divergeOpen announces only the topic, never a submission", () => {
  claude.clear();
  const round = claude.divergeOpen("best approach for X?");
  assert.equal(round.topic, "best approach for X?");
  assert.equal(round.status, "open");
  assert.equal(round.opened_by, "claude");
  assert.equal(round.expected_participants, null);

  const seen = codex.check();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, "system");
  assert.match(seen[0].body, /claude opened divergence round #\d+: best approach for X\?/);
});

test("independent submission: divergeSubmit never returns another persona's body", () => {
  claude.clear();
  const round = claude.divergeOpen("independent ideas");
  const mine = claude.divergeSubmit(round.id, "claude's secret idea");
  assert.equal(mine.persona, "claude");
  assert.equal(mine.body, "claude's secret idea");
  // Nothing about codex leaks into claude's own submit result.
  assert.ok(!JSON.stringify(mine).includes("codex"));
});

test("no leakage before close: divergeStatus hides other personas' submission bodies", () => {
  claude.clear();
  const round = claude.divergeOpen("hidden until reveal");
  claude.divergeSubmit(round.id, "claude body: apples");
  codex.divergeSubmit(round.id, "codex body: oranges");

  const claudeView = claude.divergeStatus(round.id);
  assert.equal(claudeView.round.status, "open");
  assert.equal(claudeView.submissions, null, "no full submission list while open");
  assert.equal(claudeView.mine.body, "claude body: apples", "sees own submission");
  assert.deepEqual(new Set(claudeView.submitted_personas), new Set(["claude", "codex"]));
  // The leak-detection assertion called out in the issue's implementation
  // guidance: claude's view must not contain any substring of codex's body.
  const claudeViewText = JSON.stringify(claudeView);
  assert.ok(!claudeViewText.includes("oranges"), "claude's status leaks codex's submission body");

  const codexView = codex.divergeStatus(round.id);
  assert.equal(codexView.submissions, null);
  assert.equal(codexView.mine.body, "codex body: oranges");
  const codexViewText = JSON.stringify(codexView);
  assert.ok(!codexViewText.includes("apples"), "codex's status leaks claude's submission body");
});

test("concurrent-submission isolation: one persona's submit never observes a peer's prior submission", () => {
  claude.clear();
  const round = claude.divergeOpen("isolation check");
  claude.divergeSubmit(round.id, "claude first");
  const codexResult = codex.divergeSubmit(round.id, "codex second");
  assert.equal(codexResult.persona, "codex");
  assert.equal(codexResult.body, "codex second");
  assert.ok(
    !JSON.stringify(codexResult).includes("claude first"),
    "codex's own submit result must not be influenced by claude's prior submission",
  );
});

test("explicit divergeClose reveals all submissions and announces the reveal", () => {
  claude.clear();
  const round = claude.divergeOpen("reveal on close");
  claude.divergeSubmit(round.id, "claude's take");
  codex.divergeSubmit(round.id, "codex's take");
  codex.check(); // drain announcements so far

  const closed = claude.divergeClose(round.id);
  assert.equal(closed.status, "closed");
  assert.equal(closed.closed_by, "claude");

  const status = codex.divergeStatus(round.id);
  assert.equal(status.round.status, "closed");
  assert.equal(status.submissions.length, 2);
  const bodies = status.submissions.map((s) => s.body).sort();
  assert.deepEqual(bodies, ["claude's take", "codex's take"]);

  const seen = codex.check();
  assert.equal(seen.length, 1);
  assert.match(seen[0].body, /claude closed divergence round #\d+: reveal on close/);
  // The chat announcement itself must not leak a submission body.
  assert.ok(!seen[0].body.includes("claude's take"));
  assert.ok(!seen[0].body.includes("codex's take"));
});

test("divergeClose on an already-closed round is an idempotent no-op", () => {
  claude.clear();
  const round = claude.divergeOpen("close twice");
  claude.divergeSubmit(round.id, "one and only");
  claude.divergeClose(round.id);
  codex.check();
  const again = claude.divergeClose(round.id);
  assert.equal(again.status, "closed");
  assert.equal(codex.check().length, 0, "no second announcement");
});

test("auto-close once every expected participant has submitted", () => {
  claude.clear();
  const round = claude.divergeOpen("auto close", { expectedParticipants: ["claude", "codex"] });
  claude.divergeSubmit(round.id, "claude's entry");

  const midway = claude.divergeStatus(round.id);
  assert.equal(midway.round.status, "open", "not closed until every expected participant submits");

  codex.check(); // drain open announcement
  codex.divergeSubmit(round.id, "codex's entry");

  const after = claude.divergeStatus(round.id);
  assert.equal(after.round.status, "closed", "auto-closed once all expected participants submitted");
  assert.equal(after.round.closed_by, "codex", "closed by the persona whose submission completed the set");
  assert.equal(after.submissions.length, 2);

  const announcement = claude.check().at(-1);
  assert.match(announcement.body, /auto-closed/);
});

test("a round without expected_participants never auto-closes", () => {
  claude.clear();
  const round = claude.divergeOpen("no auto close");
  claude.divergeSubmit(round.id, "claude's entry");
  codex.divergeSubmit(round.id, "codex's entry");
  const status = claude.divergeStatus(round.id);
  assert.equal(status.round.status, "open", "no expected_participants means only explicit close ends it");
});

test("resubmission by the same persona overwrites rather than duplicates", () => {
  claude.clear();
  const round = claude.divergeOpen("overwrite check");
  const first = claude.divergeSubmit(round.id, "draft one");
  const second = claude.divergeSubmit(round.id, "draft two, final");
  assert.equal(second.id, first.id, "same row, not a duplicate");

  const closed = claude.divergeClose(round.id);
  assert.equal(closed.status, "closed");
  const status = codex.divergeStatus(round.id);
  assert.equal(status.submissions.length, 1, "one row per persona even after resubmission");
  assert.equal(status.submissions[0].body, "draft two, final");
});

test("divergeSubmit on a closed round throws", () => {
  claude.clear();
  const round = claude.divergeOpen("closed already");
  claude.divergeClose(round.id);
  assert.throws(() => codex.divergeSubmit(round.id, "too late"), /closed/);
});

test("divergeStatus / divergeSubmit / divergeClose on a missing round throw", () => {
  assert.throws(() => claude.divergeStatus(999999), /no divergence round/);
  assert.throws(() => claude.divergeSubmit(999999, "x"), /no divergence round/);
  assert.throws(() => claude.divergeClose(999999), /no divergence round/);
});

test("clear wipes divergence rounds and submissions along with everything else", () => {
  claude.clear();
  const round = claude.divergeOpen("to be wiped");
  claude.divergeSubmit(round.id, "gone soon");
  codex.clear();
  assert.throws(() => codex.divergeStatus(round.id), /no divergence round/);
});
