import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, renameSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

// This suite exercises the CLI as a subprocess (not via dynamic import),
// because the whole point is to observe behavior across process boundaries
// the way an MCP host or a human terminal actually would.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(repoRoot, "dist", "index.js");

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [entry, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("squad doctor passes when dependencies, database, and persona all resolve", () => {
  const dir = mkdtempSync(join(tmpdir(), "squad-doctor-"));
  try {
    const res = runCli(["doctor"], { SQUAD_DIR: dir });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /\[ok\] dependencies:/);
    assert.match(res.stdout, /\[ok\] database:/);
    assert.match(res.stdout, /\[ok\] persona:/);
    assert.match(res.stdout, /all checks passed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("squad doctor reports a pinned persona", () => {
  const dir = mkdtempSync(join(tmpdir(), "squad-doctor-"));
  try {
    const res = runCli(["doctor"], { SQUAD_DIR: dir, SQUAD_PERSONA: "codex" });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /pinned via SQUAD_PERSONA='codex'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The following tests simulate the exact failure mode from the bug report:
// dist/ present and built, but node_modules missing (e.g. after a host
// reboot wiped it). They temporarily rename node_modules out of the way, so
// they run in one serial test file and always restore it, even on failure.
const nodeModules = join(repoRoot, "node_modules");
const hasNodeModules = existsSync(nodeModules);

test(
  "CLI degrades gracefully without node_modules: doctor reports the failure instead of crashing",
  { skip: !hasNodeModules },
  () => {
    const hidden = join(repoRoot, "node_modules.doctor-test-hidden");
    renameSync(nodeModules, hidden);
    try {
      const res = runCli(["doctor"], {
        SQUAD_DIR: mkdtempSync(join(tmpdir(), "squad-doctor-")),
      });
      assert.equal(res.status, 1, res.stdout + res.stderr);
      assert.match(res.stdout, /\[FAIL\] dependencies:.*Cannot find package/);
      assert.match(res.stdout, /pnpm install/);
      // The unrelated checks still run and still pass.
      assert.match(res.stdout, /\[ok\] database:/);
      assert.match(res.stdout, /\[ok\] persona:/);
    } finally {
      renameSync(hidden, nodeModules);
    }
  },
);

test(
  "CLI degrades gracefully without node_modules: --help still works (no eager SDK import)",
  { skip: !hasNodeModules },
  () => {
    const hidden = join(repoRoot, "node_modules.doctor-test-hidden");
    renameSync(nodeModules, hidden);
    try {
      const res = runCli(["--help"]);
      assert.equal(res.status, 0, res.stdout + res.stderr);
      assert.match(res.stdout, /squad — local cross-agent chat room/);
    } finally {
      renameSync(hidden, nodeModules);
    }
  },
);

test(
  "CLI degrades gracefully without node_modules: MCP startup fails loudly and leaves a room breadcrumb",
  { skip: !hasNodeModules },
  () => {
    const hidden = join(repoRoot, "node_modules.doctor-test-hidden");
    renameSync(nodeModules, hidden);
    const dir = mkdtempSync(join(tmpdir(), "squad-doctor-"));
    try {
      // No subcommand + non-TTY stdin is exactly how an MCP host launches
      // the server; spawnSync's stdio defaults to a pipe, so this is a
      // faithful reproduction.
      const res = runCli([], { SQUAD_DIR: dir, SQUAD_PERSONA: "claude" });
      assert.notEqual(res.status, 0, res.stdout + res.stderr);
      assert.match(res.stderr, /MCP server failed to start/);
      assert.match(res.stderr, /squad doctor/);
      assert.match(res.stderr, /left a diagnostic message in the room/);

      const db = new DatabaseSync(join(dir, "squad.db"));
      const rows = db.prepare("SELECT * FROM messages").all();
      db.close();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].kind, "system");
      assert.match(rows[0].body, /squad MCP server failed to start on this host/);
      assert.match(rows[0].body, /pnpm install/);
    } finally {
      renameSync(hidden, nodeModules);
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("squad --help works normally (sanity check with node_modules present)", () => {
  const res = runCli(["--help"]);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /squad doctor/);
});
