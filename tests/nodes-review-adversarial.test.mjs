import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openDb } from "../dist/db.js";
import { Squad } from "../dist/core.js";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "squad-node-review-adversarial-"));
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
  writeFileSync(
    join(repo, "check.mjs"),
    `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
const root = ${JSON.stringify(root)};
appendFileSync(root + "/builds", process.cwd() + "\\n");
if (existsSync(root + "/mode")) {
  const mode = readFileSync(root + "/mode", "utf8");
  if (mode === "wait") {
    writeFileSync(root + "/started", "ready");
    while (!existsSync(root + "/release")) await delay(10);
  }
  if (mode === "dirty") {
    execFileSync("git", ["update-index", "--assume-unchanged", "artifact.txt"]);
    writeFileSync("artifact.txt", "hidden edit\\n");
  }
}
if (!readFileSync("artifact.txt", "utf8").length) process.exit(1);
`,
  );
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
    otherDb = openDb();
  const squad = new Squad(db, "author"),
    peer = new Squad(db, "peer"),
    other = new Squad(otherDb, "editor");
  t.after(() => {
    otherDb.close();
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
      build_command: "node check.mjs",
      steward: "peer",
    },
    0,
  );
  const node = squad.nodeCreate({
    title: "Research claim",
    question: "What does this artifact establish?",
    artifacts: [{ path: "artifact.txt", commit }],
  });
  const bank = async () => {
    const attempt = squad.nodeSubmit(node.id, node.revision, "bank-node", 1);
    const result = await squad.bank(attempt.id);
    assert.equal(result.status, "verified");
    return result;
  };
  const builds = () =>
    readFileSync(join(root, "builds"), "utf8").trim().split("\n");
  return {
    root,
    repo,
    remote,
    git,
    db,
    otherDb,
    squad,
    peer,
    other,
    node,
    bank,
    builds,
  };
}

async function waitForBuild(root) {
  const until = Date.now() + 10000;
  while (!existsSync(join(root, "started"))) {
    if (Date.now() > until)
      throw new Error("review build did not reach its barrier");
    await delay(10);
  }
}

function reviewInput(attempt, key = "independent-review") {
  return {
    request_key: key,
    attempt_id: attempt.id,
    verdict: "approve",
    rationale:
      "Independently inspected the claim and reproduced its configured checks.",
  };
}

test("node claim reuses an active directed request and allows exploratory work before bank", (t) => {
  const { squad, peer, other, node } = fixture(t);
  const first = squad.nodeClaim(node.id, node.revision);
  const repeat = squad.nodeClaim(node.id, node.revision);
  assert.equal(first.review.id, repeat.review.id);
  assert.equal(first.review.target, "peer");
  assert.equal(peer.pendingReviews().length, 1);
  assert.equal(peer.nodeGet(node.id).banked, false);
  try {
    const foreign = other.nodeClaim(node.id, node.revision, "elsewhere");
    assert.equal(foreign.review.id, first.review.id);
    assert.equal(foreign.review.target, "peer");
  } catch (error) {
    assert.match(String(error), /active|pending|target|review|claim/i);
  }
  assert.equal(peer.reviewGet(first.review.id).status, "pending");
});

test("independent review performs a new isolated build without publishing or changing source", async (t) => {
  const { root, repo, remote, git, squad, peer, node, bank, builds } =
    fixture(t);
  const attempt = await bank();
  const request = squad.nodeClaim(node.id, node.revision).review;
  peer.reviewClaim(request.id);
  const sourceHead = git(repo, "rev-parse", "HEAD"),
    remoteHead = git(remote, "rev-parse", "refs/heads/main");
  const first = await peer.nodeReview(request.id, reviewInput(attempt));
  assert.equal(first.status, "approved");
  assert.equal(first.reviewer, "peer");
  assert.equal(first.revision, node.revision);
  assert.equal(first.attempt_id, attempt.id);
  assert.equal(
    builds().length,
    2,
    "bank receipt must not replace a new independent build",
  );
  assert.notEqual(
    builds()[0],
    builds()[1],
    "independent build gets its own checkout",
  );
  assert.notEqual(builds()[1], repo);
  assert.equal(git(repo, "rev-parse", "HEAD"), sourceHead);
  assert.equal(git(repo, "status", "--porcelain"), "");
  assert.equal(git(remote, "rev-parse", "refs/heads/main"), remoteHead);
  const replay = await peer.nodeReview(request.id, reviewInput(attempt));
  assert.equal(replay.id, first.id);
  assert.equal(
    builds().length,
    2,
    "completed idempotent retry must not rebuild or duplicate proof",
  );
  await assert.rejects(
    () =>
      peer.nodeReview(request.id, {
        ...reviewInput(attempt),
        rationale: "different payload",
      }),
    /key|payload|conflict|different/i,
  );
  squad.cardUpdate(node.id, {
    question: "A materially different research question?",
  });
  const current = peer.nodeGet(node.id);
  assert.notEqual(current.review_status, "approved");
  assert.ok(
    current.reviews.some(
      (review) =>
        review.id === first.id &&
        review.status === "approved" &&
        review.current === false,
    ),
  );
});

test("self-targeting and generic prose resolution cannot approve a node", async (t) => {
  const { squad, peer, node, bank } = fixture(t);
  const attempt = await bank();
  const own = squad.nodeClaim(node.id, node.revision, "author").review;
  squad.reviewClaim(own.id);
  await assert.rejects(
    () => squad.nodeReview(own.id, reviewInput(attempt, "self-proof")),
    /self|independent|author|review/i,
  );
  squad.reviewCancel(own.id, "Choose an independent reviewer");
  const request = squad.nodeClaim(node.id, node.revision).review;
  peer.reviewClaim(request.id);
  peer.reviewResolve(request.id, "Approved: trust my unverified assertion.");
  assert.notEqual(squad.nodeGet(node.id).review_status, "approved");
});

for (const change of ["content", "configuration", "cancellation"]) {
  test(`a ${change} change during independent build cannot confer current approval`, async (t) => {
    const { root, squad, peer, other, node, bank } = fixture(t);
    const attempt = await bank();
    const request = squad.nodeClaim(node.id, node.revision).review;
    peer.reviewClaim(request.id);
    writeFileSync(join(root, "mode"), "wait");
    const pending = peer.nodeReview(request.id, reviewInput(attempt));
    pending.catch(() => {}); // Observe early rejection while waiting for the build barrier.
    try {
      await waitForBuild(root);
      if (change === "content")
        other.cardUpdate(node.id, {
          question: "Changed while the reviewer was building?",
        });
      if (change === "configuration") {
        const prior = other.integrationGet();
        other.integrationSet(
          { ...prior.config, branch: "another-target" },
          prior.revision,
        );
      }
      if (change === "cancellation")
        squad.reviewCancel(request.id, "Withdraw during build");
    } finally {
      writeFileSync(join(root, "release"), "ready");
    }
    const result = await pending;
    assert.ok(
      ["stale", "cancelled"].includes(result.status),
      JSON.stringify(result),
    );
    assert.notEqual(peer.nodeGet(node.id).review_status, "approved");
    assert.ok(
      peer.nodeGet(node.id).reviews.some((review) => review.id === result.id),
      "completed build evidence remains in history",
    );
  });
}

test("independent verification rejects hidden physical edits despite successful build exit", async (t) => {
  const { root, squad, peer, node, bank } = fixture(t);
  const attempt = await bank();
  const request = squad.nodeClaim(node.id, node.revision).review;
  peer.reviewClaim(request.id);
  writeFileSync(join(root, "mode"), "dirty");
  const result = await peer.nodeReview(request.id, reviewInput(attempt));
  assert.equal(result.status, "failed");
  assert.notEqual(peer.nodeGet(node.id).review_status, "approved");
});

test("recovered terminal review receipt cannot be overwritten by its expired original runner", async (t) => {
  const { root, db, otherDb, squad, peer, node, bank } = fixture(t);
  const attempt = await bank();
  const request = squad.nodeClaim(node.id, node.revision).review;
  peer.reviewClaim(request.id);
  writeFileSync(join(root, "mode"), "wait");
  const pending = peer.nodeReview(
    request.id,
    reviewInput(attempt, "recover-review"),
  );
  pending.catch(() => {});
  let recovered, sealed;
  try {
    await waitForBuild(root);
    otherDb
      .prepare("UPDATE node_reviews SET lease_expires=0 WHERE request_key=?")
      .run("recover-review");
    recovered = await new Squad(otherDb, "peer").nodeReview(
      request.id,
      reviewInput(attempt, "recover-review"),
    );
    assert.equal(recovered.status, "failed");
    sealed = otherDb
      .prepare("SELECT receipt_json FROM node_reviews WHERE id=?")
      .get(recovered.id).receipt_json;
  } finally {
    writeFileSync(join(root, "release"), "ready");
  }
  await pending.catch((error) =>
    assert.match(String(error), /lease|runner|fenc|expired|completed/i),
  );
  assert.equal(
    db
      .prepare("SELECT receipt_json FROM node_reviews WHERE id=?")
      .get(recovered.id).receipt_json,
    sealed,
    "terminal recovery receipt must be immutable when the old build finishes",
  );
  assert.notEqual(peer.nodeGet(node.id).review_status, "approved");
});

test("unrelated branch advances preserve review while a later rejection supersedes historical approval", async (t) => {
  const { repo, git, squad, peer, node, bank } = fixture(t);
  const attempt = await bank();
  const firstRequest = squad.nodeClaim(node.id, node.revision).review;
  peer.reviewClaim(firstRequest.id);
  const approval = await peer.nodeReview(
    firstRequest.id,
    reviewInput(attempt, "first-verdict"),
  );
  assert.equal(approval.status, "approved");
  git(repo, "fetch", "-q", "origin", "main");
  git(repo, "checkout", "-q", "-B", "unrelated", "FETCH_HEAD");
  writeFileSync(join(repo, "unrelated.txt"), "Other research node\n");
  git(repo, "add", "unrelated.txt");
  git(repo, "commit", "-qm", "unrelated integration work");
  git(repo, "push", "-q", "origin", "HEAD:main");
  assert.equal(peer.nodeGet(node.id).review_status, "approved");
  const secondRequest = squad.nodeClaim(node.id, node.revision).review;
  assert.notEqual(secondRequest.id, firstRequest.id);
  peer.reviewClaim(secondRequest.id);
  const rejection = await peer.nodeReview(secondRequest.id, {
    ...reviewInput(attempt, "second-verdict"),
    verdict: "reject",
    rationale:
      "Reproduction passes, but further inspection found the scientific inference unsupported.",
  });
  assert.equal(rejection.status, "rejected");
  const current = peer.nodeGet(node.id);
  assert.equal(
    current.review_status,
    "rejected",
    "new rejection must not be hidden by an earlier approval",
  );
  assert.ok(
    current.reviews.some(
      (review) => review.id === approval.id && review.status === "approved",
    ),
    "historical approval remains queryable",
  );
});

test("review binding and immutable build receipts survive export/import and clear", async (t) => {
  const { squad, peer, node, bank, root, db } = fixture(t);
  const attempt = await bank();
  const request = squad.nodeClaim(node.id, node.revision).review;
  peer.reviewClaim(request.id);
  const receipt = await peer.nodeReview(request.id, reviewInput(attempt));
  assert.equal(receipt.status, "approved");
  const before = squad.nodeGet(node.id);
  const backup = join(root, "review-export.db");
  await squad.exportRoom(backup);
  squad.clear();
  for (const table of [
    "node_reviews",
    "node_review_requests",
    "node_review_builds",
  ])
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  squad.importRoom(backup);
  assert.deepEqual(squad.nodeGet(node.id), before);
  assert.deepEqual(
    await peer.nodeReview(request.id, reviewInput(attempt)),
    receipt,
  );
});

test("renaming a contributing session cannot make it an independent reviewer", async (t) => {
  const { squad, node, bank } = fixture(t);
  const attempt = await bank();
  const request = squad.nodeClaim(
    node.id,
    node.revision,
    "renamed-author",
  ).review;
  squad.setPersona("renamed-author");
  squad.reviewClaim(request.id);
  await assert.rejects(
    squad.nodeReview(request.id, reviewInput(attempt)),
    /author|independen|own/,
  );
});

test("reviewer rename during build retains evidence without resolving as another identity", async (t) => {
  const { root, squad, peer, node, bank } = fixture(t);
  const attempt = await bank();
  const request = squad.nodeClaim(node.id, node.revision).review;
  peer.reviewClaim(request.id);
  writeFileSync(join(root, "mode"), "wait");
  const pending = peer.nodeReview(request.id, reviewInput(attempt));
  pending.catch(() => {});
  try {
    await waitForBuild(root);
    peer.setPersona("renamed-reviewer");
  } finally {
    writeFileSync(join(root, "release"), "ready");
  }
  const receipt = await pending;
  assert.equal(receipt.status, "stale");
  assert.equal(receipt.reviewer, "peer");
  assert.equal(receipt.build.exit_code, 0);
  assert.equal(squad.reviewGet(request.id).status, "claimed");
  assert.ok(
    squad
      .nodeGet(node.id)
      .reviews.some((r) => r.id === receipt.id && r.build.clean),
  );
  assert.notEqual(squad.nodeGet(node.id).review_status, "approved");
});

test("two independent clones bank and review committed artifacts absent from configured checkout", async (t) => {
  const { root, repo, remote, git, squad, peer, node, bank, builds } =
    fixture(t);
  git(repo, "checkout", "main");
  const author = join(root, "author");
  execFileSync("git", ["clone", "-q", repo, author]);
  git(author, "config", "user.name", "Author");
  git(author, "config", "user.email", "author@example.org");
  writeFileSync(join(author, "artifact.txt"), "independent research\n");
  writeFileSync(join(author, "new-proof.txt"), "new proof\n");
  writeFileSync(join(author, "unselected.txt"), "excluded\n");
  git(author, "add", ".");
  git(author, "commit", "-qm", "independent artifacts");
  const commit = git(author, "rev-parse", "HEAD");
  git(author, "push", "-q", "origin", "HEAD:refs/heads/author-artifacts");
  const updated = squad.nodeUpdate(node.id, node.revision, {
    artifacts: ["artifact.txt", "new-proof.txt"].map((path) => ({ path, commit })),
  });
  node.revision = updated.revision;
  const index = readFileSync(join(repo, ".git", "index"));
  assert.equal(existsSync(join(repo, "new-proof.txt")), false);
  const submission = squad.nodeSubmit(node.id, node.revision, "two-clone-bank", 1);
  const attempt = await squad.bank(submission.id);
  assert.equal(attempt.status, "verified", JSON.stringify(attempt.evidence));
  assert.equal(git(remote, "show", "main:artifact.txt"), "independent research");
  assert.equal(git(remote, "show", "main:new-proof.txt"), "new proof");
  assert.equal(git(remote, "ls-tree", "main", "--", "unselected.txt"), "");
  assert.equal(existsSync(join(repo, "new-proof.txt")), false);
  assert.deepEqual(readFileSync(join(repo, ".git", "index")), index);
  assert.equal(git(author, "status", "--porcelain"), "");
  const request = squad.nodeClaim(node.id, node.revision).review;
  peer.reviewClaim(request.id);
  const sourceHead = git(repo, "rev-parse", "HEAD"),
    remoteHead = git(remote, "rev-parse", "refs/heads/main");
  const first = await peer.nodeReview(request.id, reviewInput(attempt));
  assert.equal(first.status, "approved");
  assert.equal(first.reviewer, "peer");
  assert.equal(first.revision, node.revision);
  assert.equal(first.attempt_id, attempt.id);
  assert.equal(
    builds().length,
    2,
    "bank receipt must not replace a new independent build",
  );
  assert.notEqual(
    builds()[0],
    builds()[1],
    "independent build gets its own checkout",
  );
  assert.notEqual(builds()[1], repo);
  assert.equal(git(repo, "rev-parse", "HEAD"), sourceHead);
  assert.equal(git(repo, "status", "--porcelain"), "");
  assert.equal(git(remote, "rev-parse", "refs/heads/main"), remoteHead);
  const replay = await peer.nodeReview(request.id, reviewInput(attempt));
  assert.equal(replay.id, first.id);
  assert.equal(
    builds().length,
    2,
    "completed idempotent retry must not rebuild or duplicate proof",
  );
  await assert.rejects(
    () =>
      peer.nodeReview(request.id, {
        ...reviewInput(attempt),
        rationale: "different payload",
      }),
    /key|payload|conflict|different/i,
  );
  squad.cardUpdate(node.id, {
    question: "A materially different research question?",
  });
  const current = peer.nodeGet(node.id);
  assert.notEqual(current.review_status, "approved");
  assert.ok(
    current.reviews.some(
      (review) =>
        review.id === first.id &&
        review.status === "approved" &&
        review.current === false,
    ),
  );
});
