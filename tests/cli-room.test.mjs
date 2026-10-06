import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, realpathSync, renameSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

function squad(args, { cwd, env = {} } = {}) {
  const e = { ...process.env, SQUAD_PERSONA: "tester", ...env };
  delete e.SQUAD_DIR;
  if (env.SQUAD_DIR) e.SQUAD_DIR = env.SQUAD_DIR;
  return spawnSync(process.execPath, [entry, ...args], { cwd, env: e, encoding: "utf8" });
}
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "squad-room-")));
function repoWithRoom() {
  const repo = tmp();
  execFileSync("git", ["init", "-q", repo]);
  const r = squad(["send", "seed"], { cwd: repo });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(repo, ".squad", "squad.db")));
  return repo;
}

test("--room delivers into that repo's room from an unrelated cwd", () => {
  const repo = repoWithRoom();
  const other = tmp();
  try {
    const r = squad(["send", "--room", repo, "hello", "there"], { cwd: other });
    assert.equal(r.status, 0, r.stderr);
    assert.match(squad(["read"], { cwd: repo }).stdout, /hello there/);
    assert.ok(!existsSync(join(other, ".squad")));
    // trailing slash and the .squad dir itself both resolve to the same room
    assert.equal(squad(["send", "--room", repo + "/", "slash"], { cwd: other }).status, 0);
    assert.equal(squad(["send", "--room", join(repo, ".squad"), "dot"], { cwd: other }).status, 0);
    const out = squad(["read"], { cwd: repo }).stdout;
    assert.match(out, /slash/);
    assert.match(out, /dot/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test("--room with a linked worktree path resolves to the primary room", () => {
  const repo = repoWithRoom();
  const wt = join(tmp(), "wt");
  try {
    execFileSync("git", ["-C", repo, "-c", "user.email=a@b", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "x"]);
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", wt]);
    const r = squad(["send", "--room", wt, "from-wt"], { cwd: tmp() });
    assert.equal(r.status, 0, r.stderr);
    assert.match(squad(["read"], { cwd: repo }).stdout, /from-wt/);
    assert.ok(!existsSync(join(wt, ".squad")));
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(dirname(wt), { recursive: true, force: true });
  }
});

test("--room with no existing room fails loudly and creates nothing", () => {
  const repo = tmp();
  try {
    execFileSync("git", ["init", "-q", repo]);
    const r = squad(["send", "--room", repo, "msg"], { cwd: tmp() });
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes(join(repo, ".squad")), r.stderr);
    assert.ok(!existsSync(join(repo, ".squad")));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("--room with missing path, bad path or no body errors", () => {
  const cwd = tmp();
  try {
    assert.notEqual(squad(["send", "--room"], { cwd }).status, 0);
    const r = squad(["send", "--room", join(cwd, "nope"), "x"], { cwd });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /usage: squad send/);
    assert.ok(!existsSync(join(cwd, ".squad")));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("--room mid-message is sent verbatim; plain send unchanged", () => {
  const dir = tmp();
  try {
    const env = { SQUAD_DIR: dir };
    assert.equal(squad(["send", "try", "--room", "x"], { env, cwd: dir }).status, 0);
    assert.match(squad(["read"], { env, cwd: dir }).stdout, /try --room x/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- cross-room request/reply routing (#144) --------------------------------

const { Squad } = await import("../dist/core.js");
const { openExistingRoom, ROOM_TABLES } = await import("../dist/db.js");

const roomOf = (repo) => join(repo, ".squad");
/** A git repo whose room holds a private sentinel posted by `persona`. */
function privateRoom(persona, sentinel) {
  const repo = tmp();
  execFileSync("git", ["init", "-q", repo]);
  const r = squad(["send", sentinel], { cwd: repo, env: { SQUAD_PERSONA: persona } });
  assert.equal(r.status, 0, r.stderr);
  return repo;
}
function rows(repo, sql, ...args) {
  const db = new DatabaseSync(join(roomOf(repo), "squad.db"), { readOnly: true });
  try {
    return db.prepare(sql).all(...args);
  } finally {
    db.close();
  }
}
const bodies = (repo) => rows(repo, "SELECT body FROM messages ORDER BY id").map((r) => r.body);
const copies = (repo) => rows(repo, "SELECT * FROM message_routes WHERE direction = 'delivered'");
/** Send A -> B from inside A; returns B's local id for the request. */
function ask(a, b, text, env = { SQUAD_PERSONA: "alice" }) {
  const r = squad(["send", "--room", b, text], { cwd: a, env });
  assert.equal(r.status, 0, r.stderr);
  return rows(b, "SELECT message_id FROM message_routes WHERE direction = 'inbound' ORDER BY message_id DESC LIMIT 1")[0].message_id;
}
/** A Squad on an existing room, as the MCP server would hold it. */
function open(repo, persona) {
  const db = openExistingRoom(roomOf(repo));
  return { db, squad: new Squad(db, persona) };
}
function cleanup(...dirs) {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

test("two-room request/reply: origin metadata, one threaded copy, nothing else crosses", () => {
  const a = privateRoom("alice", "A-PRIVATE-SENTINEL");
  const b = privateRoom("bob", "B-PRIVATE-SENTINEL");
  try {
    const sent = squad(["send", "--room", b, "please", "review", "PR", "12"], { cwd: a, env: { SQUAD_PERSONA: "alice" } });
    assert.equal(sent.status, 0, sent.stderr);
    assert.match(sent.stdout, /cross-room request [0-9a-f-]{36} delivered to/);
    const [inbound] = rows(b, "SELECT * FROM message_routes WHERE direction = 'inbound'");
    assert.equal(inbound.remote_room, realpathSync(roomOf(a)));
    assert.equal(inbound.remote_persona, "alice");
    assert.match(inbound.request_id, /^[0-9a-f-]{36}$/);
    assert.equal(inbound.answered_ts, null);
    const [msg] = rows(b, "SELECT * FROM messages WHERE id = ?", inbound.message_id);
    assert.equal(msg.sender, "alice@" + a.split("/").at(-1));
    assert.equal(msg.session_id, null, "no foreign session id in the target room");
    assert.ok(!bodies(b).includes("A-PRIVATE-SENTINEL"));

    // B's check and join expose the route (the shared operation MCP uses).
    const { db, squad: bob } = open(b, "bob");
    try {
      const checked = bob.check().find((m) => m.id === inbound.message_id);
      assert.equal(checked.route.direction, "inbound");
      assert.equal(checked.route.request_id, inbound.request_id);
      assert.equal(bob.checkSummary().cross_room_request_count, 1);
      const joined = bob.join();
      assert.equal(joined.recent.find((m) => m.id === inbound.message_id).route.remote_persona, "alice");
      assert.equal(joined.cross_room_requests.length, 1);
      assert.equal(joined.cross_room_requests[0].origin_room, realpathSync(roomOf(a)));
      assert.ok(joined.cross_room_requests[0].age_ms >= 0);
    } finally {
      db.close();
    }

    // An unrelated message in B never reaches A.
    assert.equal(squad(["send", "B-UNRELATED"], { cwd: b, env: { SQUAD_PERSONA: "bob" } }).status, 0);

    // CLI reply delivers exactly one threaded copy addressed to alice.
    const replied = squad(["send", "--reply", String(inbound.message_id), "LGTM"], { cwd: b, env: { SQUAD_PERSONA: "bob" } });
    assert.equal(replied.status, 0, replied.stderr);
    assert.match(replied.stdout, /delivered to alice in /);
    const [copy] = copies(a);
    assert.equal(copies(a).length, 1);
    assert.equal(copy.request_id, inbound.request_id);
    assert.equal(copy.recipient, "alice");
    assert.equal(copy.remote_room, realpathSync(roomOf(b)));
    assert.equal(copy.remote_persona, "bob");
    const [copyMsg] = rows(a, "SELECT * FROM messages WHERE id = ?", copy.message_id);
    assert.equal(copyMsg.body, "@alice LGTM");
    assert.equal(copyMsg.sender, "bob@" + b.split("/").at(-1));
    const aBodies = bodies(a);
    for (const leaked of ["B-PRIVATE-SENTINEL", "B-UNRELATED", "please review PR 12"])
      assert.ok(!aBodies.some((x) => x.includes(leaked)), `${leaked} must not cross`);
    assert.match(squad(["read"], { cwd: a, env: { SQUAD_PERSONA: "alice" } }).stdout, /reply from .* to your request/);

    // Answered: no longer outstanding in B.
    const [answered] = rows(b, "SELECT * FROM message_routes WHERE message_id = ?", inbound.message_id);
    assert.equal(answered.answered_by, "bob");
    assert.ok(answered.answered_ts);

    // A retry of that same delivery is a no-op; a distinct reply (MCP path) is a distinct copy.
    const delivery = rows(b, "SELECT delivery_id FROM route_deliveries")[0].delivery_id;
    const retried = squad(["send", "--retry", delivery], { cwd: b, env: { SQUAD_PERSONA: "bob" } });
    assert.equal(retried.status, 0, retried.stderr);
    assert.match(retried.stdout, /already delivered/);
    assert.equal(copies(a).length, 1);
    const second = open(b, "carol");
    try {
      const r = second.squad.reply(inbound.message_id, "one more note");
      assert.equal(r.routed, true);
      assert.equal(r.delivery.status, "delivered");
      assert.equal(r.message.route.direction, "reply");
      assert.equal(r.message.route.recipient, "alice");
    } finally {
      second.db.close();
    }
    assert.equal(copies(a).length, 2);

    // Replying to a delivered copy in A stays local: no forwarding loop.
    const bCount = bodies(b).length;
    const local = squad(["send", "--reply", String(copy.message_id), "thanks"], { cwd: a, env: { SQUAD_PERSONA: "alice" } });
    assert.equal(local.status, 0, local.stderr);
    assert.equal(bodies(b).length, bCount);
    assert.equal(rows(a, "SELECT direction FROM message_routes WHERE reply_to = ?", copy.message_id)[0].direction, "local-reply");
  } finally {
    cleanup(a, b);
  }
});

test("delivery failure before/after the origin commit is retryable without duplicates", () => {
  const a = privateRoom("alice", "a");
  const b = privateRoom("bob", "b");
  try {
    for (const phase of ["beforeOriginCommit", "afterOriginCommit"]) {
      const before = copies(a).length;
      const id = ask(a, b, `question ${phase}`);
      const { db, squad: bob } = open(b, "bob");
      try {
        bob.deliveryFaults = { [phase]: () => { throw new Error(`injected ${phase}`); } };
        assert.throws(() => bob.reply(id, `answer ${phase}`), (err) => {
          assert.match(err.message, /stored in this room but was NOT delivered/);
          assert.match(err.message, new RegExp(`injected ${phase}`));
          assert.match(err.message, /squad send --retry [0-9a-f-]{36}/);
          return true;
        });
        bob.deliveryFaults = null;
        // Not answered, reply stored, delivery pending with its error.
        const [outstanding] = bob.crossRoomRequests().filter((r) => r.message_id === id);
        assert.ok(outstanding, "request stays outstanding");
        assert.equal(outstanding.pending_deliveries.length, 1);
        const pending = outstanding.pending_deliveries[0];
        assert.match(pending.last_error, new RegExp(`injected ${phase}`));
        assert.equal(copies(a).length, before + (phase === "afterOriginCommit" ? 1 : 0));
        // Retry the same delivery id: exactly one copy either way.
        const done = bob.retryDelivery(pending.delivery_id);
        assert.equal(done.status, "delivered");
        assert.equal(copies(a).length, before + 1);
        assert.equal(copies(a).filter((c) => c.delivery_id === pending.delivery_id).length, 1);
        assert.equal(bob.retryDelivery(pending.delivery_id).status, "already-delivered");
        assert.equal(copies(a).length, before + 1);
        assert.ok(!bob.crossRoomRequests().some((r) => r.message_id === id), "answered once delivered");
        assert.deepEqual(bob.pendingDeliveries(), []);
      } finally {
        db.close();
      }
    }
  } finally {
    cleanup(a, b);
  }
});

test("missing (moved) origin room: clear failure, no room created, retry after it returns", () => {
  const a = privateRoom("alice", "a");
  const b = privateRoom("bob", "b");
  const moved = a + "-moved";
  try {
    const id = ask(a, b, "where are you");
    renameSync(a, moved);
    const r = squad(["send", "--reply", String(id), "here"], { cwd: b, env: { SQUAD_PERSONA: "bob" } });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no squad room at .* no room was created/);
    assert.match(r.stderr, /request stays outstanding/);
    assert.ok(!existsSync(a), "the missing origin is not recreated");
    const [pending] = rows(b, "SELECT * FROM route_deliveries");
    assert.equal(pending.status, "pending");
    assert.equal(rows(b, "SELECT answered_ts FROM message_routes WHERE message_id = ?", id)[0].answered_ts, null);
    renameSync(moved, a);
    const retry = squad(["send", "--retry", pending.delivery_id], { cwd: b, env: { SQUAD_PERSONA: "bob" } });
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(copies(a).length, 1);
    assert.notEqual(rows(b, "SELECT answered_ts FROM message_routes WHERE message_id = ?", id)[0].answered_ts, null);
  } finally {
    cleanup(a, b, moved);
  }
});

test("an origin room from a newer, incompatible squad build is refused, not written", () => {
  const a = privateRoom("alice", "a");
  const b = privateRoom("bob", "b");
  try {
    const id = ask(a, b, "q");
    const raw = new DatabaseSync(join(roomOf(a), "squad.db"));
    raw.exec("PRAGMA user_version = 999");
    raw.close();
    const r = squad(["send", "--reply", String(id), "a"], { cwd: b, env: { SQUAD_PERSONA: "bob" } });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /schema v999, newer than this build/);
    assert.equal(copies(a).length, 0);
  } finally {
    cleanup(a, b);
  }
});

test("routing policies: absent, empty, restrictive, aliases, malformed, outbound replies", () => {
  const a = privateRoom("alice", "a");
  const b = privateRoom("bob", "b");
  const c = privateRoom("carl", "c");
  const links = tmp();
  try {
    const policy = (repo, value) =>
      writeFileSync(join(roomOf(repo), "routing.json"), typeof value === "string" ? value : JSON.stringify(value));
    const send = (from, to, text) => squad(["send", "--room", to, text], { cwd: from, env: { SQUAD_PERSONA: "alice" } });

    policy(b, { accept_from: [] });
    let r = send(a, b, "denied-empty");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /does not accept cross-room messages from .*"accept_from" is empty/);
    assert.ok(!bodies(b).includes("denied-empty"));

    policy(b, { accept_from: [c] });
    assert.notEqual(send(a, b, "denied-restrictive").status, 0);
    assert.ok(!bodies(b).includes("denied-restrictive"));

    // A symlink alias of A in the allowlist names the same canonical room.
    const alias = join(links, "alias-of-a");
    symlinkSync(a, alias);
    policy(b, { accept_from: [alias] });
    assert.equal(send(a, b, "allowed-alias").status, 0);
    // ...and sending *from* a linked worktree of A is still room A.
    execFileSync("git", ["-C", a, "-c", "user.email=a@b", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "x"]);
    const wt = join(links, "wt");
    execFileSync("git", ["-C", a, "worktree", "add", "-q", wt]);
    assert.equal(send(wt, b, "from-worktree").status, 0);
    const origins = rows(b, "SELECT remote_room FROM message_routes WHERE direction = 'inbound'").map((x) => x.remote_room);
    assert.deepEqual([...new Set(origins)], [realpathSync(roomOf(a))]);
    // A worktree path in the policy also canonicalizes to A.
    policy(b, { accept_from: [wt] });
    assert.equal(send(a, b, "allowed-worktree-entry").status, 0);

    policy(b, "{not json");
    r = send(a, b, "malformed");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /invalid routing policy at .*routing\.json: not valid JSON/);
    policy(b, { accept_from: "x" });
    assert.match(send(a, b, "malformed2").stderr, /"accept_from" must be an array/);
    policy(b, { inbound: [] });
    assert.match(send(a, b, "malformed3").stderr, /unknown key "inbound"/);

    // Outbound replies: B's own reply_to, then A's accept_from, both pre-flight.
    policy(b, { reply_to: [] });
    const id = rows(b, "SELECT message_id FROM message_routes WHERE direction = 'inbound' ORDER BY message_id DESC")[0].message_id;
    const before = bodies(b).length;
    r = squad(["send", "--reply", String(id), "denied-out"], { cwd: b, env: { SQUAD_PERSONA: "bob" } });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /"reply_to" is empty\) does not allow delivering replies/);
    assert.equal(bodies(b).length, before, "a refused reply stores nothing");
    assert.equal(copies(a).length, 0);

    policy(b, { reply_to: [alias] });
    policy(a, { accept_from: [c] });
    r = squad(["send", "--reply", String(id), "denied-by-origin"], { cwd: b, env: { SQUAD_PERSONA: "bob" } });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /does not accept cross-room messages from/);
    assert.equal(bodies(b).length, before);

    rmSync(join(roomOf(a), "routing.json"));
    r = squad(["send", "--reply", String(id), "allowed-out"], { cwd: b, env: { SQUAD_PERSONA: "bob" } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(copies(a).length, 1);
  } finally {
    cleanup(a, b, c, links);
  }
});

test("source resolution: explicit SQUAD_DIR, same-room, source-less and automatic identities", () => {
  const a = privateRoom("alice", "a");
  const b = privateRoom("bob", "b");
  const elsewhere = tmp();
  const roomless = tmp();
  try {
    // Explicit source SQUAD_DIR wins over cwd.
    let r = squad(["send", "--room", b, "via-env"], { cwd: elsewhere, env: { SQUAD_PERSONA: "alice", SQUAD_DIR: roomOf(a) } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(rows(b, "SELECT remote_room FROM message_routes")[0].remote_room, realpathSync(roomOf(a)));

    // Same room: a plain local message, no route.
    r = squad(["send", "--room", a, "same-room"], { cwd: a, env: { SQUAD_PERSONA: "alice" } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(rows(a, "SELECT COUNT(*) AS n FROM message_routes")[0].n, 0);
    assert.ok(bodies(a).includes("same-room"));

    // Source-less: one-way, reported, and no source room is created.
    execFileSync("git", ["init", "-q", roomless]);
    r = squad(["send", "--room", b, "one-way"], { cwd: roomless, env: { SQUAD_PERSONA: "dave" } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /this message is one-way: replies to it cannot be routed back/);
    assert.ok(!existsSync(roomOf(roomless)));
    const oneWay = rows(b, "SELECT id, sender FROM messages WHERE body = 'one-way'")[0];
    assert.equal(oneWay.sender, "dave", "legacy send keeps its documented sender");
    assert.equal(rows(b, "SELECT COUNT(*) AS n FROM message_routes WHERE message_id = ?", oneWay.id)[0].n, 0);

    // Automatic identity: resolved in the source room, never minted in the
    // target, and the resume token never appears in the target room.
    const token = "0f0e0d0c-0b0a-4908-8706-050403020100";
    const auto = { SQUAD_PERSONA: "", SQUAD_SESSION_ID: token, SQUAD_MODEL: "opus" };
    r = squad(["send", "hi-from-auto"], { cwd: a, env: auto });
    assert.equal(r.status, 0, r.stderr);
    const persona = rows(a, "SELECT persona FROM agent_identities WHERE identity_id = ?", token)[0].persona;
    r = squad(["send", "--room", b, "auto-ask"], { cwd: a, env: auto });
    assert.equal(r.status, 0, r.stderr);
    const [route] = rows(b, "SELECT * FROM message_routes WHERE direction = 'inbound' ORDER BY message_id DESC LIMIT 1");
    assert.equal(route.remote_persona, persona);
    assert.equal(rows(b, "SELECT COUNT(*) AS n FROM agent_identities")[0].n, 0, "no persona minted in the target");
    const bFile = readFileSync(join(roomOf(b), "squad.db"));
    const exported = JSON.stringify(ROOM_TABLES.map((t) => rows(b, `SELECT * FROM ${t}`)));
    assert.ok(!exported.includes(token) && !bFile.includes(token), "resume token never stored in the target room");
  } finally {
    cleanup(a, b, elsewhere, roomless);
  }
});

test("flag parsing: --reply/--retry are leading-only; literal flags in prose are sent verbatim", () => {
  const a = privateRoom("alice", "a");
  const b = privateRoom("bob", "b");
  try {
    const env = { SQUAD_PERSONA: "alice" };
    assert.equal(squad(["send", "see", "--reply", "3", "and", "--retry", "x"], { cwd: a, env }).status, 0);
    assert.ok(bodies(a).includes("see --reply 3 and --retry x"));
    const id = ask(a, b, "body with --reply 1 inside");
    assert.ok(bodies(b).includes("body with --reply 1 inside"));
    assert.match(squad(["send", "--reply", "--help"], { cwd: b }).stdout, /usage: squad send --reply <message-id>/);
    assert.match(squad(["send", "--retry", "-h"], { cwd: b }).stdout, /usage: squad send --retry <delivery-id>/);
    for (const bad of [["--reply"], ["--reply", "x", "t"], ["--reply", String(id)], ["--retry"], ["--retry", "a", "b"]]) {
      const r = squad(["send", ...bad], { cwd: b, env: { SQUAD_PERSONA: "bob" } });
      assert.notEqual(r.status, 0, bad.join(" "));
      assert.match(r.stderr, /usage: squad send --re(ply|try)/);
    }
    let r = squad(["send", "--reply", "999", "nope"], { cwd: b, env: { SQUAD_PERSONA: "bob" } });
    assert.match(r.stderr, /no message #999/);
    r = squad(["send", "--retry", "not-a-delivery"], { cwd: b, env: { SQUAD_PERSONA: "bob" } });
    assert.match(r.stderr, /no cross-room delivery 'not-a-delivery'/);
    r = squad(["send", "--room", b, "--reply", String(id), "x"], { cwd: a, env });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--room cannot be combined with --reply/);
    assert.match(squad(["send", "--help"], { cwd: b }).stdout, /--reply <message-id>/);
    assert.match(squad(["help"], { cwd: b }).stdout, /routing\.json/);
  } finally {
    cleanup(a, b);
  }
});

test("join and doctor list an old unanswered request beyond the recent window; doctor writes nothing", () => {
  const a = privateRoom("alice", "a");
  const b = privateRoom("bob", "b");
  try {
    const id = ask(a, b, "ancient question");
    const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const raw = new DatabaseSync(join(roomOf(b), "squad.db"));
    raw.prepare("UPDATE message_routes SET created_ts = ? WHERE message_id = ?").run(old, id);
    raw.prepare("UPDATE messages SET ts = ? WHERE id = ?").run(old, id);
    raw.close();
    for (let i = 0; i < 40; i++)
      assert.equal(squad(["send", `chatter ${i}`], { cwd: b, env: { SQUAD_PERSONA: "bob" } }).status, 0);

    const snapshot = () => JSON.stringify(ROOM_TABLES.map((t) => rows(b, `SELECT * FROM ${t}`)));
    const before = snapshot();
    const doc = squad(["doctor", "--room"], { cwd: b });
    assert.equal(doc.status, 0, doc.stderr);
    assert.match(doc.stdout, /== Cross-room requests \(1\) ==/);
    assert.match(doc.stdout, /\[warning\] Cross-room request #\d+ from alice .* has no delivered reply/);
    assert.match(doc.stdout, /age: 3d/);
    assert.match(doc.stdout, new RegExp(`squad send --reply ${id} `));
    assert.equal(snapshot(), before, "doctor --room is read-only");

    const { db, squad: bob } = open(b, "bob");
    try {
      const report = bob.roomDoctor({ message_limit: 5 });
      const finding = report.findings.find((f) => f.category === "cross_room_request");
      assert.ok(finding && finding.age_ms >= 3 * 86_400_000 - 60_000);
      const joined = bob.join(5);
      assert.ok(!joined.recent.some((m) => m.id === id), "outside the recent window");
      assert.equal(joined.cross_room_requests.length, 1);
      assert.equal(joined.cross_room_requests[0].message_id, id);
      assert.ok(joined.cross_room_requests[0].age_ms >= 3 * 86_400_000 - 60_000);

      // A failed delivery is reported too, with the retry command.
      bob.deliveryFaults = { beforeOriginCommit: () => { throw new Error("offline"); } };
      assert.throws(() => bob.reply(id, "late answer"));
      bob.deliveryFaults = null;
      const pending = bob.roomDoctor().findings.find((f) => f.category === "undelivered_reply");
      assert.match(pending.next_step, /squad send --retry /);
      bob.retryDelivery(bob.pendingDeliveries()[0].delivery_id);
      assert.deepEqual(bob.join().cross_room_requests, []);
      assert.ok(!bob.roomDoctor().findings.some((f) => f.category.startsWith("cross_room") || f.category === "undelivered_reply"));
    } finally {
      db.close();
    }
  } finally {
    cleanup(a, b);
  }
});

test("export/import round-trips routing state", async () => {
  const a = privateRoom("alice", "a");
  const b = privateRoom("bob", "b");
  const dest = tmp();
  try {
    const id = ask(a, b, "keep me");
    const { db, squad: bob } = open(b, "bob");
    const file = join(dest, "export.db");
    try {
      await bob.exportRoom(file);
    } finally {
      db.close();
    }
    const fresh = tmp();
    process.env.SQUAD_DIR = fresh;
    try {
      const { openDb } = await import("../dist/db.js");
      const fdb = openDb();
      const s = new Squad(fdb, "bob");
      s.importRoom(file);
      const [req] = s.crossRoomRequests();
      assert.equal(req.message_id, id);
      assert.equal(req.origin_persona, "alice");
      fdb.close();
    } finally {
      delete process.env.SQUAD_DIR;
      rmSync(fresh, { recursive: true, force: true });
    }
  } finally {
    cleanup(a, b, dest);
  }
});
