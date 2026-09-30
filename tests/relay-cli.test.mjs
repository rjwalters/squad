import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { openDb } from "../dist/db.js";
import { Squad } from "../dist/core.js";
import { opportunisticRelay, relayConfigFromEnv, relayOnce, relayStatus } from "../dist/relay.js";
import { parseRelayArgs, RELAY_USAGE, HELP } from "../dist/cli.js";

// #113: the product surface over the #112 relay engine -- `squad relay`
// (--once / --follow / status) and the fire-and-forget hook a live MCP server
// runs after each message insert. As in tests/relay.test.mjs, the only
// collector ever contacted is a mock bound to 127.0.0.1 in this process, so
// CLI subprocesses are spawned asynchronously (spawnSync would block the very
// event loop the mock answers on).

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(repoRoot, "dist", "index.js");
const RELAY_VARS = ["SQUAD_RELAY_ENDPOINT", "SQUAD_RELAY_HEADERS", "SQUAD_RELAY_ROOM_NAME", "SQUAD_RELAY_KINDS"];

/** A mock OTLP/HTTP+JSON logs receiver (same shape as relay.test.mjs's). */
async function mockOtlp(t) {
  const requests = [];
  const state = { status: 200, gate: null };
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      requests.push(raw);
      if (state.gate) await state.gate;
      res.writeHead(state.status, { "content-type": "application/json" });
      res.end("");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((r) => server.close(r));
  });
  return {
    endpoint: `http://127.0.0.1:${server.address().port}/v1/logs`,
    requests,
    state,
    bodies() {
      return requests.flatMap((raw) =>
        JSON.parse(raw).resourceLogs.flatMap((rl) =>
          rl.scopeLogs.flatMap((sl) => sl.logRecords.map((rec) => rec.body.stringValue)),
        ),
      );
    },
  };
}

/** An http endpoint on a port nothing is listening on. */
async function deadEndpoint() {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  return `http://127.0.0.1:${port}/v1/logs`;
}

function freshRoom(t) {
  const root = mkdtempSync(join(tmpdir(), "squad-relay-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, ".squad");
}

/** process.env minus every relay var and persona pin, plus `extra`. */
function envWith(extra) {
  const env = { ...process.env };
  for (const k of [...RELAY_VARS, "SQUAD_PERSONA", "SQUAD_SESSION_ID"]) delete env[k];
  return { ...env, ...extra };
}

/** Run the CLI without blocking this process's event loop. */
function runCli(args, env) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [entry, ...args], { cwd: repoRoot, env: envWith(env) });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (status, signal) => resolvePromise({ status, signal, stdout, stderr }));
  });
}

async function waitFor(predicate, what, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Seed messages in a room directly, then close the handle. */
function seed(dir, bodies) {
  const saved = process.env.SQUAD_DIR;
  process.env.SQUAD_DIR = dir;
  try {
    const db = openDb();
    const squad = new Squad(db, "claude");
    for (const b of bodies) squad.send(b);
    db.close();
  } finally {
    if (saved === undefined) delete process.env.SQUAD_DIR;
    else process.env.SQUAD_DIR = saved;
  }
}

// --- argument parsing ------------------------------------------------------

test("squad relay argument parsing", () => {
  assert.deepEqual(parseRelayArgs([]), { mode: "once" });
  assert.deepEqual(parseRelayArgs(["--once"]), { mode: "once" });
  assert.deepEqual(parseRelayArgs(["--follow"]), { mode: "follow", intervalMs: 5000 });
  assert.deepEqual(parseRelayArgs(["--follow", "--interval", "0.5"]), { mode: "follow", intervalMs: 500 });
  assert.deepEqual(parseRelayArgs(["status"]), { mode: "status" });
  assert.deepEqual(parseRelayArgs(["--help"]), { mode: "help" });
  for (const bad of [
    ["--once", "--follow"],
    ["--follow", "--interval"],
    ["--follow", "--interval", "0"],
    ["--follow", "--interval", "-1"],
    ["--follow", "--interval", "soon"],
    ["status", "--verbose"],
    ["--bogus"],
    ["--interval", "5"],
  ])
    assert.throws(() => parseRelayArgs(bad), { message: RELAY_USAGE }, bad.join(" "));
});

test("help documents the relay command and all four relay env vars", () => {
  assert.match(HELP, /squad relay \[--once\]/);
  assert.match(HELP, /squad relay --follow/);
  assert.match(HELP, /squad relay status/);
  for (const v of RELAY_VARS) assert.ok(HELP.includes(v), `${v} is in squad help`);
  assert.match(HELP, /sends message bodies off this machine/);
});

// --- status ----------------------------------------------------------------

test("squad relay status with no config reports 'not configured' instead of erroring", async (t) => {
  const dir = freshRoom(t);
  const res = await runCli(["relay", "status"], { SQUAD_DIR: dir });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /relay: not configured/);
  assert.equal(res.stderr, "");
});

test("squad relay --once without config is a clear error", async (t) => {
  const dir = freshRoom(t);
  const res = await runCli(["relay", "--once"], { SQUAD_DIR: dir });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /relay: not configured/);
});

test("squad relay does not open a presence lease for the relaying process", async (t) => {
  const dir = freshRoom(t);
  const receiver = await mockOtlp(t);
  seed(dir, ["one"]);
  await runCli(["relay", "--once"], { SQUAD_DIR: dir, SQUAD_RELAY_ENDPOINT: receiver.endpoint });
  const who = await runCli(["who"], { SQUAD_DIR: dir });
  assert.doesNotMatch(who.stdout, /^human\t/m);
});

// --- --once ------------------------------------------------------------------

test("squad relay --once backfills full history on a newly-enabled room, then status reports no lag", async (t) => {
  const dir = freshRoom(t);
  const receiver = await mockOtlp(t);
  seed(dir, ["first", "second", "third"]);
  const env = { SQUAD_DIR: dir, SQUAD_RELAY_ENDPOINT: receiver.endpoint };

  const before = await runCli(["relay", "status"], env);
  assert.equal(before.status, 0, before.stderr);
  assert.match(before.stdout, /relay: configured/);
  assert.match(before.stdout, new RegExp(`target: +${receiver.endpoint.replace(/[.]/g, "\\.")}`));
  assert.match(before.stdout, /lag: +3 unshipped message\(s\)/);
  assert.match(before.stdout, /cursor: +message #0 \(never advanced\)/);
  assert.match(before.stdout, /last error: none/);

  const once = await runCli(["relay", "--once"], env);
  assert.equal(once.status, 0, once.stdout + once.stderr);
  assert.match(once.stdout, /shipped 3 message\(s\)/);
  assert.deepEqual(receiver.bodies(), ["first", "second", "third"], "full history, from message id 0");

  const after = await runCli(["relay", "status"], env);
  assert.match(after.stdout, /lag: +0 unshipped message\(s\)/);
  assert.match(after.stdout, /cursor: +message #3 \(last advanced /);
  assert.match(after.stdout, /last error: none/);

  const again = await runCli(["relay", "--once"], env);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /nothing new/);
  assert.equal(receiver.requests.length, 1, "a second --once re-sends nothing");
});

test("status counts only relayed kinds as lag when SQUAD_RELAY_KINDS is set", async (t) => {
  const dir = freshRoom(t);
  seed(dir, ["chat one"]);
  const saved = process.env.SQUAD_DIR;
  process.env.SQUAD_DIR = dir;
  t.after(() => {
    if (saved === undefined) delete process.env.SQUAD_DIR;
    else process.env.SQUAD_DIR = saved;
  });
  const db = openDb();
  t.after(() => db.close());
  new Squad(db, "claude").send("a system notice", "system");
  assert.equal(relayStatus(db, "http://x.example/v1/logs").lag, 2);
  assert.equal(relayStatus(db, "http://x.example/v1/logs", ["chat"]).lag, 1);
});

test("a failed pass is persisted as the last error, and cleared by the next successful one", async (t) => {
  const dir = freshRoom(t);
  seed(dir, ["hello"]);
  const dead = await deadEndpoint();
  const failed = await runCli(["relay", "--once"], { SQUAD_DIR: dir, SQUAD_RELAY_ENDPOINT: dead });
  assert.equal(failed.status, 1, "a failed pass exits non-zero");
  assert.match(failed.stdout, /failed/);

  const status = await runCli(["relay", "status"], { SQUAD_DIR: dir, SQUAD_RELAY_ENDPOINT: dead });
  assert.equal(status.status, 0);
  assert.match(status.stdout, /last error: relay: POST .* failed: .*\(at \d{4}-/);
  assert.match(status.stdout, /lag: +1 unshipped/);

  // Unconfigured status still surfaces targets this room has relayed to.
  const unconfigured = await runCli(["relay", "status"], { SQUAD_DIR: dir });
  assert.match(unconfigured.stdout, /not configured/);
  assert.match(unconfigured.stdout, /previously relayed targets/);
  assert.ok(unconfigured.stdout.includes(dead));

  // Same target, now answering: the error clears.
  const saved = process.env.SQUAD_DIR;
  process.env.SQUAD_DIR = dir;
  try {
    const db = openDb();
    const config = relayConfigFromEnv({ SQUAD_RELAY_ENDPOINT: dead });
    db.prepare("UPDATE relay_cursors SET last_error='old' WHERE target=?").run(config.target);
    const receiver = await mockOtlp(t);
    const ok = await relayOnce(db, { ...config, endpoint: receiver.endpoint });
    assert.equal(ok.status, "ok");
    assert.equal(relayStatus(db, config.target).lastError, null);
    db.close();
  } finally {
    if (saved === undefined) delete process.env.SQUAD_DIR;
    else process.env.SQUAD_DIR = saved;
  }
});

test("an existing relay_cursors table from #112 gains the last-error columns on open", (t) => {
  const dir = freshRoom(t);
  const saved = process.env.SQUAD_DIR;
  process.env.SQUAD_DIR = dir;
  t.after(() => {
    if (saved === undefined) delete process.env.SQUAD_DIR;
    else process.env.SQUAD_DIR = saved;
  });
  let db = openDb();
  db.exec("DROP TABLE relay_cursors");
  db.exec(
    "CREATE TABLE relay_cursors (target TEXT PRIMARY KEY, last_message_id INTEGER NOT NULL DEFAULT 0, updated_at TEXT, lease_expires INTEGER NOT NULL DEFAULT 0)",
  );
  db.close();
  db = openDb();
  const cols = db.prepare("PRAGMA table_info(relay_cursors)").all().map((c) => c.name);
  db.close();
  assert.ok(cols.includes("last_error") && cols.includes("last_error_at"), cols.join(","));
});

// --- --follow ------------------------------------------------------------------

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`squad relay --follow keeps shipping new messages until ${signal}, then stops cleanly`, async (t) => {
    const dir = freshRoom(t);
    const receiver = await mockOtlp(t);
    seed(dir, ["backlog"]);
    const child = spawn(process.execPath, [entry, "relay", "--follow", "--interval", "0.1"], {
      cwd: repoRoot,
      env: envWith({ SQUAD_DIR: dir, SQUAD_RELAY_ENDPOINT: receiver.endpoint }),
    });
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stdout += c));
    const exited = new Promise((r) => child.on("close", (status, sig) => r({ status, sig })));
    t.after(() => child.kill("SIGKILL"));

    await waitFor(() => receiver.bodies().includes("backlog"), "the backlog to ship");
    seed(dir, ["live one"]);
    await waitFor(() => receiver.bodies().includes("live one"), "a new message to ship");

    child.kill(signal);
    const { status, sig } = await exited;
    assert.equal(sig, null, `exits on its own rather than dying to ${signal}: ${stdout}`);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /relay: stopped \(cursor at #2\)/);
    assert.deepEqual(receiver.bodies(), ["backlog", "live one"]);
  });
}

test("--follow interrupted mid-POST leaves the batch unshipped and resumable", async (t) => {
  const dir = freshRoom(t);
  const receiver = await mockOtlp(t);
  let release;
  receiver.state.gate = new Promise((r) => (release = r));
  t.after(() => release());
  seed(dir, ["stuck"]);
  const env = { SQUAD_DIR: dir, SQUAD_RELAY_ENDPOINT: receiver.endpoint };
  const child = spawn(process.execPath, [entry, "relay", "--follow"], { cwd: repoRoot, env: envWith(env) });
  let stdout = "";
  child.stdout.on("data", (c) => (stdout += c));
  const exited = new Promise((r) => child.on("close", (status) => r(status)));
  t.after(() => child.kill("SIGKILL"));

  await waitFor(() => receiver.requests.length === 1, "the POST to be in flight");
  child.kill("SIGINT");
  assert.equal(await exited, 0, stdout);
  assert.match(stdout, /relay: stopped \(cursor at #0\)/);

  // The interrupt is not recorded as an endpoint failure, and nothing moved.
  const status = await runCli(["relay", "status"], env);
  assert.match(status.stdout, /last error: none/);
  assert.match(status.stdout, /cursor: +message #0/);

  release();
  receiver.state.gate = null;
  const resumed = await runCli(["relay", "--once"], env);
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.match(resumed.stdout, /shipped 1 message/);
});

// --- opportunistic hook ----------------------------------------------------------

/** A Squad on a fresh room with the opportunistic hook installed. */
function hookedRoom(t, env, onPass) {
  const dir = freshRoom(t);
  const saved = process.env.SQUAD_DIR;
  process.env.SQUAD_DIR = dir;
  t.after(() => {
    if (saved === undefined) delete process.env.SQUAD_DIR;
    else process.env.SQUAD_DIR = saved;
  });
  const db = openDb();
  t.after(() => {
    if (db.isOpen) db.close();
  });
  const squad = new Squad(db, "claude");
  squad.onMessageInserted = opportunisticRelay(db, { env, onPass });
  return { db, squad };
}

test("an insert succeeds, synchronously, when the relay target is unreachable", async (t) => {
  const passes = [];
  const { db, squad } = hookedRoom(t, { SQUAD_RELAY_ENDPOINT: await deadEndpoint() }, (r) => passes.push(r));
  const m = squad.send("still delivered");
  assert.equal(m.body, "still delivered");
  assert.equal(passes.length, 0, "no relay work runs inside the insert call");
  await waitFor(() => passes.length > 0, "the background pass");
  assert.equal(passes[0].status, "failed");
  assert.equal(squad.read(5).at(-1).body, "still delivered");
  assert.equal(relayStatus(db, passes[0].target).cursor, 0);
  assert.match(relayStatus(db, passes[0].target).lastError, /failed/);
});

test("a hung collector never delays the insert, and bursts coalesce", async (t) => {
  const receiver = await mockOtlp(t);
  let release;
  receiver.state.gate = new Promise((r) => (release = r));
  t.after(() => release());
  const passes = [];
  const { squad } = hookedRoom(t, { SQUAD_RELAY_ENDPOINT: receiver.endpoint }, (r) => passes.push(r));
  squad.send("one");
  await waitFor(() => receiver.requests.length === 1, "the first POST to hang");
  const started = Date.now();
  for (let i = 0; i < 20; i++) squad.send(`burst ${i}`);
  assert.ok(Date.now() - started < 1000, "20 inserts behind a hung collector stay fast");
  assert.equal(receiver.requests.length, 1, "no pile-up of concurrent POSTs");
  release();
  receiver.state.gate = null;
  await waitFor(() => receiver.bodies().length === 21, "the coalesced follow-up pass");
  assert.equal(receiver.requests.length, 2, "one in-flight pass plus exactly one follow-up");
});

test("an invalid relay config or a throwing hook never fails the insert", async (t) => {
  const { squad } = hookedRoom(t, { SQUAD_RELAY_ENDPOINT: "ftp://nope.example" });
  assert.equal(squad.send("fine").body, "fine");
  await new Promise((r) => setImmediate(r));
  squad.onMessageInserted = () => {
    throw new Error("boom");
  };
  assert.equal(squad.send("still fine").body, "still fine");
});

test("the hook is inert when SQUAD_RELAY_ENDPOINT is unset", async (t) => {
  const passes = [];
  const { db, squad } = hookedRoom(t, {}, (r) => passes.push(r));
  squad.send("local only");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(passes.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM relay_cursors").get().n, 0);
});

test("steward reminders, the other insert path, also trigger the hook", async (t) => {
  const { db } = hookedRoom(t, {});
  // Same fixture as tests/steward.test.mjs: a configured steward whose first
  // tick always has a stale-outline reminder to send.
  db.prepare(
    "INSERT INTO integration_configs(config_json, updated_by, updated_ts) VALUES (?, ?, ?)",
  ).run(
    JSON.stringify({ repository: tmpdir(), remote: "origin", branch: "main", build_command: "true", steward: "keeper" }),
    "human",
    new Date().toISOString(),
  );
  const keeper = new Squad(db, "keeper");
  let fired = 0;
  keeper.onMessageInserted = () => fired++;
  const tick = keeper.stewardTick();
  assert.equal(tick.sent.length, 1);
  assert.equal(fired, 1, "fired once, after COMMIT");
  keeper.stewardTick(); // within cadence: sends nothing
  assert.equal(fired, 1, "a tick that inserts nothing does not fire");
});

// --- live MCP server ---------------------------------------------------------------

async function mcpClient(t, dir, extraEnv) {
  const env = envWith({ SQUAD_DIR: dir, SQUAD_PERSONA: "claude", ...extraEnv });
  const client = new Client({ name: "relay-test", version: "1" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [resolve(entry)], env, stderr: "pipe" }),
  );
  t.after(() => client.close());
  return async (name, args = {}) => client.callTool({ name, arguments: args });
}

test("a live MCP server relays squad_send, and an unreachable target does not fail the tool call", async (t) => {
  const receiver = await mockOtlp(t);
  const call = await mcpClient(t, freshRoom(t), { SQUAD_RELAY_ENDPOINT: receiver.endpoint });
  const sent = await call("squad_send", { body: "over the wire" });
  assert.ok(!sent.isError, JSON.stringify(sent));
  await waitFor(() => receiver.bodies().includes("over the wire"), "the opportunistic pass");

  const deadCall = await mcpClient(t, freshRoom(t), { SQUAD_RELAY_ENDPOINT: await deadEndpoint() });
  const res = await deadCall("squad_send", { body: "nobody listening" });
  assert.ok(!res.isError, JSON.stringify(res));
  assert.match(res.content[0].text, /nobody listening/);
});

test("a hung collector does not delay a live MCP server's tool calls", async (t) => {
  const receiver = await mockOtlp(t);
  let release;
  receiver.state.gate = new Promise((r) => (release = r));
  t.after(() => release());
  const call = await mcpClient(t, freshRoom(t), { SQUAD_RELAY_ENDPOINT: receiver.endpoint });
  await call("squad_send", { body: "first" });
  await waitFor(() => receiver.requests.length === 1, "the POST to hang");
  const started = Date.now();
  const res = await call("squad_send", { body: "second" });
  assert.ok(!res.isError);
  assert.ok(Date.now() - started < 2000, "tool call returned while the relay POST is still hung");
});
