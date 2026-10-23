import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";

const { openDb } = await import("../dist/db.js");
const { Squad } = await import("../dist/core.js");
const wh = await import("../dist/wake-handles.js");
const { wakeOnce, parseWakerArgs, WAKER_SENDER } = await import("../dist/waker.js");

const T0 = Date.parse("2026-01-01T00:00:00Z");

function setup(fn, over = {}) {
  const dir = mkdtempSync(join(tmpdir(), "squad-waker-"));
  process.env.SQUAD_DIR = dir;
  const db = openDb();
  const clock = { t: T0 };
  const spawns = [];
  const deps = {
    squadDir: dir,
    now: () => clock.t,
    spawn: async (argv, opts) => { spawns.push({ argv, opts }); return { pid: null }; },
    alive: () => false,
    cooldownMs: 10 * 60_000,
    ttlMinutes: 240,
    maxAttempts: 48,
    rand: () => 0.5,
    roomLabel: "room",
    ...over,
  };
  // "bob" has a handle and has left; "alice" is the sender.
  const alice = new Squad(db, "alice", { sessionId: "alice-s" });
  const bob = new Squad(db, "bob", { sessionId: "bob-s" });
  bob.join?.();
  bob.leave();
  wh.upsertWakeHandle(db, { persona: "bob", runtime: "claude", sessionRef: "sess-bob", cwd: "/w" });
  const lines = () => db.prepare("SELECT body FROM messages WHERE sender = ? ORDER BY id").all(WAKER_SENDER).map((r) => r.body);
  return Promise.resolve(fn({ db, dir, deps, clock, spawns, alice, bob, lines })).finally(() => {
    db.close();
    delete process.env.SQUAD_DIR;
    rmSync(dir, { recursive: true, force: true });
  });
}

test("parseWakerArgs", () => {
  assert.deepEqual(parseWakerArgs([]), { mode: "once" });
  assert.deepEqual(parseWakerArgs(["--follow", "--interval", "2"]), { mode: "follow", intervalMs: 2000 });
  assert.equal(parseWakerArgs(["status"]).mode, "status");
  assert.throws(() => parseWakerArgs(["--bogus"]), /usage: squad waker/);
});

test("directed @mention wakes a departed persona once, with argv and a room line", () =>
  setup(async ({ db, deps, alice, spawns, lines }) => {
    alice.send("hey @bob please look");
    const r = await wakeOnce(db, deps);
    assert.equal(r.outcomes[0].result, "woke");
    assert.equal(spawns.length, 1);
    assert.deepEqual(spawns[0].argv.slice(0, 4), ["claude", "--resume", "sess-bob", "-p"]);
    assert.match(spawns[0].argv[4], /1 directed message in room; read them/);
    assert.match(lines()[0], /^woke bob for @mention #\d+$/);
    // Same messages are not woken for again.
    await wakeOnce(db, deps);
    assert.equal(spawns.length, 1);
  }));

test("undirected chatter never wakes anyone", () =>
  setup(async ({ db, deps, alice, spawns, lines }) => {
    alice.send("just chatting, no mentions");
    await wakeOnce(db, deps);
    assert.equal(spawns.length, 0);
    assert.deepEqual(lines(), []);
  }));

test("a persona with a live session is never woken (no second instance)", () =>
  setup(async ({ db, deps, alice, spawns, bob }) => {
    alice.send("@bob ping");
    bob.check({ peek: true }); // touches: bob is live again
    await wakeOnce(db, deps);
    assert.equal(spawns.length, 0);
  }));

test("an in-flight wake blocks a second one", () =>
  setup(async ({ db, deps, alice, spawns, clock }) => {
    deps.spawn = async (argv, opts) => { spawns.push({ argv, opts }); return { pid: 4242 }; };
    deps.alive = (pid) => pid === 4242;
    alice.send("@bob one");
    await wakeOnce(db, deps);
    clock.t += 3_600_000;
    alice.send("@bob two");
    const r = await wakeOnce(db, deps);
    assert.equal(spawns.length, 1);
    assert.equal(r.outcomes[0].reason, "a wake is already in flight");
  }));

test("cooldown holds a second wake; elapses afterwards", () =>
  setup(async ({ db, deps, alice, spawns, clock, lines }) => {
    alice.send("@bob one");
    await wakeOnce(db, deps);
    clock.t += 60_000;
    alice.send("@bob two");
    await wakeOnce(db, deps);
    assert.equal(spawns.length, 1);
    assert.match(lines().at(-1), /not woken: bob -- cooldown/);
    clock.t += 11 * 60_000;
    await wakeOnce(db, deps);
    assert.equal(spawns.length, 2);
  }));

test("repeated identical skips are posted once", () =>
  setup(async ({ db, deps, alice, spawns, clock, lines }) => {
    wh.setNoWake(db, "bob", true);
    alice.send("@bob one");
    await wakeOnce(db, deps);
    clock.t += 1000;
    await wakeOnce(db, deps);
    await wakeOnce(db, deps);
    assert.equal(spawns.length, 0);
    assert.deepEqual(lines(), ["not woken: bob -- persona opted out"]);
  }));

test("no handle is skipped with a reason", () =>
  setup(async ({ db, deps, alice, spawns, lines }) => {
    wh.clearWakeHandle(db, "bob");
    alice.send("@bob one");
    await wakeOnce(db, deps);
    assert.equal(spawns.length, 0);
    assert.deepEqual(lines(), ["not woken: bob -- no wake handle recorded"]);
  }));

test("a handle from another host is skipped", () =>
  setup(async ({ db, deps, alice, spawns, lines }) => {
    wh.upsertWakeHandle(db, { persona: "bob", runtime: "claude", sessionRef: "s", host: "elsewhere" });
    alice.send("@bob one");
    await wakeOnce(db, { ...deps, host: hostname() });
    assert.equal(spawns.length, 0);
    assert.match(lines()[0], /another host/);
  }));

test("operator stop files (room-wide and per-persona) block wakes", () =>
  setup(async ({ db, deps, dir, alice, spawns, clock, lines }) => {
    alice.send("@bob one");
    writeFileSync(join(dir, "reentry-stop"), "");
    await wakeOnce(db, deps);
    assert.equal(spawns.length, 0);
    assert.match(lines()[0], /operator stop/);
    rmSync(join(dir, "reentry-stop"));
    mkdirSync(join(dir, "reentry"), { recursive: true });
    writeFileSync(join(dir, "reentry", "bob.stop"), "");
    await wakeOnce(db, deps);
    assert.equal(spawns.length, 0);
    rmSync(join(dir, "reentry", "bob.stop"));
    await wakeOnce(db, deps);
    assert.equal(spawns.length, 1);
  }));

test("stop file appearing mid-poll is honoured for later personas", () =>
  setup(async ({ db, deps, dir, alice, spawns }) => {
    new Squad(db, "zed", { sessionId: "zed-s" }).leave();
    wh.upsertWakeHandle(db, { persona: "zed", runtime: "codex", sessionRef: "zs", cwd: "/z" });
    alice.send("@bob @zed go");
    deps.spawn = async (argv) => {
      spawns.push(argv);
      writeFileSync(join(dir, "reentry-stop"), "");
      return { pid: null };
    };
    await wakeOnce(db, deps);
    assert.equal(spawns.length, 1); // bob woke, zed was stopped
  }));

test("TTL and attempt cap stop wakes", () =>
  setup(async ({ db, deps, alice, spawns, clock, lines }) => {
    alice.send("@bob one");
    await wakeOnce(db, { ...deps, maxAttempts: 1 });
    clock.t += 11 * 60_000;
    alice.send("@bob two");
    await wakeOnce(db, { ...deps, maxAttempts: 1 });
    assert.equal(spawns.length, 1);
    assert.match(lines().at(-1), /attempt cap of 1 reached/);
  }));

test("TTL exceeded across a continuous wake chain stops wakes", () =>
  setup(async ({ db, deps, alice, spawns, clock, lines }) => {
    const d = { ...deps, ttlMinutes: 30, cooldownMs: 60_000 };
    for (let i = 0; i < 3; i++) {
      alice.send(`@bob n${i}`);
      await wakeOnce(db, d);
      clock.t += 16 * 60_000;
    }
    assert.equal(spawns.length, 2);
    assert.match(lines().at(-1), /TTL of 30m exceeded/);
  }));

test("spawn failure backs off, posts once, and does not start a cooldown", () =>
  setup(async ({ db, deps, alice, spawns, clock, lines }) => {
    let fail = true;
    deps.spawn = async (argv) => {
      spawns.push(argv);
      if (fail) throw new Error("ENOENT claude");
      return { pid: null };
    };
    alice.send("@bob one");
    const r1 = await wakeOnce(db, deps);
    assert.equal(r1.outcomes[0].result, "failed");
    const r2 = await wakeOnce(db, deps); // still inside backoff
    assert.equal(r2.outcomes[0].reason, "backing off after a failed wake");
    assert.equal(spawns.length, 1);
    fail = false;
    clock.t += 60_000;
    const r3 = await wakeOnce(db, deps);
    assert.equal(r3.outcomes[0].result, "woke");
    assert.equal(lines().filter((l) => /wake failed/.test(l)).length, 1);
  }));

test("a pending review request is directed work; replies to a departed requester's review count", () =>
  setup(async ({ db, deps, alice, bob, spawns, lines }) => {
    alice.reviewOpen?.("bob", "look at x");
    await wakeOnce(db, deps);
    assert.equal(spawns.length, 1);
    assert.match(lines()[0], /woke bob for review request #1/);
  }));

test("reply to a review the departed persona filed wakes it", () =>
  setup(async ({ db, deps, alice, bob, spawns, lines }) => {
    new Squad(db, "bob", { sessionId: "bob-s2" }).reviewOpen("alice", "check y");
    new Squad(db, "bob", { sessionId: "bob-s2" }).leave();
    alice.reviewClaim(1);
    await wakeOnce(db, deps);
    assert.equal(spawns.length, 1);
    assert.match(lines()[0], /woke bob for @mention #\d+/);
  }));

test("the waker's own lines never count as directed work", () =>
  setup(async ({ db, deps, alice, spawns }) => {
    alice.send("@bob one");
    await wakeOnce(db, deps); // posts "woke bob for @mention" which contains no @bob, but sender is excluded anyway
    deps.cooldownMs = 0;
    await wakeOnce(db, deps);
    assert.equal(spawns.length, 1);
  }));

test("two wakers polling at once spawn a single instance", () =>
  setup(async ({ db, deps, alice, spawns }) => {
    deps.spawn = async (argv) => {
      spawns.push(argv);
      await new Promise((r) => setTimeout(r, 50));
      return { pid: null };
    };
    alice.send("@bob one");
    await Promise.all([wakeOnce(db, deps), wakeOnce(db, deps)]);
    assert.equal(spawns.length, 1);
  }));
