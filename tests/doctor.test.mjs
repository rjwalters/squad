import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

// This suite exercises the CLI as a subprocess (not via dynamic import),
// because the whole point is to observe behavior across process boundaries
// the way an MCP host or a human terminal actually would.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(repoRoot, "dist");
const entry = join(distDir, "index.js");

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

// Every ancestor of `dir` (inclusive) that contains a node_modules. Node
// resolves a bare specifier by walking *up* from the importing module's own
// directory, so "dependencies are not installed" only holds when the whole
// ancestor chain is free of node_modules — not just the nearest one.
function ancestorsWithNodeModules(dir) {
  const found = [];
  for (let d = dir; ; ) {
    if (existsSync(join(d, "node_modules"))) found.push(d);
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return found;
}

// The following tests simulate the exact failure mode from the bug report:
// dist/ present and built, but node_modules missing (e.g. after a host reboot
// wiped it). They run a copy of dist/ from a scratch directory outside the
// repo, where nothing in the ancestor chain can satisfy a bare import.
//
// The obvious alternative — renaming <repoRoot>/node_modules out of the way —
// is wrong whenever repoRoot is a linked git worktree nested inside its
// primary clone (Loom's `.loom/worktrees/issue-N` topology, which is what the
// fleet builds every issue in). Resolution just walks past the hidden
// directory and finds the primary clone's node_modules two levels up, so the
// CLI started fine and both tests false-negatived (issue #101). Copying dist/
// out of the repo also means the suite never mutates a developer's
// node_modules, so an interrupted run can no longer leave it renamed.
function withoutDependencies(fn) {
  const sandbox = mkdtempSync(join(tmpdir(), "squad-nodeps-"));
  try {
    const distCopy = join(sandbox, "dist");
    cpSync(distDir, distCopy, { recursive: true });

    // Fail loudly instead of silently asserting nothing: if the sandbox can
    // see any node_modules, the imports below would resolve and these tests
    // would be exercising a fully-installed CLI. This is the guard whose
    // absence made #101 invisible.
    const visible = ancestorsWithNodeModules(distCopy);
    assert.deepEqual(
      visible,
      [],
      `missing-dependency sandbox ${distCopy} is not dependency-free — ` +
        `node_modules visible in: ${visible.join(", ")}`,
    );

    const runIsolated = (args, env = {}) =>
      spawnSync(process.execPath, [join(distCopy, "index.js"), ...args], {
        cwd: sandbox,
        encoding: "utf8",
        env: { ...process.env, ...env },
      });
    return fn(runIsolated);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

test("CLI degrades gracefully without node_modules: doctor reports the failure instead of crashing", () => {
  withoutDependencies((runIsolated) => {
    const dir = mkdtempSync(join(tmpdir(), "squad-doctor-"));
    try {
      const res = runIsolated(["doctor"], { SQUAD_DIR: dir });
      assert.equal(res.status, 1, res.stdout + res.stderr);
      assert.match(res.stdout, /\[FAIL\] dependencies:.*Cannot find package/);
      assert.match(res.stdout, /pnpm install/);
      // The unrelated checks still run and still pass.
      assert.match(res.stdout, /\[ok\] database:/);
      assert.match(res.stdout, /\[ok\] persona:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("CLI degrades gracefully without node_modules: --help still works (no eager SDK import)", () => {
  withoutDependencies((runIsolated) => {
    const res = runIsolated(["--help"]);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /squad — local cross-agent chat room/);
  });
});

test("CLI degrades gracefully without node_modules: MCP startup fails loudly and leaves a room breadcrumb", () => {
  withoutDependencies((runIsolated) => {
    const dir = mkdtempSync(join(tmpdir(), "squad-doctor-"));
    try {
      // No subcommand + non-TTY stdin is exactly how an MCP host launches
      // the server; spawnSync's stdio defaults to a pipe, so this is a
      // faithful reproduction.
      const res = runIsolated([], { SQUAD_DIR: dir, SQUAD_PERSONA: "claude" });
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
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("squad --help works normally (sanity check with node_modules present)", () => {
  const res = runCli(["--help"]);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /squad doctor/);
});
