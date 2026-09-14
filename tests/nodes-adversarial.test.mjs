import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../dist/db.js";
import { Squad } from "../dist/core.js";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "squad-nodes-adversarial-"));
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

test("legacy card edits, evidence and transitions revise the same node without rewriting history", (t) => {
  const { squad, peer } = fixture(t);
  const card = squad.cardCreate({
    title: "Existing card",
    question: "Original question?",
  });
  const original = peer.nodeGet(card.id),
    history = JSON.stringify(original.revisions);
  squad.cardUpdate(card.id, { question: "Revised question?" });
  const edited = peer.nodeGet(card.id);
  assert.equal(edited.id, card.id);
  assert.ok(edited.revision > original.revision);
  assert.equal(
    JSON.stringify(edited.revisions.slice(0, original.revisions.length)),
    history,
  );
  squad.cardUpdate(card.id, { question: "Revised question?" });
  assert.equal(
    peer.nodeGet(card.id).revision,
    edited.revision,
    "a no-op edit does not invalidate review content",
  );
  squad.cardEvidenceAdd(
    card.id,
    "observation",
    "fixture://observation",
    "Observed evidence",
  );
  const evidenced = peer.nodeGet(card.id);
  assert.ok(evidenced.revision > edited.revision);
  squad.cardTransition(card.id, "DIVERGE", "Explore alternatives");
  const transitioned = peer.nodeGet(card.id);
  assert.ok(transitioned.revision > evidenced.revision);
  assert.equal(transitioned.phase, "DIVERGE");
  assert.equal(
    JSON.stringify(transitioned.revisions.slice(0, original.revisions.length)),
    history,
  );
});

test("invalid dependencies and artifact paths leave graph and revision history unchanged", (t) => {
  const { squad, create } = fixture(t);
  const a = create("A"),
    b = create("B");
  squad.nodeUpdate(b.id, b.revision, { dependencies: [a.id] });
  const before = squad.nodeGet(a.id);
  assert.throws(
    () => squad.nodeUpdate(a.id, before.revision, { dependencies: [b.id] }),
    /cycle/,
  );
  assert.throws(
    () => squad.nodeUpdate(a.id, before.revision, { dependencies: [999999] }),
    /missing/,
  );
  assert.throws(
    () =>
      squad.nodeUpdate(a.id, before.revision, {
        artifacts: [{ path: "../outside", commit: "a".repeat(40) }],
      }),
    /traversal|relative/,
  );
  assert.deepEqual(squad.nodeGet(a.id), before);
});

test("a node edit makes its historical verified bank stale and cannot reuse its submission key", async (t) => {
  const { squad, peer, create } = fixture(t);
  const node = create();
  const attempt = squad.nodeSubmit(node.id, node.revision, "node-attempt", 1);
  const bank = await squad.bank(attempt.id);
  assert.equal(bank.status, "verified", JSON.stringify(bank.evidence));
  assert.equal(peer.nodeGet(node.id).banked, true);
  squad.cardUpdate(node.id, { question: "A materially different claim?" });
  const revised = peer.nodeGet(node.id);
  assert.equal(revised.banked, false);
  assert.equal(revised.integrations[0].status, "verified");
  assert.equal(revised.integrations[0].current, false);
  assert.equal(squad.integrationAttempt(attempt.id).status, "verified");
  assert.throws(
    () => squad.nodeSubmit(node.id, revised.revision, "node-attempt", 1),
    /different submission/,
  );
  assert.throws(
    () => squad.nodeSubmit(node.id, node.revision, "stale-attempt", 1),
    /revision changed/,
  );
  assert.equal(squad.nodeGet(node.id).integrations.length, 1);
});

test("direct submissions with stale or missing nodes roll back both attempts and bindings", (t) => {
  const { squad, db, create, commit } = fixture(t);
  const node = create();
  squad.cardUpdate(node.id, { question: "New revision?" });
  const count = () =>
    db.prepare("SELECT COUNT(*) AS n FROM integration_attempts").get().n;
  const before = count();
  const submission = {
    request_key: "stale-direct",
    config_revision: 1,
    commits: [commit],
    selection: { paths: ["artifact.txt"] },
    node_refs: [String(node.id)],
    node_revisions: { [node.id]: node.revision },
  };
  assert.throws(() => squad.integrationSubmit(submission), /revision/);
  assert.throws(
    () =>
      squad.integrationSubmit({
        ...submission,
        request_key: "missing-direct",
        node_refs: ["999999"],
        node_revisions: { 999999: 1 },
      }),
    /no science card|missing/,
  );
  assert.equal(count(), before);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM node_integrations").get().n,
    0,
  );
});

test("node discovery and history queries work on a read-only database connection", (t) => {
  const { squad, db, create } = fixture(t);
  const node = create();
  const before = db.prepare("SELECT total_changes() AS n").get().n;
  db.exec("PRAGMA query_only = ON");
  try {
    assert.equal(squad.nodeGet(node.id).id, node.id);
    assert.ok(squad.nodeList().some((item) => item.id === node.id));
    assert.equal(db.prepare("SELECT total_changes() AS n").get().n, before);
  } finally {
    db.exec("PRAGMA query_only = OFF");
  }
});

test("changing or disabling the room target preserves history without presenting an old bank as current", async (t) => {
  const { squad, create } = fixture(t);
  const node = create();
  const attempt = squad.nodeSubmit(node.id, node.revision, "target-bound", 1);
  assert.equal((await squad.bank(attempt.id)).status, "verified");
  const initial = squad.nodeGet(node.id);
  assert.equal(initial.banked, true);
  assert.equal(initial.integrations[0].current_configuration, true);
  const originalConfig = squad.integrationGet().config;
  squad.integrationSet({ ...originalConfig, branch: "another-target" }, 1);
  const changed = squad.nodeGet(node.id);
  assert.equal(
    changed.revision,
    node.revision,
    "target changes do not edit research content",
  );
  assert.equal(changed.banked, false);
  assert.equal(changed.integrations[0].current, true);
  assert.equal(changed.integrations[0].current_configuration, false);
  assert.equal(changed.integrations[0].config_revision, 1);
  assert.equal(changed.integrations[0].status, "verified");
  squad.integrationUnset(2);
  const disabled = squad.nodeGet(node.id);
  assert.equal(disabled.banked, false);
  assert.equal(disabled.integrations[0].current_configuration, false);
  assert.equal(squad.integrationAttempt(attempt.id).config.branch, "main");
  assert.equal(squad.integrationAttempt(attempt.id).status, "verified");
});

// Invoke an actual writer connection between two reader statements. The hook
// controls scheduling only; all reads, writes and WAL snapshots are real SQLite.
function interleaveRead(db, sql, method, matches, write) {
  const prepare = db.prepare.bind(db);
  let fired = false;
  db.prepare = (query, ...args) => {
    const statement = prepare(query, ...args);
    if (query === sql) {
      const read = statement[method].bind(statement);
      statement[method] = (...values) => {
        if (!fired && matches(values)) {
          fired = true;
          write();
        }
        return read(...values);
      };
    }
    return statement;
  };
  return () => {
    db.prepare = prepare;
    assert.equal(
      fired,
      true,
      "the competing connection committed during the read",
    );
  };
}

test("nodeGet reads one WAL snapshot across concurrent content and target changes", async (t) => {
  const { db, squad, create } = fixture(t);
  const node = create();
  const attempt = squad.nodeSubmit(node.id, node.revision, "snapshot-node", 1);
  assert.equal((await squad.bank(attempt.id)).status, "verified");
  const writerDb = openDb(),
    writer = new Squad(writerDb, "concurrent-writer");
  t.after(() => writerDb.close());
  const before = squad.nodeGet(node.id);
  const changes = db.prepare("SELECT total_changes() AS n").get().n;
  db.exec("PRAGMA query_only=ON");
  const restore = interleaveRead(
    db,
    "SELECT * FROM node_metadata WHERE card_id = ?",
    "get",
    () => true,
    () => {
      writer.nodeUpdate(node.id, node.revision, {
        artifacts: [{ path: "different.txt", commit: "a".repeat(40) }],
      });
      writer.cardUpdate(node.id, { question: "Concurrent research question" });
      writer.cardEvidenceAdd(
        node.id,
        "observation",
        "concurrent://evidence",
        "new assertion",
      );
      writer.cardTransition(node.id, "DIVERGE", "concurrent phase");
      writer.integrationUnset(1);
    },
  );
  let observed;
  try {
    observed = squad.nodeGet(node.id);
  } finally {
    restore();
  }
  assert.deepEqual(
    observed,
    before,
    "content, revision, history, target and banking must all come from the original snapshot",
  );
  assert.equal(
    db.prepare("SELECT total_changes() AS n").get().n,
    changes,
    "reads never write or renew presence",
  );
  const fresh = squad.nodeGet(node.id);
  assert.equal(fresh.artifacts[0].path, "different.txt");
  assert.equal(fresh.question, "Concurrent research question");
  assert.ok(fresh.revision > before.revision);
  assert.equal(fresh.banked, false);
  assert.equal(fresh.integrations[0].current_configuration, false);
  db.exec("SAVEPOINT enclosing_read");
  assert.deepEqual(squad.nodeGet(node.id), fresh);
  assert.equal(squad.nodeList().length, 1);
  db.exec("ROLLBACK TO enclosing_read; RELEASE enclosing_read");
  assert.equal(db.prepare("SELECT total_changes() AS n").get().n, changes);
});

test("nodeList shares one read snapshot across all nodes and configuration", async (t) => {
  const { db, squad, create, commit } = fixture(t);
  const first = create("First"),
    second = create("Second");
  const attempt = squad.integrationSubmit({
    request_key: "snapshot-list",
    config_revision: 1,
    commits: [commit],
    node_refs: [String(first.id), String(second.id)],
    node_revisions: {
      [first.id]: first.revision,
      [second.id]: second.revision,
    },
    selection: { paths: ["artifact.txt"] },
  });
  assert.equal((await squad.bank(attempt.id)).status, "verified");
  const writerDb = openDb(),
    writer = new Squad(writerDb, "concurrent-writer");
  t.after(() => writerDb.close());
  const before = squad.nodeList();
  assert.ok(before.every((node) => node.banked));
  const changes = db.prepare("SELECT total_changes() AS n").get().n;
  db.exec("PRAGMA query_only=ON");
  const restore = interleaveRead(
    db,
    "SELECT * FROM science_cards WHERE id = ?",
    "get",
    (values) => values[0] === second.id,
    () => {
      writer.nodeUpdate(second.id, second.revision, {
        dependencies: [first.id],
      });
      writer.cardUpdate(second.id, { question: "New list question" });
      const configuration = writer.integrationGet();
      writer.integrationSet(
        { ...configuration.config, build_command: "false" },
        configuration.revision,
      );
    },
  );
  let observed;
  try {
    observed = squad.nodeList();
  } finally {
    restore();
  }
  assert.deepEqual(
    observed,
    before,
    "every list entry must reflect the same database snapshot",
  );
  assert.equal(db.prepare("SELECT total_changes() AS n").get().n, changes);
  const fresh = squad.nodeList();
  assert.ok(fresh.every((node) => !node.banked));
  assert.deepEqual(fresh[1].dependencies, [first.id]);
  assert.equal(fresh[1].question, "New list question");
});

test("nodeSubmit still rejects content edits after its read snapshot ends", (t) => {
  const { db, squad, create } = fixture(t);
  const node = create();
  const writerDb = openDb(),
    writer = new Squad(writerDb, "concurrent-writer");
  t.after(() => writerDb.close());
  const exec = db.exec.bind(db);
  let fired = false;
  db.exec = (sql) => {
    if (sql === "BEGIN IMMEDIATE" && !fired) {
      fired = true;
      writer.cardUpdate(node.id, { question: "Changed before submission" });
    }
    return exec(sql);
  };
  try {
    assert.throws(
      () => squad.nodeSubmit(node.id, node.revision, "snapshot-submit-race", 1),
      /revision changed/,
    );
  } finally {
    db.exec = exec;
  }
  assert.equal(fired, true);
  assert.equal(squad.integrationAttempts().length, 0);
  assert.equal(squad.nodeGet(node.id).integrations.length, 0);
});
