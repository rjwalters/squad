import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Two layers, mirroring what tests/reentry-hook.test.mjs does for the Claude
// Code side:
//
//   1. Pure-function tests for the Codex supervisor's decision logic
//      (classification, argv construction, the pre-launch gate).
//   2. Control-loop tests driving `supervise()` with injected deps and a
//      virtual clock — no real Codex, no real sleeping.
//
// Plus one integration-style test at the bottom that spawns a *real* stub
// process which ends by writing a simulated `task_complete` rollout record,
// and asserts the supervisor re-invokes it (issue #60's Test Plan).
const {
  classifyRolloutTail,
  pickLatestRollout,
  buildCodexArgs,
  preLaunchStop,
  isCleanPark,
  parkAnnouncement,
  crashAnnouncement,
  startAnnouncement,
  supervise,
  FALLBACK_JOIN_PROMPT,
} = await import("../dist/codex-reentry.js");

const { initialState, decide } = await import("../dist/reentry.js");
const { classifyRunFromLogs } = await import("../dist/codex-reentry-driver.js");

const FAST_BACKOFF = { baseMs: 1000, multiplier: 2, capMs: 4000, jitterFraction: 0 };

// --- classification ---------------------------------------------------------

test("classifyRolloutTail recognizes a flat task_complete record", () => {
  const log = ['{"type":"turn_started"}', '{"type":"task_complete"}'].join("\n") + "\n";
  assert.equal(classifyRolloutTail(log), "task_complete");
});

test("classifyRolloutTail recognizes an enveloped task_complete payload", () => {
  const log =
    '{"timestamp":"2026-01-01T00:00:00Z","type":"event_msg","payload":{"type":"task_complete","last_agent_message":"done"}}';
  assert.equal(classifyRolloutTail(log), "task_complete");
});

test("classifyRolloutTail only looks at the LAST record", () => {
  const log = ['{"type":"task_complete"}', '{"type":"stream_error"}'].join("\n");
  assert.equal(classifyRolloutTail(log), "error");
});

test("classifyRolloutTail reports non-terminal and unreadable tails without faking a park", () => {
  assert.equal(classifyRolloutTail('{"type":"agent_message"}'), "unknown");
  assert.equal(classifyRolloutTail(""), "missing");
  assert.equal(classifyRolloutTail("   \n\n"), "missing");
  assert.equal(classifyRolloutTail("not json at all"), "missing");
  assert.equal(classifyRolloutTail('{"no":"type"}'), "missing");
  assert.equal(classifyRolloutTail("[1,2,3]"), "missing");
});

// --- rollout selection ------------------------------------------------------

test("pickLatestRollout takes the newest candidate at/after the run start", () => {
  const candidates = [
    { path: "/old.jsonl", mtimeMs: 1000 },
    { path: "/new.jsonl", mtimeMs: 9000 },
    { path: "/mid.jsonl", mtimeMs: 6000 },
  ];
  assert.equal(pickLatestRollout(candidates, 5000, 0), "/new.jsonl");
});

test("pickLatestRollout ignores files older than the run (with mtime tolerance)", () => {
  const candidates = [{ path: "/stale.jsonl", mtimeMs: 1000 }];
  assert.equal(pickLatestRollout(candidates, 50_000, 0), null);
  // within tolerance → accepted (fs mtime granularity)
  assert.equal(pickLatestRollout(candidates, 2000, 2000), "/stale.jsonl");
  assert.equal(pickLatestRollout([], 0, 0), null);
});

// --- argv -------------------------------------------------------------------

test("buildCodexArgs uses `exec` (the mode that exits at end of turn)", () => {
  assert.deepEqual(buildCodexArgs({ mode: "fresh", prompt: "/squad-join" }), [
    "exec",
    "/squad-join",
  ]);
  assert.deepEqual(
    buildCodexArgs({ mode: "fresh", prompt: "p", extraArgs: ["--model", "x"] }),
    ["exec", "--model", "x", "p"],
  );
});

test("buildCodexArgs resumes the last session when the local codex supports it", () => {
  assert.deepEqual(buildCodexArgs({ mode: "resume", prompt: "keep going" }), [
    "exec",
    "resume",
    "--last",
    "keep going",
  ]);
});

// --- the pre-launch gate ----------------------------------------------------

test("preLaunchStop: operator-stop, then TTL, then the attempt cap, then null", () => {
  const armed = "2026-01-01T00:00:00.000Z";
  const armedMs = Date.parse(armed);
  const base = { state: initialState(armed), nowMs: armedMs, ttlMinutes: 60, maxAttempts: 5 };

  assert.match(preLaunchStop({ ...base, operatorStopped: true }), /operator stop/);
  assert.match(
    preLaunchStop({ ...base, nowMs: armedMs + 61 * 60_000, operatorStopped: false }),
    /TTL of 60m/,
  );
  assert.match(
    preLaunchStop({
      ...base,
      state: { ...base.state, attempt: 5 },
      operatorStopped: false,
    }),
    /attempt cap of 5/,
  );
  assert.equal(preLaunchStop({ ...base, operatorStopped: false }), null);
});

test("preLaunchStop: maxAttempts <= 0 means no cap", () => {
  const armed = "2026-01-01T00:00:00.000Z";
  assert.equal(
    preLaunchStop({
      state: { ...initialState(armed), attempt: 999 },
      nowMs: Date.parse(armed),
      ttlMinutes: 60,
      maxAttempts: 0,
      operatorStopped: false,
    }),
    null,
  );
});

// --- shared decision core: the attempt cap ----------------------------------

test("decide: the attempt cap allows the stop and overrides directed work", () => {
  const state = { ...initialState("2026-01-01T00:00:00.000Z"), attempt: 3 };
  const result = decide({
    state,
    nowMs: Date.parse("2026-01-01T00:01:00.000Z"),
    hasDirectedWork: true,
    operatorStopped: false,
    ttlMinutes: 240,
    maxAttempts: 3,
  });
  assert.equal(result.block, false);
  assert.match(result.reason, /attempt cap of 3/);
  assert.equal(result.nextState, state);
});

test("decide: an unset/zero maxAttempts leaves the Claude Stop hook uncapped", () => {
  const state = { ...initialState("2026-01-01T00:00:00.000Z"), attempt: 500 };
  for (const maxAttempts of [undefined, 0]) {
    const result = decide({
      state,
      nowMs: Date.parse("2026-01-01T00:01:00.000Z"),
      hasDirectedWork: true,
      operatorStopped: false,
      ttlMinutes: 240,
      maxAttempts,
    });
    assert.equal(result.block, true, `maxAttempts=${maxAttempts} should stay uncapped`);
  }
});

// --- park / crash messaging -------------------------------------------------

test("parkAnnouncement is unambiguous that nothing will bring the persona back", () => {
  const body = parkAnnouncement({
    persona: "codex",
    reason: "TTL of 240m exceeded since 2026-01-01T00:00:00.000Z",
    runs: 4,
    attempts: 3,
  });
  assert.match(body, /will NOT return without an operator/);
  assert.match(body, /squad codex-reentry/);
  assert.match(body, /TTL of 240m/);
});

test("startAnnouncement tells the room a quiet gap will self-heal", () => {
  const body = startAnnouncement({ persona: "codex", ttlMinutes: 240, maxAttempts: 48 });
  assert.match(body, /re-enter itself/);
  assert.match(body, /240m TTL/);
  assert.match(body, /48 re-entries/);
});

test("crashAnnouncement distinguishes a failure from a park", () => {
  const body = crashAnnouncement({ persona: "codex", run: 2, exitCode: 1, outcome: "error" });
  assert.match(body, /not a clean park/);
});

test("isCleanPark: a non-zero exit is never a park; a clean exit with no log still is", () => {
  assert.equal(isCleanPark("task_complete", 0), true);
  assert.equal(isCleanPark("missing", 0), true);
  assert.equal(isCleanPark("unknown", 0), true);
  assert.equal(isCleanPark("error", 0), false);
  assert.equal(isCleanPark("task_complete", 1), false);
  assert.equal(isCleanPark("task_complete", null), false);
});

// --- the control loop (injected deps, virtual clock) ------------------------

/**
 * Builds a `SuperviseDeps` whose clock only advances when the loop sleeps —
 * so backoff windows elapse deterministically and the test never waits.
 */
function fakeDeps(overrides = {}) {
  const calls = { runs: [], sleeps: [], announcements: [], logs: [] };
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  let state = initialState(new Date(now).toISOString());
  const deps = {
    runCodex: async (args) => {
      calls.runs.push(args);
      return 0;
    },
    classifyRun: async () => "task_complete",
    resumeSupported: async () => false,
    now: () => now,
    sleep: async (ms) => {
      calls.sleeps.push(ms);
      now += ms;
      if (calls.sleeps.length > 5000) throw new Error("runaway supervisor loop");
    },
    loadState: () => state,
    saveState: (s) => {
      state = s;
    },
    operatorStopped: () => false,
    hasDirectedWork: async () => false,
    announce: (body) => calls.announcements.push(body),
    log: (line) => calls.logs.push(line),
    ...overrides,
  };
  return { deps, calls, getState: () => state, setNow: (v) => (now = v) };
}

const baseCfg = {
  persona: "codex",
  ttlMinutes: 10_000,
  maxAttempts: 3,
  joinPrompt: FALLBACK_JOIN_PROMPT,
  reentryPrompt: "keep going",
  extraArgs: [],
  backoff: FAST_BACKOFF,
  sleepCapMs: 500,
  minRunIntervalMs: 0,
};

test("supervise re-enters a parked session and stops at the attempt cap", async () => {
  const { deps, calls } = fakeDeps();
  const summary = await supervise(baseCfg, deps);

  // Initial launch + one launch per fired re-entry, then a hard stop.
  assert.equal(summary.runs, 4);
  assert.equal(summary.attempts, 3);
  assert.match(summary.stopReason, /attempt cap of 3/);
  assert.deepEqual(summary.outcomes, Array(4).fill("task_complete"));
  assert.equal(calls.runs.length, 4);
  for (const args of calls.runs) assert.deepEqual(args, ["exec", FALLBACK_JOIN_PROMPT]);
  assert.match(calls.announcements.at(-1), /will NOT return without an operator/);
});

test("supervise resumes rather than rejoining once the binary supports it", async () => {
  const { deps, calls } = fakeDeps({ resumeSupported: async () => true });
  await supervise({ ...baseCfg, maxAttempts: 2 }, deps);
  assert.deepEqual(calls.runs[0], ["exec", FALLBACK_JOIN_PROMPT]);
  assert.deepEqual(calls.runs[1], ["exec", "resume", "--last", "keep going"]);
});

test("supervise: operator-stop quiets a live supervisor within one sleep slice", async () => {
  let stopped = false;
  const { deps, calls } = fakeDeps({ operatorStopped: () => stopped });
  deps.runCodex = async (args) => {
    calls.runs.push(args);
    stopped = true; // operator touches .squad/reentry-stop while the run is in flight
    return 0;
  };
  const summary = await supervise(baseCfg, deps);
  assert.equal(summary.runs, 1);
  assert.match(summary.stopReason, /operator stop requested/);
  assert.match(calls.announcements.at(-1), /will NOT return without an operator/);
});

test("supervise: operator-stop before the first launch never spawns codex at all", async () => {
  const { deps, calls } = fakeDeps({ operatorStopped: () => true });
  const summary = await supervise(baseCfg, deps);
  assert.equal(summary.runs, 0);
  assert.equal(calls.runs.length, 0);
  assert.deepEqual(calls.announcements, []); // no "supervisor is up" claim it can't keep
});

test("supervise: the TTL bounds re-entry even with the attempt cap far away", async () => {
  const { deps } = fakeDeps();
  const summary = await supervise({ ...baseCfg, ttlMinutes: 1, maxAttempts: 1000 }, deps);
  assert.match(summary.stopReason, /TTL of 1m exceeded/);
  assert.ok(summary.runs >= 1 && summary.runs < 1000);
});

test("supervise: a crashing codex is announced and never re-entered on directed work", async () => {
  const { deps, calls } = fakeDeps({
    classifyRun: async () => "error",
    hasDirectedWork: async () => {
      throw new Error("hasDirectedWork must not be consulted after a crash");
    },
  });
  deps.runCodex = async (args) => {
    calls.runs.push(args);
    return 1;
  };
  const summary = await supervise({ ...baseCfg, maxAttempts: 2 }, deps);
  assert.equal(summary.runs, 3);
  assert.ok(calls.announcements.some((a) => /ended abnormally/.test(a)));
  // Backoff still grew normally rather than hot-looping.
  assert.ok(calls.sleeps.reduce((a, b) => a + b, 0) > 0);
});

test("supervise: directed work re-enters immediately without burning an attempt", async () => {
  let directedRemaining = 1;
  const { deps, calls } = fakeDeps({
    hasDirectedWork: async () => directedRemaining-- > 0,
  });
  const summary = await supervise({ ...baseCfg, maxAttempts: 1 }, deps);
  // run 1 → @mention → immediate re-entry (attempt stays 0) → run 2 →
  // quiet → one backoff window fires (attempt 1) → run 3 → cap.
  assert.equal(summary.runs, 3);
  assert.equal(summary.attempts, 1);
  assert.equal(calls.runs.length, 3);
  assert.match(summary.stopReason, /attempt cap of 1/);
});

test("supervise: the inter-run floor throttles a directed-work reset", async () => {
  const { deps, calls } = fakeDeps({ hasDirectedWork: async () => true });
  await supervise({ ...baseCfg, maxAttempts: 1, minRunIntervalMs: 5000, ttlMinutes: 1 }, deps);
  // Every gap between runs waited out the floor rather than relaunching hot.
  assert.ok(calls.sleeps.length > 0);
  assert.ok(calls.sleeps.every((ms) => ms > 0));
});

// --- integration: a real stub process that parks on task_complete -----------

test("supervise re-invokes a real stub process that ends in a task_complete record", async () => {
  const home = mkdtempSync(join(tmpdir(), "squad-codex-home-"));
  const sessionsDir = join(home, "sessions", "2026", "01", "01");
  mkdirSync(sessionsDir, { recursive: true });
  const argvLog = join(home, "argv.log");

  // A stand-in for `codex exec`: it writes a rollout record that looks
  // exactly like a cleanly parked Codex turn, then exits 0 — the silent-park
  // signature from issue #60, with nothing to restart it.
  const stub = join(home, "stub-codex.mjs");
  writeFileSync(
    stub,
    [
      "#!/usr/bin/env node",
      'import { appendFileSync, writeFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
      "const n = Date.now();",
      `writeFileSync(${JSON.stringify(sessionsDir)} + "/rollout-" + n + "-" + Math.random() + ".jsonl",`,
      '  \'{"type":"event_msg","payload":{"type":"agent_message"}}\\n\' +',
      '  \'{"type":"event_msg","payload":{"type":"task_complete"}}\\n\');',
      "process.exit(0);",
    ].join("\n"),
  );
  chmodSync(stub, 0o755);

  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;

  let state = initialState(new Date().toISOString());
  const outcomesSeen = [];
  const announcements = [];

  try {
    const summary = await supervise(
      {
        persona: "codex",
        ttlMinutes: 10_000,
        maxAttempts: 2,
        joinPrompt: "/squad-join",
        reentryPrompt: "keep going",
        extraArgs: [],
        backoff: { baseMs: 1, multiplier: 1, capMs: 1, jitterFraction: 0 },
        sleepCapMs: 5,
        minRunIntervalMs: 0,
      },
      {
        runCodex: (args) =>
          new Promise((resolve) => {
            const child = spawn(process.execPath, [stub, ...args], { stdio: "ignore" });
            child.on("error", () => resolve(null));
            child.on("close", (code) => resolve(code));
          }),
        // The real log reader, against the real temp CODEX_HOME the stub wrote.
        classifyRun: async (startedAtMs) => {
          const outcome = classifyRunFromLogs(startedAtMs);
          outcomesSeen.push(outcome);
          return outcome;
        },
        resumeSupported: async () => false,
        now: () => Date.now(),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        loadState: () => state,
        saveState: (s) => {
          state = s;
        },
        operatorStopped: () => false,
        hasDirectedWork: async () => false,
        announce: (body) => announcements.push(body),
        log: () => {},
      },
    );

    // The parked stub was recovered without any operator action: three real
    // process launches, each classified from its own rollout log.
    assert.equal(summary.runs, 3);
    assert.deepEqual(summary.outcomes, ["task_complete", "task_complete", "task_complete"]);
    assert.deepEqual(outcomesSeen, ["task_complete", "task_complete", "task_complete"]);
    assert.match(summary.stopReason, /attempt cap of 2/);
    assert.ok(announcements.every((a) => !/ended abnormally/.test(a)));
    assert.match(announcements.at(-1), /will NOT return without an operator/);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("classifyRunFromLogs reports `missing` when there is no readable session log", () => {
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(tmpdir(), "squad-codex-home-does-not-exist-" + Date.now());
  try {
    assert.equal(classifyRunFromLogs(Date.now()), "missing");
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
  }
});
