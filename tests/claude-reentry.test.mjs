import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "dist", "index.js");
const driver = await import("../dist/claude-reentry-driver.js");
const { getAdapter } = await import("../dist/agent.js");
const { openDb } = await import("../dist/db.js");
const { getWakeHandle } = await import("../dist/wake-handles.js");
const { isCleanPark } = await import("../dist/codex-reentry.js");

const SID = "11111111-2222-3333-4444-555555555555";
const ok = JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: SID, result: "parked" });
const apiError = JSON.stringify({
  type: "result", subtype: "success", is_error: true, terminal_reason: "api_error", session_id: SID,
});

test("squad agent claude --help prints usage", () => {
  const r = spawnSync(process.execPath, [entry, "agent", "claude", "--help"], { encoding: "utf8", cwd: root });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /usage: squad agent claude/);
});

test("fresh and resume argv", () => {
  assert.deepEqual(driver.buildClaudeArgs({ mode: "fresh", prompt: "hi", extraArgs: ["--x"] }), [
    "-p", "hi", "--output-format", "json", "--x",
  ]);
  assert.deepEqual(driver.buildClaudeArgs({ mode: "resume", prompt: "hi", sessionId: SID, extraArgs: ["--x"] }), [
    "--resume", SID, "-p", "hi", "--output-format", "json", "--x",
  ]);
  // No recorded id: never resume a guessed session; fall back to a fresh launch.
  assert.deepEqual(driver.buildClaudeArgs({ mode: "resume", prompt: "hi", sessionId: null }), [
    "-p", "hi", "--output-format", "json",
  ]);
});

test("parseClaudeResult maps results onto outcomes and reads the session id", () => {
  assert.deepEqual(driver.parseClaudeResult(ok), { outcome: "task_complete", sessionId: SID });
  assert.deepEqual(driver.parseClaudeResult(apiError), { outcome: "error", sessionId: SID });
  const errSub = JSON.stringify({ type: "result", subtype: "error_max_turns", session_id: SID });
  assert.equal(driver.parseClaudeResult(errSub).outcome, "error");
  assert.equal(driver.parseClaudeResult(`[{"type":"system"},${ok}]`).outcome, "task_complete");
  assert.deepEqual(driver.parseClaudeResult("not json"), { outcome: "missing", sessionId: null });
  assert.deepEqual(driver.parseClaudeResult(""), { outcome: "missing", sessionId: null });
  assert.deepEqual(driver.parseClaudeResult('{"type":"other"}'), { outcome: "unknown", sessionId: null });
  // Error is a failure (backoff) even with exit 0; a clean result parks.
  assert.equal(isCleanPark("error", 0), false);
  assert.equal(isCleanPark("task_complete", 0), true);
});

test("adapter: run captures the session, records the wake handle, resume uses the real id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "squad-claude-"));
  const prevDir = process.env.SQUAD_DIR;
  process.env.SQUAD_DIR = dir;
  const shim = join(dir, "claude");
  const out = join(dir, "out.json");
  writeFileSync(
    shim,
    `#!/bin/sh\nif [ "$1" = "--help" ]; then echo "  -r, --resume [value]"; exit 0; fi\ncat "${out}"\n`,
  );
  chmodSync(shim, 0o755);
  const adapter = getAdapter("claude");
  const silence = process.stdout.write.bind(process.stdout);
  try {
    assert.equal(await adapter.supportsResume(shim), true);
    assert.equal(await adapter.supportsResume(join(dir, "missing")), false);

    // Unreadable output: nothing recorded, resume degrades to fresh.
    driver.resetClaudeAdapterState();
    writeFileSync(out, "garbage");
    process.stdout.write = () => true;
    assert.equal(await adapter.run(shim, adapter.launch("p", [])), 0);
    process.stdout.write = silence;
    adapter.recordWakeHandle("persona-c", Date.now());
    assert.equal(await adapter.detectTurnEnd(0), "missing");
    assert.equal(adapter.resume("again", [])[0], "-p");
    let db = openDb();
    assert.equal(getWakeHandle(db, "persona-c"), null);
    db.close();

    // Real result: handle recorded with runtime claude and the real id.
    writeFileSync(out, ok);
    process.stdout.write = () => true;
    assert.equal(await adapter.run(shim, adapter.launch("p", [])), 0);
    process.stdout.write = silence;
    assert.equal(await adapter.detectTurnEnd(0), "task_complete");
    adapter.recordWakeHandle("persona-c", Date.now());
    db = openDb();
    const h = getWakeHandle(db, "persona-c");
    db.close();
    assert.equal(h?.runtime, "claude");
    assert.equal(h?.session_ref, SID);
    assert.deepEqual(adapter.resume("again", []).slice(0, 4), ["--resume", SID, "-p", "again"]);

    // api_error result classifies as a failure.
    writeFileSync(out, apiError);
    process.stdout.write = () => true;
    await adapter.run(shim, adapter.launch("p", []));
    process.stdout.write = silence;
    assert.equal(await adapter.detectTurnEnd(0), "error");
  } finally {
    process.stdout.write = silence;
    if (prevDir === undefined) delete process.env.SQUAD_DIR;
    else process.env.SQUAD_DIR = prevDir;
    rmSync(dir, { recursive: true, force: true });
  }
});
