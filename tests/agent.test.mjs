import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "dist", "index.js");
const { getAdapter, registeredRuntimes, agentUsage } = await import("../dist/agent.js");
const { openDb } = await import("../dist/db.js");
const { Squad } = await import("../dist/core.js");

const run = (args) =>
  spawnSync(process.execPath, [entry, ...args], { encoding: "utf8", cwd: root });

test("registry lists codex, claude and opencode and resolves case-insensitively", () => {
  assert.deepEqual(registeredRuntimes(), ["codex", "claude", "opencode"]);
  assert.equal(getAdapter("CODEX")?.runtime, "codex");
  assert.equal(getAdapter("Claude")?.runtime, "claude");
  assert.equal(getAdapter("OpenCode")?.runtime, "opencode");
  assert.match(agentUsage(), /registered runtimes: codex, claude, opencode/);
});

test("codex adapter builds the same argv as buildCodexArgs", () => {
  const a = getAdapter("codex");
  assert.deepEqual(a.launch("hi", ["--x"]), ["exec", "--x", "hi"]);
  assert.deepEqual(a.resume("hi", ["--x"]), ["exec", "resume", "--last", "--x", "hi"]);
});

test("opencode adapter builds run argv; resume is unsupported without a session id", async () => {
  const a = getAdapter("OpenCode");
  assert.equal(a.runtime, "opencode");
  assert.deepEqual(a.launch("hi", ["--x"]), ["run", "--x", "hi"]);
  const { buildOpencodeArgs, parseOpencodeAgentArgs } = await import("../dist/opencode-agent.js");
  assert.deepEqual(
    buildOpencodeArgs({ mode: "resume", sessionId: "ses_1", prompt: "hi", extraArgs: ["--x"] }),
    ["run", "--session", "ses_1", "--x", "hi"],
  );
  assert.equal(await a.supportsResume("opencode"), false);
  assert.equal(await a.detectTurnEnd(0), "unknown");
  assert.equal(a.recordWakeHandle, undefined);
  const o = parseOpencodeAgentArgs(["--persona", "p", "--opencode", "/x/oc", "--", "-m", "foo"]);
  assert.equal(o.persona, "p");
  assert.equal(o.bin, "/x/oc");
  assert.deepEqual(o.extraArgs, ["-m", "foo"]);
  assert.throws(() => parseOpencodeAgentArgs(["--bogus"]), /unrecognized flag/);
});

test("squad agent with no runtime exits 1 and lists runtimes", () => {
  const r = run(["agent"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /registered runtimes: codex, claude, opencode/);
});

test("squad agent with an unregistered runtime exits 1 without launching", () => {
  const r = run(["agent", "gemini"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no adapter for runtime 'gemini'/);
});

test("squad agent --help and agent codex --help print usage; alias help matches", () => {
  assert.equal(run(["agent", "--help"]).status, 0);
  const a = run(["agent", "codex", "--help"]);
  const b = run(["codex-reentry", "--help"]);
  assert.equal(a.status, 0);
  assert.equal(a.stdout, b.stdout);
  assert.match(a.stdout, /usage: squad codex-reentry/);
});

// runAgent's supervisor waits out the minimum run interval and then a failure
// backoff window in real time (it builds its own clock), so this drives the real
// `squad agent codex` path in a child and kills it once the failure window is
// persisted -- everything the assertions need is on disk by then.
test("missing binary: 'not woken' lands in the room and the run counts as a backoff failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "squad-agent-enoent-"));
  const bin = join(dir, "no-such-codex");
  const persona = "enoent-agent";
  const stateFile = join(dir, "reentry", `${persona}.json`);
  const readState = () => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : null);
  const child = spawn(
    process.execPath,
    [entry, "agent", "codex", "--persona", persona, "--codex", bin, "--no-resume", "--ttl-minutes", "60"],
    { cwd: root, env: { ...process.env, SQUAD_DIR: dir, SQUAD_PERSONA: persona }, stdio: "ignore" },
  );
  try {
    const deadline = Date.now() + 60_000;
    let state = null;
    while (Date.now() < deadline) {
      state = readState();
      if (state?.windowKind === "failure") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(state?.windowKind, "failure", `no failure backoff window persisted: ${JSON.stringify(state)}`);
    // Backoff window, not the minimum run interval: the null exit code is a crash.
    assert.ok(Date.parse(state.nextFireAt) > Date.now(), JSON.stringify(state));

    const prev = process.env.SQUAD_DIR;
    process.env.SQUAD_DIR = dir;
    const db = openDb();
    try {
      const bodies = new Squad(db, "observer").read(50).filter((m) => m.kind === "system").map((m) => m.body);
      assert.ok(
        bodies.includes(`not woken: ${persona} -- ${bin} not found`),
        `missing 'not woken' line in: ${JSON.stringify(bodies)}`,
      );
      assert.ok(bodies.some((b) => /not a clean park/.test(b)), JSON.stringify(bodies));
    } finally {
      db.close();
      if (prev === undefined) delete process.env.SQUAD_DIR;
      else process.env.SQUAD_DIR = prev;
    }
  } finally {
    child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opencode missing binary: 'not woken' lands in the room and the run counts as a backoff failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "squad-agent-oc-enoent-"));
  const bin = join(dir, "no-such-opencode");
  const persona = "enoent-opencode";
  const stateFile = join(dir, "reentry", `${persona}.json`);
  const readState = () => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : null);
  const child = spawn(
    process.execPath,
    [entry, "agent", "opencode", "--persona", persona, "--opencode", bin, "--no-resume", "--ttl-minutes", "60"],
    { cwd: root, env: { ...process.env, SQUAD_DIR: dir, SQUAD_PERSONA: persona }, stdio: "ignore" },
  );
  try {
    const deadline = Date.now() + 60_000;
    let state = null;
    while (Date.now() < deadline) {
      state = readState();
      if (state?.windowKind === "failure") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(state?.windowKind, "failure", `no failure backoff window persisted: ${JSON.stringify(state)}`);
    // Backoff window, not the minimum run interval: the null exit code is a crash.
    assert.ok(Date.parse(state.nextFireAt) > Date.now(), JSON.stringify(state));

    const prev = process.env.SQUAD_DIR;
    process.env.SQUAD_DIR = dir;
    const db = openDb();
    try {
      const bodies = new Squad(db, "observer").read(50).filter((m) => m.kind === "system").map((m) => m.body);
      assert.ok(
        bodies.includes(`not woken: ${persona} -- ${bin} not found`),
        `missing 'not woken' line in: ${JSON.stringify(bodies)}`,
      );
      assert.ok(bodies.some((b) => /not a clean park/.test(b)), JSON.stringify(bodies));
    } finally {
      db.close();
      if (prev === undefined) delete process.env.SQUAD_DIR;
      else process.env.SQUAD_DIR = prev;
    }
  } finally {
    child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
