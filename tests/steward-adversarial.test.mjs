import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../dist/db.js";
import { Squad } from "../dist/core.js";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "squad-steward-adversarial-"));
  const repo = join(root, "source"),
    remote = join(root, "remote.git");
  const git = (cwd, ...args) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  execFileSync("git", ["init", "--bare", "-q", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.name", "Fixture");
  git(repo, "config", "user.email", "fixture@example.org");
  git(repo, "remote", "add", "origin", remote);
  writeFileSync(join(repo, "artifact.txt"), "baseline\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "baseline");
  git(repo, "push", "-q", "origin", "main");
  git(repo, "checkout", "-qb", "research");
  writeFileSync(join(repo, "artifact.txt"), "new research\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "research artifact");
  const commit = git(repo, "rev-parse", "HEAD");
  const previousRoom = process.env.SQUAD_DIR;
  process.env.SQUAD_DIR = join(root, "room");
  const db = openDb(),
    squad = new Squad(db, "author"),
    peer = new Squad(db, "peer");
  t.after(() => {
    db.close();
    if (previousRoom === undefined) delete process.env.SQUAD_DIR;
    else process.env.SQUAD_DIR = previousRoom;
    rmSync(root, { recursive: true, force: true });
  });
  squad.integrationSet(
    {
      repository: repo,
      remote: "origin",
      branch: "main",
      build_command: "test -s artifact.txt",
      steward: "peer",
    },
    0,
  );
  const create = (title = "Research node") =>
    squad.nodeCreate({
      title,
      question: "What does this artifact establish?",
      artifacts: [{ path: "artifact.txt", commit }],
    });
  return { root, repo, remote, commit, db, squad, peer, create };
}

test("steward status is a pure snapshot available to non-steward peers", (t) => {
  const { db, squad, peer, create } = fixture(t);
  create();
  const before = db.prepare("SELECT total_changes() AS n").get().n;
  db.exec("PRAGMA query_only=ON");
  try {
    const author = squad.stewardStatus(),
      steward = peer.stewardStatus();
    assert.ok(JSON.stringify(author).includes("Research node"));
    assert.ok(JSON.stringify(steward).includes("Research node"));
    assert.equal(db.prepare("SELECT total_changes() AS n").get().n, before);
  } finally {
    db.exec("PRAGMA query_only=OFF");
  }
});

test("only the configured steward can tick; reminders do not fabricate integration or review", async (t) => {
  const { db, squad, peer, create } = fixture(t);
  const node = create();
  const messages = () =>
    Number(db.prepare("SELECT COUNT(*) AS n FROM messages").get().n);
  const before = messages();
  await assert.rejects(
    async () => squad.stewardTick(),
    /steward|configured|identity|persona/i,
  );
  assert.equal(messages(), before);
  await peer.stewardTick();
  assert.ok(
    messages() > before,
    "eligible unbanked work should produce a reminder",
  );
  assert.ok(messages() - before <= 5, "each tick is bounded");
  assert.equal(squad.integrationAttempts().length, 0);
  assert.equal(peer.nodeGet(node.id).banked, false);
  assert.notEqual(peer.nodeGet(node.id).review_status, "approved");
});

test("steward reminders survive restart and permit fresh material revisions without duplicates", async (t) => {
  const { db, squad, peer, create } = fixture(t);
  const node = create();
  const messages = () =>
    Number(db.prepare("SELECT COUNT(*) AS n FROM messages").get().n);
  for (let i = 0; i < 10; i++) await peer.stewardTick();
  const first = messages();
  const restarted = new Squad(db, "peer");
  for (let i = 0; i < 3; i++) await restarted.stewardTick();
  assert.equal(
    messages(),
    first,
    "restart must not repeat already-sent current-condition reminders",
  );
  squad.cardUpdate(node.id, { question: "A new material research revision?" });
  const afterEdit = messages();
  await restarted.stewardTick();
  assert.ok(
    messages() > afterEdit,
    "changed node revision may produce a new condition reminder",
  );
  assert.equal(squad.integrationAttempts().length, 0);
});

test("reminder cadence and lifetime cap remain effective across repeated steward ticks", async (t) => {
  const { db, peer, create } = fixture(t);
  create();
  for (let round = 0; round < 5; round++) {
    if (round)
      db.prepare("UPDATE steward_reminders SET last_sent_ms=?").run(
        Date.now() - 86400001,
      );
    await peer.stewardTick();
  }
  const rows = peer.stewardStatus().reminders;
  assert.ok(rows.length > 0);
  assert.ok(
    rows.every((row) => row.sends <= 3),
    "unchanged condition revision has a lifetime cap",
  );
  db.prepare("UPDATE steward_reminders SET last_sent_ms=?").run(
    Date.now() - 86400001,
  );
  const again = await peer.stewardTick();
  assert.equal(
    again.sent.length,
    0,
    "aging capped conditions must not bypass the lifetime cap",
  );
});

test("failed reminder delivery rolls back its durable deduplication record", async (t) => {
  const { db, peer, create } = fixture(t);
  create();
  db.exec(
    "CREATE TEMP TRIGGER deny_reminder BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'fixture message failure'); END",
  );
  await assert.rejects(
    async () => peer.stewardTick(),
    /fixture message failure/,
  );
  assert.equal(
    peer.stewardStatus().reminders.length,
    0,
    "unsent reminders must remain eligible after failure",
  );
  db.exec("DROP TRIGGER deny_reminder");
  const retry = await peer.stewardTick();
  assert.ok(retry.sent.length > 0);
  assert.equal(peer.stewardStatus().reminders.length, retry.sent.length);
});

test("expired directed requests do not suppress reminders to obtain fresh node review", async (t) => {
  const { db, squad, peer, create } = fixture(t);
  const node = create();
  const request = squad.nodeClaim(node.id, node.revision).review;
  db.prepare("UPDATE review_requests SET expires_ts=? WHERE id=?").run(
    "2000-01-01T00:00:00.000Z",
    request.id,
  );
  await peer.stewardTick();
  const reminders = peer.stewardStatus().reminders;
  assert.ok(reminders.some((row) => row.condition === "missing_review"));
  assert.ok(
    !reminders.some((row) => row.condition === "pending_review"),
    "expired request no longer gates reviewer",
  );
});

test("steward status exposes the durable review key needed for idempotent restart", async (t) => {
  const { db, squad, peer, create } = fixture(t);
  const node = create();
  const attempt = squad.nodeSubmit(node.id, node.revision, "steward-bank", 1);
  assert.equal((await squad.bank(attempt.id)).status, "verified");
  const request = squad.nodeClaim(node.id, node.revision).review;
  peer.reviewClaim(request.id);
  const input = {
    request_key: "preserved-review-key",
    attempt_id: attempt.id,
    verdict: "approve",
    rationale: "Independent fixture verification and judgment.",
  };
  const receipt = await peer.nodeReview(request.id, input);
  assert.equal(receipt.status, "approved");
  const restarted = new Squad(db, "peer");
  const current = restarted
    .stewardStatus()
    .nodes.find((item) => item.id === node.id);
  const recorded = current.reviews.find((item) => item.id === receipt.id);
  assert.equal(
    recorded.request_key,
    input.request_key,
    "restart must discover the original key rather than inventing another",
  );
  const resumed = await restarted.nodeReview(request.id, {
    ...input,
    request_key: recorded.request_key,
  });
  assert.equal(resumed.id, receipt.id);
  assert.equal(restarted.nodeGet(node.id).reviews.length, 1);
});
