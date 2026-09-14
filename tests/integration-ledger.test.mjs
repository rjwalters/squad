import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { openDb, SCHEMA_VERSION } from "../dist/db.js";
import { Squad } from "../dist/core.js";
import { IntegrationLedger } from "../dist/integration-ledger.js";

const commit = "a".repeat(40),
  tree = "b".repeat(40),
  base = "c".repeat(40);
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "squad-ledger-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", [
    "-C",
    dir,
    "remote",
    "add",
    "origin",
    "https://example.org/research.git",
  ]);
  process.env.SQUAD_DIR = join(dir, "room");
  const db = openDb();
  t.after(() => db.close());
  const squad = new Squad(db, "alice"),
    ledger = new IntegrationLedger(db, "executor");
  const config = squad.integrationSet(
    {
      repository: dir,
      remote: "origin",
      branch: "main",
      build_command: "false",
      steward: "alice",
    },
    0,
  );
  const input = {
    request_key: "selection-1",
    config_revision: config.revision,
    commits: [commit],
    node_refs: [],
  };
  const submit = () => squad.integrationSubmit(input);
  return { dir, db, squad, ledger, config, input, submit };
}
function execution(ledger, attempt) {
  const { token } = ledger.claim(attempt.id);
  const append = (event) => {
    attempt = ledger.append(attempt.id, attempt.revision, event, token);
    return attempt;
  };
  const candidate = { kind: "candidate", commit, tree, base };
  const build = {
    kind: "build",
    commit,
    tree,
    command: attempt.config.build_command,
    exit_code: 0,
    clean: true,
    output: "build passed",
    started_ts: "2026-01-01T00:00:00Z",
    finished_ts: "2026-01-01T00:00:01Z",
  };
  const intent = {
    kind: "publication_intent",
    commit,
    tree,
    remote_url: attempt.config.remote_url,
    branch: attempt.config.branch,
  };
  const receipt = { ...intent, kind: "publication", observed_commit: commit };
  return {
    token,
    append,
    candidate,
    build,
    intent,
    receipt,
    get: () => ledger.get(attempt.id),
    verify: () => ledger.verify(attempt.id, attempt.revision, token),
  };
}

test("submission is pending and key-idempotent across actors and configuration changes; chat is not evidence", (t) => {
  const { squad, db, input, submit } = fixture(t);
  const attempt = submit();
  assert.equal(attempt.status, "pending");
  assert.equal(attempt.submitted_by, "alice");
  assert.deepEqual(attempt.evidence, []);
  squad.send("banked: build passes and publication done");
  const peer = new Squad(db, "bob");
  assert.deepEqual(peer.integrationSubmit(input), attempt);
  assert.deepEqual(peer.integrationAttempts({ status: "verified" }), []);
  assert.throws(
    () => peer.integrationSubmit({ ...input, commits: [tree] }),
    /different submission/,
  );
  squad.integrationUnset(1);
  assert.deepEqual(submit(), attempt);
  assert.throws(
    () => squad.integrationSubmit({ ...input, request_key: "new" }),
    /not configured/,
  );
  assert.throws(
    () => squad.integrationSubmit({ ...input, config_revision: 2 }),
    /different submission/,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM integration_attempts").get().n,
    1,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM science_cards").get().n,
    0,
  );
});

test("trusted finalization requires candidate, clean exact build and subsequent exact publication; verified retries do not duplicate receipts", (t) => {
  const { ledger, submit, squad } = fixture(t);
  const attempt = submit(),
    run = execution(ledger, attempt);
  assert.throws(run.verify, /missing candidate/);
  run.append(run.candidate);
  assert.throws(run.verify, /matching successful/);
  run.append(run.build);
  run.append(run.intent);
  assert.throws(run.verify, /matching successful/);
  run.append(run.receipt);
  const verified = run.verify();
  assert.equal(verified.status, "verified");
  assert.equal(verified.evidence.at(-1).event.kind, "verified");
  assert.deepEqual(ledger.verify(attempt.id, 0, run.token), verified);
  assert.deepEqual(submit(), verified);
  assert.equal(squad.integrationAttempts({ status: "verified" }).length, 1);
  assert.throws(() => run.append(run.candidate), /revision changed|immutable/);
  assert.equal(verified.evidence.length, 5);
  assert.ok(verified.evidence.every((e) => e.actor === "executor" && e.run_id));
});

test("mismatched evidence, dirty builds, negative/null exits, wrong targets and reversed publication order cannot verify", (t) => {
  const { ledger, squad, input } = fixture(t);
  const variants = [
    { build: { commit: tree } },
    { build: { tree: commit } },
    { build: { command: "true" } },
    { build: { clean: false } },
    { build: { exit_code: 1 } },
    { build: { exit_code: null } },
    { intent: { branch: "wrong" } },
    { receipt: { remote_url: "https://example.org/other.git" } },
    { receipt: { observed_commit: tree } },
    { receipt: { tree: commit } },
    { reversed: true },
  ];
  for (const [i, variant] of variants.entries()) {
    const run = execution(
      ledger,
      squad.integrationSubmit({ ...input, request_key: `bad-${i}` }),
    );
    run.append(run.candidate);
    run.append({ ...run.build, ...variant.build });
    if (variant.reversed) run.append(run.receipt);
    run.append({ ...run.intent, ...variant.intent });
    if (!variant.reversed) run.append({ ...run.receipt, ...variant.receipt });
    assert.throws(run.verify, /matching successful/);
    assert.equal(run.get().status, "pending");
  }
});

test("new candidate and explicit retry cannot reuse old successes; failures and bounded logs remain visible", (t) => {
  const { ledger, submit } = fixture(t);
  const run = execution(ledger, submit());
  run.append(run.candidate);
  run.append({ ...run.build, output: "x".repeat(70_000) });
  run.append(run.intent);
  run.append(run.receipt);
  run.append({
    kind: "failure",
    stage: "publication",
    message: "transport interrupted before confirmation",
  });
  assert.equal(run.get().status, "failed");
  assert.throws(run.verify, /failed attempt/);
  assert.throws(() => run.append(run.candidate), /retry failed/);
  const failedRun = run.get().evidence[0].run_id;
  run.append({ kind: "retry", reason: "reconcile the failed attempt" });
  assert.notEqual(run.get().evidence.at(-1).run_id, failedRun);
  assert.throws(run.verify, /missing candidate/);
  run.append({ ...run.candidate, base: null });
  assert.throws(run.verify, /matching successful/);
  const oldBuild = run.get().evidence[1].event;
  assert.equal(oldBuild.output.length, 65_536);
  assert.equal(oldBuild.output_truncated, true);
  assert.equal(
    run.get().evidence.filter((e) => e.event.kind === "failure").length,
    1,
  );
});

test("runner claims fence concurrent and expired writers, preserving recoverable run identity on takeover", (t) => {
  const { ledger, submit, db } = fixture(t);
  const attempt = submit(),
    run = execution(ledger, attempt);
  run.append(run.candidate);
  run.append(run.build);
  run.append(run.intent);
  assert.throws(() => ledger.claim(attempt.id), /active runner/);
  assert.throws(
    () => ledger.append(attempt.id, 3, run.receipt, "other"),
    /expired or superseded/,
  );
  ledger.renew(attempt.id, run.token);
  db.prepare(
    "UPDATE integration_runners SET expires_ms = 0 WHERE attempt_id = ?",
  ).run(attempt.id);
  assert.throws(
    () => ledger.renew(attempt.id, run.token),
    /expired or superseded/,
  );
  const next = ledger.claim(attempt.id);
  assert.notEqual(next.token, run.token);
  assert.throws(
    () => ledger.release(attempt.id, run.token),
    /expired or superseded/,
  );
  assert.throws(
    () => ledger.append(attempt.id, 2, run.receipt, next.token),
    /revision changed/,
  );
  const recovered = ledger.append(
    attempt.id,
    3,
    { ...run.receipt, observed_commit: tree, candidate_reachable: true },
    next.token,
  );
  assert.equal(recovered.evidence[0].run_id, recovered.evidence.at(-1).run_id);
  assert.equal(ledger.verify(attempt.id, 4, next.token).status, "verified");
});

test("configuration changes cannot retarget a pending attempt and stale new submissions are rejected", (t) => {
  const { squad, ledger, submit, input, config } = fixture(t);
  const run = execution(ledger, submit());
  squad.integrationSet(
    { ...config.config, branch: "other", build_command: "different" },
    1,
  );
  assert.throws(
    () => squad.integrationSubmit({ ...input, request_key: "stale" }),
    /revision changed/,
  );
  run.append(run.candidate);
  run.append(run.build);
  run.append(run.intent);
  run.append(run.receipt);
  assert.equal(run.verify().config.branch, "main");
});

test("all evidence and runner recovery state survive export/import, while clear removes it", async (t) => {
  const { squad, ledger, submit, input, dir, db } = fixture(t);
  const good = execution(ledger, submit());
  good.append(good.candidate);
  good.append(good.build);
  good.append(good.intent);
  good.append(good.receipt);
  good.verify();
  const bad = execution(
    ledger,
    squad.integrationSubmit({ ...input, request_key: "failure" }),
  );
  bad.append({
    kind: "failure",
    stage: "build",
    message: "compiler rejected lemma",
  });
  ledger.release(bad.get().id, bad.token);
  squad.integrationSubmit({ ...input, request_key: "pending" });
  const before = squad.integrationAttempts();
  const snapshot = join(dir, "snapshot.db");
  await squad.exportRoom(snapshot);
  squad.clear();
  for (const table of [
    "integration_attempts",
    "integration_events",
    "integration_runners",
  ])
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  squad.importRoom(snapshot);
  assert.deepEqual(squad.integrationAttempts(), before);
  const reclaimed = ledger.claim(bad.get().id);
  assert.ok(reclaimed.token);
  assert.deepEqual(submit(), good.get());
});

test("schema-4 migration keeps room state and adds empty ledger; malformed public requests have no side effects", (t) => {
  const { squad, input, db } = fixture(t);
  squad.goalAdd("keep this goal");
  db.exec(
    "DROP TABLE integration_attempts; DROP TABLE integration_events; DROP TABLE integration_runners; PRAGMA user_version = 4;",
  );
  const migrated = openDb();
  t.after(() => migrated.close());
  const peer = new Squad(migrated, "bob");
  assert.equal(
    migrated.prepare("PRAGMA user_version").get().user_version,
    SCHEMA_VERSION,
  );
  assert.equal(peer.goals()[0].body, "keep this goal");
  assert.deepEqual(peer.integrationAttempts(), []);
  for (const fields of [
    { commits: ["HEAD"] },
    { commits: [] },
    { commits: [commit, commit] },
    { config_revision: -1 },
    { node_refs: [""] },
  ])
    assert.throws(() => peer.integrationSubmit({ ...input, ...fields }));
  assert.throws(
    () => peer.integrationAttempts({ status: "banked" }),
    /invalid status/,
  );
  assert.throws(() => peer.integrationAttempts({ limit: 0 }), /limit/);
  for (const args of [
    ["submit"],
    ["attempt"],
    ["attempts", "--status", "banked"],
    [
      "submit",
      "--request-key",
      "x",
      "--config-revision",
      "1",
      "--commit",
      "HEAD",
    ],
    ["verify", "anything"],
  ]) {
    const result = spawnSync(
      process.execPath,
      ["dist/index.js", "integration", ...args],
      { encoding: "utf8", env: process.env },
    );
    assert.equal(result.status, 1, result.stdout);
  }
  assert.deepEqual(peer.integrationAttempts(), []);
});
