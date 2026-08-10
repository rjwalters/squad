import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

// This suite exercises repo-root resolution, so SQUAD_DIR must be unset.
delete process.env.SQUAD_DIR;

const { squadDir, findRepoRoot, mainWorktreeRoot, roomSplitWarning } =
  await import("../dist/db.js");

/** Run git in `cwd`, or return null when git is unavailable/fails. */
function git(cwd, ...args) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

const hasGit = git(tmpdir(), "--version") !== null;

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

test("a git worktree resolves to the primary clone's room", { skip: !hasGit }, () => {
  const repo = join(scratch, "wt-main");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  const wt = join(scratch, "wt-linked");
  assert.notEqual(git(repo, "worktree", "add", "-q", "-b", "linked", wt), null);

  const prev = process.cwd();
  try {
    // The primary clone's room is the baseline both runtimes must agree on.
    process.chdir(repo);
    const primaryRoom = squadDir();
    assert.equal(primaryRoom, join(repo, ".squad"));

    // Same room from the worktree root...
    process.chdir(wt);
    assert.equal(squadDir(), primaryRoom);
    assert.equal(findRepoRoot(wt), repo);

    // ...and from a nested cwd inside the worktree.
    mkdirSync(join(wt, "src", "deep"), { recursive: true });
    process.chdir(join(wt, "src", "deep"));
    assert.equal(squadDir(), primaryRoom);
  } finally {
    process.chdir(prev);
  }
});

test("SQUAD_DIR still wins inside a worktree", { skip: !hasGit }, () => {
  const repo = join(scratch, "wt-env-main");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  const wt = join(scratch, "wt-env-linked");
  assert.notEqual(git(repo, "worktree", "add", "-q", "-b", "env-linked", wt), null);

  const prev = process.cwd();
  try {
    process.chdir(wt);
    process.env.SQUAD_DIR = "/x/y/z";
    assert.equal(squadDir(), "/x/y/z");
  } finally {
    delete process.env.SQUAD_DIR;
    process.chdir(prev);
  }
});

test("falls back to the cwd walk when git is unavailable", () => {
  // Synthetic worktree: .git is a `gitdir:` pointer file, as git writes it.
  const repo = join(scratch, "nogit-main");
  const wt = join(scratch, "nogit-linked");
  mkdirSync(join(repo, ".git", "worktrees", "linked"), { recursive: true });
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "linked")}\n`);

  const prevPath = process.env.PATH;
  try {
    process.env.PATH = join(scratch, "no-such-bin");
    // Must not throw; degrades to today's cwd walk (the worktree's own root).
    assert.equal(findRepoRoot(wt), wt);
  } finally {
    process.env.PATH = prevPath;
  }
});

test("warns when an empty worktree room shadows the primary clone's", { skip: !hasGit }, () => {
  const repo = join(scratch, "warn-main");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  const wt = join(scratch, "warn-linked");
  assert.notEqual(git(repo, "worktree", "add", "-q", "-b", "warn-linked", wt), null);

  // The primary clone has a live room; the worktree carries its own empty one
  // (e.g. left behind by a pre-fix run), so the walk stops there.
  mkdirSync(join(repo, ".squad"), { recursive: true });
  writeFileSync(join(repo, ".squad", "squad.db"), "");
  mkdirSync(join(wt, ".squad"), { recursive: true });

  assert.equal(findRepoRoot(wt), wt);
  const warning = roomSplitWarning(join(wt, ".squad"), wt);
  assert.match(warning ?? "", /empty room/);
  assert.match(warning ?? "", new RegExp(`SQUAD_DIR=${join(repo, ".squad")}`));

  // No warning once the resolved room is the primary clone's.
  assert.equal(roomSplitWarning(join(repo, ".squad"), wt), null);
  // ...nor from the primary clone itself.
  assert.equal(roomSplitWarning(join(repo, ".squad"), repo), null);
});

test("mainWorktreeRoot ignores non-worktree git dirs", { skip: !hasGit }, () => {
  const bare = join(scratch, "bare-repo.git");
  mkdirSync(bare, { recursive: true });
  git(bare, "init", "-q", "--bare");
  // A bare repo has no working tree, so there is no room root to resolve.
  assert.equal(mainWorktreeRoot(bare), null);
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
