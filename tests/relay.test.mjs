import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb, ROOM_TABLES } from "../dist/db.js";
import { Squad } from "../dist/core.js";
import {
  defaultRelayRoomName,
  parseRelayHeaders,
  relayConfigFromEnv,
  relayOnce,
  relayTarget,
  toExportRequest,
  toLogRecord,
} from "../dist/relay.js";

// Every case here talks to a mock OTLP receiver bound to 127.0.0.1:0 in this
// same process -- the suite never reaches a real collector, and never needs a
// network. The receiver is a deliberately dumb HTTP endpoint: it records what
// it was sent and answers with whatever status/body the test set, including
// holding a response open so two relay passes can be made to overlap.

/** A mock OTLP/HTTP+JSON logs receiver. */
async function mockOtlp(t) {
  /** Every request seen, accepted or not: { headers, raw }. */
  const requests = [];
  const state = {
    status: 200,
    body: "",
    contentType: "application/json",
    /** When set, a promise the handler awaits before responding. */
    gate: null,
  };
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", async () => {
      requests.push({ headers: { ...req.headers }, raw, url: req.url, method: req.method });
      if (state.gate) await state.gate;
      res.writeHead(state.status, { "content-type": state.contentType });
      res.end(state.body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    endpoint: `http://127.0.0.1:${server.address().port}/v1/logs`,
    requests,
    state,
    /** Every log record the receiver was sent, in request order. */
    records() {
      return requests.flatMap((r) =>
        JSON.parse(r.raw).resourceLogs.flatMap((rl) => rl.scopeLogs.flatMap((sl) => sl.logRecords)),
      );
    },
    /** `squad.message_id` of every record sent, in request order. */
    ids() {
      return this.records().map((rec) => Number(attrOf(rec, "squad.message_id")));
    },
  };
}

/** The value of one attribute on an OTLP log record. */
function attrOf(record, key) {
  const found = record.attributes.find((a) => a.key === key);
  if (!found) return undefined;
  return found.value.stringValue ?? found.value.intValue;
}

/** A room on disk with no relay config in the environment. */
function room(t) {
  const root = mkdtempSync(join(tmpdir(), "squad-relay-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, ".squad");
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
  return { root, dir, db };
}

/** Seed `messages` directly: deterministic ids, kinds, and timestamps. */
function seed(db, rows) {
  const insert = db.prepare(
    "INSERT INTO messages (sender, kind, body, ts, occurrences) VALUES (?, ?, ?, ?, ?)",
  );
  for (const r of rows)
    insert.run(r.sender ?? "claude", r.kind ?? "chat", r.body, r.ts ?? "2026-01-01T00:00:00.000Z", r.occurrences ?? 1);
}

/** A config pointing at the mock receiver, with relay env vars applied. */
function configFor(receiver, env = {}, overrides = {}) {
  return relayConfigFromEnv(
    { SQUAD_RELAY_ENDPOINT: receiver.endpoint, ...env },
    { host: "test-host", ...overrides },
  );
}

function cursorRow(db, target) {
  return db.prepare("SELECT * FROM relay_cursors WHERE target=?").get(target);
}

// --- schema ---------------------------------------------------------------

test("relay_cursors is local delivery state, not room state", (t) => {
  const { db } = room(t);
  assert.ok(
    !ROOM_TABLES.includes("relay_cursors"),
    "relay_cursors must stay out of ROOM_TABLES: a room clear/import must not rewind an outbox cursor",
  );
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);
  assert.ok(tables.includes("relay_cursors"), "openDb() creates relay_cursors");
  db.prepare(
    "INSERT INTO relay_cursors (target, last_message_id, updated_at, lease_expires) VALUES (?, ?, ?, 0)",
  ).run("http://collector.example/v1/logs", 7, "2026-01-01T00:00:00.000Z");
  new Squad(db, "claude").clear();
  assert.equal(
    cursorRow(db, "http://collector.example/v1/logs").last_message_id,
    7,
    "squad clear() leaves the relay cursor alone",
  );
});

// --- config parsing ------------------------------------------------------

test("relaying is off until SQUAD_RELAY_ENDPOINT is set", (t) => {
  room(t);
  assert.equal(relayConfigFromEnv({}), null);
  assert.equal(relayConfigFromEnv({ SQUAD_RELAY_ENDPOINT: "   " }), null);
  assert.equal(relayConfigFromEnv({ SQUAD_RELAY_HEADERS: "k=v" }), null);
});

test("an endpoint that is present but unusable is an error, not a silent no-op", (t) => {
  room(t);
  assert.throws(() => relayConfigFromEnv({ SQUAD_RELAY_ENDPOINT: "not a url" }), /not a URL/);
  assert.throws(
    () => relayConfigFromEnv({ SQUAD_RELAY_ENDPOINT: "ftp://collector.example/v1/logs" }),
    /must be http/,
  );
});

test("relay config reads room, kinds and headers from the environment", (t) => {
  const { root } = room(t);
  const config = relayConfigFromEnv({
    SQUAD_RELAY_ENDPOINT: "https://collector.example/v1/logs",
    SQUAD_RELAY_HEADERS: "signoz-ingestion-key=key-abc, x-extra =  spaced ",
    SQUAD_RELAY_KINDS: "chat, system ,",
    SQUAD_RELAY_ROOM_NAME: "my-room",
  });
  assert.equal(config.room, "my-room");
  assert.deepEqual(config.kinds, ["chat", "system"]);
  assert.deepEqual(config.headers, { "signoz-ingestion-key": "key-abc", "x-extra": "spaced" });
  assert.equal(config.target, "https://collector.example/v1/logs");
  assert.equal(config.repoPath, root, "squad.repo_path is the repository holding the room");
  // Unset SQUAD_RELAY_KINDS means "every kind", not "no kinds".
  assert.equal(
    relayConfigFromEnv({ SQUAD_RELAY_ENDPOINT: "https://collector.example/v1/logs" }).kinds,
    null,
  );
});

test("the default room name is the directory holding the room", (t) => {
  const { root } = room(t);
  assert.equal(defaultRelayRoomName("/home/dev/projects/squad/.squad"), "squad");
  assert.equal(
    relayConfigFromEnv({ SQUAD_RELAY_ENDPOINT: "https://collector.example/v1/logs" }).room,
    root.split("/").pop(),
    "with no override, squad.room is the repository directory name",
  );
});

test("the cursor key strips query strings and userinfo from the endpoint", (t) => {
  room(t);
  assert.equal(
    relayTarget("https://user:pw@collector.example:4318/v1/logs?ingestion-key=secret-xyz#frag"),
    "https://collector.example:4318/v1/logs",
  );
  const config = relayConfigFromEnv({
    SQUAD_RELAY_ENDPOINT: "https://collector.example/v1/logs?ingestion-key=secret-xyz",
  });
  assert.equal(config.target, "https://collector.example/v1/logs");
  assert.ok(
    !config.target.includes("secret-xyz"),
    "the one config value that reaches disk must not carry a credential",
  );
  // ...while the request itself still goes to the full endpoint.
  assert.ok(config.endpoint.includes("ingestion-key=secret-xyz"));
});

test("malformed SQUAD_RELAY_HEADERS is rejected without echoing the value", (t) => {
  room(t);
  assert.deepEqual(parseRelayHeaders(undefined), {});
  assert.deepEqual(parseRelayHeaders(""), {});
  assert.throws(() => parseRelayHeaders("no-equals-sign"), /name=value/);
  assert.throws(() => parseRelayHeaders("bad header=v"), /invalid header name/);
  try {
    parseRelayHeaders("x-key=secret-xyz\nx-injected: 1");
    assert.fail("a control character in a header value must be rejected");
  } catch (err) {
    assert.match(err.message, /control character/);
    assert.ok(!err.message.includes("secret-xyz"), "the error must not leak the credential");
  }
});

// --- OTLP mapping --------------------------------------------------------

test("each message maps to one OTLP log record with the documented attributes", (t) => {
  room(t);
  const config = relayConfigFromEnv(
    { SQUAD_RELAY_ENDPOINT: "https://collector.example/v1/logs", SQUAD_RELAY_ROOM_NAME: "demo" },
    { host: "test-host", repoPath: "/repos/demo" },
  );
  const record = toLogRecord(
    { id: 42, sender: "codex", kind: "system", body: "hello room", ts: "2026-01-01T00:00:00.500Z", occurrences: 3 },
    config,
    1_800_000_000_000,
  );
  assert.equal(record.body.stringValue, "hello room");
  assert.equal(record.timeUnixNano, "1767225600500000000");
  assert.equal(record.observedTimeUnixNano, "1800000000000000000");
  assert.equal(attrOf(record, "squad.room"), "demo");
  assert.equal(attrOf(record, "squad.repo_path"), "/repos/demo");
  assert.equal(attrOf(record, "squad.host"), "test-host");
  assert.equal(attrOf(record, "squad.message_id"), "42");
  assert.equal(attrOf(record, "squad.sender"), "codex");
  assert.equal(attrOf(record, "squad.kind"), "system");
  assert.equal(attrOf(record, "squad.occurrences"), "3");
  // int64 attributes are proto3-JSON strings, not numbers.
  const messageId = record.attributes.find((a) => a.key === "squad.message_id");
  assert.equal(typeof messageId.value.intValue, "string");

  const request = toExportRequest([record], config);
  const resource = request.resourceLogs[0].resource.attributes;
  assert.equal(resource.find((a) => a.key === "service.name").value.stringValue, "squad");
  assert.equal(resource.find((a) => a.key === "host.name").value.stringValue, "test-host");
  assert.equal(request.resourceLogs[0].scopeLogs[0].logRecords.length, 1);
});

// --- delivery ------------------------------------------------------------

test("relayOnce ships new messages and advances the cursor only after a 2xx", async (t) => {
  const { db } = room(t);
  const receiver = await mockOtlp(t);
  const config = configFor(receiver, { SQUAD_RELAY_ROOM_NAME: "demo" });
  seed(db, [
    { body: "first", ts: "2026-01-01T00:00:01.000Z" },
    { body: "second", sender: "codex", ts: "2026-01-01T00:00:02.000Z" },
  ]);

  const first = await relayOnce(db, config);
  assert.equal(first.status, "ok");
  assert.equal(first.scanned, 2);
  assert.equal(first.shipped, 2);
  assert.equal(first.batches, 1);
  assert.equal(first.cursor, 2);
  assert.deepEqual(receiver.ids(), [1, 2]);
  assert.equal(receiver.requests[0].method, "POST");
  assert.equal(receiver.requests[0].headers["content-type"], "application/json");
  assert.deepEqual(
    receiver.records().map((r) => r.body.stringValue),
    ["first", "second"],
  );
  assert.equal(attrOf(receiver.records()[1], "squad.sender"), "codex");

  const row = cursorRow(db, config.target);
  assert.equal(row.last_message_id, 2);
  assert.equal(row.lease_expires, 0, "the shipping lease is released at the end of a pass");
  assert.match(row.updated_at, /^\d{4}-\d{2}-\d{2}T/);

  // A second pass with nothing new is a no-op: no request at all.
  const second = await relayOnce(db, config);
  assert.equal(second.status, "empty");
  assert.equal(second.shipped, 0);
  assert.equal(receiver.requests.length, 1);

  // ...and only messages past the cursor are shipped afterwards.
  seed(db, [{ body: "third", ts: "2026-01-01T00:00:03.000Z" }]);
  const third = await relayOnce(db, config);
  assert.equal(third.shipped, 1);
  assert.deepEqual(receiver.ids(), [1, 2, 3]);
  assert.equal(cursorRow(db, config.target).last_message_id, 3);
});

test("real room traffic relays through Squad.send", async (t) => {
  const { db } = room(t);
  const receiver = await mockOtlp(t);
  const squad = new Squad(db, "claude");
  squad.send("hello from the room");
  const result = await relayOnce(db, configFor(receiver));
  assert.equal(result.status, "ok");
  assert.ok(result.shipped >= 1);
  assert.ok(
    receiver.records().some((r) => r.body.stringValue === "hello from the room"),
    "a message sent through the room API reaches the collector",
  );
});

test("an empty room ships nothing and issues no request", async (t) => {
  const { db } = room(t);
  const receiver = await mockOtlp(t);
  const result = await relayOnce(db, configFor(receiver));
  assert.equal(result.status, "empty");
  assert.equal(result.scanned, 0);
  assert.equal(result.shipped, 0);
  assert.equal(result.batches, 0);
  assert.equal(result.cursor, 0);
  assert.equal(receiver.requests.length, 0);
});

test("backfill: an unset cursor starts from message id 0 and ships full history", async (t) => {
  const { db } = room(t);
  const receiver = await mockOtlp(t);
  const config = configFor(receiver, {}, { batchSize: 2 });
  seed(db, Array.from({ length: 5 }, (_, i) => ({ body: `m${i + 1}` })));
  assert.equal(cursorRow(db, config.target), undefined, "no cursor row exists before the first pass");

  const result = await relayOnce(db, config);
  assert.equal(result.status, "ok");
  assert.equal(result.scanned, 5);
  assert.equal(result.shipped, 5);
  assert.equal(result.batches, 3, "5 rows at batchSize 2 is three requests");
  assert.equal(result.cursor, 5);
  assert.deepEqual(receiver.ids(), [1, 2, 3, 4, 5], "every historical message, exactly once, in id order");
  assert.equal(cursorRow(db, config.target).last_message_id, 5);
});

// --- outage --------------------------------------------------------------

test("an endpoint outage leaves the cursor unmoved and the batch is re-sent next pass", async (t) => {
  const { db } = room(t);
  const receiver = await mockOtlp(t);
  const config = configFor(receiver);
  seed(db, [{ body: "one" }, { body: "two" }]);

  receiver.state.status = 503;
  receiver.state.body = "service unavailable";
  const failed = await relayOnce(db, config);
  assert.equal(failed.status, "failed");
  assert.equal(failed.shipped, 0);
  assert.equal(failed.cursor, 0);
  assert.match(failed.error, /503/);
  assert.equal(
    cursorRow(db, config.target).last_message_id,
    0,
    "a rejected batch must not advance the cursor",
  );
  assert.equal(cursorRow(db, config.target).lease_expires, 0, "a failed pass still releases its lease");

  receiver.state.status = 200;
  receiver.state.body = "";
  const retried = await relayOnce(db, config);
  assert.equal(retried.status, "ok");
  assert.equal(retried.shipped, 2);
  assert.deepEqual(receiver.ids(), [1, 2, 1, 2], "the same rows are re-sent verbatim after the outage");
  assert.equal(cursorRow(db, config.target).last_message_id, 2);
});

test("a non-JSON error body is reported, not parsed", async (t) => {
  const { db } = room(t);
  const receiver = await mockOtlp(t);
  const config = configFor(receiver);
  seed(db, [{ body: "one" }]);
  receiver.state.status = 502;
  receiver.state.contentType = "text/html";
  receiver.state.body = "<html><body>Bad Gateway</body></html>";
  const result = await relayOnce(db, config);
  assert.equal(result.status, "failed");
  assert.match(result.error, /502/);
  assert.match(result.error, /Bad Gateway/);
  assert.equal(cursorRow(db, config.target).last_message_id, 0);
});

test("an unreachable endpoint fails the pass instead of throwing", async (t) => {
  const { db } = room(t);
  // Port 0 is never listening; a connection attempt is refused immediately.
  const config = relayConfigFromEnv({ SQUAD_RELAY_ENDPOINT: "http://127.0.0.1:1/v1/logs" }, { timeoutMs: 2_000 });
  seed(db, [{ body: "one" }]);
  const result = await relayOnce(db, config);
  assert.equal(result.status, "failed");
  assert.ok(result.error.startsWith("relay: POST"), result.error);
  assert.equal(result.cursor, 0);
  assert.equal(cursorRow(db, config.target).last_message_id, 0);
});

test("OTLP partial success counts the rejected records but still advances", async (t) => {
  const { db } = room(t);
  const receiver = await mockOtlp(t);
  const config = configFor(receiver);
  seed(db, [{ body: "one" }, { body: "two" }]);
  receiver.state.body = JSON.stringify({
    partialSuccess: { rejectedLogRecords: "1", errorMessage: "one record was malformed" },
  });
  const result = await relayOnce(db, config);
  assert.equal(result.status, "ok");
  assert.equal(result.rejected, 1);
  assert.equal(result.shipped, 1);
  assert.equal(
    cursorRow(db, config.target).last_message_id,
    2,
    "a record the collector will never accept must not wedge the outbox",
  );
});

// --- kind filtering ------------------------------------------------------

test("SQUAD_RELAY_KINDS ships only matching kinds and advances past the rest", async (t) => {
  const { db } = room(t);
  const receiver = await mockOtlp(t);
  const config = configFor(receiver, { SQUAD_RELAY_KINDS: "chat" });
  seed(db, [
    { body: "chat one", kind: "chat" },
    { body: "system one", kind: "system" },
    { body: "chat two", kind: "chat" },
  ]);
  const result = await relayOnce(db, config);
  assert.equal(result.status, "ok");
  assert.equal(result.scanned, 3);
  assert.equal(result.shipped, 2);
  assert.deepEqual(receiver.ids(), [1, 3]);
  assert.equal(result.cursor, 3, "the cursor tracks rows considered, not rows sent");
  const second = await relayOnce(db, config);
  assert.equal(second.status, "empty");
  assert.equal(receiver.requests.length, 1);
});

test("a batch filtered out entirely advances the cursor without a request", async (t) => {
  const { db } = room(t);
  const receiver = await mockOtlp(t);
  const config = configFor(receiver, { SQUAD_RELAY_KINDS: "chat" });
  seed(db, [
    { body: "system one", kind: "system" },
    { body: "system two", kind: "system" },
  ]);
  const result = await relayOnce(db, config);
  assert.equal(result.status, "ok");
  assert.equal(result.scanned, 2);
  assert.equal(result.shipped, 0);
  assert.equal(result.batches, 0, "nothing to ship means no POST at all");
  assert.equal(result.cursor, 2, "an all-filtered batch is still consumed, so passes do not re-scan forever");
  assert.equal(receiver.requests.length, 0);
});

// --- lease ---------------------------------------------------------------

test("two concurrent passes do not both ship the same batch", async (t) => {
  const { db } = room(t);
  const receiver = await mockOtlp(t);
  const config = configFor(receiver);
  seed(db, [{ body: "one" }, { body: "two" }]);

  // Hold the receiver's response open so the first pass is still in flight
  // (lease held, cursor not yet advanced) while the second one runs.
  let open;
  receiver.state.gate = new Promise((resolve) => {
    open = resolve;
  });
  const shipping = relayOnce(db, config);
  // Let the first pass reach the in-flight POST.
  while (receiver.requests.length === 0) await new Promise((r) => setTimeout(r, 5));

  const raced = await relayOnce(db, config);
  assert.equal(raced.status, "lease-held");
  assert.equal(raced.shipped, 0);
  assert.equal(raced.batches, 0, "the losing pass must not POST anything");

  open();
  const winner = await shipping;
  assert.equal(winner.status, "ok");
  assert.equal(winner.shipped, 2);
  assert.equal(receiver.requests.length, 1, "exactly one batch reached the collector");
  assert.deepEqual(receiver.ids(), [1, 2], "each message shipped exactly once");
  assert.equal(cursorRow(db, config.target).last_message_id, 2);
});

test("an expired lease is stealable, and the stale holder cannot move the cursor", async (t) => {
  const { db } = room(t);
  const receiver = await mockOtlp(t);
  const config = configFor(receiver);
  seed(db, [{ body: "one" }]);
  // A crashed process's lease: recorded, long expired.
  db.prepare(
    "INSERT INTO relay_cursors (target, last_message_id, updated_at, lease_expires) VALUES (?, 0, NULL, ?)",
  ).run(config.target, Date.now() - 60_000);
  const result = await relayOnce(db, config);
  assert.equal(result.status, "ok", "an expired lease does not block the next pass forever");
  assert.equal(result.shipped, 1);

  // A cursor write fenced by a lease token nobody holds changes nothing.
  const changed = db
    .prepare("UPDATE relay_cursors SET last_message_id=? WHERE target=? AND lease_expires=?")
    .run(99, config.target, Date.now() + 999_999);
  assert.equal(Number(changed.changes), 0);
  assert.equal(cursorRow(db, config.target).last_message_id, 1);
});

test("different endpoints keep independent cursors", async (t) => {
  const { db } = room(t);
  const a = await mockOtlp(t);
  const b = await mockOtlp(t);
  seed(db, [{ body: "one" }]);
  await relayOnce(db, configFor(a));
  const second = await relayOnce(db, configFor(b));
  assert.equal(second.shipped, 1, "a second target back-fills from its own (unset) cursor");
  assert.deepEqual(a.ids(), [1]);
  assert.deepEqual(b.ids(), [1]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM relay_cursors").get().n, 2);
});

// --- credential hygiene --------------------------------------------------

test("SQUAD_RELAY_HEADERS reaches the collector but never the database or an export", async (t) => {
  const { root, dir, db } = room(t);
  const receiver = await mockOtlp(t);
  const SECRET = "signoz-ingestion-key-sentinel-4f2c9";
  const config = configFor(receiver, {
    SQUAD_RELAY_HEADERS: `signoz-ingestion-key=${SECRET}`,
  });
  seed(db, [{ body: "one" }]);
  const result = await relayOnce(db, config);
  assert.equal(result.status, "ok");
  assert.equal(
    receiver.requests[0].headers["signoz-ingestion-key"],
    SECRET,
    "the header is actually sent -- otherwise this test would pass vacuously",
  );

  const squad = new Squad(db, "claude");
  const exported = join(root, "export.db");
  await squad.exportRoom(exported);
  db.close();

  // Every byte squad wrote for this room, plus the export: the credential must
  // appear in none of them (WAL/shm sidecars included -- a secret checkpointed
  // out of the WAL later is no less persisted).
  const written = [
    ...readdirSync(dir).map((f) => join(dir, f)),
    exported,
  ];
  assert.ok(written.some((f) => f.endsWith("squad.db")), "the room database was written");
  for (const file of written) {
    assert.ok(
      !readFileSync(file).includes(SECRET),
      `${file} must not contain the relay credential`,
    );
  }
  // The cursor row that *is* persisted names only the endpoint.
  const reopened = openDb();
  t.after(() => reopened.close());
  assert.equal(cursorRow(reopened, config.target).target, config.target);
});

test("the installer never writes a relay credential into a consumer repo", () => {
  // SQUAD_RELAY_HEADERS is read from process.env on every relay pass and held
  // only in memory. install.sh / install-lifecycle.mjs write an explicit
  // allowlist of env keys into .mcp.json; a relay key must never be added to
  // it, so assert the installer surface does not mention the variable at all.
  for (const file of ["../install.sh", "../scripts/install-lifecycle.mjs", "../hooks/squad-mcp.mjs"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.ok(
      !source.includes("SQUAD_RELAY"),
      `${file} must not reference any SQUAD_RELAY_* variable`,
    );
  }
  // ...and the engine is the only module that reads the header variable, so a
  // future persistence path cannot pick it up implicitly somewhere else.
  // (src/cli.ts may *name* it in its help text (#113) -- it just never reads it.)
  const relay = readFileSync(new URL("../src/relay.ts", import.meta.url), "utf8");
  assert.ok(relay.includes("SQUAD_RELAY_HEADERS"), "the engine is what reads the header variable");
  for (const other of ["../src/core.ts", "../src/db.ts", "../src/mcp.ts"]) {
    assert.ok(
      !readFileSync(new URL(other, import.meta.url), "utf8").includes("SQUAD_RELAY_HEADERS"),
      `${other} must not read the relay credential`,
    );
  }
  // src/cli.ts may only name it inside the HELP template literal: strip that
  // literal, then the variable must not appear at all -- this catches any read
  // form (process.env.X, env?.X, env["X"], destructuring, ...).
  const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  const helpLiteral = /const HELP = `[^`]*`;/;
  assert.match(cli, helpLiteral, "src/cli.ts still defines HELP as a single template literal");
  assert.ok(cli.match(helpLiteral)[0].includes("SQUAD_RELAY_HEADERS"), "the help text names the variable");
  assert.ok(
    !cli.replace(helpLiteral, "").includes("SQUAD_RELAY_HEADERS"),
    "src/cli.ts must not read the relay credential from the environment",
  );
});
