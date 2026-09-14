import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { decide, initialState, wakeIntervalMs } from "../dist/reentry.js";
import { loadState, saveState } from "../dist/reentry-state.js";
import { observeWakeWork } from "../dist/reentry-room.js";
import { Squad } from "../dist/core.js";
import { openDb } from "../dist/db.js";
const now = Date.parse("2026-01-01T00:00:00Z");
const base = () => ({ state: initialState(new Date(now).toISOString()), nowMs: now,
  hasDirectedWork: false, operatorStopped: false, ttlMinutes: 240, rand: () => 0.5 });

test("idle jitter endpoints, claim interval and polling stability are deterministic", () => {
  assert.equal(wakeIntervalMs(false, undefined, () => 0), 30 * 60_000);
  assert.equal(wakeIntervalMs(false, undefined, () => 1), 45 * 60_000);
  assert.equal(wakeIntervalMs(true), 5 * 60_000);
  const start = decide(base());
  assert.equal(Date.parse(start.nextState.nextFireAt) - now, 37.5 * 60_000);
  const poll = decide({ ...base(), state: start.nextState, nowMs: now + 45_000,
    rand: () => { throw Error("must not resample"); } });
  assert.equal(poll.nextState, start.nextState);
  const claimed = decide({ ...base(), state: start.nextState, hasHeldClaims: true });
  assert.equal(Date.parse(claimed.nextState.nextFireAt) - now, 5 * 60_000);
  const released = decide({ ...base(), state: claimed.nextState });
  assert.equal(released.nextState.windowKind, "idle");
  assert.equal(decide({ ...base(), state: released.nextState, hasDirectedWork: true }).sleepMs, 0);
});

test("failed launch delay cannot be shortened by mentions, reviews, or claims", () => {
  const opts = { ...base(), failureBackoff: true, hasDirectedWork: true, hasHeldClaims: true,
    backoff: { baseMs: 1000, capMs: 10_000, multiplier: 2, jitterFraction: 0 } };
  const first = decide(opts);
  assert.equal(first.sleepMs, 1000);
  const poll = decide({ ...opts, state: first.nextState, nowMs: now + 999 });
  assert.equal(poll.sleepMs, 1);
  const fired = decide({ ...opts, state: poll.nextState, nowMs: now + 1000 });
  assert.equal(fired.nextState.totalFired, 1);
  assert.equal(fired.nextState.attempt, 1);
  assert.equal(decide({ ...opts, state: fired.nextState }).sleepMs, 2000);
  for (const overrides of [{ operatorStopped: true }, { ttlMinutes: 0 }, { maxAttempts: 1 }]) {
    assert.equal(decide({ ...opts, state: fired.nextState, ...overrides }).block, false);
  }
});

test("persistent directed work spends lifetime cap even though failure counter resets", () => {
  let state = base().state;
  for (let i = 0; i < 3; i++) {
    state = decide({ ...base(), state, hasDirectedWork: true, maxAttempts: 3 }).nextState;
    assert.equal(state.attempt, 0);
    assert.equal(state.totalFired, i + 1);
  }
  assert.equal(decide({ ...base(), state, hasDirectedWork: true, maxAttempts: 3 }).block, false);
});

function roomFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "squad-wake-"));
  const old = process.env.SQUAD_DIR;
  process.env.SQUAD_DIR = dir;
  const db = openDb();
  t.after(() => { db.close(); if (old === undefined) delete process.env.SQUAD_DIR;
    else process.env.SQUAD_DIR = old; rmSync(dir, { recursive: true, force: true }); });
  return { dir, db, worker: new Squad(db, "worker"), peer: new Squad(db, "peer") };
}

test("shared observer sees unconsumed mentions, own claims and pending/claimed reviews only", (t) => {
  const { worker, peer } = roomFixture(t);
  peer.claim("other");
  assert.deepEqual(observeWakeWork(worker, "worker"), { directed: false, held: false });
  worker.claim("mine");
  peer.send("@worker hello");
  assert.deepEqual(observeWakeWork(worker, "worker"), { directed: true, held: true });
  assert.ok(worker.check().some(m => m.body === "@worker hello"));
  const review = peer.reviewOpen("worker", "review this");
  worker.check(); // review is still directed after its chat announcement is read
  assert.equal(observeWakeWork(worker, "worker").directed, true);
  worker.reviewClaim(review.id);
  assert.equal(observeWakeWork(worker, "worker").directed, true);
  worker.reviewResolve(review.id);
  peer.reviewOpen("worker", "expired", { expiresTs: "2000-01-01T00:00:00Z" });
  peer.reviewOpen("someone-else", "not ours");
  worker.check();
  assert.equal(observeWakeWork(worker, "worker").directed, false);
});

test("legacy state migrates known count without restarting TTL", (t) => {
  const { dir } = roomFixture(t);
  const legacy = { attempt: 4, firstArmedAt: new Date(now).toISOString(), nextFireAt: null, lastFiredAt: null };
  saveState(dir, "worker", legacy);
  const state = loadState(dir, "worker", new Date().toISOString());
  assert.equal(state.totalFired, 4);
  assert.equal(state.firstArmedAt, legacy.firstArmedAt);
});

test("real Claude hook detects review, preserves loop guard and announces stop once", (t) => {
  const { dir, peer, worker } = roomFixture(t);
  peer.reviewOpen("worker", "pending review"); worker.check();
  const invoke = (input = {}, env = {}) => spawnSync(process.execPath, [resolve("dist/reentry-hook.js")], {
    input: JSON.stringify(input), encoding: "utf8", timeout: 3000,
    env: { ...process.env, SQUAD_DIR: dir, SQUAD_PERSONA: "worker", ...env },
  });
  let result = invoke();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).decision, "block");
  assert.equal(loadState(dir, "worker", "").totalFired, 1);
  result = invoke({ stop_hook_active: true });
  assert.equal(result.stdout, "");
  assert.equal(loadState(dir, "worker", "").totalFired, 1);
  for (let i = 0; i < 2; i++) {
    result = invoke({}, { SQUAD_REENTRY_STOP: "1" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  }
  const stops = worker.read().filter(m => m.body.includes("stopping permanently"));
  assert.equal(stops.length, 1);
  assert.equal(stops[0].occurrences, 1);
  assert.match(loadState(dir, "worker", "").stoppedReason, /operator stop/);
});


test("sleep slices do not overshoot the remaining TTL", () => {
  const result = decide({ ...base(), ttlMinutes: 1, nowMs: now + 59_990 });
  assert.equal(result.sleepMs, 10);
});


test("a newly held claim never postpones an imminent idle heartbeat", () => {
  const state = { ...base().state, windowKind: "idle", nextFireAt: new Date(now + 10).toISOString() };
  assert.equal(decide({ ...base(), state, hasHeldClaims: true }).sleepMs, 10);
  const due = decide({ ...base(), state, nowMs: now + 10, hasHeldClaims: true });
  assert.equal(due.sleepMs, 0);
  assert.equal(due.nextState.totalFired, 1);
});


test("real Claude hook latches operator stop before opening an unavailable room", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "squad-wake-unavailable-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, SQUAD_DIR: dir, SQUAD_PERSONA: "worker" };
  delete env.SQUAD_REENTRY_STOP;
  writeFileSync(join(dir, "squad.db"), "not a sqlite database");
  const invoke = (extra = {}) => spawnSync(process.execPath, [resolve("dist/reentry-hook.js")], {
    input: "{}", encoding: "utf8", timeout: 3000, env: { ...env, ...extra },
  });
  const stopped = invoke({ SQUAD_REENTRY_STOP: "1" });
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(stopped.stdout, "");
  const state = loadState(dir, "worker", "");
  assert.equal(state.stoppedReason, "operator stop requested");
  assert.equal(state.stopAnnounced, true);

  rmSync(join(dir, "squad.db"));
  const restored = spawnSync(process.execPath, ["--input-type=module", "-e",
    'import { openDb } from "./dist/db.js"; import { Squad } from "./dist/core.js"; ' +
    'const db = openDb(); new Squad(db, "peer").send("@worker please resume"); db.close();'],
    { encoding: "utf8", env });
  assert.equal(restored.status, 0, restored.stderr);
  const retry = invoke();
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(retry.stdout, "", "recovering the room must not re-arm the stopped cycle");
  assert.equal(loadState(dir, "worker", "").firstArmedAt, state.firstArmedAt);
  assert.equal(loadState(dir, "worker", "").totalFired, 0);
});
