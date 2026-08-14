import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SQUAD_DIR = mkdtempSync(join(tmpdir(), "squad-test-"));

const { openDb } = await import("../dist/db.js");
const { Squad, DEFAULT_IDLE_MINUTES, DEFAULT_STALE_MINUTES } = await import("../dist/core.js");

test.after(() => rmSync(process.env.SQUAD_DIR, { recursive: true, force: true }));

const db = openDb();
const claude = new Squad(db, "claude");
const codex = new Squad(db, "codex");

test("send and read", () => {
  claude.clear();
  claude.send("hello");
  codex.send("hi back");
  const msgs = claude.read();
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].sender, "claude");
  assert.equal(msgs[1].sender, "codex");
});

test("check excludes own messages and consumes", () => {
  claude.clear();
  claude.send("one");
  claude.send("two");
  codex.send("three");
  const unread = claude.check();
  assert.deepEqual(unread.map((m) => m.body), ["three"]);
  assert.equal(claude.check().length, 0, "second check is empty (consumed)");
});

test("peek does not consume", () => {
  claude.clear();
  codex.send("psst");
  assert.equal(claude.check({ peek: true }).length, 1);
  assert.equal(claude.check().length, 1, "still unread after peek");
});

test("join catches up and advances cursor", () => {
  claude.clear();
  codex.send("old news");
  const { members, recent } = claude.join();
  assert.equal(recent.length, 1);
  assert.ok(members.some((m) => m.persona === "claude"));
  assert.equal(claude.check().length, 0, "join marked history read");
});

// --- presence leases (#38) ------------------------------------------------

/**
 * Age a persona's live sessions by `minutes`, lease included. touch() always
 * stamps real time, so the only way to reach the idle/stale windows in a test
 * is to backdate the stored lease directly — the same trick the claim
 * staleness test has always used.
 */
function backdate(persona, minutes) {
  const seen = new Date(Date.now() - minutes * 60_000).toISOString();
  const expires = new Date(Date.parse(seen) + DEFAULT_STALE_MINUTES * 60_000).toISOString();
  db.prepare(
    "UPDATE sessions SET last_seen = ?, lease_expires_at = ? WHERE persona = ? AND left_ts IS NULL",
  ).run(seen, expires, persona);
}

test("join returns a session id and a lease", () => {
  claude.clear();
  const joined = claude.join();
  assert.ok(joined.session_id, "join returns a session identifier");
  assert.equal(joined.session_id, claude.sessionId, "…the caller's own session");
  assert.ok(
    Date.parse(joined.lease_expires_at) > Date.now(),
    "the lease runs into the future",
  );
  // The lease is one stale-window long, measured from the last touch — which
  // join() performs more than once, so allow a few ms of drift from joined_at.
  const leaseMs = Date.parse(joined.lease_expires_at) - Date.parse(joined.joined_at);
  assert.ok(
    leaseMs >= DEFAULT_STALE_MINUTES * 60_000 && leaseMs < (DEFAULT_STALE_MINUTES + 1) * 60_000,
    `lease of ${leaseMs}ms should be one stale window (${DEFAULT_STALE_MINUTES} min)`,
  );
  const rejoined = claude.join();
  assert.equal(rejoined.session_id, joined.session_id, "re-joining renews, never re-issues");
  assert.ok(
    Date.parse(rejoined.lease_expires_at) >= Date.parse(joined.lease_expires_at),
    "…and pushes the expiry out",
  );
});

test("join and check both report peers with active/idle/stale state", () => {
  claude.clear();
  codex.join();
  const { members } = claude.join();
  const peer = members.find((m) => m.persona === "codex");
  assert.ok(peer, "the peer's session shows up in the member list");
  assert.equal(peer.state, "active", "a peer that just joined is active");
  assert.equal(peer.sessions, 1);

  // peers() is what squad_check surfaces: everyone but yourself, same state.
  const peers = claude.peers();
  assert.deepEqual(peers.map((p) => p.persona), ["codex"]);
  assert.equal(peers[0].state, "active");
  assert.ok(!claude.peers().some((p) => p.persona === "claude"), "you are not your own peer");
});

test("presence crosses active -> idle -> stale as the lease ages", () => {
  claude.clear();
  claude.join();
  codex.join();
  const stateOfClaude = () => codex.peers().find((p) => p.persona === "claude")?.state;
  assert.equal(stateOfClaude(), "active");

  backdate("claude", DEFAULT_IDLE_MINUTES + 1);
  assert.equal(stateOfClaude(), "idle", "quiet past the idle window, lease still good");

  backdate("claude", DEFAULT_STALE_MINUTES + 1);
  assert.equal(stateOfClaude(), "stale", "past the lease expiry");

  // Any operation renews the lease — no separate heartbeat call.
  claude.check();
  assert.equal(stateOfClaude(), "active", "a tool call renews the lease");
});

test("leave ends the session, announces it, and drops you from peers", () => {
  claude.clear();
  claude.join();
  codex.join();
  assert.equal(codex.peers().length, 1);

  const left = claude.leave();
  assert.equal(left.persona, "claude");
  assert.equal(left.sessions_ended.length, 1);
  assert.equal(left.sessions_remaining, 0);
  assert.ok(left.left_ts);
  assert.equal(claude.sessionId, null, "the connection no longer holds a session");

  assert.deepEqual(codex.peers(), [], "a persona that left is not in the room");
  assert.ok(!codex.members().some((m) => m.persona === "claude"));
  const announced = codex.check().at(-1);
  assert.equal(announced.kind, "system");
  assert.match(announced.body, /claude left the room/);
});

test("leave names the claims you walk away from", () => {
  claude.clear();
  claude.claim("src/core.ts");
  codex.check();
  claude.leave();
  assert.match(codex.check().at(-1).body, /claude left the room .*still holding src\/core\.ts/);
  const held = codex.claims();
  assert.equal(held.length, 1, "leaving never releases a claim on your behalf");
  assert.equal(held[0].stale, true, "…but the claim is stale the moment its holder leaves");
  assert.equal(held[0].holder_state, "stale");
});

test("leaving with nothing to leave is a silent no-op", () => {
  claude.clear();
  codex.join();
  codex.check();
  const nobody = new Squad(db, "ghost");
  const left = nobody.leave();
  assert.deepEqual(left.sessions_ended, []);
  assert.equal(left.left_ts, null);
  assert.equal(codex.check().length, 0, "no announcement for a no-op");
});

test("an operation after leaving opens a fresh session", () => {
  claude.clear();
  const first = claude.join().session_id;
  claude.leave();
  const second = claude.join().session_id;
  assert.notEqual(second, first, "a left session is never resurrected");
  assert.equal(codex.peers().find((p) => p.persona === "claude").state, "active");
  const rows = db
    .prepare("SELECT left_ts FROM sessions WHERE persona = 'claude' ORDER BY joined_at ASC")
    .all();
  assert.equal(rows.length, 2, "the ended session is kept as history");
  assert.ok(rows.some((r) => r.left_ts !== null) && rows.some((r) => r.left_ts === null));
});

test("goals announce in chat and complete", () => {
  claude.clear();
  const goal = claude.goalAdd("ship it");
  assert.equal(goal.status, "open");
  const seen = codex.check();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, "system");
  assert.match(seen[0].body, /goal #\d+: ship it/);

  const done = codex.goalDone(goal.id);
  assert.equal(done.status, "done");
  assert.equal(done.done_by, "codex");
  assert.equal(claude.goals().length, 0, "no open goals left");
  assert.equal(claude.goals(true).length, 1);
  assert.match(claude.check().at(-1).body, /marked goal #\d+ done/);
});

test("goalDone on missing id throws", () => {
  assert.throws(() => claude.goalDone(9999), /no goal/);
});

test("goalReopen resets a done goal and announces", () => {
  claude.clear();
  const goal = claude.goalAdd("prove the bound");
  codex.goalDone(goal.id);
  const reopened = claude.goalReopen(goal.id);
  assert.equal(reopened.status, "open");
  assert.equal(reopened.done_by, null);
  assert.equal(reopened.done_ts, null);
  const board = claude.goals(true);
  assert.equal(board.length, 1);
  assert.equal(board[0].status, "open", "reopen persisted");
  assert.equal(board[0].done_by, null);
  assert.match(codex.check().at(-1).body, /reopened goal #\d+/);
});

test("goalReopen on an open goal is a silent no-op", () => {
  claude.clear();
  const goal = claude.goalAdd("still open");
  codex.check();
  const same = claude.goalReopen(goal.id);
  assert.equal(same.status, "open");
  assert.equal(codex.check().length, 0, "no announcement for a no-op");
});

test("goalReopen on missing id throws", () => {
  assert.throws(() => claude.goalReopen(9999), /no goal/);
});

test("claim announces in chat and appears in claims()", () => {
  claude.clear();
  const c = claude.claim("src/core.ts");
  assert.equal(c.path, "src/core.ts");
  assert.equal(c.persona, "claude");

  const seen = codex.check();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, "system");
  assert.match(seen[0].body, /claude claimed src\/core\.ts/);

  const listed = codex.claims();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].path, "src/core.ts");
  assert.equal(listed[0].persona, "claude");
  assert.equal(listed[0].stale, false, "a just-claimed path is not stale");
});

test("claiming your own path twice is idempotent and silent", () => {
  claude.clear();
  const first = claude.claim("docs/README.md");
  codex.check();
  const second = claude.claim("docs/README.md");
  assert.equal(second.id, first.id);
  assert.equal(codex.claims().length, 1, "no duplicate row");
  assert.equal(codex.check().length, 0, "no second announcement");
});

test("claiming a path a peer holds is allowed and names the holder", () => {
  claude.clear();
  claude.claim("src/mcp.ts");
  codex.check();
  codex.claim("src/mcp.ts");
  const seen = claude.check();
  assert.equal(seen.length, 1);
  assert.match(seen.at(-1).body, /codex claimed src\/mcp\.ts .*already claimed by claude/);
  assert.equal(claude.claims().length, 2, "advisory: both claims are visible");
});

test("release removes the claim and announces", () => {
  claude.clear();
  claude.claim("src/cli.ts");
  codex.check();
  const released = claude.release("src/cli.ts");
  assert.equal(released.length, 1);
  assert.equal(released[0].path, "src/cli.ts");
  assert.equal(claude.claims().length, 0);
  assert.match(codex.check().at(-1).body, /claude released src\/cli\.ts/);
});

test("releasing a nonexistent claim is a silent no-op", () => {
  claude.clear();
  codex.check();
  const released = claude.release("nothing/here.ts");
  assert.deepEqual(released, []);
  assert.equal(codex.check().length, 0, "no announcement for a no-op");
});

test("release takes over a peer's claim when you hold none", () => {
  claude.clear();
  claude.claim("src/db.ts");
  codex.check();
  const released = codex.release("src/db.ts");
  assert.equal(released.length, 1);
  assert.equal(released[0].persona, "claude");
  assert.equal(codex.claims().length, 0);
  assert.match(claude.check().at(-1).body, /codex released src\/db\.ts \(held by claude\)/);
});

test("release drops only your own claim when a peer also holds the path", () => {
  claude.clear();
  claude.claim("shared.ts");
  codex.claim("shared.ts");
  const released = codex.release("shared.ts");
  assert.equal(released.length, 1);
  assert.equal(released[0].persona, "codex");
  const left = claude.claims();
  assert.equal(left.length, 1);
  assert.equal(left[0].persona, "claude", "peer's claim survives");
});

test("join includes current claims", () => {
  claude.clear();
  claude.claim("tests/core.test.mjs");
  const { claims } = codex.join();
  assert.equal(claims.length, 1);
  assert.equal(claims[0].path, "tests/core.test.mjs");
  assert.equal(claims[0].persona, "claude");
});

test("a claim goes stale with its holder's lease", () => {
  claude.clear();
  claude.claim("stale/target.ts");
  assert.equal(codex.claims()[0].stale, false);
  assert.equal(codex.claims()[0].holder_state, "active");

  // A paused holder is idle, not stale — the claim is still someone's work.
  backdate("claude", DEFAULT_IDLE_MINUTES + 1);
  assert.equal(codex.claims()[0].holder_state, "idle");
  assert.equal(codex.claims()[0].stale, false, "an idle holder's claim is not stale");

  // Past the lease, the claim and its holder go stale together — one clock.
  backdate("claude", DEFAULT_STALE_MINUTES + 1);
  const listed = codex.claims();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].persona, "claude");
  assert.equal(listed[0].stale, true, "an absent holder's claim lists as stale");
  assert.equal(
    listed[0].holder_state,
    codex.members().find((m) => m.persona === "claude").state,
    "claim staleness and peer presence never disagree",
  );
});

test("clear wipes claims and sessions along with everything else", () => {
  claude.clear();
  claude.claim("wiped.ts");
  claude.goalAdd("also wiped");
  assert.equal(claude.claims().length, 1);
  assert.ok(claude.members().length > 0);
  codex.clear();
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n,
    0,
    "presence sessions are wiped too",
  );
  assert.deepEqual(codex.members(), [], "an empty room has no members");
  assert.equal(codex.claims().length, 0);
  assert.equal(codex.goals(true).length, 0);
  assert.equal(codex.read().length, 0);
});

// MCP tool registration / response shape: no live transport here (same
// approach as the card tools' registration tests), just a check that the
// presence surface is wired into src/mcp.ts.
test("mcp.ts registers squad_leave and returns the check summary from squad_check", () => {
  const mcpSrc = readFileSync(new URL("../src/mcp.ts", import.meta.url), "utf8");
  assert.match(mcpSrc, /registerTool\(\s*"squad_leave"/, "squad_leave must be registered");
  const check = mcpSrc.slice(mcpSrc.indexOf('"squad_check"'), mcpSrc.indexOf('"squad_leave"'));
  assert.match(check, /squad\.checkSummary\(\)/, "squad_check must return the room-state summary");
  // ...and that summary is what carries peer presence and the renewed lease.
  const summary = claude.checkSummary();
  assert.ok(Array.isArray(summary.peers), "squad_check must return peer presence");
  assert.ok("lease_expires_at" in summary, "squad_check must report the renewed lease");
  assert.equal(typeof summary.open_goals, "number");
  assert.equal(typeof summary.active_claims, "number");
});

test("checkWait returns promptly when a message lands", async () => {
  claude.clear();
  setTimeout(() => codex.send("late arrival"), 300);
  const t0 = Date.now();
  const msgs = await claude.checkWait(10);
  assert.equal(msgs.length, 1);
  assert.ok(Date.now() - t0 < 5000, "returned well before the deadline");
});

test("checkWait times out empty", async () => {
  claude.clear();
  const msgs = await claude.checkWait(1);
  assert.equal(msgs.length, 0);
});
