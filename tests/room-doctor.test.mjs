import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { openDb } from "../dist/db.js";
import { Squad } from "../dist/core.js";
import { commitExistsLocally } from "../dist/room-doctor.js";

const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** A room with no integration configured -- cheapest fixture, used by
 * scenarios that do not need a real git remote (stale reviews/claims, an
 * unconfigured/partially-observable room, chat claim scanning). */
function bareRoom(t) {
  const root = mkdtempSync(join(tmpdir(), "squad-room-doctor-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  process.env.SQUAD_DIR = join(root, "room");
  const db = openDb();
  t.after(() => {
    if (db.isOpen) db.close();
  });
  return { root, db, squad: new Squad(db, "keeper") };
}

/** A room with a real git repository + bare remote configured as the
 * integration target, mirroring tests/bank.test.mjs and tests/nodes.test.mjs. */
function gitRoom(t, buildCommand) {
  const { root, db, squad } = bareRoom(t);
  const repo = join(root, "repo"),
    remote = join(root, "remote.git");
  execFileSync("git", ["init", "--bare", "-q", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.org");
  writeFileSync(join(repo, "base"), "baseline");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "origin", "main");
  writeFileSync(join(repo, "proof.txt"), "proof\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "proof");
  const commit = git(repo, "rev-parse", "HEAD");
  squad.integrationSet(
    { repository: repo, remote: "origin", branch: "main", build_command: buildCommand, steward: "keeper" },
    0,
  );
  return { root, repo, remote, commit, db, squad };
}

function findings(report, category) {
  return report.findings.filter((f) => f.category === category);
}

test("healthy room: banked and independently reviewed node, published outline, truthful chat mention -- no drift", async (t) => {
  const { db, squad, commit } = gitRoom(t, "test -f proof.txt");
  const peer = new Squad(db, "reviewer");
  const node = squad.nodeCreate({
    title: "lemma",
    question: "does it hold?",
    artifacts: [{ path: "proof.txt", commit }],
  });
  const attempt = squad.nodeSubmit(node.id, node.revision, "req", 1);
  const receipt = await squad.bank(attempt.id);
  assert.equal(receipt.status, "verified", JSON.stringify(receipt.evidence));
  const request = squad.nodeClaim(node.id, node.revision, "reviewer").review;
  peer.reviewClaim(request.id);
  const review = await peer.nodeReview(request.id, {
    request_key: "independent-review",
    attempt_id: attempt.id,
    verdict: "approve",
    rationale: "Independently inspected the claim and reproduced its configured checks.",
  });
  assert.equal(review.status, "approved", JSON.stringify(review));
  const published = await squad.outlinePublish({ request_key: "outline-req" });
  assert.equal(published.attempt.status, "verified", JSON.stringify(published.attempt.evidence));
  // A truthful chat "banked" claim, correctly referencing the now-banked node,
  // must never be reported as a mismatch.
  squad.send(`keeper banked node #${node.id} after review`);

  const report = squad.roomDoctor();
  assert.equal(report.configured, true);
  assert.equal(report.outline.fresh, true);
  assert.deepEqual(report.summary.by_severity, { info: 0, warning: 0, critical: 0 });
  assert.equal(report.summary.healthy, true, JSON.stringify(report.findings));
  assert.equal(report.findings.length, 0);
  assert.equal(report.branch_observations.length, 1);
  assert.equal(report.branch_observations[0].classification, "verified_clean");

  // Calling again without any write in between must agree exactly on shape.
  const again = squad.roomDoctor();
  assert.deepEqual(
    again.findings.map((f) => f.category),
    report.findings.map((f) => f.category),
  );
  assert.equal(again.summary.healthy, report.summary.healthy);
});

test("drifting room: declared artifact commit unreachable, never submitted", (t) => {
  const { squad } = gitRoom(t, "true");
  const fabricated = "a".repeat(40); // well-formed SHA, but no such object anywhere
  const node = squad.nodeCreate({
    title: "conjecture",
    question: "still open?",
    artifacts: [{ path: "somewhere.lean", commit: fabricated }],
  });

  const report = squad.roomDoctor();
  assert.equal(report.summary.healthy, false);

  const unbanked = findings(report, "unbanked_work");
  assert.equal(unbanked.length, 1);
  assert.match(unbanked[0].evidence, /no submission recorded/);
  assert.match(unbanked[0].next_step, new RegExp(`squad node submit ${node.id}`));

  assert.match(
    findings(report, "outline_divergence")[0].evidence,
    /no verified publication has ever been recorded/,
  );

  assert.equal(report.branch_observations.length, 1);
  assert.equal(report.branch_observations[0].classification, "unreachable");
  assert.match(report.branch_observations[0].evidence, /not present in the configured integration repository/);
});

test("stale room: review request and claim both past the 24h threshold", (t) => {
  const { db, squad } = bareRoom(t);
  const node = squad.nodeCreate({ title: "lemma", question: "why?" });
  // nodeClaim both opens a directed review request AND takes an advisory
  // claim on the node (`node:<id>`) -- both age out together here.
  squad.nodeClaim(node.id, node.revision, "reviewer");
  const oldTs = new Date(Date.now() - 30 * 3600_000).toISOString();
  db.prepare("UPDATE review_requests SET created_ts=?").run(oldTs);
  db.prepare("UPDATE claims SET created_ts=?").run(oldTs);

  const report = squad.roomDoctor();
  const overdue = findings(report, "overdue_review");
  assert.equal(overdue.length, 1);
  assert.equal(overdue[0].severity, "warning"); // aged, not past an explicit expiry
  assert.ok(overdue[0].age_ms >= 24 * 3600_000);
  assert.match(overdue[0].next_step, /squad review claim/);

  // nodeClaim's own advisory claim on `node:<id>` is the only claim here, and
  // it aged out along with the review request above.
  const hygiene = findings(report, "claim_hygiene");
  assert.equal(hygiene.length, 1);
  assert.match(hygiene[0].summary, /node:1/);
  assert.match(hygiene[0].evidence, /older than 24 hours/);

  // missing_review must not also fire: the (aged) request is still open.
  assert.equal(findings(report, "missing_review").length, 0);
});

test("failed-build room: observed locally but not banked, distinct from unreachable", async (t) => {
  const { squad, commit } = gitRoom(t, "echo bad; exit 7");
  const node = squad.nodeCreate({
    title: "lemma",
    question: "does it hold?",
    artifacts: [{ path: "proof.txt", commit }],
  });
  const attempt = squad.nodeSubmit(node.id, node.revision, "req", 1);
  const receipt = await squad.bank(attempt.id);
  assert.equal(receipt.status, "failed");

  const report = squad.roomDoctor();
  const unbanked = findings(report, "unbanked_work");
  assert.equal(unbanked.length, 1);
  assert.equal(unbanked[0].severity, "critical");
  assert.match(unbanked[0].evidence, new RegExp(`attempt ${attempt.id} status=failed`));

  const attemptFindings = findings(report, "integration_attempt");
  assert.equal(attemptFindings.length, 1);
  assert.equal(attemptFindings[0].severity, "critical");
  assert.match(attemptFindings[0].evidence, /exit_code=7/);

  assert.equal(report.branch_observations.length, 1);
  assert.equal(
    report.branch_observations[0].classification,
    "observed_unbanked",
    "a build that ran and failed is observed, not unreachable",
  );
});

test("partially observable room: no integration configured, reachability cannot be determined", (t) => {
  const { squad } = bareRoom(t);
  const node = squad.nodeCreate({
    title: "conjecture",
    question: "still open?",
    artifacts: [{ path: "somewhere.lean", commit: "b".repeat(40) }],
  });

  const report = squad.roomDoctor();
  assert.equal(report.configured, false);
  assert.equal(report.branch_observations.length, 1);
  assert.equal(report.branch_observations[0].classification, "unobserved");
  assert.match(report.branch_observations[0].evidence, /no integration target is configured/);
  assert.match(
    findings(report, "unbanked_work")[0].next_step,
    /squad integration set/,
  );
});

test("chat banking claims are cross-checked against the ledger, not taken on faith", (t) => {
  const { squad } = bareRoom(t);
  const node = squad.nodeCreate({
    title: "conjecture",
    question: "still open?",
    artifacts: [{ path: "somewhere.lean", commit: "c".repeat(40) }],
  });
  squad.send(`alice says this is banked now, right? #${node.id}`);
  squad.send("I believe everything got banked earlier today"); // "banked", no resolvable ref
  squad.send(`node #${node.id} is still WIP, not done`); // no "bank" word: never a finding

  const report = squad.roomDoctor();
  const mismatches = findings(report, "banking_claim_mismatch");
  const warnings = mismatches.filter((f) => f.severity === "warning");
  const info = mismatches.filter((f) => f.severity === "info");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].evidence, new RegExp(`node ${node.id} revision`));
  assert.equal(info.length, 1);
  assert.match(info[0].summary, /does not reference a resolvable node ID/);
});

test("CLI: squad doctor --room is documented, wired, and read-only", (t) => {
  const root = mkdtempSync(join(tmpdir(), "squad-room-doctor-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, SQUAD_DIR: root, SQUAD_PERSONA: "human" };
  const run = (...args) =>
    spawnSync(process.execPath, ["dist/index.js", ...args], { encoding: "utf8", env });

  const help = run("--help");
  assert.match(help.stdout, /squad doctor --room/);

  const before = run("read", "-n", "50");
  const room = run("doctor", "--room");
  assert.equal(room.status, 0, room.stdout + room.stderr);
  assert.match(room.stdout, /read-only room drift report/);
  assert.match(room.stdout, /== Unbanked work/);
  assert.match(room.stdout, /== Branch observations/);
  const after = run("read", "-n", "50");
  assert.equal(before.stdout, after.stdout, "doctor --room must never write to the room");

  const bad = run("doctor", "--room", "extra");
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /usage: squad doctor/);
});

test("commitExistsLocally: a confirmed-absent object is distinct from a repository it cannot even inspect", (t) => {
  const root = mkdtempSync(join(tmpdir(), "squad-commit-exists-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.org");
  writeFileSync(join(repo, "f"), "hi\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "c");
  const commit = git(repo, "rev-parse", "HEAD");

  assert.equal(commitExistsLocally(repo, commit), true);
  // Well-formed SHA, valid repository, object genuinely absent -- a
  // confident "not reachable" answer, so this must return false, not throw.
  assert.equal(commitExistsLocally(repo, "a".repeat(40)), false);
  // Repository path itself is gone -- the check could not even run, so this
  // must throw (the caller reports "unobserved"), never silently return false
  // as if the object had been confidently ruled absent.
  assert.throws(() => commitExistsLocally(join(root, "does-not-exist"), "a".repeat(40)));
});

test("partially observable room: configured repository is inaccessible, distinct from a confirmed-unreachable commit", (t) => {
  // gitRoom's own cleanup (t.after) removes `root`, which still exists after
  // this rmSync -- only the configured `repo` subdirectory vanishes here.
  const { squad, repo } = gitRoom(t, "true");
  // The repository becomes inaccessible after configuration (e.g. an
  // unmounted network drive) -- reachability cannot even be attempted, which
  // must never be reported the same way as a commit that was checked and
  // confirmed absent.
  rmSync(repo, { recursive: true, force: true });
  const node = squad.nodeCreate({
    title: "conjecture",
    question: "still open?",
    artifacts: [{ path: "somewhere.lean", commit: "d".repeat(40) }],
  });

  const report = squad.roomDoctor();
  assert.equal(report.configured, true);
  assert.equal(report.branch_observations.length, 1);
  assert.equal(report.branch_observations[0].node_id, node.id);
  assert.equal(report.branch_observations[0].classification, "unobserved");
  assert.match(report.branch_observations[0].evidence, /could not be inspected/);
});

test("chat mentions of banking that are not assertions of current state never become a mismatch", (t) => {
  const { squad } = bareRoom(t);
  const node = squad.nodeCreate({
    title: "conjecture",
    question: "still open?",
    artifacts: [{ path: "somewhere.lean", commit: "e".repeat(40) }],
  });
  squad.send(`node #${node.id} is not banked yet, still working on it`); // negation
  squad.send(`please bank #${node.id} once you get a chance`); // request/intent
  squad.send(`is #${node.id} banked?`); // genuine question -- uncertain, not asserted

  squad.send(`Banking node #${node.id} failed.`);
  squad.send(`I will bank node #${node.id} tomorrow.`);
  squad.send(`The bank status for node #${node.id} is pending.`);

  const report = squad.roomDoctor();
  assert.equal(
    findings(report, "banking_claim_mismatch").length,
    0,
    JSON.stringify(findings(report, "banking_claim_mismatch")),
  );
});

test("chat claims about a superseded revision are not compared against the current, still-unbanked one", async (t) => {
  const { squad, repo, commit } = gitRoom(t, "test -f proof.txt");
  const node = squad.nodeCreate({
    title: "lemma",
    question: "does it hold?",
    artifacts: [{ path: "proof.txt", commit }],
  });
  const bankedRevision = node.revision;
  const attempt = squad.nodeSubmit(node.id, node.revision, "req", 1);
  const receipt = await squad.bank(attempt.id);
  assert.equal(receipt.status, "verified", JSON.stringify(receipt.evidence));

  squad.send(`node #${node.id} was banked after review`);
  // Ensure this historical message precedes the next durable revision.
  await new Promise((resolve) => setTimeout(resolve, 5));
  writeFileSync(join(repo, "proof.txt"), "revised proof\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "revise proof");
  const revisedCommit = git(repo, "rev-parse", "HEAD");
  const updated = squad.nodeUpdate(node.id, node.revision, {
    artifacts: [{ path: "proof.txt", commit: revisedCommit }],
  });
  assert.equal(updated.banked, false);
  assert.ok(updated.revision > bankedRevision);

  // Historically accurate: revision `bankedRevision` really was banked. The
  // *current* revision is unbanked, but this claim is about the earlier one
  // and must not be compared against the current state.
  squad.send(`node #${node.id} revision ${bankedRevision} was banked after review`);

  const report = squad.roomDoctor();
  assert.equal(
    findings(report, "banking_claim_mismatch").length,
    0,
    JSON.stringify(findings(report, "banking_claim_mismatch")),
  );
});

test("MCP: squad_room_doctor is registered as a read-only tool", () => {
  const mcpSrc = readFileSync("src/mcp.ts", "utf8");
  assert.match(mcpSrc, /registerTool\(\s*"squad_room_doctor"/);
});


test("CLI doctor neither reserves runtime identities nor migrates or creates a room", (t) => {
  const { root, db, squad } = bareRoom(t);
  squad.nodeCreate({ title: "existing work", question: "preserve?" });
  const env = { ...process.env, SQUAD_SESSION_ID: "doctor-read-only-session" };
  delete env.SQUAD_PERSONA;
  const run = (...args) => spawnSync(process.execPath, ["dist/index.js", ...args], { encoding: "utf8", env });
  const snapshot = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()]);
  const before = snapshot();
  const result = run("doctor", "--room");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(snapshot(), before, "every durable table must remain unchanged");
  db.exec("PRAGMA user_version = 1");
  const oldSchema = run("doctor", "--room");
  assert.notEqual(oldSchema.status, 0);
  assert.match(oldSchema.stderr, /schema 1.*expected/);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 1);
  assert.deepEqual(snapshot(), before);
  env.SQUAD_DIR = join(root, "absent-room");
  assert.notEqual(run("doctor", "--room").status, 0);
  assert.equal(existsSync(env.SQUAD_DIR), false);
  assert.notEqual(run("doctor", "--room", "extra").status, 0);
  assert.equal(existsSync(env.SQUAD_DIR), false);
});
