import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// `squad heal` (#132): rooms created before #111's fix only healed when squad
// ran in that checkout again. Heal reaches dormant rooms without opening them:
// it never calls openDb(), never joins, and never creates a room.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(repoRoot, "dist", "index.js");

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

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "squad heal-"))); // note the space
test.after(() => rmSync(scratch, { recursive: true, force: true }));

function runHeal(args, { cwd } = {}) {
  const env = { ...process.env };
  for (const key of ["SQUAD_DIR", "SQUAD_PERSONA", "SQUAD_SESSION_ID"]) delete env[key];
  // An unrelated working directory: heal must not depend on (or touch) cwd.
  const workdir = cwd ?? mkdtempSync(join(scratch, "cwd-"));
  const res = spawnSync(process.execPath, [entry, "heal", ...args], {
    cwd: workdir,
    encoding: "utf8",
    env,
    timeout: 30_000,
  });
  return { ...res, workdir };
}

/** A real git repo with one empty commit, so `git status` is meaningful. */
function repo(parent, name) {
  const root = join(parent, name);
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  return root;
}

/** A pre-#111 room: database plus WAL sidecars, no ignore entry anywhere. */
function room(root, rel = ".squad") {
  const dir = join(root, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "squad.db"), "db-bytes");
  writeFileSync(join(dir, "squad.db-wal"), "wal-bytes");
  writeFileSync(join(dir, "squad.db-shm"), "shm-bytes");
  return dir;
}

function excludeOf(root) {
  return join(root, ".git", "info", "exclude");
}

function excludeText(root) {
  const path = excludeOf(root);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function roomEntries(text) {
  return text.split(/\r?\n/).filter((line) => line.trim() === ".squad/").length;
}

function snapshot(dir) {
  return Object.fromEntries(
    readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), "utf8")]),
  );
}

function summary(stdout) {
  const m = /heal: (\d+) exclude file\(s\) written, (\d+) already ignored, (\d+) skipped, (\d+) failed/.exec(
    stdout,
  );
  assert.ok(m, `heal printed a summary line:\n${stdout}`);
  return { written: +m[1], covered: +m[2], skipped: +m[3], failed: +m[4] };
}

test("one heal run ignores every dormant room under --root; a second run writes nothing", { skip: !hasGit }, () => {
  const root = join(scratch, "fleet one");
  const a = repo(root, "alpha repo");
  const b = repo(root, "beta");
  const roomA = room(a);
  const roomB = room(b);
  const before = { a: snapshot(roomA), b: snapshot(roomB) };
  assert.match(git(a, "status", "--porcelain") ?? "", /\.squad/);

  const first = runHeal(["--root", root]);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.deepEqual(summary(first.stdout), { written: 2, covered: 0, skipped: 0, failed: 0 });
  assert.ok(first.stdout.includes(`wrote: ${excludeOf(a)}`), first.stdout);
  assert.ok(first.stdout.includes(`wrote: ${excludeOf(b)}`), first.stdout);
  for (const r of [a, b]) {
    assert.equal(git(r, "status", "--porcelain"), "");
    assert.equal(roomEntries(excludeText(r)), 1);
  }
  const excludes = { a: excludeText(a), b: excludeText(b) };

  const second = runHeal(["--root", root]);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.deepEqual(summary(second.stdout), { written: 0, covered: 2, skipped: 0, failed: 0 });
  assert.doesNotMatch(second.stdout, /wrote:/);
  assert.equal(excludeText(a), excludes.a, "byte-identical exclude on the second pass");
  assert.equal(excludeText(b), excludes.b, "byte-identical exclude on the second pass");

  // Room contents are never opened, migrated or joined.
  assert.deepEqual(snapshot(roomA), before.a);
  assert.deepEqual(snapshot(roomB), before.b);
  // Nothing written into the unrelated working directory either.
  assert.deepEqual(readdirSync(second.workdir), []);
});

test("heal never creates a room or database where none exists", { skip: !hasGit }, () => {
  const root = join(scratch, "roomless");
  const r = repo(root, "plain");
  mkdirSync(join(root, "not-a-repo"));
  const res = runHeal(["--root", root]);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.deepEqual(summary(res.stdout), { written: 0, covered: 0, skipped: 0, failed: 0 });
  assert.equal(existsSync(join(r, ".squad")), false);
  assert.equal(existsSync(join(root, "not-a-repo", ".squad")), false);
  assert.equal(existsSync(join(root, ".squad")), false);
  assert.equal(excludeText(r).includes(".squad"), false);
});

test("existing ignore patterns, non-git rooms, symlinks and out-of-scope nesting", { skip: !hasGit }, () => {
  const root = join(scratch, "mixed");
  // Already covered three ways: .gitignore, existing exclude entry, broad pattern.
  const gi = repo(root, "gitignored");
  writeFileSync(join(gi, ".gitignore"), ".squad/\n");
  room(gi);
  const ex = repo(root, "excluded");
  writeFileSync(excludeOf(ex), "# mine\n.squad/\n");
  room(ex);
  const broad = repo(root, "broad");
  writeFileSync(join(broad, ".gitignore"), ".sq*\n");
  room(broad);
  // A room in a directory that is not a git working tree: a skip.
  const lone = join(root, "lonely");
  room(lone);
  // A symlinked candidate directory and a symlinked room are never followed.
  const target = repo(scratch, "symlink-target");
  room(target);
  symlinkSync(target, join(root, "linked-checkout"));
  const sr = repo(root, "symlinked-room");
  const realRoom = room(scratch, "elsewhere-room");
  symlinkSync(realRoom, join(sr, ".squad"));
  // Nested deeper than one level: outside the documented scan scope.
  const nested = repo(join(root, "group"), "deep");
  room(nested);

  const excludesBefore = { ex: excludeText(ex), gi: excludeText(gi), broad: excludeText(broad) };
  const res = runHeal(["--root", root]);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.deepEqual(summary(res.stdout), { written: 0, covered: 3, skipped: 2, failed: 0 });
  assert.match(res.stdout, /skip: .*lonely.*not inside a git working tree/);
  assert.match(res.stdout, /skip: .*symlinked-room.*symlink/);
  assert.equal(excludeText(ex), excludesBefore.ex);
  assert.equal(excludeText(gi), excludesBefore.gi);
  assert.equal(excludeText(broad), excludesBefore.broad);
  assert.equal(excludeText(target).includes(".squad"), false, "symlinked checkout not followed");
  assert.equal(excludeText(sr).includes(".squad"), false, "symlinked room not healed");
  assert.equal(excludeText(nested).includes(".squad"), false, "no recursion past one level");

  // An explicit --root reaches the nested layout.
  const deeper = runHeal(["--root", join(root, "group")]);
  assert.equal(deeper.status, 0, deeper.stdout + deeper.stderr);
  assert.equal(summary(deeper.stdout).written, 1);
  assert.equal(git(nested, "status", "--porcelain"), "");
});

test("the root itself is a candidate, and linked worktrees share one exclude entry", { skip: !hasGit }, () => {
  const main = repo(scratch, "wt-root");
  room(main);
  const wt = join(main, "linked");
  assert.notEqual(git(main, "worktree", "add", "-q", "-b", "linked", wt), null);
  writeFileSync(excludeOf(main), `${readFileSync(excludeOf(main), "utf8")}linked/\n`);
  room(wt);

  const res = runHeal(["--root", main]);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  // The root's own room plus the worktree's room resolve to the same common
  // exclude file: one write, then the second candidate is already covered.
  const s = summary(res.stdout);
  assert.equal(s.failed, 0);
  assert.equal(s.written, 1);
  assert.equal(roomEntries(excludeText(main)), 1);
  assert.equal(git(main, "status", "--porcelain"), "");
  assert.equal(git(wt, "status", "--porcelain"), "");
});

test("one failing candidate does not stop the next, and the exit is nonzero", { skip: !hasGit }, () => {
  const root = join(scratch, "partial");
  const bad = repo(root, "a-broken");
  room(bad);
  // .git/info as a plain file: the exclude file cannot be created under it.
  rmSync(join(bad, ".git", "info"), { recursive: true, force: true });
  writeFileSync(join(bad, ".git", "info"), "not a directory");
  const good = repo(root, "b-healthy");
  room(good);

  const res = runHeal(["--root", root]);
  assert.equal(res.status, 1, res.stdout + res.stderr);
  const s = summary(res.stdout);
  assert.equal(s.failed, 1);
  assert.equal(s.written, 1);
  assert.match(res.stdout + res.stderr, /FAILED: .*a-broken/);
  assert.equal(git(good, "status", "--porcelain"), "");
});

test("a read-only exclude is reported as unresolved, not as already covered", { skip: !hasGit || process.getuid?.() === 0 }, () => {
  const root = join(scratch, "readonly");
  const r = repo(root, "locked");
  room(r);
  writeFileSync(excludeOf(r), "# locked\n");
  chmodSync(excludeOf(r), 0o444);
  try {
    const res = runHeal(["--root", root]);
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.equal(summary(res.stdout).failed, 1);
    assert.equal(summary(res.stdout).covered, 0);
  } finally {
    chmodSync(excludeOf(r), 0o644);
  }
});

test("invalid roots and arguments fail clearly without writing", () => {
  const missing = runHeal(["--root", join(scratch, "does-not-exist")]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /not a directory/);

  const file = join(scratch, "a-file");
  writeFileSync(file, "x");
  const notDir = runHeal(["--root", file]);
  assert.equal(notDir.status, 1);
  assert.match(notDir.stderr, /not a directory/);

  for (const args of [["--root"], ["--bogus"], ["extra"], ["--root", scratch, "more"]]) {
    const res = runHeal(args);
    assert.equal(res.status, 1, `heal ${args.join(" ")}`);
    assert.match(res.stderr, /usage: squad heal/);
    assert.deepEqual(readdirSync(res.workdir), []);
  }
});

test("the default root is the parent of the squad source checkout", async () => {
  const { defaultHealRoot } = await import("../dist/room-heal.js");
  assert.equal(defaultHealRoot(), dirname(repoRoot));
});
