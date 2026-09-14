import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { openDb, ROOM_TABLES } from "../dist/db.js";
import { Squad } from "../dist/core.js";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "squad-steward-"));
  const prev = process.env.SQUAD_DIR;
  process.env.SQUAD_DIR = root;
  const db = openDb();
  const config = {
    repository: root,
    remote: "origin",
    branch: "main",
    build_command: "true",
    steward: "keeper",
  };
  db.prepare(
    "INSERT INTO integration_configs(config_json, updated_by, updated_ts) VALUES (?, ?, ?)",
  ).run(JSON.stringify(config), "human", new Date().toISOString());
  const squad = new Squad(db, "keeper");
  t.after(() => {
    db.close();
    if (prev === undefined) delete process.env.SQUAD_DIR;
    else process.env.SQUAD_DIR = prev;
    rmSync(root, { recursive: true, force: true });
  });
  return { root, db, squad };
}

test("reminder insertion failure rolls back chat and leaves durable queue queryable", (t) => {
  const { db, squad } = fixture(t);
  db.exec(
    "CREATE TRIGGER fail_reminder BEFORE INSERT ON steward_reminders BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END;",
  );
  const before = db.prepare("SELECT COUNT(*) AS n FROM messages").get().n;
  assert.throws(() => squad.stewardTick(), /simulated disk failure/);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM messages").get().n,
    before,
  );
  assert.equal(squad.stewardStatus().outline.fresh, false);
  assert.deepEqual(squad.stewardStatus().reminders, []);
  db.exec("DROP TRIGGER fail_reminder");
  assert.equal(squad.stewardTick().sent.length, 1);
});

test("cadence, clock rollback and lifetime bound survive reopened connections", (t) => {
  const { db, squad } = fixture(t);
  assert.equal(squad.stewardTick().sent.length, 1);
  db.prepare("UPDATE steward_reminders SET last_sent_ms=?").run(
    Date.now() + 86400000,
  );
  assert.equal(squad.stewardTick().sent.length, 0);
  for (let i = 0; i < 4; i++) {
    db.prepare("UPDATE steward_reminders SET last_sent_ms=0").run();
    const reopened = openDb();
    try {
      new Squad(reopened, "keeper").stewardTick();
    } finally {
      reopened.close();
    }
  }
  assert.equal(squad.stewardStatus().reminders[0].sends, 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages").get().n, 3);
});

test("steward history participates in room export/import and reset", async (t) => {
  const { root, db, squad } = fixture(t);
  squad.stewardTick();
  const before = squad.stewardStatus().reminders;
  const archive = join(root, "archive.db");
  await squad.exportRoom(archive);
  squad.clear();
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM steward_reminders").get().n,
    0,
  );
  squad.importRoom(archive);
  assert.deepEqual(squad.stewardStatus().reminders, before);
  assert.equal(squad.stewardTick().sent.length, 0);
  assert.ok(ROOM_TABLES.includes("steward_reminders"));
});

test("steward CLI rejects unsupported arguments before tick writes", (t) => {
  const { root, db } = fixture(t);
  for (const args of [
    ["steward"],
    ["steward", "status", "extra"],
    ["steward", "tick", "--force"],
    ["steward", "unknown"],
  ]) {
    const result = spawnSync(process.execPath, ["dist/index.js", ...args], {
      encoding: "utf8",
      env: { ...process.env, SQUAD_DIR: root, SQUAD_PERSONA: "keeper" },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /usage: squad steward/);
  }
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM steward_reminders").get().n,
    0,
  );
});

test("concurrent CLI steward processes share the same transactional reminder bound", async (t) => {
  const { root, db } = fixture(t);
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      run(process.execPath, ["dist/index.js", "steward", "tick"], {
        env: { ...process.env, SQUAD_DIR: root, SQUAD_PERSONA: "keeper" },
      }),
    ),
  );
  assert.equal(
    results.reduce((n, result) => n + JSON.parse(result.stdout).sent.length, 0),
    1,
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages").get().n, 1);
  assert.equal(
    db.prepare("SELECT sends FROM steward_reminders").get().sends,
    1,
  );
});

test("schema 8 room adopts reminder history without losing prior user records", (t) => {
  const { db, squad } = fixture(t);
  const node = squad.nodeCreate({
    title: "Preserved",
    question: "Prior user work",
  });
  squad.claim("manual/path");
  db.exec("DROP TABLE steward_reminders; PRAGMA user_version=8");
  const migrated = openDb();
  try {
    const keeper = new Squad(migrated, "keeper");
    assert.equal(migrated.prepare("PRAGMA user_version").get().user_version, 9);
    assert.equal(keeper.nodeGet(node.id).question, "Prior user work");
    assert.equal(keeper.stewardStatus().claims[0].path, "manual/path");
    assert.deepEqual(keeper.stewardStatus().reminders, []);
    assert.ok(keeper.stewardTick().sent.length > 0);
  } finally {
    migrated.close();
  }
});
