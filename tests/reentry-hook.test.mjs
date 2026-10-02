import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

// Two harnesses, mirroring tests/inbox-hook.test.mjs: the pure decision logic
// from dist/reentry.js, plus the real hook process (dist/reentry-hook.js)
// driven over its actual stdin/stdout protocol against a real room, which is
// where the presence-identity guarantees actually have to hold. The
// `stop_hook_active` loop-guard semantics and the backoff-sleep timing are
// still covered by the pure tests and by the manual verification steps in
// reentry-hook.ts's module doc rather than here.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repoRoot, "dist", "index.js");
const hook = join(repoRoot, "dist", "reentry-hook.js");

/**
 * The `session_id` Claude Code puts on stdin for every Stop firing of one
 * logical session — what the hook pins its presence row to.
 */
const HOOK_SESSION_ID = "11111111-2222-3333-4444-555555555555";
/** A second Claude Code session in the same room — a genuinely different id. */
const OTHER_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function freshDir() {
  return mkdtempSync(join(tmpdir(), "squad-reentry-"));
}

function runCli(args, env = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return result;
}

/** Invoke the Stop hook with an arbitrary stdin payload; returns trimmed stdout. */
function callHook(dir, persona, payload, env = {}) {
  const result = spawnSync(process.execPath, [hook], {
    cwd: repoRoot,
    encoding: "utf8",
    input: JSON.stringify(payload),
    env: { ...process.env, SQUAD_DIR: dir, SQUAD_PERSONA: persona, ...env },
  });
  // Fail-open invariant: the hook never exits non-zero, which Claude Code
  // would read as a hook failure rather than "allow the stop".
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/**
 * Invoke the hook exactly as Claude Code does. Every test that uses this
 * keeps directed work pending in the room, so `decide()` blocks immediately
 * with no backoff sleep and the hook returns promptly.
 */
function runHook(dir, persona, sessionId = HOOK_SESSION_ID, env = {}) {
  return callHook(
    dir,
    persona,
    {
      session_id: sessionId,
      transcript_path: join(dir, "transcript.jsonl"),
      stop_hook_active: false,
      cwd: repoRoot,
    },
    env,
  );
}

/** The presence rows a persona holds in the room, oldest first. */
function sessionIds(dir, persona) {
  const db = new DatabaseSync(join(dir, "squad.db"));
  try {
    return db
      .prepare("SELECT session_id FROM sessions WHERE persona = ? ORDER BY joined_at ASC")
      .all(persona)
      .map((row) => row.session_id);
  } finally {
    db.close();
  }
}

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

test("mentionsPersona default boundary matches hyphenated refinements, exact does not", () => {
  // Default (no opts): a refinement mention counts, e.g. "@repo-doctor" names
  // a persona built on top of "repo".
  assert.equal(mentionsPersona("@repo-doctor can you look at this?", "repo"), true);
  // exact: true anchors the match so a refinement no longer counts — for
  // broadcast targets, "repo-doctor" is an unrelated persona, not a form of
  // address to "repo".
  assert.equal(mentionsPersona("@repo-doctor can you look at this?", "repo", { exact: true }), false);
  assert.equal(mentionsPersona("@repo stop writing to disk", "repo", { exact: true }), true);
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

test("decide: quiet with an elapsed window fires — lifetime count increments, window clears", () => {
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
  assert.equal(result.nextState.attempt, 0);
  assert.equal(result.nextState.totalFired, 3);
  assert.equal(result.nextState.nextFireAt, null);
});

// --- the real hook process: one Claude session is one presence row (#126) ---

test("every wake of one Claude session shares that session's single presence row", () => {
  const dir = freshDir();
  try {
    runCli(["send", "@claude-worker please pick this up"], {
      SQUAD_DIR: dir,
      SQUAD_PERSONA: "codex",
    });
    // Three stop events of ONE Claude Code session: three separate OS
    // processes, all carrying the same stdin `session_id`. Before #126 each
    // minted its own live `sessions` row.
    for (const _ of [1, 2, 3])
      assert.match(runHook(dir, "claude-worker"), /"decision":"block"/);
    assert.deepEqual(
      sessionIds(dir, "claude-worker"),
      [HOOK_SESSION_ID],
      "one logical Claude session is one presence row, not one per wake",
    );

    // A genuinely different Claude session is still its own presence row.
    runHook(dir, "claude-worker", OTHER_SESSION_ID);
    assert.deepEqual(sessionIds(dir, "claude-worker"), [HOOK_SESSION_ID, OTHER_SESSION_ID]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the permanent-stop announcement posts from the same session row", () => {
  const dir = freshDir();
  try {
    runCli(["send", "@claude-worker please pick this up"], {
      SQUAD_DIR: dir,
      SQUAD_PERSONA: "codex",
    });
    assert.match(runHook(dir, "claude-worker"), /"decision":"block"/);

    // Operator stop: the hook allows the stop and announces it into the room
    // through a second `Squad` (the `announceStopOnce` callback), which must
    // post as the same logical session rather than opening another row.
    assert.equal(runHook(dir, "claude-worker", HOOK_SESSION_ID, { SQUAD_REENTRY_STOP: "1" }), "");
    const posted = runCli(["read"], { SQUAD_DIR: dir, SQUAD_PERSONA: "codex" }).stdout;
    assert.match(posted, /stopping permanently/);
    assert.deepEqual(sessionIds(dir, "claude-worker"), [HOOK_SESSION_ID]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing or non-string session_id still fails open, minting its own row", () => {
  const dir = freshDir();
  try {
    runCli(["send", "@claude-worker please pick this up"], {
      SQUAD_DIR: dir,
      SQUAD_PERSONA: "codex",
    });
    const base = {
      transcript_path: join(dir, "transcript.jsonl"),
      stop_hook_active: false,
      cwd: repoRoot,
    };
    // No `session_id` key at all, then a non-string one, then blank: each
    // must still decide normally (exit 0 asserted inside callHook) and fall
    // back to today's behavior — a freshly minted session per process.
    assert.match(callHook(dir, "claude-worker", base), /"decision":"block"/);
    assert.match(callHook(dir, "claude-worker", { ...base, session_id: 42 }), /"decision":"block"/);
    assert.match(
      callHook(dir, "claude-worker", { ...base, session_id: "   " }),
      /"decision":"block"/,
    );

    const ids = sessionIds(dir, "claude-worker");
    assert.equal(ids.length, 3, "nothing to pin to — each process keeps its own row");
    for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DEFAULT_BACKOFF and DEFAULT_SLEEP_CAP_MS are sane (documented in README)", () => {
  assert.equal(DEFAULT_BACKOFF.baseMs, 30_000);
  assert.equal(DEFAULT_BACKOFF.multiplier, 2);
  assert.equal(DEFAULT_BACKOFF.capMs, 30 * 60_000);
  assert.equal(DEFAULT_BACKOFF.jitterFraction, 0.2);
  assert.equal(DEFAULT_SLEEP_CAP_MS, 45_000);
});
