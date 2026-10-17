import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const { openDb, ROOM_TABLES, SCHEMA_VERSION } = await import("../dist/db.js");
const wh = await import("../dist/wake-handles.js");

const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), "squad-wake-"));
  process.env.SQUAD_DIR = dir;
  const db = openDb();
  try {
    return fn(db, dir);
  } finally {
    db.close();
    delete process.env.SQUAD_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("upsert stores a handle and replaces it; never a row without runtime+ref", () =>
  withDb((db) => {
    assert.equal(wh.upsertWakeHandle(db, { persona: "a", runtime: "codex", sessionRef: "" }), null);
    assert.equal(wh.upsertWakeHandle(db, { persona: "a", runtime: "gemini", sessionRef: "x" }), null);
    assert.equal(wh.getWakeHandle(db, "a"), null);
    const h = wh.upsertWakeHandle(db, { persona: "a", runtime: "codex", sessionRef: "s1", cwd: "/w" });
    assert.equal(h.session_ref, "s1");
    assert.equal(h.no_wake, false);
    wh.upsertWakeHandle(db, { persona: "a", runtime: "claude", sessionRef: "s2" });
    assert.equal(wh.getWakeHandle(db, "a").runtime, "claude");
    assert.equal(wh.listWakeHandles(db).length, 1);
  }));

test("opt-out survives re-upsert; opt-in reverses; clear removes", () =>
  withDb((db) => {
    wh.upsertWakeHandle(db, { persona: "a", runtime: "codex", sessionRef: "s1" });
    assert.equal(wh.setNoWake(db, "a", true), true);
    wh.upsertWakeHandle(db, { persona: "a", runtime: "codex", sessionRef: "s2" });
    assert.equal(wh.getWakeHandle(db, "a").no_wake, true);
    wh.setNoWake(db, "a", false);
    assert.equal(wh.getWakeHandle(db, "a").no_wake, false);
    assert.equal(wh.setNoWake(db, "ghost", true), false);
    assert.equal(wh.clearWakeHandle(db, "a"), true);
    assert.equal(wh.clearWakeHandle(db, "a"), false);
  }));

test("resolveWakeCommand returns argv arrays for both runtimes, null otherwise", () => {
  assert.deepEqual(wh.resolveWakeCommand({ runtime: "codex", session_ref: "S" }, "go"), [
    "codex", "exec", "resume", "S", "go",
  ]);
  assert.deepEqual(wh.resolveWakeCommand({ runtime: "claude", session_ref: "S" }, "go"), [
    "claude", "--resume", "S", "-p", "go",
  ]);
  assert.equal(wh.resolveWakeCommand({ runtime: "claude", session_ref: "" }), null);
  assert.equal(wh.resolveWakeCommand({ runtime: "bash", session_ref: "S" }), null);
});

test("hostile prompt and session ref stay single argv elements", () => {
  const nasty = `it's "x"; touch pwned $(id) \`id\` a b`;
  const argv = wh.resolveWakeCommand({ runtime: "claude", session_ref: "a b;c" }, nasty);
  assert.equal(argv[2], "a b;c");
  assert.equal(argv[4], nasty);
  assert.equal(argv.length, 5);
});

test("handle on another host is listed but not usable here", () =>
  withDb((db) => {
    wh.upsertWakeHandle(db, { persona: "far", runtime: "codex", sessionRef: "s", host: "other-host" });
    wh.upsertWakeHandle(db, { persona: "near", runtime: "codex", sessionRef: "s" });
    const byName = Object.fromEntries(wh.listWakeHandles(db).map((h) => [h.persona, h]));
    assert.equal(byName.far.usable_here, false);
    assert.equal(byName.near.usable_here, true);
  }));

test("persona names with spaces/quotes/; are stored verbatim", () =>
  withDb((db) => {
    const p = `we ird"na'me;x`;
    wh.upsertWakeHandle(db, { persona: p, runtime: "codex", sessionRef: "s" });
    assert.equal(wh.getWakeHandle(db, p).persona, p);
  }));

test("migration is idempotent on an existing db and the table is outside ROOM_TABLES", () => {
  const dir = mkdtempSync(join(tmpdir(), "squad-wake-mig-"));
  try {
    process.env.SQUAD_DIR = dir;
    openDb().close();
    const db = openDb();
    wh.upsertWakeHandle(db, { persona: "a", runtime: "codex", sessionRef: "s" });
    db.close();
    const again = openDb();
    assert.equal(wh.getWakeHandle(again, "a").session_ref, "s");
    again.close();
    assert.ok(!ROOM_TABLES.includes("wake_handles"));
    assert.equal(SCHEMA_VERSION, 11);
  } finally {
    delete process.env.SQUAD_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("codexSessionFromRollout extracts the uuid", () => {
  assert.equal(
    wh.codexSessionFromRollout(
      "/h/.codex/sessions/2026/10/17/rollout-2026-10-17T10-00-00-0199aaaa-bbbb-cccc-dddd-eeeeffff0000.jsonl",
    ),
    "0199aaaa-bbbb-cccc-dddd-eeeeffff0000",
  );
  assert.equal(wh.codexSessionFromRollout("rollout-nothing.jsonl"), null);
});

test("CLI: set/show/list/opt-out/clear round trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "squad-wake-cli-"));
  try {
    const run = (...a) =>
      spawnSync(process.execPath, [entry, "wake-handle", ...a], {
        env: { ...process.env, SQUAD_DIR: dir },
        encoding: "utf8",
      });
    assert.equal(run("set", "bob", "codex", "sess-1").status, 0);
    assert.match(run("show", "bob").stdout, /"session_ref": "sess-1"/);
    assert.match(run("list").stdout, /bob\tcodex/);
    assert.match(run("opt-out", "bob").stdout, /opted out/);
    assert.match(run("list").stdout, /no-wake/);
    assert.equal(run("set", "bob", "nope", "x").status, 1);
    assert.match(run("clear", "bob").stdout, /cleared/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
