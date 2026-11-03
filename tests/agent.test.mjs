import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "dist", "index.js");
const { getAdapter, registeredRuntimes, agentUsage } = await import("../dist/agent.js");

const run = (args) =>
  spawnSync(process.execPath, [entry, ...args], { encoding: "utf8", cwd: root });

test("registry lists codex and resolves case-insensitively", () => {
  assert.deepEqual(registeredRuntimes(), ["codex"]);
  assert.equal(getAdapter("CODEX")?.runtime, "codex");
  assert.equal(getAdapter("claude"), undefined);
  assert.match(agentUsage(), /registered runtimes: codex/);
});

test("codex adapter builds the same argv as buildCodexArgs", () => {
  const a = getAdapter("codex");
  assert.deepEqual(a.launch("hi", ["--x"]), ["exec", "--x", "hi"]);
  assert.deepEqual(a.resume("hi", ["--x"]), ["exec", "resume", "--last", "--x", "hi"]);
});

test("squad agent with no runtime exits 1 and lists runtimes", () => {
  const r = run(["agent"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /registered runtimes: codex/);
});

test("squad agent with an unregistered runtime exits 1 without launching", () => {
  const r = run(["agent", "claude"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no adapter for runtime 'claude'/);
});

test("squad agent --help and agent codex --help print usage; alias help matches", () => {
  assert.equal(run(["agent", "--help"]).status, 0);
  const a = run(["agent", "codex", "--help"]);
  const b = run(["codex-reentry", "--help"]);
  assert.equal(a.status, 0);
  assert.equal(a.stdout, b.stdout);
  assert.match(a.stdout, /usage: squad codex-reentry/);
});
