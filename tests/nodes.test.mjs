import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { openDb, ROOM_TABLES, SCHEMA_VERSION } from "../dist/db.js";
import { Squad } from "../dist/core.js";
import { IntegrationLedger } from "../dist/integration-ledger.js";

const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
function room(t) {
  const root = mkdtempSync(join(tmpdir(), "squad-nodes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  process.env.SQUAD_DIR = join(root, "room");
  const db = openDb();
  t.after(() => {
    if (db.isOpen) db.close();
  });
  return { root, db, squad: new Squad(db, "author") };
}

test("node artifacts bind a real published build to an immutable content revision", async (t) => {
  const { root, db, squad } = room(t),
    repo = join(root, "repo"),
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
    {
      repository: repo,
      remote: "origin",
      branch: "main",
      build_command: "test -f proof.txt",
      steward: "author",
    },
    0,
  );
  const prerequisite = squad.cardCreate({
    title: "assumptions",
    question: "under which assumptions?",
  });
  const node = squad.nodeCreate({
    title: "lemma",
    question: "does it hold?",
    claim_kind: "formal",
    dependencies: [prerequisite.id],
    artifacts: [{ path: "proof.txt", commit, theorem: "lemma" }],
  });
  assert.equal(node.revision, 1);
  assert.equal(node.banked, false);
  const peer = new Squad(db, "peer");
  assert.deepEqual(peer.nodeGet(node.id), node);
  assert.ok(peer.join().nodes.some((n) => n.id === node.id));
  const attempt = squad.nodeSubmit(node.id, 1, "node-proof", 1);
  assert.deepEqual(squad.nodeSubmit(node.id, 1, "node-proof", 1), attempt);
  assert.deepEqual(attempt.selection, {
    paths: ["proof.txt"],
    theorem: "lemma",
  });
  assert.deepEqual(attempt.node_revisions, { [node.id]: 1 });
  assert.equal(squad.nodeGet(node.id).banked, false);
  const receipt = await squad.bank(attempt.id);
  assert.equal(receipt.status, "verified", JSON.stringify(receipt.evidence));
  const banked = peer.nodeGet(node.id);
  assert.equal(banked.banked, true);
  assert.equal(banked.review_status, "unreviewed");
  assert.equal(
    banked.revision,
    1,
    "bank receipts are not research content changes",
  );
  assert.equal(
    banked.integrations[0].integrated.commit,
    git(remote, "rev-parse", "main"),
  );
  assert.equal(banked.integrations[0].revision, 1);
  peer.cardEvidenceAdd(
    node.id,
    "formal-check",
    "proof.txt",
    "an additional evidentiary claim",
  );
  const revised = squad.nodeGet(node.id);
  assert.equal(revised.revision, 2);
  assert.equal(revised.integrations[0].current, false);
  assert.equal(revised.banked, false);
  assert.deepEqual(revised.revisions[0], node.revisions[0]);
  assert.throws(
    () => squad.nodeSubmit(node.id, 2, "node-proof", 1),
    /request key/,
  );
  assert.equal(squad.integrationAttempts().length, 1);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM node_integrations").get().n,
    1,
  );
});

test("schema-5 cards adopt one explicit baseline, retain evidence and unresolved old references", (t) => {
  const { db, squad } = room(t);
  const card = squad.cardCreate({
    title: "old",
    question: "what did we already learn?",
  });
  squad.cardTransition(card.id, "DIVERGE", "old history");
  squad.cardEvidenceAdd(card.id, "literature", "old paper", "old evidence");
  const before = squad.cardGet(card.id);
  db.exec(
    "DROP TABLE node_integrations; DROP TABLE node_metadata; DROP TABLE node_revisions; PRAGMA user_version=5",
  );
  db.close();
  const migrated = openDb();
  t.after(() => migrated.close());
  const next = new Squad(migrated, "new-agent");
  assert.deepEqual(next.cardGet(card.id), before);
  const node = next.nodeGet(card.id);
  assert.equal(node.revision, 1);
  assert.equal(node.revisions[0].origin, "adopted");
  assert.equal(node.revisions[0].actor, null);
  assert.equal(node.revisions[0].session_id, null);
  assert.equal(
    migrated.prepare("PRAGMA user_version").get().user_version,
    SCHEMA_VERSION,
  );
  next.cardUpdate(card.id, { question: "what is the next question?" });
  assert.equal(next.nodeGet(card.id).revision, 2);
  const reopened = openDb();
  t.after(() => reopened.close());
  assert.equal(new Squad(reopened, "other").nodeGet(card.id).revision, 2);
});

test("node snapshots and bindings round-trip; clear removes the graph and provenance", async (t) => {
  const { root, db, squad } = room(t);
  execFileSync("git", ["init", "-q", root]);
  git(root, "remote", "add", "origin", "https://example.org/research.git");
  squad.integrationSet(
    {
      repository: root,
      remote: "origin",
      branch: "main",
      build_command: "false",
      steward: "author",
    },
    0,
  );
  const node = squad.nodeCreate({
    title: "durable",
    question: "why?",
    artifacts: [{ path: "proof", commit: "a".repeat(40) }],
  });
  squad.nodeSubmit(node.id, 1, "bound", 1);
  const ledger = new IntegrationLedger(db, "legacy");
  const legacy = ledger.submit({
    request_key: "legacy",
    config_revision: 1,
    commits: ["a".repeat(40)],
    node_refs: ["future-node"],
  });
  assert.deepEqual(squad.integrationAttempt(legacy.id).node_refs, [
    "future-node",
  ]);
  assert.equal(squad.nodeGet(node.id).integrations.length, 1);
  assert.throws(
    () =>
      squad.integrationSubmit({
        request_key: "new-opaque",
        config_revision: 1,
        commits: ["a".repeat(40)],
        node_refs: ["future-node"],
      }),
    /node reference/,
  );
  const before = squad.nodeGet(node.id),
    file = join(root, "backup.db");
  await squad.exportRoom(file);
  squad.clear();
  for (const table of ROOM_TABLES)
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,
      0,
      table,
    );
  squad.importRoom(file);
  assert.deepEqual(squad.nodeGet(node.id), before);
  assert.deepEqual(squad.integrationAttempt(legacy.id).node_refs, [
    "future-node",
  ]);
});
