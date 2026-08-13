import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SQUAD_DIR = mkdtempSync(join(tmpdir(), "squad-diverge-test-"));

const { openDb } = await import("../dist/db.js");
const { Squad } = await import("../dist/core.js");

test.after(() => rmSync(process.env.SQUAD_DIR, { recursive: true, force: true }));

const db = openDb();
const claude = new Squad(db, "claude");
const codex = new Squad(db, "codex");
const human = new Squad(db, "human");

test("independent submission: multiple personas can submit to the same open round", () => {
  claude.clear();
  const round = claude.divergeOpen("what should we build next?");
  assert.equal(round.status, "open");
  assert.equal(round.topic, "what should we build next?");

  claude.divergeSubmit(round.id, "claude's idea");
  codex.divergeSubmit(round.id, "codex's idea");

  // Both submissions landed, even though the round is still open.
  const status = human.divergeStatus(round.id);
  assert.equal(status.round.status, "open");
  assert.equal(status.submission_count, 2);
  assert.deepEqual(new Set(status.submitted_personas), new Set(["claude", "codex"]));
});

test("open round announcement carries only the topic, never a submission body", () => {
  claude.clear();
  claude.divergeOpen("secret plan");
  const seen = codex.check();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, "system");
  assert.match(seen[0].body, /claude opened divergence round #\d+: secret plan/);
});

test("no leakage before close: divergeStatus never reveals a peer's submission body", () => {
  claude.clear();
  const round = claude.divergeOpen("hidden until reveal");
  claude.divergeSubmit(round.id, "claude's secret opinion ALPHA");
  codex.divergeSubmit(round.id, "codex's secret opinion BETA");

  // codex's own view: sees its own submission, not claude's body.
  const codexView = codex.divergeStatus(round.id);
  assert.equal(codexView.round.status, "open");
  assert.equal(codexView.mine.body, "codex's secret opinion BETA");
  const codexPayload = JSON.stringify(codexView);
  assert.ok(!codexPayload.includes("ALPHA"), "codex's status leaked claude's submission body");

  // claude's own view: sees its own submission, not codex's body.
  const claudeView = claude.divergeStatus(round.id);
  assert.equal(claudeView.mine.body, "claude's secret opinion ALPHA");
  const claudePayload = JSON.stringify(claudeView);
  assert.ok(!claudePayload.includes("BETA"), "claude's status leaked codex's submission body");

  // a bystander with no submission of their own sees no bodies at all.
  const humanView = human.divergeStatus(round.id);
  assert.equal(humanView.mine, null);
  const humanPayload = JSON.stringify(humanView);
  assert.ok(!humanPayload.includes("ALPHA") && !humanPayload.includes("BETA"));

  // returning divergeSubmit's own result must not leak either.
  const submitResult = human.divergeSubmit(round.id, "human's own take GAMMA");
  const submitPayload = JSON.stringify(submitResult);
  assert.ok(!submitPayload.includes("ALPHA") && !submitPayload.includes("BETA"));
  assert.equal(submitResult.mine.body, "human's own take GAMMA");
});

test("explicit close reveals every submission to every persona", () => {
  claude.clear();
  const round = claude.divergeOpen("reveal on close");
  claude.divergeSubmit(round.id, "claude's answer");
  codex.divergeSubmit(round.id, "codex's answer");

  const closed = claude.divergeClose(round.id);
  assert.equal(closed.round.status, "closed");
  assert.equal(closed.round.closed_by, "claude");
  assert.equal(closed.submissions.length, 2);

  // Any persona querying status after close sees all submissions.
  const status = codex.divergeStatus(round.id);
  assert.equal(status.submissions.length, 2);
  const bodies = status.submissions.map((s) => s.body).sort();
  assert.deepEqual(bodies, ["claude's answer", "codex's answer"]);
});

test("close announces the reveal in chat without leaking submission bodies", () => {
  claude.clear();
  const round = claude.divergeOpen("close announcement");
  claude.divergeSubmit(round.id, "TOPSECRET body text");
  codex.check(); // consume the open + submit-related chatter (none for submit)
  claude.divergeClose(round.id);
  const seen = codex.check();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, "system");
  assert.match(seen[0].body, /claude closed divergence round #\d+.*revealed/);
  assert.ok(!seen[0].body.includes("TOPSECRET"), "close announcement leaked a submission body");
});

test("divergeClose on an already-closed round is an idempotent no-op (no double announcement)", () => {
  claude.clear();
  const round = claude.divergeOpen("close twice");
  claude.divergeSubmit(round.id, "only submission");
  claude.divergeClose(round.id);
  codex.check();
  const second = claude.divergeClose(round.id);
  assert.equal(second.round.status, "closed");
  assert.equal(codex.check().length, 0, "no second close announcement");
});

test("auto-close on all expected participants reveals without an explicit close call", () => {
  claude.clear();
  const round = claude.divergeOpen("auto close", {
    expectedParticipants: ["claude", "codex"],
  });
  assert.equal(round.status, "open");

  const afterFirst = claude.divergeSubmit(round.id, "claude's take");
  assert.equal(afterFirst.round.status, "open", "still open with one of two expected in");

  const afterSecond = codex.divergeSubmit(round.id, "codex's take");
  assert.equal(afterSecond.round.status, "closed", "auto-closed once all expected submitted");
  assert.equal(afterSecond.submissions.length, 2);
  const bodies = afterSecond.submissions.map((s) => s.body).sort();
  assert.deepEqual(bodies, ["claude's take", "codex's take"]);

  // A round with no expected_participants never auto-closes.
  const openEnded = claude.divergeOpen("no auto close here");
  claude.divergeSubmit(openEnded.id, "one submission");
  const status = claude.divergeStatus(openEnded.id);
  assert.equal(status.round.status, "open");
});

test("resubmission by the same persona overwrites rather than duplicates", () => {
  claude.clear();
  const round = claude.divergeOpen("overwrite test");
  claude.divergeSubmit(round.id, "first draft");
  const second = claude.divergeSubmit(round.id, "revised draft");
  assert.equal(second.mine.body, "revised draft");
  assert.equal(second.submission_count, 1, "resubmission did not create a duplicate row");

  const closed = claude.divergeClose(round.id);
  assert.equal(closed.submissions.length, 1);
  assert.equal(closed.submissions[0].body, "revised draft");
});

test("submitting to a closed round throws", () => {
  claude.clear();
  const round = claude.divergeOpen("closed already");
  claude.divergeClose(round.id);
  assert.throws(() => claude.divergeSubmit(round.id, "too late"), /already closed/);
});

test("divergeStatus on a missing round throws", () => {
  assert.throws(() => claude.divergeStatus(999999), /no divergence round/);
});

test("divergeOpen accepts an optional nullable card_id with no enforced foreign key", () => {
  claude.clear();
  const round = claude.divergeOpen("attached to a card", { cardId: 4242 });
  assert.equal(round.card_id, 4242);

  const standalone = claude.divergeOpen("no card at all");
  assert.equal(standalone.card_id, null);
});

test("clear wipes divergence rounds and submissions along with everything else", () => {
  claude.clear();
  const round = claude.divergeOpen("to be wiped");
  claude.divergeSubmit(round.id, "gone soon");
  claude.clear();
  assert.throws(() => claude.divergeStatus(round.id), /no divergence round/);
});
