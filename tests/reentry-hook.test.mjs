import test from "node:test";
import assert from "node:assert/strict";

// Pure-function tests only — the actual Claude Code Stop hook invocation
// protocol (stdin/stdout, `stop_hook_active` loop-guard semantics, the
// filesystem/db side effects in reentry-hook.ts) is not exercised here; see
// its module doc for the manual verification steps that cover that part.
const {
  DEFAULT_BACKOFF,
  DEFAULT_SLEEP_CAP_MS,
  backoffIntervalMs,
  rawIntervalMs,
  ttlExceeded,
  initialState,
  decide,
  mentionsPersona,
} = await import("../dist/reentry.js");

test("rawIntervalMs grows exponentially and respects the cap", () => {
  const params = { baseMs: 1000, multiplier: 2, capMs: 10_000, jitterFraction: 0 };
  assert.equal(rawIntervalMs(0, params), 1000);
  assert.equal(rawIntervalMs(1, params), 2000);
  assert.equal(rawIntervalMs(2, params), 4000);
  assert.equal(rawIntervalMs(3, params), 8000);
  assert.equal(rawIntervalMs(4, params), 10_000); // capped, would be 16000 uncapped
  assert.equal(rawIntervalMs(10, params), 10_000); // stays capped
});

test("backoffIntervalMs is monotonic (ignoring jitter) across attempts", () => {
  const params = { baseMs: 500, multiplier: 3, capMs: 60_000, jitterFraction: 0 };
  const noJitter = () => 0.5; // rand()*2-1 === 0 → no jitter applied
  let prev = -1;
  for (let attempt = 0; attempt < 8; attempt++) {
    const interval = backoffIntervalMs(attempt, params, noJitter);
    assert.ok(interval >= prev, `attempt ${attempt}: ${interval} should be >= ${prev}`);
    prev = interval;
  }
});

test("backoffIntervalMs jitter stays within the documented fraction", () => {
  const params = { baseMs: 10_000, multiplier: 2, capMs: 100_000, jitterFraction: 0.2 };
  const raw = rawIntervalMs(2, params); // 40_000
  const min = raw * (1 - params.jitterFraction);
  const max = raw * (1 + params.jitterFraction);

  const atMinRand = backoffIntervalMs(2, params, () => 0); // rand()*2-1 = -1 → full negative jitter
  const atMaxRand = backoffIntervalMs(2, params, () => 1); // rand()*2-1 = +1 → full positive jitter (rand() should be < 1 in practice, but exercise the boundary)
  assert.ok(atMinRand >= Math.floor(min) - 1, `${atMinRand} should be >= ~${min}`);
  assert.ok(atMaxRand <= Math.ceil(max) + 1, `${atMaxRand} should be <= ~${max}`);
});

test("backoffIntervalMs never goes negative even at the floor with full negative jitter", () => {
  const params = { baseMs: 100, multiplier: 2, capMs: 1000, jitterFraction: 1.5 }; // exaggerated jitter
  const interval = backoffIntervalMs(0, params, () => 0);
  assert.ok(interval >= 0);
});

test("ttlExceeded: false before the TTL, true at/after it", () => {
  const armed = "2026-01-01T00:00:00.000Z";
  const armedMs = Date.parse(armed);
  assert.equal(ttlExceeded(armed, 60, armedMs + 59 * 60_000), false);
  assert.equal(ttlExceeded(armed, 60, armedMs + 60 * 60_000), true);
  assert.equal(ttlExceeded(armed, 60, armedMs + 61 * 60_000), true);
});

test("ttlExceeded: ttlMinutes <= 0 always exceeded (disables re-entry)", () => {
  const armed = "2026-01-01T00:00:00.000Z";
  assert.equal(ttlExceeded(armed, 0, Date.parse(armed)), true);
  assert.equal(ttlExceeded(armed, -5, Date.parse(armed)), true);
});

test("ttlExceeded: corrupt firstArmedAt fails toward exceeded (allow the stop)", () => {
  assert.equal(ttlExceeded("not-a-date", 60, Date.now()), true);
});

test("mentionsPersona matches @name mentions, case-insensitively, word-bounded", () => {
  assert.equal(mentionsPersona("hey @claude can you take this?", "claude"), true);
  assert.equal(mentionsPersona("hey @Claude can you take this?", "claude"), true);
  assert.equal(mentionsPersona("no mentions here", "claude"), false);
  assert.equal(mentionsPersona("email me at foo@claude.example.com", "claude"), false);
  assert.equal(mentionsPersona("@claudette are you around?", "claude"), false);
});

test("decide: operator-stop wins over everything, including directed work", () => {
  const state = initialState("2026-01-01T00:00:00.000Z");
  const result = decide({
    state,
    nowMs: Date.parse("2026-01-01T00:00:01.000Z"),
    hasDirectedWork: true,
    operatorStopped: true,
    ttlMinutes: 240,
  });
  assert.equal(result.block, false);
  assert.equal(result.sleepMs, 0);
  assert.equal(result.nextState, state); // state untouched
});

test("decide: TTL exceeded wins over directed work (edge case from the issue's Test Plan)", () => {
  const state = initialState("2026-01-01T00:00:00.000Z");
  const nowMs = Date.parse("2026-01-01T00:00:00.000Z") + 240 * 60_000; // exactly at TTL
  const result = decide({
    state,
    nowMs,
    hasDirectedWork: true,
    operatorStopped: false,
    ttlMinutes: 240,
  });
  assert.equal(result.block, false);
  assert.match(result.reason, /TTL/);
});

test("decide: directed work resets the backoff window and re-enters immediately", () => {
  const state = {
    attempt: 5,
    firstArmedAt: "2026-01-01T00:00:00.000Z",
    nextFireAt: "2026-01-01T00:30:00.000Z",
    lastFiredAt: "2026-01-01T00:01:00.000Z",
  };
  const nowMs = Date.parse("2026-01-01T00:05:00.000Z");
  const result = decide({
    state,
    nowMs,
    hasDirectedWork: true,
    operatorStopped: false,
    ttlMinutes: 240,
  });
  assert.equal(result.block, true);
  assert.equal(result.sleepMs, 0);
  assert.equal(result.nextState.attempt, 0);
  assert.equal(result.nextState.nextFireAt, null);
});

test("decide: quiet with no window in progress starts one, sleep capped", () => {
  const state = initialState("2026-01-01T00:00:00.000Z");
  const nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const backoff = { baseMs: 5 * 60_000, multiplier: 2, capMs: 60 * 60_000, jitterFraction: 0 };
  const result = decide({
    state,
    nowMs,
    hasDirectedWork: false,
    operatorStopped: false,
    ttlMinutes: 240,
    backoff,
    sleepCapMs: 1000,
  });
  assert.equal(result.block, true);
  assert.equal(result.sleepMs, 1000); // interval (5min) capped to sleepCapMs
  assert.ok(result.nextState.nextFireAt);
  assert.equal(result.nextState.attempt, 0); // not yet fired — only the window started
});

test("decide: quiet with an in-progress window not yet elapsed keeps waiting (capped), attempt unchanged", () => {
  const state = {
    attempt: 2,
    firstArmedAt: "2026-01-01T00:00:00.000Z",
    nextFireAt: "2026-01-01T00:10:00.000Z",
    lastFiredAt: null,
  };
  const nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const result = decide({
    state,
    nowMs,
    hasDirectedWork: false,
    operatorStopped: false,
    ttlMinutes: 240,
    sleepCapMs: 45_000,
  });
  assert.equal(result.block, true);
  assert.equal(result.sleepMs, 45_000); // 10 minutes remaining, capped to 45s
  assert.deepEqual(result.nextState, state); // untouched — window still in progress
});

test("decide: quiet with an elapsed window fires — attempt increments, window clears", () => {
  const state = {
    attempt: 2,
    firstArmedAt: "2026-01-01T00:00:00.000Z",
    nextFireAt: "2026-01-01T00:10:00.000Z",
    lastFiredAt: null,
  };
  const nowMs = Date.parse("2026-01-01T00:10:00.001Z");
  const result = decide({
    state,
    nowMs,
    hasDirectedWork: false,
    operatorStopped: false,
    ttlMinutes: 240,
  });
  assert.equal(result.block, true);
  assert.equal(result.sleepMs, 0);
  assert.equal(result.nextState.attempt, 3);
  assert.equal(result.nextState.nextFireAt, null);
});

test("DEFAULT_BACKOFF and DEFAULT_SLEEP_CAP_MS are sane (documented in README)", () => {
  assert.equal(DEFAULT_BACKOFF.baseMs, 30_000);
  assert.equal(DEFAULT_BACKOFF.multiplier, 2);
  assert.equal(DEFAULT_BACKOFF.capMs, 30 * 60_000);
  assert.equal(DEFAULT_BACKOFF.jitterFraction, 0.2);
  assert.equal(DEFAULT_SLEEP_CAP_MS, 45_000);
});
