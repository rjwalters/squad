import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Two harnesses, mirroring tests/reentry-hook.test.mjs plus what that suite
// leaves to manual verification: the pure decision logic from dist/inbox.js,
// and the real hook process (dist/inbox-hook.js) driven over its actual
// stdin/stdout protocol against a real room, which is where the fail-open,
// rate-limit and "report once" guarantees actually have to hold.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repoRoot, "dist", "index.js");
const hook = join(repoRoot, "dist", "inbox-hook.js");

const {
  DEFAULT_INBOX_INTERVAL_SECONDS,
  INBOX_NOTICE_ITEMS,
  INBOX_QUOTE_LENGTH,
  REPO_BROADCAST,
  decideInbox,
  initialInboxState,
  peekDue,
  renderNotice,
} = await import("../dist/inbox.js");

function freshDir() {
  return mkdtempSync(join(tmpdir(), "squad-inbox-"));
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

/** Invoke the hook exactly as Claude Code does, and parse what it emitted. */
function runHook(dir, persona, env = {}, event = "PostToolUse") {
  const result = spawnSync(process.execPath, [hook], {
    cwd: repoRoot,
    encoding: "utf8",
    input: JSON.stringify({
      session_id: "11111111-2222-3333-4444-555555555555",
      hook_event_name: event,
      cwd: repoRoot,
      tool_name: "Bash",
    }),
    env: {
      ...process.env,
      SQUAD_DIR: dir,
      SQUAD_PERSONA: persona,
      SQUAD_INBOX_INTERVAL_SECONDS: "0", // rate limit off unless a test sets it
      ...env,
    },
  });
  // Invariant 1: the hook must never fail the tool call it rides on.
  assert.equal(result.status, 0, result.stderr);
  const text = result.stdout.trim();
  return {
    raw: text,
    context: text ? JSON.parse(text).hookSpecificOutput.additionalContext : null,
    event: text ? JSON.parse(text).hookSpecificOutput.hookEventName : null,
  };
}

test("peekDue enforces the rate limit, and fails toward peeking", () => {
  const base = Date.parse("2026-10-01T00:00:00.000Z");
  const state = { ...initialInboxState(), lastPeekAt: "2026-10-01T00:00:00.000Z" };
  assert.equal(peekDue(state, base + 59_000, 60), false);
  assert.equal(peekDue(state, base + 60_000, 60), true);
  assert.equal(peekDue(state, base + 600_000, 60), true);
  // No prior peek, a corrupt stamp, and a disabled limit all peek.
  assert.equal(peekDue(initialInboxState(), base, 60), true);
  assert.equal(peekDue({ ...state, lastPeekAt: "nonsense" }, base, 60), true);
  assert.equal(peekDue(state, base, 0), true);
  assert.equal(peekDue(state, base, -5), true);
  assert.equal(DEFAULT_INBOX_INTERVAL_SECONDS, 60);
});

test("decideInbox reports a directed message once, then stays quiet", () => {
  const observation = {
    unread: [
      { id: 7, sender: "human", body: "unrelated chatter" },
      { id: 8, sender: "opus-5-3f2a", body: "@claude-worker disk triage please" },
    ],
    directed: [{ id: 8, sender: "opus-5-3f2a", body: "@claude-worker disk triage please" }],
    reviews: [],
  };
  const first = decideInbox(observation, initialInboxState(), "2026-10-01T00:00:00.000Z");
  assert.match(first.notice, /disk triage please/);
  assert.equal(first.nextState.notifiedMessageId, 8);
  assert.equal(first.nextState.lastPeekAt, "2026-10-01T00:00:00.000Z");

  // Same still-unread message (the hook never consumes) — not reported again.
  const second = decideInbox(observation, first.nextState, "2026-10-01T00:01:00.000Z");
  assert.equal(second.notice, null);
  assert.equal(second.nextState.notifiedMessageId, 8);
});

test("decideInbox advances the mark past undirected chatter so it cannot queue up", () => {
  const first = decideInbox(
    {
      unread: [{ id: 4, sender: "human", body: "nothing for you" }],
      directed: [],
      reviews: [],
    },
    initialInboxState(),
    "2026-10-01T00:00:00.000Z",
  );
  assert.equal(first.notice, null);
  assert.equal(first.nextState.notifiedMessageId, 4);
});

test("decideInbox reports a pending review once and prunes closed ones", () => {
  const review = { id: 3, requested_by: "codex", priority: "high", body: "check the migration" };
  const first = decideInbox(
    { unread: [], directed: [], reviews: [review] },
    initialInboxState(),
    "2026-10-01T00:00:00.000Z",
  );
  assert.match(first.notice, /1 pending review/);
  assert.match(first.notice, /squad_review open/);
  assert.deepEqual(first.nextState.notifiedReviewIds, [3]);

  const again = decideInbox(
    { unread: [], directed: [], reviews: [review] },
    first.nextState,
    "2026-10-01T00:01:00.000Z",
  );
  assert.equal(again.notice, null);
  assert.deepEqual(again.nextState.notifiedReviewIds, [3]);

  // Resolved: the id drops out, so the list is bounded by live requests.
  const resolved = decideInbox(
    { unread: [], directed: [], reviews: [] },
    again.nextState,
    "2026-10-01T00:02:00.000Z",
  );
  assert.equal(resolved.notice, null);
  assert.deepEqual(resolved.nextState.notifiedReviewIds, []);
});

test("renderNotice collapses long bodies and overflow items", () => {
  assert.equal(renderNotice([], []), null);
  const long = renderNotice(
    [{ id: 1, sender: "codex", body: "x".repeat(INBOX_QUOTE_LENGTH + 50) }],
    [],
  );
  assert.ok(long.includes("…"), "a long body is elided");
  assert.ok(!long.includes("x".repeat(INBOX_QUOTE_LENGTH + 1)));
  const many = renderNotice(
    Array.from({ length: INBOX_NOTICE_ITEMS + 2 }, (_, i) => ({
      id: i + 1,
      sender: "codex",
      body: `ping ${i}`,
    })),
    [],
  );
  assert.match(many, new RegExp(`${INBOX_NOTICE_ITEMS + 2} directed messages`));
  assert.match(many, /\+2 more/);
  assert.equal(REPO_BROADCAST, "repo");
});

test("a directed message reaches a busy session's next tool call exactly once", () => {
  const dir = freshDir();
  try {
    runCli(["send", "@claude-worker disk triage: pause writes"], {
      SQUAD_DIR: dir,
      SQUAD_PERSONA: "opus-5-3f2a",
    });
    const first = runHook(dir, "claude-worker");
    assert.match(first.context, /disk triage: pause writes/);
    assert.match(first.context, /squad_check/);
    assert.equal(first.event, "PostToolUse");

    // Reported once: the next eligible tool call is silent even though the
    // message is still unread.
    assert.equal(runHook(dir, "claude-worker").raw, "");

    // ...and it really was not consumed. Forgetting only what the *hook*
    // announced (its own state file, never the room's read cursor) brings the
    // same still-unread message straight back: a consuming read would have
    // left nothing for the peek to find.
    rmSync(join(dir, "inbox", "claude-worker.json"));
    assert.match(runHook(dir, "claude-worker").context, /disk triage: pause writes/);

    // UserPromptSubmit echoes its own event name back (Claude Code drops a
    // hookSpecificOutput whose event does not match the firing event).
    runCli(["send", "@claude-worker second ask"], {
      SQUAD_DIR: dir,
      SQUAD_PERSONA: "opus-5-3f2a",
    });
    const prompt = runHook(dir, "claude-worker", {}, "UserPromptSubmit");
    assert.equal(prompt.event, "UserPromptSubmit");
    assert.match(prompt.context, /second ask/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an @repo broadcast reaches a session whose persona was never mentioned", () => {
  const dir = freshDir();
  try {
    runCli(["send", "@repo stop writing to disk, we are at 99%"], {
      SQUAD_DIR: dir,
      SQUAD_PERSONA: "human",
    });
    // An automatically generated '<label>-<hex>' identity: nothing in the
    // message names it, and it never joined.
    const broadcast = runHook(dir, "opus-5-3f2a");
    assert.match(broadcast.context, /stop writing to disk/);
    assert.equal(runHook(dir, "opus-5-3f2a").raw, "");
    // ...and every other session in the room gets it too.
    assert.match(runHook(dir, "gpt-6-9c1d").context, /stop writing to disk/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("@repo-doctor is an ordinary mention, not an @repo broadcast", () => {
  const dir = freshDir();
  try {
    runCli(["send", "@repo-doctor can you look at the schema drift?"], {
      SQUAD_DIR: dir,
      SQUAD_PERSONA: "human",
    });
    // "repo-doctor" is an ordinary name sharing the broadcast target's
    // prefix. An unrelated session must stay silent.
    assert.equal(runHook(dir, "opus-5-3f2a").raw, "");

    // The real @repo broadcast still reaches everyone.
    runCli(["send", `@${REPO_BROADCAST} stop writing to disk, we are at 99%`], {
      SQUAD_DIR: dir,
      SQUAD_PERSONA: "human",
    });
    assert.match(runHook(dir, "opus-5-3f2a").context, /stop writing to disk/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ordinary chatter never interrupts", () => {
  const dir = freshDir();
  try {
    runCli(["send", "rebuilding the index, back in a bit"], {
      SQUAD_DIR: dir,
      SQUAD_PERSONA: "codex",
    });
    assert.equal(runHook(dir, "claude-worker").raw, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the rate limit keeps most tool calls out of the room entirely", () => {
  const dir = freshDir();
  try {
    runCli(["send", "@claude-worker first"], { SQUAD_DIR: dir, SQUAD_PERSONA: "codex" });
    const env = { SQUAD_INBOX_INTERVAL_SECONDS: "3600" };
    assert.match(runHook(dir, "claude-worker", env).context, /first/);
    runCli(["send", "@claude-worker second"], { SQUAD_DIR: dir, SQUAD_PERSONA: "codex" });
    // Inside the window: not even peeked, so the second ask waits.
    assert.equal(runHook(dir, "claude-worker", env).raw, "");
    // Window open again: delivered.
    assert.match(runHook(dir, "claude-worker").context, /second/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no room resolves from cwd: no output, no error, and no room created", () => {
  const dir = freshDir();
  try {
    const quiet = runHook(dir, "claude-worker");
    assert.equal(quiet.raw, "");
    assert.throws(() => readFileSync(join(dir, "squad.db")), /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("operator stop is honored in all three forms", () => {
  const dir = freshDir();
  try {
    runCli(["send", "@claude-worker urgent"], { SQUAD_DIR: dir, SQUAD_PERSONA: "codex" });
    assert.equal(runHook(dir, "claude-worker", { SQUAD_INBOX_STOP: "1" }).raw, "");

    writeFileSync(join(dir, "inbox-stop"), "");
    assert.equal(runHook(dir, "claude-worker").raw, "");
    rmSync(join(dir, "inbox-stop"));

    mkdirSync(join(dir, "inbox"), { recursive: true });
    writeFileSync(join(dir, "inbox", "claude-worker.stop"), "");
    assert.equal(runHook(dir, "claude-worker").raw, "");
    // Another persona in the same room is unaffected by a persona-scoped stop.
    runCli(["send", "@other urgent"], { SQUAD_DIR: dir, SQUAD_PERSONA: "codex" });
    assert.match(runHook(dir, "other").context, /urgent/);

    rmSync(join(dir, "inbox", "claude-worker.stop"));
    assert.match(runHook(dir, "claude-worker").context, /urgent/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fails open on a corrupt state file, an unwritable state dir, and a corrupt room", () => {
  const dir = freshDir();
  try {
    runCli(["send", "@claude-worker look at this"], { SQUAD_DIR: dir, SQUAD_PERSONA: "codex" });

    // Corrupt state: re-derived from scratch, so the message is still told.
    mkdirSync(join(dir, "inbox"), { recursive: true });
    writeFileSync(join(dir, "inbox", "claude-worker.json"), "{not json");
    assert.match(runHook(dir, "claude-worker").context, /look at this/);

    // Unwritable state directory: still delivers, just cannot remember.
    rmSync(join(dir, "inbox", "claude-worker.json"));
    chmodSync(join(dir, "inbox"), 0o500);
    try {
      assert.match(runHook(dir, "claude-worker").context, /look at this/);
    } finally {
      chmodSync(join(dir, "inbox"), 0o700);
    }

    // Corrupt database: silent, exit 0 (asserted inside runHook).
    const broken = freshDir();
    try {
      writeFileSync(join(broken, "squad.db"), "this is not a sqlite file");
      assert.equal(runHook(broken, "claude-worker").raw, "");
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed, foreign, and unidentified invocations stay silent", () => {
  const dir = freshDir();
  try {
    runCli(["send", "@claude-worker hello"], { SQUAD_DIR: dir, SQUAD_PERSONA: "codex" });
    const call = (input, env = {}) => {
      const result = spawnSync(process.execPath, [hook], {
        cwd: repoRoot,
        encoding: "utf8",
        input,
        env: {
          ...process.env,
          SQUAD_DIR: dir,
          SQUAD_PERSONA: "claude-worker",
          SQUAD_INBOX_INTERVAL_SECONDS: "0",
          ...env,
        },
      });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    assert.equal(call("{not json"), "");
    assert.equal(call(""), "");
    // An event this hook is not wired to is not ours to answer.
    assert.equal(call(JSON.stringify({ hook_event_name: "PreToolUse" })), "");
    // No pinned identity: nothing to match @mentions against.
    assert.equal(
      call(JSON.stringify({ hook_event_name: "PostToolUse" }), { SQUAD_PERSONA: "" }),
      "",
    );
    // Sanity: the same input with an identity does deliver.
    assert.match(call(JSON.stringify({ hook_event_name: "PostToolUse" })), /hello/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the bash wrapper short-circuits inside the rate-limit window", () => {
  const dir = freshDir();
  const scratch = freshDir();
  try {
    const wrapper = join(scratch, "squad-inbox.sh");
    writeFileSync(
      wrapper,
      readFileSync(join(repoRoot, "hooks/squad-inbox.sh"), "utf8")
        .replaceAll("__SQUAD_INBOX_JS__", hook)
        .replaceAll("__SQUAD_INBOX_PERSONA__", "claude-worker"),
    );
    chmodSync(wrapper, 0o755);
    const call = (env = {}) => {
      const result = spawnSync("bash", [wrapper], {
        cwd: repoRoot,
        encoding: "utf8",
        input: JSON.stringify({ hook_event_name: "PostToolUse", cwd: repoRoot }),
        env: { ...process.env, SQUAD_DIR: dir, ...env },
      });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    runCli(["send", "@claude-worker through the wrapper"], {
      SQUAD_DIR: dir,
      SQUAD_PERSONA: "codex",
    });
    assert.match(call({ SQUAD_INBOX_INTERVAL_SECONDS: "3600" }), /through the wrapper/);
    // The state file is now fresh, so the wrapper exits without spawning node.
    runCli(["send", "@claude-worker and again"], { SQUAD_DIR: dir, SQUAD_PERSONA: "codex" });
    assert.equal(call({ SQUAD_INBOX_INTERVAL_SECONDS: "3600" }), "");
    // A missing build is silent rather than an error on every tool call.
    const missing = join(scratch, "missing-build.sh");
    writeFileSync(
      missing,
      readFileSync(join(repoRoot, "hooks/squad-inbox.sh"), "utf8")
        .replaceAll("__SQUAD_INBOX_JS__", join(scratch, "no-such-build.js"))
        .replaceAll("__SQUAD_INBOX_PERSONA__", "claude-worker"),
    );
    chmodSync(missing, 0o755);
    const broken = spawnSync("bash", [missing], {
      cwd: repoRoot,
      encoding: "utf8",
      input: JSON.stringify({ hook_event_name: "PostToolUse", cwd: repoRoot }),
      env: { ...process.env, SQUAD_DIR: dir },
    });
    assert.equal(broken.status, 0, broken.stderr);
    assert.equal(broken.stdout.trim(), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("'repo' is reserved: no persona, automatic or pinned, can claim it", async () => {
  const { isReservedPersona, reserveAutomaticPersona } = await import("../dist/identity.js");
  const { Squad } = await import("../dist/core.js");
  const { openDb } = await import("../dist/db.js");
  assert.equal(isReservedPersona("repo"), true);
  assert.equal(isReservedPersona("REPO"), true);
  assert.equal(isReservedPersona("repo-doctor"), false);

  const dir = freshDir();
  const previous = process.env.SQUAD_DIR;
  process.env.SQUAD_DIR = dir;
  try {
    const db = openDb();
    try {
      // An explicit pin fails loudly rather than shadowing @repo silently.
      assert.throws(() => new Squad(db, "repo"), /reserved name/);
      // A rename is refused with a note, like a pin violation.
      const room = new Squad(db, "codex");
      const outcome = room.requestPersona("repo");
      assert.equal(outcome.applied, false);
      assert.equal(room.persona, "codex");
      assert.match(outcome.note, /reserved name/);
      // Automatic minting skips the reserved name even when asked to prefer it.
      const reserved = reserveAutomaticPersona(
        db,
        { sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", model: "opus-5" },
        { prefer: "repo", suffix: () => "3f2a" },
      );
      assert.equal(reserved.persona, "opus-5-3f2a");
    } finally {
      db.close();
    }
  } finally {
    if (previous === undefined) delete process.env.SQUAD_DIR;
    else process.env.SQUAD_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the rate-limited path is cheap enough to run on every tool call", () => {
  const dir = freshDir();
  try {
    runCli(["send", "@claude-worker measured"], { SQUAD_DIR: dir, SQUAD_PERSONA: "codex" });
    const env = { SQUAD_INBOX_INTERVAL_SECONDS: "3600" };
    runHook(dir, "claude-worker", env); // stamps the rate-limit clock
    const samples = [];
    for (let i = 0; i < 10; i++) {
      const started = process.hrtime.bigint();
      assert.equal(runHook(dir, "claude-worker", env).raw, "");
      samples.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    samples.sort((a, b) => a - b);
    // Deliberately loose: this asserts the *shape* (the rate-limited path
    // never opens the room, so it costs about one node start) rather than a
    // wall-clock budget that a loaded CI box could not honor. The measured
    // figure quoted in the README comes from running this suite locally.
    assert.ok(
      samples[8] < 1500,
      `p90 of the quiet path was ${samples[8].toFixed(1)}ms: ${samples.join(", ")}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
