import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SQUAD_DIR = mkdtempSync(join(tmpdir(), "squad-test-review-"));

const { openDb } = await import("../dist/db.js");
const { Squad, REVIEW_PRIORITIES } = await import("../dist/core.js");

test.after(() => rmSync(process.env.SQUAD_DIR, { recursive: true, force: true }));

const db = openDb();
const claude = new Squad(db, "claude");
const codex = new Squad(db, "codex");
const human = new Squad(db, "human");

const past = () => new Date(Date.now() - 60_000).toISOString();
const future = () => new Date(Date.now() + 600_000).toISOString();

// ---------------------------------------------------------------- opening

test("reviewOpen creates a pending request and announces it in chat", () => {
  claude.clear();
  const req = claude.reviewOpen("codex", "does the lease renewal race?", {
    refs: ["src/core.ts:487", "abc1234"],
    priority: "high",
  });
  assert.equal(req.status, "pending");
  assert.equal(req.target, "codex");
  assert.equal(req.requested_by, "claude");
  assert.equal(req.priority, "high");
  assert.deepEqual(req.refs, ["src/core.ts:487", "abc1234"]);
  assert.equal(req.claimed_by, null);
  assert.equal(req.claimed_ts, null);
  assert.equal(req.expires_ts, null);
  assert.ok(req.id > 0);

  const seen = codex.check();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, "system");
  assert.match(
    seen[0].body,
    /claude requested review #\d+ from codex \[high\]: does the lease renewal race\?/,
  );
  assert.match(seen[0].body, /src\/core\.ts:487/, "refs are named in the announcement");
});

test("reviewOpen defaults priority to normal and refs to empty", () => {
  claude.clear();
  const req = claude.reviewOpen("codex", "quick look at the schema diff");
  assert.equal(req.priority, "normal");
  assert.deepEqual(req.refs, []);
});

test("reviewOpen validates target, body, and priority", () => {
  claude.clear();
  assert.throws(() => claude.reviewOpen("", "body"), /target/);
  assert.throws(() => claude.reviewOpen("codex", "   "), /body/);
  assert.throws(() => claude.reviewOpen("codex", "body", { priority: "meh" }), /invalid priority/);
  assert.throws(
    () => claude.reviewOpen("codex", "body", { expiresTs: "not-a-timestamp" }),
    /expires_ts/,
  );
  assert.deepEqual([...REVIEW_PRIORITIES], ["low", "normal", "high", "urgent"]);
});

// -------------------------------------------------- pending-directed view

test("pendingReviews is scoped to the caller and hidden from the requester", () => {
  claude.clear();
  const req = claude.reviewOpen("codex", "please look at the WAL pragma");

  const mine = codex.pendingReviews();
  assert.equal(mine.length, 1);
  assert.equal(mine[0].id, req.id);
  assert.equal(mine[0].expired, false);

  assert.equal(claude.pendingReviews().length, 0, "the requester is not the target");
  assert.equal(human.pendingReviews().length, 0, "an unrelated persona sees nothing");
});

test("join() and checkSummary() surface the caller's pending-directed requests", () => {
  claude.clear();
  const req = claude.reviewOpen("codex", "gate: does presence leak sessions?", {
    priority: "urgent",
  });

  const joined = codex.join();
  assert.equal(joined.pending_reviews.length, 1);
  assert.equal(joined.pending_reviews[0].id, req.id);
  assert.equal(joined.pending_reviews[0].priority, "urgent");

  const summary = codex.checkSummary();
  assert.equal(summary.pending_review_count, 1);
  assert.equal(summary.pending_reviews.length, 1);
  assert.equal(summary.pending_reviews[0].id, req.id);
  // the pre-existing squad_check fields are still there
  assert.equal(typeof summary.open_goals, "number");
  assert.equal(typeof summary.active_claims, "number");
  assert.ok(Array.isArray(summary.peers));

  // the requester's own view stays empty
  assert.equal(claude.checkSummary().pending_review_count, 0);
});

test("pendingReviews is priority-ordered, oldest first within a priority", () => {
  claude.clear();
  const low = claude.reviewOpen("codex", "low one", { priority: "low" });
  const urgent = claude.reviewOpen("codex", "urgent one", { priority: "urgent" });
  const normalA = claude.reviewOpen("codex", "normal first", { priority: "normal" });
  const normalB = claude.reviewOpen("codex", "normal second", { priority: "normal" });
  const high = claude.reviewOpen("codex", "high one", { priority: "high" });

  const ids = codex.pendingReviews().map((r) => r.id);
  assert.deepEqual(ids, [urgent.id, high.id, normalA.id, normalB.id, low.id]);
});

test("a claimed request still counts as directed work for its claimant", () => {
  claude.clear();
  const req = claude.reviewOpen("codex", "still mine until resolved");
  codex.reviewClaim(req.id);
  const mine = codex.pendingReviews();
  assert.equal(mine.length, 1);
  assert.equal(mine[0].status, "claimed");
  assert.equal(codex.checkSummary().pending_review_count, 1);
});

// ------------------------------------------------------ the state machine

test("claim records the claimant and a claim timestamp, and announces it", () => {
  claude.clear();
  const req = claude.reviewOpen("codex", "ack me");
  claude.check(); // drain the open announcement

  const claimed = codex.reviewClaim(req.id);
  assert.equal(claimed.status, "claimed");
  assert.equal(claimed.claimed_by, "codex");
  assert.ok(claimed.claimed_ts, "claim timestamp recorded");

  const seen = claude.check();
  assert.equal(seen.length, 1);
  assert.match(seen[0].body, /codex claimed review #\d+/);
  assert.equal(seen[0].kind, "system");
});

test("resolve from claimed records the resolver and announces it", () => {
  claude.clear();
  const req = claude.reviewOpen("codex", "resolve me");
  codex.reviewClaim(req.id);
  claude.check(); // drain

  const resolved = codex.reviewResolve(req.id, "looks fine, shipped");
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.resolved_by, "codex");
  assert.ok(resolved.resolved_ts);
  assert.equal(resolved.resolution, "looks fine, shipped");

  const seen = claude.check();
  assert.equal(seen.length, 1);
  assert.match(seen[0].body, /codex resolved review #\d+: looks fine, shipped/);

  assert.equal(codex.pendingReviews().length, 0, "a resolved request no longer gates the target");
});

test("cancel from pending (by the requester) announces and clears the gate", () => {
  claude.clear();
  const req = claude.reviewOpen("codex", "never mind");
  codex.check(); // drain

  const cancelled = claude.reviewCancel(req.id, "fixed it myself");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.cancelled_by, "claude");
  assert.ok(cancelled.cancelled_ts);
  assert.equal(cancelled.cancel_reason, "fixed it myself");

  const seen = codex.check();
  assert.equal(seen.length, 1);
  assert.match(seen[0].body, /claude cancelled review #\d+: fixed it myself/);
  assert.equal(codex.pendingReviews().length, 0);
});

test("cancel from claimed (by the target) is allowed", () => {
  claude.clear();
  const req = claude.reviewOpen("codex", "declining this one");
  codex.reviewClaim(req.id);
  const cancelled = codex.reviewCancel(req.id, "out of my depth");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.cancelled_by, "codex");
  assert.equal(codex.pendingReviews().length, 0);
});

test("illegal transitions are rejected with the request's actual current state", () => {
  claude.clear();

  // pending -> resolved is not a legal shortcut: it must be claimed first.
  const a = claude.reviewOpen("codex", "no shortcut");
  assert.throws(() => codex.reviewResolve(a.id), /pending -> resolved/);
  assert.throws(() => codex.reviewResolve(a.id), /allowed from pending: claimed, cancelled/);

  // claimed -> claimed
  const b = claude.reviewOpen("codex", "claim twice");
  codex.reviewClaim(b.id);
  assert.throws(() => codex.reviewClaim(b.id), /claimed -> claimed/);

  // resolved is terminal
  const c = claude.reviewOpen("codex", "terminal resolved");
  codex.reviewClaim(c.id);
  codex.reviewResolve(c.id);
  assert.throws(() => codex.reviewClaim(c.id), /resolved -> claimed/);
  assert.throws(() => codex.reviewResolve(c.id), /resolved -> resolved/);
  assert.throws(() => claude.reviewCancel(c.id), /resolved -> cancelled/);
  assert.throws(() => claude.reviewCancel(c.id), /terminal state/);

  // cancelled is terminal
  const d = claude.reviewOpen("codex", "terminal cancelled");
  claude.reviewCancel(d.id);
  assert.throws(() => codex.reviewClaim(d.id), /cancelled -> claimed/);
  assert.throws(() => codex.reviewResolve(d.id), /cancelled -> resolved/);
  assert.throws(() => claude.reviewCancel(d.id), /cancelled -> cancelled/);
});

test("nothing is written for a rejected transition", () => {
  claude.clear();
  const req = claude.reviewOpen("codex", "rejected writes nothing");
  assert.throws(() => codex.reviewResolve(req.id, "sneaky"));
  const after = codex.reviewGet(req.id);
  assert.equal(after.status, "pending");
  assert.equal(after.resolved_by, null);
  assert.equal(after.resolution, null);
});

// -------------------------------------------------------------- authority

test("only the target may claim a request directed at them", () => {
  claude.clear();
  const req = claude.reviewOpen("codex", "codex only");
  assert.throws(() => human.reviewClaim(req.id), /directed at codex/);
  assert.throws(() => claude.reviewClaim(req.id), /only the target/);
  assert.equal(codex.reviewClaim(req.id).status, "claimed");
});

test("only the claimant may resolve", () => {
  claude.clear();
  const req = claude.reviewOpen("codex", "claimant resolves");
  codex.reviewClaim(req.id);
  assert.throws(() => claude.reviewResolve(req.id), /claimed by codex/);
  assert.throws(() => human.reviewResolve(req.id), /only the claimant/);
  assert.equal(codex.reviewResolve(req.id).status, "resolved");
});

test("cancel is requester-or-target; anyone else is rejected", () => {
  claude.clear();
  const req = claude.reviewOpen("codex", "who can cancel");
  assert.throws(() => human.reviewCancel(req.id), /requester \(claude\) or the target \(codex\)/);
  assert.equal(claude.reviewCancel(req.id).status, "cancelled");
});

test("claim / resolve / cancel / get on a missing request throw", () => {
  assert.throws(() => claude.reviewGet(999999), /no review request with id 999999/);
  assert.throws(() => claude.reviewClaim(999999), /no review request with id 999999/);
  assert.throws(() => claude.reviewResolve(999999), /no review request with id 999999/);
  assert.throws(() => claude.reviewCancel(999999), /no review request with id 999999/);
});

// ----------------------------------------------------------------- expiry

test("an expired pending request stops gating without any explicit cancel", () => {
  claude.clear();
  const live = claude.reviewOpen("codex", "still live", { expiresTs: future() });
  const dead = claude.reviewOpen("codex", "already stale", { expiresTs: past() });

  const mine = codex.pendingReviews();
  assert.deepEqual(
    mine.map((r) => r.id),
    [live.id],
    "the expired request is excluded from the pending-directed set",
  );
  assert.equal(codex.checkSummary().pending_review_count, 1);
  assert.equal(codex.join().pending_reviews.length, 1);

  // Expiry is lazy: the stored status is untouched, only the derived view changes.
  const stored = codex.reviewGet(dead.id);
  assert.equal(stored.status, "pending", "expiry never mutates the stored status");
  assert.equal(stored.expired, true);
  assert.equal(codex.reviewGet(live.id).expired, false);
});

test("a request that expires while claimed also stops gating", async () => {
  claude.clear();
  // A short expiry that lapses *after* the claim lands, so the request is
  // genuinely in the `claimed` state when its deadline passes.
  const req = claude.reviewOpen("codex", "claimed then expired", {
    expiresTs: new Date(Date.now() + 120).toISOString(),
  });
  codex.reviewClaim(req.id);
  assert.equal(codex.pendingReviews().length, 1, "gates while claimed and unexpired");

  await new Promise((r) => setTimeout(r, 250));

  const view = codex.reviewGet(req.id);
  assert.equal(view.status, "claimed", "expiry never mutates the stored status");
  assert.equal(view.expired, true);
  assert.equal(codex.pendingReviews().length, 0, "an expired claimed request stops gating");
  assert.equal(codex.checkSummary().pending_review_count, 0);
  assert.equal(codex.join().pending_reviews.length, 0);
});

test("an expired request cannot be claimed, but can still be resolved or cancelled", () => {
  claude.clear();
  const a = claude.reviewOpen("codex", "too late to claim", { expiresTs: past() });
  assert.throws(() => codex.reviewClaim(a.id), /expired/);

  // Closing out an expired request is still allowed, so the record stays honest.
  const b = claude.reviewOpen("codex", "cancel an expired one", { expiresTs: past() });
  assert.equal(claude.reviewCancel(b.id).status, "cancelled");
});

test("expires_in_minutes is an alternative to an explicit expires_ts", () => {
  claude.clear();
  const req = claude.reviewOpen("codex", "expires soon", { expiresInMinutes: 30 });
  assert.ok(req.expires_ts, "expiry computed from the offset");
  assert.ok(Date.parse(req.expires_ts) > Date.now());
  assert.equal(codex.pendingReviews().length, 1);
});

// ------------------------------------------------------------------- list

test("reviewList filters by target, status, and expiry", () => {
  claude.clear();
  const forCodex = claude.reviewOpen("codex", "for codex");
  const forHuman = claude.reviewOpen("human", "for human");
  const expired = claude.reviewOpen("codex", "expired one", { expiresTs: past() });
  codex.reviewClaim(forCodex.id);

  const all = claude.reviewList({ includeExpired: true });
  assert.equal(all.length, 3);

  const codexOnly = claude.reviewList({ target: "codex", includeExpired: true });
  assert.deepEqual(new Set(codexOnly.map((r) => r.id)), new Set([forCodex.id, expired.id]));

  const claimed = claude.reviewList({ status: "claimed" });
  assert.deepEqual(
    claimed.map((r) => r.id),
    [forCodex.id],
  );

  const openOnes = claude.reviewList();
  assert.ok(!openOnes.some((r) => r.id === expired.id), "expired hidden unless asked for");
  assert.ok(openOnes.some((r) => r.id === forHuman.id));

  claude.reviewCancel(forHuman.id);
  const afterCancel = claude.reviewList();
  assert.ok(
    !afterCancel.some((r) => r.id === forHuman.id),
    "terminal states are hidden by default",
  );
  assert.ok(claude.reviewList({ includeTerminal: true }).some((r) => r.id === forHuman.id));
});

test("clear wipes review requests along with everything else", () => {
  claude.clear();
  const req = claude.reviewOpen("codex", "to be wiped");
  codex.clear();
  assert.throws(() => codex.reviewGet(req.id), /no review request/);
  assert.equal(codex.pendingReviews().length, 0);
});
