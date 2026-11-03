import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// `squad wait` (#222). The loop logic is driven in-process with an injected
// clock (no real 60s sleeps); identity refusal, --json and a real early
// return are driven through the CLI as a subprocess.

const scratch = mkdtempSync(join(tmpdir(), "squad-test-wait-"));
process.env.SQUAD_DIR = join(scratch, "boot");
const { openDb } = await import("../dist/db.js");
const { Squad, receiveCrossRoomRequest } = await import("../dist/core.js");
const wait = await import("../dist/wait.js");
const { parseWaitArgs } = await import("../dist/cli.js");
const { backoffSeconds, nextStep, chooseNext, runWait, formatWait, WAIT_EXIT } = wait;

test.after(() => rmSync(scratch, { recursive: true, force: true }));

let rooms = 0;
/** A fresh file-backed room (cross-room routing needs a real room dir). */
function freshRoom() {
  process.env.SQUAD_DIR = join(scratch, `room-${++rooms}`);
  return openDb();
}

/**
 * Virtual time: sleep() advances the clock instead of waiting, then runs any
 * scheduled actions that have come due, so "a peer posts 10s into the wait"
 * is deterministic.
 */
function fakeClock(offsetMs = 0) {
  const start = Date.now() + offsetMs;
  let t = start;
  const due = [];
  return {
    now: () => t,
    async sleep(ms) {
      assert.ok(ms > 0, "never sleeps a non-positive interval");
      t += ms;
      for (const job of due.filter((j) => !j.done && t - start >= j.at)) {
        job.done = true;
        job.fn();
      }
    },
    at(seconds, fn) {
      due.push({ at: seconds * 1000, fn, done: false });
    },
    elapsed: () => t - start,
  };
}

const opts = (clock, extra = {}) => ({ clock, pollMs: 2000, parkMinutes: 45, sessionKey: "s1", ...extra });

/** Establish wait state (board fingerprint, review mark) without waiting. */
async function prime(squad, db, sessionKey = "s1") {
  return runWait(squad, db, { clock: fakeClock(), maxSeconds: 0, sessionKey });
}

test("backoff steps are 60/120/240/480, repeat at the top, and are capped by --max", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map((s) => backoffSeconds(s, 540)), [60, 120, 240, 480, 480, 480]);
  assert.deepEqual([0, 1, 2, 3].map((s) => backoffSeconds(s, 100)), [60, 100, 100, 100]);
  assert.equal(backoffSeconds(2, 0), 0);
  assert.deepEqual([0, 1, 2, 3].map((s) => nextStep(s, false)), [1, 2, 3, 3]);
  assert.deepEqual([0, 2, 3].map((s) => nextStep(s, true)), [0, 0, 0]);
  assert.deepEqual([0, 2].map((s) => nextStep(s, false, 0)), [0, 2], "a --max 0 snapshot keeps its step");
});

test("quiet calls back off across calls, persisted per session, and reset after a wake", async () => {
  const db = freshRoom();
  const alice = new Squad(db, "alice");
  const bob = new Squad(db, "bob");
  bob.goalAdd("keep the board non-empty");
  await prime(alice, db);
  const waits = [];
  for (let i = 0; i < 5; i++) {
    const clock = fakeClock();
    const r = await runWait(alice, db, opts(clock, { maxSeconds: 540 }));
    assert.equal(r.exit, WAIT_EXIT.quiet);
    assert.equal(clock.elapsed(), r.wait_seconds * 1000, "waits exactly the window");
    waits.push(r.wait_seconds);
  }
  assert.deepEqual(waits, [60, 120, 240, 480, 480]);

  // A wake resets the step: the following quiet call waits 60s again.
  const clock = fakeClock();
  clock.at(30, () => bob.send("anyone around?"));
  const woke = await runWait(alice, db, opts(clock));
  assert.equal(woke.exit, WAIT_EXIT.woke);
  assert.equal(woke.next_wait_seconds, 60);
  const after = await runWait(alice, db, opts(fakeClock()));
  assert.equal(after.wait_seconds, 60);
});

test("--max is honored strictly at every step", async () => {
  const db = freshRoom();
  const alice = new Squad(db, "alice");
  new Squad(db, "bob").goalAdd("x");
  await prime(alice, db);
  const seen = [];
  for (let i = 0; i < 4; i++) {
    const clock = fakeClock();
    const r = await runWait(alice, db, opts(clock, { maxSeconds: 100, pollMs: 7000 }));
    assert.ok(clock.elapsed() <= 100_000, `step ${i} overran --max: ${clock.elapsed()}ms`);
    seen.push(r.wait_seconds);
  }
  assert.deepEqual(seen, [60, 100, 100, 100]);
});

test("two sessions sharing one persona keep separate backoff state", async () => {
  const db = freshRoom();
  const a1 = new Squad(db, "alice");
  new Squad(db, "bob").goalAdd("x");
  await prime(a1, db, "s1");
  await runWait(a1, db, opts(fakeClock(), { sessionKey: "s1" }));
  const s1 = await runWait(a1, db, opts(fakeClock(), { sessionKey: "s1" }));
  const s2 = await runWait(new Squad(db, "alice"), db, opts(fakeClock(), { sessionKey: "s2" }));
  assert.equal(s1.wait_seconds, 120);
  assert.equal(s2.wait_seconds, 60);
});

test("presence lease is renewed while waiting", async () => {
  const db = freshRoom();
  const alice = new Squad(db, "alice");
  new Squad(db, "bob").goalAdd("x");
  await prime(alice, db);
  for (let i = 0; i < 3; i++) await runWait(alice, db, opts(fakeClock())); // reach the 480s step
  let touches = 0;
  const original = alice.touch.bind(alice);
  alice.touch = () => {
    touches++;
    original();
  };
  const r = await runWait(alice, db, opts(fakeClock(), { leaseMs: 60_000 }));
  assert.equal(r.wait_seconds, 480);
  assert.ok(touches >= 8, `expected a lease renewal per minute, got ${touches}`);
});

/** Each trigger, fired 10s into a 60s wait, ends it early with exit 0. */
const TRIGGERS = [
  ["chat", (r) => r.bob.send("plain room chat")],
  ["mention", (r) => r.bob.send("@alice can you look?")],
  ["mention", (r) => r.bob.send("@repo heads up"), "@repo broadcast"],
  ["review", (r) => r.bob.reviewOpen("alice", "please review src/wait.ts")],
  ["goals", (r) => r.bob.goalAdd("a new goal")],
  ["goals", (r) => r.bob.goalDone(r.goal.id), "goal done"],
  [
    "goals",
    (r) => {
      r.db.prepare("UPDATE goals SET status = 'done' WHERE id = ?").run(r.goal.id);
    },
    "goal reopened",
    true,
  ],
  [
    "cross-room",
    (r) =>
      receiveCrossRoomRequest(r.db, r.alice.roomDir, {
        body: "can your room answer this?",
        originRoom: join(scratch, "elsewhere"),
        originPersona: "far-agent",
      }),
  ],
];

for (const [reason, fire, label, reopen] of TRIGGERS) {
  test(`wakes early on ${label ?? reason}`, async () => {
    const db = freshRoom();
    const alice = new Squad(db, "alice");
    const bob = new Squad(db, "bob");
    const goal = bob.goalAdd("standing goal");
    const ctx = { db, alice, bob, goal };
    if (reopen) fire(ctx); // mark done before priming, reopen mid-wait
    await prime(alice, db);
    const clock = fakeClock();
    clock.at(10, reopen ? () => bob.goalReopen(goal.id) : () => fire(ctx));
    const r = await runWait(alice, db, opts(clock));
    assert.equal(r.exit, WAIT_EXIT.woke, JSON.stringify(r.reasons));
    assert.ok(r.reasons.includes(reason), `reasons ${r.reasons} lack ${reason}`);
    assert.ok(clock.elapsed() < 15_000, `returned at ${clock.elapsed()}ms, not early`);
  });
}

test("a peer's claim (system chatter) does not wake, and messages are consumed", async () => {
  const db = freshRoom();
  const alice = new Squad(db, "alice");
  const bob = new Squad(db, "bob");
  bob.goalAdd("x");
  await prime(alice, db);
  const clock = fakeClock();
  clock.at(10, () => bob.claim("src/other.ts"));
  const r = await runWait(alice, db, opts(clock));
  assert.equal(r.exit, WAIT_EXIT.quiet);
  assert.equal(clock.elapsed(), 60_000);
  assert.ok(r.messages.some((m) => /claimed src\/other\.ts/.test(m.body)), "shown once consumed");
  assert.deepEqual(alice.check({ peek: true }), [], "consumed like read --unread");
});

test("unread activity already waiting returns immediately", async () => {
  const db = freshRoom();
  const alice = new Squad(db, "alice");
  await prime(alice, db);
  new Squad(db, "bob").send("@alice ping");
  const clock = fakeClock();
  const r = await runWait(alice, db, opts(clock));
  assert.equal(r.exit, WAIT_EXIT.woke);
  assert.equal(clock.elapsed(), 0);
  assert.equal(r.next.kind, "reply");
});

// --- next: one ordered function, one test per branch ---

const goal = (id, holders = [], persona = "alice") => ({
  id,
  body: `goal ${id}`,
  holders,
  mine: holders.some((h) => h.persona === persona),
});
const base = {
  persona: "alice",
  messages: [],
  reviews: [],
  crossRoom: [],
  goals: [],
  quietMs: 0,
  parkMs: 45 * 60_000,
};
const mention = { id: 7, sender: "bob", kind: "chat", body: "@alice see this", ts: "", occurrences: 1, session_id: null };
const review = { id: 3, requested_by: "bob", priority: "high", status: "pending", body: "r" };
const request = { message_id: 9, origin_persona: "far", body: "q" };

test("next: directed work outranks everything (mention, then review, then cross-room)", () => {
  const all = { ...base, messages: [mention], reviews: [review], crossRoom: [request], goals: [goal(1, [{ persona: "alice", state: "active" }])] };
  assert.equal(chooseNext(all).kind, "reply");
  assert.match(chooseNext(all).text, /squad send --reply 7/);
  assert.equal(chooseNext({ ...all, messages: [] }).kind, "review");
  assert.equal(chooseNext({ ...all, messages: [], reviews: [] }).kind, "cross-room");
  const plain = { ...mention, body: "no address here" };
  assert.notEqual(chooseNext({ ...base, messages: [plain] }).kind, "reply", "unaddressed chat is not directed");
  assert.equal(chooseNext({ ...base, messages: [{ ...mention, body: "@repo all hands" }] }).kind, "reply");
});

test("next: a goal you hold is continued before claiming another", () => {
  const n = chooseNext({ ...base, goals: [goal(1), goal(2, [{ persona: "alice", state: "active" }])] });
  assert.deepEqual([n.kind, n.ref], ["continue", 2]);
});

test("next: an unheld open goal is claimed via its goal#<id> label", () => {
  const n = chooseNext({ ...base, goals: [goal(1, [{ persona: "bob", state: "active" }]), goal(2)] });
  assert.deepEqual([n.kind, n.ref], ["claim", 2]);
  assert.match(n.text, /squad_claim goal#2/);
});

test("next: a goal held only by stale peers is taken over", () => {
  const n = chooseNext({ ...base, goals: [goal(4, [{ persona: "bob", state: "stale" }])] });
  assert.deepEqual([n.kind, n.ref], ["takeover", 4]);
  assert.match(n.text, /bob/);
});

test("next: every goal held by a live peer means assist, never park", () => {
  const n = chooseNext({ ...base, quietMs: 10 * 3_600_000, goals: [goal(5, [{ persona: "bob", state: "idle" }])] });
  assert.equal(n.kind, "assist");
});

test("next: an empty board proposes goals until the park threshold, then parks", () => {
  assert.equal(chooseNext(base).kind, "propose");
  assert.equal(chooseNext({ ...base, quietMs: 44 * 60_000 }).kind, "propose");
  assert.equal(chooseNext({ ...base, quietMs: 45 * 60_000 }).kind, "park");
});

test("exit codes: quiet suggestion is 2, park is 3, a fresh empty room is not parked", async () => {
  const db = freshRoom();
  const alice = new Squad(db, "alice");
  const fresh = await runWait(alice, db, opts(fakeClock(), { maxSeconds: 0 }));
  assert.deepEqual([fresh.exit, fresh.next.kind], [WAIT_EXIT.quiet, "propose"]);
  const later = await runWait(alice, db, opts(fakeClock(46 * 60_000), { maxSeconds: 0 }));
  assert.deepEqual([later.exit, later.next.kind], [WAIT_EXIT.park, "park"]);
  // Clock skew: a clock behind the room's timestamps never reads as quiet.
  const skewed = await runWait(alice, db, opts(fakeClock(-3_600_000), { maxSeconds: 0 }));
  assert.equal(skewed.next.kind, "propose");
});

test("a lone agent that posts before every wait still parks once the room is quiet 45m", async () => {
  // Regression (#224 review): the caller's own chat must not reset its quiet
  // clock, or an agent obeying "ask the room" every wake never parks.
  const db = freshRoom();
  const alice = new Squad(db, "alice");
  const seen = [];
  for (let minute = 0; minute <= 90; minute += 9) {
    const clock = fakeClock(minute * 60_000);
    // Stamp the post at the injected time so it lands after started_at.
    const m = alice.send("anyone have something for me?");
    db.prepare("UPDATE messages SET ts = ? WHERE id = ?").run(new Date(clock.now()).toISOString(), m.id);
    const r = await runWait(alice, db, opts(clock, { maxSeconds: 0 }));
    seen.push([minute, r.exit, r.next.kind]);
    if (minute < 45) assert.deepEqual([r.exit, r.next.kind], [WAIT_EXIT.quiet, "propose"], JSON.stringify(seen));
    else assert.deepEqual([r.exit, r.next.kind], [WAIT_EXIT.park, "park"], JSON.stringify(seen));
  }
  // A peer's chat still counts as activity and defers the park.
  const clock = fakeClock(91 * 60_000);
  const b = new Squad(db, "bob").send("I'm here");
  db.prepare("UPDATE messages SET ts = ? WHERE id = ?").run(new Date(clock.now()).toISOString(), b.id);
  const r = await runWait(alice, db, opts(clock, { maxSeconds: 0 }));
  assert.equal(r.next.kind, "propose");
});

test("the caller's own goal add/done does not wake it; a peer's still does", async () => {
  const db = freshRoom();
  const alice = new Squad(db, "alice");
  const bob = new Squad(db, "bob");
  const peerGoal = bob.goalAdd("bob's goal");
  await prime(alice, db);
  const mine = alice.goalAdd("alice's goal");
  alice.goalDone(peerGoal.id);
  const quiet = await runWait(alice, db, opts(fakeClock()));
  assert.equal(quiet.exit, WAIT_EXIT.quiet, JSON.stringify(quiet.reasons));
  assert.ok(!quiet.reasons.includes("goals"));
  alice.goalDone(mine.id);
  const stillQuiet = await runWait(alice, db, opts(fakeClock()));
  assert.ok(!stillQuiet.reasons.includes("goals"), "own done on own goal is not news");
  const clock = fakeClock();
  clock.at(10, () => bob.goalReopen(mine.id));
  const woke = await runWait(alice, db, opts(clock));
  assert.ok(woke.reasons.includes("goals"), `reasons ${woke.reasons}`);
});

test("a goal whose holder goes stale mid-wait is offered for takeover", async () => {
  const db = freshRoom();
  const alice = new Squad(db, "alice");
  const bob = new Squad(db, "bob");
  const g = bob.goalAdd("bob's goal");
  bob.claim(`goal#${g.id}`);
  await prime(alice, db);
  const clock = fakeClock();
  clock.at(10, () =>
    db.prepare("UPDATE sessions SET lease_expires_at = ? WHERE persona = 'bob'").run("2000-01-01T00:00:00.000Z"),
  );
  const r = await runWait(alice, db, opts(clock));
  assert.equal(r.exit, WAIT_EXIT.quiet);
  assert.deepEqual([r.next.kind, r.next.ref], ["takeover", g.id]);
});

test("text output is compact: one next: line, bounded messages and goals", async () => {
  const db = freshRoom();
  const alice = new Squad(db, "alice");
  const bob = new Squad(db, "bob");
  for (let i = 0; i < 12; i++) bob.goalAdd(`goal ${i} ${"long words ".repeat(20)}`);
  await prime(alice, db);
  for (let i = 0; i < 30; i++) bob.send(`msg ${i}`);
  const r = await runWait(alice, db, opts(fakeClock()));
  const text = formatWait(r, (m) => `<${m.sender}> ${m.body}`);
  assert.equal(text.match(/^next: /gm).length, 1);
  assert.ok(text.trimEnd().split("\n").at(-1).startsWith("next: "), "next: is last");
  assert.ok(r.messages.length <= 20 && r.omitted_messages === 10);
  assert.match(text, /\+4 more/);
  assert.ok(text.split("\n").length < 30, text);
});

test("parseWaitArgs accepts --max/--json and rejects anything else", () => {
  assert.deepEqual(parseWaitArgs([]), { maxSeconds: undefined, json: false });
  assert.deepEqual(parseWaitArgs(["--max", "30", "--json"]), { maxSeconds: 30, json: true });
  for (const bad of [["--max"], ["--max", "-1"], ["--max", "abc"], ["--forever"]])
    assert.throws(() => parseWaitArgs(bad), /usage: squad wait/);
});

// --- CLI ---

const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
function cliEnv(env) {
  const e = { ...process.env, ...env };
  for (const k of ["SQUAD_DIR", "SQUAD_SESSION_ID", "SQUAD_PERSONA", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"])
    if (!(k in env)) delete e[k];
  return e;
}
const cli = (args, cwd, env = {}) =>
  spawnSync(process.execPath, [entry, ...args], { cwd, env: cliEnv(env), encoding: "utf8", timeout: 30_000 });
function repo() {
  const dir = realpathSync(mkdtempSync(join(scratch, "repo-")));
  execFileSync("git", ["init", "-q", dir]);
  return dir;
}

test("squad wait refuses a human identity", () => {
  const dir = repo();
  for (const env of [{}, { CLAUDECODE: "1" }, { SQUAD_PERSONA: "human" }, { SQUAD_PERSONA: "Human" }]) {
    const r = cli(["wait", "--max", "0"], dir, env);
    assert.equal(r.status, 1, JSON.stringify(env));
    assert.match(r.stderr, /squad wait (needs an agent identity|refuses to run as 'human')/);
  }
});

test("squad wait --json emits one structured object with the same content", () => {
  const dir = repo();
  assert.equal(cli(["goals", "add", "ship it"], dir, { SQUAD_PERSONA: "bob" }).status, 0);
  const r = cli(["wait", "--max", "0", "--json"], dir, { SQUAD_PERSONA: "alice" });
  assert.equal(r.status, 2, r.stderr); // a goal notice alone is not chat; the board is new to alice
  const out = JSON.parse(r.stdout);
  for (const k of ["exit", "woke", "reasons", "waited_seconds", "next_wait_seconds", "messages", "board", "next"])
    assert.ok(k in out, `missing ${k}`);
  assert.equal(out.exit, 2);
  assert.match(out.messages[0].body, /added goal #1/);
  assert.equal(out.board.goals[0].body, "ship it");
  assert.equal(out.next.kind, "claim");
  const text = cli(["wait", "--max", "0"], dir, { SQUAD_PERSONA: "alice" });
  assert.equal(text.status, 2);
  assert.match(text.stdout, /^next: claim goal #1/m);
});

test("squad wait returns early, exit 0, when a peer posts", async () => {
  const dir = repo();
  cli(["wait", "--max", "0"], dir, { SQUAD_PERSONA: "alice" });
  const started = Date.now();
  const child = spawn(process.execPath, [entry, "wait", "--max", "25"], { cwd: dir, env: cliEnv({ SQUAD_PERSONA: "alice" }) });
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  const exited = new Promise((resolve) => child.on("exit", resolve));
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(cli(["send", "@alice wake up"], dir, { SQUAD_PERSONA: "bob" }).status, 0);
  const code = await exited;
  assert.equal(code, 0, stdout);
  assert.ok(Date.now() - started < 15_000, "did not wait out --max");
  assert.match(stdout, /^woke: mention/m);
  assert.match(stdout, /<bob> @alice wake up/);
});
