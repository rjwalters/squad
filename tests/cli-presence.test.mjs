import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Drives the CLI as a subprocess against dist/index.js (same harness pattern
// as tests/cli-card.test.mjs) to cover the human-facing half of the presence
// leases from issue #38: `squad who` reporting active/idle/stale, and
// `squad leave` ending a persona's lease from a terminal.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(repoRoot, "dist", "index.js");

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [entry, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function freshDir() {
  return mkdtempSync(join(tmpdir(), "squad-cli-presence-"));
}

test("squad who reports presence state, and squad leave removes it", () => {
  const dir = freshDir();
  try {
    // An empty room has nobody in it — `who` never invents presence.
    assert.match(runCli(["who"], { SQUAD_DIR: dir }).stdout, /nobody in the room/);

    // Any operation opens a lease for the acting persona.
    runCli(["send", "hello"], { SQUAD_DIR: dir, SQUAD_PERSONA: "codex" });
    const who = runCli(["who"], { SQUAD_DIR: dir });
    assert.match(who.stdout, /^codex\tactive\tlast seen /m);

    const left = runCli(["leave"], { SQUAD_DIR: dir, SQUAD_PERSONA: "codex" });
    assert.equal(left.status, 0, left.stdout + left.stderr);
    assert.match(left.stdout, /codex left the room/);
    assert.match(runCli(["who"], { SQUAD_DIR: dir }).stdout, /nobody in the room/);

    // The departure is in the chat log, so a peer sees it on their next check.
    assert.match(runCli(["read"], { SQUAD_DIR: dir }).stdout, /codex left the room/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("squad leave is a no-op for a persona that is not in the room", () => {
  const dir = freshDir();
  try {
    const res = runCli(["leave"], { SQUAD_DIR: dir, SQUAD_PERSONA: "ghost" });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /ghost is not in the room/);
    assert.equal(runCli(["read"], { SQUAD_DIR: dir }).stdout.trim(), "", "no announcement");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("squad --help documents leave and the idle/stale presence knobs", () => {
  const res = runCli(["--help"]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /squad leave/);
  assert.match(res.stdout, /active\/idle\/\n?\s*stale/);
  assert.match(res.stdout, /SQUAD_IDLE_MINUTES/);
});

test("a stale peer is visible as stale to a human at the terminal", () => {
  const dir = freshDir();
  try {
    // A zero-length lease: it is already expired by the time we look. The
    // lease is stamped when the persona acts, so the env var belongs there.
    runCli(["send", "working"], {
      SQUAD_DIR: dir,
      SQUAD_PERSONA: "claude",
      SQUAD_STALE_MINUTES: "0",
    });
    const who = runCli(["who"], { SQUAD_DIR: dir });
    assert.match(who.stdout, /^claude\tstale\t/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
