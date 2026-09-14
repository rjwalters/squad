import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { openDb } from "../dist/db.js";
import { Squad } from "../dist/core.js";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "squad-integration-"));
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
  const squad = new Squad(db, "alice");
  const input = {
    repository: dir,
    remote: "origin",
    branch: "research/integration",
    build_command: "false",
    steward: "alice",
  };
  return { dir, db, squad, input };
}

test("integration config is shared, opt-in, revision guarded and visible", (t) => {
  const { db, squad, input } = fixture(t);
  assert.equal(squad.integrationGet().config, null);
  assert.throws(() => squad.integrationValidate(), /not configured/);
  squad.goalAdd("chat-only rooms still work");
  const first = squad.integrationSet(input, 0);
  assert.equal(first.revision, 1);
  assert.equal(first.config.remote_url, "https://example.org/research.git");
  const peer = new Squad(db, "bob");
  assert.deepEqual(peer.integrationGet(), first);
  assert.equal(peer.integrationValidate().revision, 1);
  assert.throws(
    () => peer.integrationSet({ ...input, steward: "bob" }, 0),
    /revision/,
  );
  assert.equal(peer.integrationGet().config.steward, "alice");
  assert.match(
    db.prepare("SELECT body FROM messages ORDER BY id DESC LIMIT 1").get().body,
    /integration.*alice/,
  );
  assert.equal(peer.integrationUnset(1).config, null);
  assert.equal(peer.integrationGet().revision, 2);
});

test("configuration validation rejects invalid target and detects changed remote", (t) => {
  const { squad, input, dir } = fixture(t);
  for (const fields of [
    { repository: "." },
    { remote: "-oops" },
    { branch: "../main" },
    { build_command: "" },
    { steward: "bad name" },
  ]) {
    assert.throws(() => squad.integrationSet({ ...input, ...fields }, 0));
    assert.equal(squad.integrationGet().revision, 0);
  }
  squad.integrationSet(input, 0);
  execFileSync("git", [
    "-C",
    dir,
    "remote",
    "set-url",
    "origin",
    "https://example.org/other.git",
  ]);
  assert.throws(() => squad.integrationValidate(), /remote.*changed/);
  assert.equal(
    squad.integrationGet().config.remote_url,
    "https://example.org/research.git",
  );
});

test("configuration history exports, imports, clears and never executes a build", async (t) => {
  const { squad, input, dir, db } = fixture(t);
  const state = squad.integrationSet(input, 0); // false would fail if executed
  const backup = join(dir, "backup.db");
  await squad.exportRoom(backup);
  squad.clear();
  assert.equal(squad.integrationGet().config, null);
  squad.importRoom(backup);
  assert.deepEqual(squad.integrationGet(), state);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM integration_configs").get().n,
    1,
  );
});

test("Git environment cannot substitute another repository; secrets and alternate push targets are rejected", (t) => {
  const { squad, input, dir } = fixture(t);
  const prior = process.env.GIT_DIR;
  process.env.GIT_DIR = "/does/not/exist";
  try {
    squad.integrationSet(input, 0);
  } finally {
    if (prior === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = prior;
  }
  execFileSync("git", [
    "-C",
    dir,
    "remote",
    "set-url",
    "origin",
    "https://secret@example.org/research.git",
  ]);
  assert.throws(() => squad.integrationSet(input, 1), /credential-free/);
  assert.equal(squad.integrationGet().revision, 1);
  execFileSync("git", [
    "-C",
    dir,
    "remote",
    "set-url",
    "origin",
    "https://example.org/research.git",
  ]);
  execFileSync("git", [
    "-C",
    dir,
    "remote",
    "set-url",
    "--push",
    "origin",
    "https://example.org/other.git",
  ]);
  assert.throws(() => squad.integrationValidate(), /identical fetch and push/);
});

test("invalid integration CLI requests produce actionable errors without changing configuration", (t) => {
  const { squad } = fixture(t);
  for (const args of [
    ["set"],
    ["unset", "--expected-revision", "bad"],
    ["show", "--unexpected"],
  ]) {
    const result = spawnSync(
      process.execPath,
      ["dist/index.js", "integration", ...args],
      {
        encoding: "utf8",
        env: process.env,
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /squad: .*?(integration|required|usage)/);
    assert.equal(squad.integrationGet().revision, 0);
  }
});

test("opening a schema-3 room adds opt-in configuration without losing its existing state", (t) => {
  const { squad, db } = fixture(t);
  const goal = squad.goalAdd("preserve an existing research goal");
  db.exec("DROP TABLE integration_configs; PRAGMA user_version = 3;");
  const migrated = openDb();
  t.after(() => migrated.close());
  const peer = new Squad(migrated, "bob");
  assert.equal(peer.integrationGet().config, null);
  assert.equal(peer.goals()[0].id, goal.id);
  assert.equal(migrated.prepare("PRAGMA user_version").get().user_version, 4);
});
