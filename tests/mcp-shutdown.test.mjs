import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const entry = resolve("dist/index.js");

function start(room) {
  const env = { ...process.env, SQUAD_DIR: room, SQUAD_PERSONA: "shut-a" };
  const child = spawn(process.execPath, [entry], { env, stdio: ["pipe", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const exited = new Promise((res) => child.on("exit", (code, sig) => res({ code, sig })));
  const banner = async () => {
    for (let i = 0; i < 100 && !err.includes("running on stdio"); i++) await new Promise((r) => setTimeout(r, 50));
    assert.match(err, /running on stdio/);
  };
  return { child, exited, banner };
}

function rpc(child, id, method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
}

async function touch(child) {
  rpc(child, 1, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "t", version: "1" },
  });
  await new Promise((r) => setTimeout(r, 300));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  rpc(child, 2, "tools/call", { name: "squad_join", arguments: {} });
  await new Promise((r) => setTimeout(r, 700));
}

function check(room, { session }) {
  const db = new DatabaseSync(join(room, "squad.db"));
  try {
    if (session) {
      const rows = db.prepare("SELECT left_ts FROM sessions WHERE persona = 'shut-a'").all();
      assert.ok(rows.length >= 1);
      for (const r of rows) assert.ok(r.left_ts, "session marked left");
    }
    assert.equal(db.prepare("SELECT count(*) AS n FROM mcp_holders").get().n, 0);
  } finally {
    db.close();
  }
  const wal = join(room, "squad.db-wal");
  assert.ok(!existsSync(wal) || statSync(wal).size === 0, "wal checkpointed");
}

const cases = [
  ["stdin EOF", (c) => c.stdin.end()],
  ["SIGTERM", (c) => c.kill("SIGTERM")],
  ["SIGINT", (c) => c.kill("SIGINT")],
  ["SIGHUP", (c) => c.kill("SIGHUP")],
];

for (const [name, trigger] of cases) {
  test(`shutdown on ${name}: leaves session, checkpoints, exits 0`, async () => {
    const room = mkdtempSync(join(tmpdir(), "squad-shutdown-"));
    try {
      const s = start(room);
      await s.banner();
      await touch(s.child);
      const who = spawnSync(process.execPath, [entry, "who"], { env: { ...process.env, SQUAD_DIR: room }, encoding: "utf8" });
      assert.match(who.stdout, new RegExp(`pid ${s.child.pid}\\b`));
      trigger(s.child);
      if (name !== "stdin EOF") trigger(s.child); // second signal is harmless
      const { code } = await s.exited;
      assert.equal(code, 0);
      check(room, { session: true });
    } finally {
      rmSync(room, { recursive: true, force: true });
    }
  });
}

test("never-touched server shuts down without ending another session of the persona", async () => {
  const room = mkdtempSync(join(tmpdir(), "squad-shutdown-"));
  try {
    const a = start(room);
    await a.banner();
    await touch(a.child);
    const b = start(room);
    await b.banner();
    b.child.kill("SIGTERM");
    assert.equal((await b.exited).code, 0);
    const db = new DatabaseSync(join(room, "squad.db"));
    const live = db.prepare("SELECT count(*) AS n FROM sessions WHERE persona = 'shut-a' AND left_ts IS NULL").get().n;
    const holders = db.prepare("SELECT pid FROM mcp_holders").all().map((r) => r.pid);
    db.close();
    assert.equal(live, 1);
    assert.deepEqual(holders, [a.child.pid]);
    a.child.stdin.end();
    await a.exited;
  } finally {
    rmSync(room, { recursive: true, force: true });
  }
});

test("banner still emitted when stdin is already closed", () => {
  const room = mkdtempSync(join(tmpdir(), "squad-shutdown-"));
  try {
    const r = spawnSync(process.execPath, [entry], {
      env: { ...process.env, SQUAD_DIR: room },
      input: "",
      encoding: "utf8",
      timeout: 5000,
    });
    assert.match(r.stderr, /running on stdio/);
    assert.equal(r.status, 0);
  } finally {
    rmSync(room, { recursive: true, force: true });
  }
});

test("who output is unchanged with no holders; dead holder pids are pruned", () => {
  const room = mkdtempSync(join(tmpdir(), "squad-shutdown-"));
  try {
    const env = { ...process.env, SQUAD_DIR: room };
    const run = () => spawnSync(process.execPath, [entry, "who"], { env, encoding: "utf8" }).stdout;
    assert.equal(run(), "nobody in the room\n");
    const db = new DatabaseSync(join(room, "squad.db"));
    db.prepare("INSERT INTO mcp_holders (host, pid, started_at) VALUES (?, 99999999, 'x')").run(
      spawnSync("hostname", { encoding: "utf8" }).stdout.trim() || "h",
    );
    db.close();
    assert.equal(run(), "nobody in the room\n");
  } finally {
    rmSync(room, { recursive: true, force: true });
  }
});
