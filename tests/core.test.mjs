import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SQUAD_DIR = mkdtempSync(join(tmpdir(), "squad-test-"));

const { openDb } = await import("../dist/db.js");
const { Squad, DEFAULT_IDLE_MINUTES, DEFAULT_STALE_MINUTES, isPersonaRefinement } = await import(
  "../dist/core.js"
);

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

// --- repeated system-message dedup (#59) ------------------------------

test("identical consecutive system messages from the same sender collapse in place", () => {
  claude.clear();
  const first = claude.send("mcp startup failed: missing deps", "system");
  assert.equal(first.occurrences, 1);
  const second = claude.send("mcp startup failed: missing deps", "system");
  assert.equal(second.id, first.id, "collapses into the same row instead of inserting a new one");
  assert.equal(second.occurrences, 2);
  const third = claude.send("mcp startup failed: missing deps", "system");
  assert.equal(third.id, first.id);
  assert.equal(third.occurrences, 3, "occurrences keeps incrementing across repeats");

  const rows = claude.read();
  assert.equal(rows.length, 1, "the room shows a single collapsed entry, not one per repeat");
  assert.equal(rows[0].occurrences, 3);
  assert.ok(Date.parse(rows[0].ts) >= Date.parse(first.ts), "ts refreshed to the latest occurrence");
});

test("system dedup checks the sender's own last message, not the room's last message overall", () => {
  claude.clear();
  claude.send("recurring failure", "system");
  codex.send("unrelated chatter"); // a different sender's message lands in between
  const again = claude.send("recurring failure", "system");
  assert.equal(again.occurrences, 2, "still collapses with claude's own prior message");
  assert.equal(claude.read().filter((m) => m.sender === "claude").length, 1);
});

test("chat messages are never collapsed, even if byte-identical", () => {
  claude.clear();
  claude.send("same text", "chat");
  claude.send("same text", "chat");
  const rows = claude.read();
  assert.equal(rows.length, 2, "identical chat messages each get their own row");
  assert.equal(rows[0].occurrences, 1);
  assert.equal(rows[1].occurrences, 1);
});

test("system dedup never crosses senders: two personas posting the same body stay separate", () => {
  claude.clear();
  claude.send("shared failure text", "system");
  codex.send("shared failure text", "system");
  const rows = claude.read();
  assert.equal(rows.length, 2, "each sender's occurrence lives in its own row");
  assert.deepEqual(
    rows.map((m) => m.sender),
    ["claude", "codex"],
  );
  assert.equal(rows[0].occurrences, 1);
  assert.equal(rows[1].occurrences, 1);
});

test("a system message that differs from the prior one by even one character is not collapsed", () => {
  claude.clear();
  claude.send("failure: connection refused", "system");
  claude.send("failure: connection refused.", "system"); // trailing period differs
  const rows = claude.read();
  assert.equal(rows.length, 2, "not identical, so each gets its own row");
  assert.equal(rows[0].occurrences, 1);
  assert.equal(rows[1].occurrences, 1);
});

test("occurrences increments correctly across many repeats without wrapping", () => {
  claude.clear();
  let last;
  for (let i = 0; i < 25; i++) {
    last = claude.send("recurring startup failure notice", "system");
  }
  assert.equal(last.occurrences, 25);
  assert.equal(claude.read().length, 1, "still a single collapsed row after many repeats");
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

// --- session-scoped read cursors (#41) ------------------------------------

test("two live sessions of one persona don't steal each other's unread stream", () => {
  claude.clear();
  const claudeA = new Squad(db, "claude"); // e.g. an MCP connection
  claudeA.join();

  // A message arrives while session A hasn't read it yet.
  codex.send("urgent update");

  // A second session of the same persona joins mid-conversation (e.g. a CLI
  // invocation). Before #41, join() unconditionally fast-forwarded the
  // shared persona-keyed cursor to "now", silently marking A's still-unread
  // message as read out from under it.
  const claudeB = new Squad(db, "claude");
  claudeB.join();

  const unreadA = claudeA.check();
  assert.deepEqual(
    unreadA.map((m) => m.body),
    ["urgent update"],
    "session A's next check() still returns the message it hadn't consumed yet",
  );
});

test("check() and join() from independent same-persona sessions see new messages independently", () => {
  claude.clear();
  const claudeA = new Squad(db, "claude");
  const claudeB = new Squad(db, "claude");
  claudeA.join();
  claudeB.join();

  codex.send("new for both");
  assert.deepEqual(claudeA.check().map((m) => m.body), ["new for both"]);
  assert.deepEqual(
    claudeB.check().map((m) => m.body),
    ["new for both"],
    "a message posted after both sessions joined is unread for both, independently",
  );
  // Each session consumed its own copy — neither affects the other's cursor.
  assert.equal(claudeA.check().length, 0);
  assert.equal(claudeB.check().length, 0);
});

test("a brand-new session's cursor seeds from the persona's most-advanced prior session", () => {
  claude.clear();
  const claudeA = new Squad(db, "claude");
  claudeA.join();
  codex.send("m1");
  codex.send("m2");
  claudeA.check(); // consumes m1, m2 — advances session A's cursor to "now"

  // A brand-new session of the same persona (never joined before) should
  // inherit that advanced cursor instead of replaying the whole backlog.
  const claudeC = new Squad(db, "claude");
  assert.deepEqual(
    claudeC.check({ peek: true }),
    [],
    "new session sees no backlog — seeded from the persona's most-advanced session",
  );
});

test("a persona's very first session ever starts at the room's beginning", () => {
  claude.clear();
  codex.send("before anyone joined");
  const brandNew = new Squad(db, "brand-new-persona");
  assert.deepEqual(
    brandNew.check().map((m) => m.body),
    ["before anyone joined"],
    "no prior session for this persona to seed from, so the cursor falls back to 0",
  );
});

test("a persona whose sessions have all aged out doesn't replay the room on its next join", () => {
  claude.clear();
  const claudeA = new Squad(db, "claude");
  claudeA.join();
  codex.send("m1");
  const m2 = codex.send("m2");
  claudeA.check(); // consumes m1, m2

  // Age every session past SESSION_RETENTION_HOURS (24h), then let another
  // persona's join() run the sweep: claude now has no session row — and no
  // session_cursors row — left to seed from.
  const aged = new Date(Date.now() - 48 * 3_600_000).toISOString();
  db.prepare("UPDATE sessions SET last_seen = ?, lease_expires_at = ?").run(aged, aged);
  new Squad(db, "codex").join();

  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE persona = 'claude'").get().n,
    0,
    "claude's aged-out session rows were pruned",
  );
  assert.equal(
    db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM session_cursors sc
           JOIN sessions s ON s.session_id = sc.session_id
          WHERE s.persona = 'claude'`,
      )
      .get().n,
    0,
    "and their session cursor rows went with them",
  );
  assert.equal(
    db.prepare("SELECT last_seen_id FROM cursors WHERE persona = 'claude'").get().last_seen_id,
    m2.id,
    "but the persona's durable high-water mark survives the sweep",
  );

  codex.send("m3");
  const returning = new Squad(db, "claude"); // reconnecting days later
  assert.deepEqual(
    returning.check().map((m) => m.body),
    ["m3"],
    "only what arrived during the gap is unread — not the whole room replayed",
  );
});

test("own messages via another session of the same persona never return as unread", () => {
  claude.clear();
  const claudeA = new Squad(db, "claude");
  const claudeB = new Squad(db, "claude");
  claudeA.join();
  claudeB.join();

  claudeA.send("posted via session A");
  assert.equal(
    claudeB.check().length,
    0,
    "session B never sees session A's message as unread — both are 'claude'",
  );
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

// --- persona refinement + identity collision (#50) -------------------------

test("isPersonaRefinement treats a pinned identity as a namespace, not a name", () => {
  assert.ok(isPersonaRefinement("codex", "codex"), "the pinned name itself refines it");
  assert.ok(isPersonaRefinement("codex", "codex-2"), "<pinned>-<n> is the fanout convention");
  assert.ok(isPersonaRefinement("codex", "codex-sol3"), "any suffix, not just a number");
  assert.ok(isPersonaRefinement("codex", "CODEX-2"), "case-insensitive, like the persona regex");
  assert.ok(!isPersonaRefinement("codex", "fable"), "an unrelated name is impersonation");
  assert.ok(!isPersonaRefinement("codex", "codex2"), "no separator — a different name entirely");
  assert.ok(!isPersonaRefinement("codex", "codex-"), "a bare separator names nobody");
  assert.ok(!isPersonaRefinement("codex", "sol-codex-2"), "the pin must be the prefix");
  assert.ok(!isPersonaRefinement("codex", "codex/sol3"), "'/' is outside the persona charset");
});

test("requestPersona honours a refinement of the pin and refuses anything else", () => {
  const one = new Squad(db, "codex");
  const accepted = one.requestPersona("codex-1", "codex");
  assert.equal(accepted.applied, true, "a refinement of the pin is honoured");
  assert.equal(accepted.persona, "codex-1");
  assert.equal(one.persona, "codex-1", "the connection now speaks as codex-1");
  assert.equal(accepted.note, undefined, "an accepted rename needs no explanation");

  const two = new Squad(db, "codex");
  const rejected = two.requestPersona("fable", "codex");
  assert.equal(rejected.applied, false);
  assert.equal(two.persona, "codex", "the pin still wins against an unrelated name");
  assert.match(
    rejected.note,
    /not a refinement/,
    "the note says why, not just 'rename ignored'",
  );
  assert.match(rejected.note, /codex-/, "…and shows how to refine instead");

  // An unpinned connection keeps the old free-rename behaviour.
  const anon = new Squad(db, "agent");
  assert.equal(anon.requestPersona("fable", null).applied, true);
  assert.equal(anon.persona, "fable", "nothing pinned, so any valid name is accepted");
});

test("sessions under refined personas of one pinned agent see each other", () => {
  claude.clear();
  const sol1 = new Squad(db, "codex-1");
  const sol2 = new Squad(db, "codex-2");
  sol1.join();
  sol2.join();

  sol1.send("front A is closed");
  sol2.send("front B needs a hand");

  // Self-suppression keys on the sender string, so it only works once the
  // senders genuinely differ — which is exactly what refinement buys.
  assert.deepEqual(
    sol2.check().map((m) => m.body),
    ["front A is closed"],
    "codex-2 sees codex-1's message",
  );
  assert.deepEqual(
    sol1.check().map((m) => m.body),
    ["front B needs a hand"],
    "codex-1 sees codex-2's message",
  );
});

test("join warns when the identity already holds another live session", () => {
  claude.clear();
  const first = new Squad(db, "codex");
  first.join();

  const second = new Squad(db, "codex");
  const joined = second.join();
  assert.ok(joined.identity_collision, "a co-named session is told so at join");
  assert.equal(joined.identity_collision.persona, "codex");
  assert.deepEqual(
    joined.identity_collision.session_ids,
    [first.sessionId],
    "…and which other session holds the identity",
  );
  assert.match(
    joined.identity_collision.note,
    /codex-/,
    "…pointed at the refinement convention that fixes it",
  );

  assert.equal(
    new Squad(db, "fable").join().identity_collision,
    undefined,
    "a unique identity joins clean",
  );
});

test("re-joining is not a collision with yourself", () => {
  claude.clear();
  const only = new Squad(db, "codex-1");
  only.join();
  assert.equal(
    only.join().identity_collision,
    undefined,
    "join() is idempotent — its own session row is never a twin",
  );
});

test("a co-named session whose lease expired is not a live collision", () => {
  claude.clear();
  new Squad(db, "codex").join();
  backdate("codex", DEFAULT_STALE_MINUTES + 1);
  assert.equal(
    new Squad(db, "codex").join().identity_collision,
    undefined,
    "an expired lease is a dead process, not a live twin",
  );
});

test("mcp.ts wires the refinement decision and the collision warning into squad_join", () => {
  const mcpSrc = readFileSync(new URL("../src/mcp.ts", import.meta.url), "utf8");
  const join = mcpSrc.slice(mcpSrc.indexOf('"squad_join"'), mcpSrc.indexOf('"squad_send"'));
  assert.match(join, /requestPersona\(/, "squad_join must route renames through requestPersona");
  assert.match(join, /identity_collision/, "…and surface the collision warning in its note");
});
