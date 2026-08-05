import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

// This suite exercises repo-root resolution, so SQUAD_DIR must be unset.
delete process.env.SQUAD_DIR;

const { squadDir, findRepoRoot } = await import("../dist/db.js");

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "squad-dir-")));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

test("SQUAD_DIR env overrides everything", () => {
  process.env.SQUAD_DIR = "/x/y/z";
  assert.equal(squadDir(), "/x/y/z");
  delete process.env.SQUAD_DIR;
});

test("resolves to <repo-root>/.squad from a nested cwd", () => {
  const repo = join(scratch, "myrepo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "src", "deep"), { recursive: true });
  const prev = process.cwd();
  try {
    process.chdir(join(repo, "src", "deep"));
    assert.equal(squadDir(), join(repo, ".squad"));
  } finally {
    process.chdir(prev);
  }
});

test("an existing .squad dir marks the root even without .git", () => {
  const repo = join(scratch, "bare");
  mkdirSync(join(repo, ".squad"), { recursive: true });
  mkdirSync(join(repo, "sub"), { recursive: true });
  assert.equal(findRepoRoot(join(repo, "sub")), repo);
});

test("falls back to ~/.squad outside any repo", () => {
  const lone = join(scratch, "nowhere", "at", "all");
  mkdirSync(lone, { recursive: true });
  const prev = process.cwd();
  try {
    process.chdir(lone);
    // scratch/tmpdir trees have no .git/.squad/.mcp.json ancestors in CI,
    // but a developer machine might (e.g. a repo above tmp). Accept either
    // the home fallback or a genuinely-found ancestor root.
    const dir = squadDir();
    const root = findRepoRoot(lone);
    assert.equal(dir, root ? join(root, ".squad") : join(homedir(), ".squad"));
  } finally {
    process.chdir(prev);
  }
});
