import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// This suite exercises repo-relative room placement, so SQUAD_DIR must be unset
// for the openDb() cases (the individual tests set it only where they mean to).
delete process.env.SQUAD_DIR;

const { ensureRoomIgnored, ensureRoomIgnoredStrict, roomIgnoreState, openDb } = await import(
  "../dist/db.js"
);
const { healRooms } = await import("../dist/room-heal.js");

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

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "squad-ignore-")));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

/** A real git repo with one empty commit, so `git status` is meaningful. */
function repo(name) {
  const root = join(scratch, name);
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  return root;
}

function excludeOf(root) {
  return join(root, ".git", "info", "exclude");
}

function excludeText(root) {
  const path = excludeOf(root);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** Occurrences of a whole-line `.squad/` entry across the exclude file. */
function roomEntries(text) {
  return text.split(/\r?\n/).filter((line) => line.trim() === ".squad/").length;
}

test("a fresh repo gets .squad/ excluded, and git stops seeing the room", { skip: !hasGit }, () => {
  const root = repo("fresh");
  const room = join(root, ".squad");
  mkdirSync(room, { recursive: true });
  writeFileSync(join(room, "squad.db"), "");

  // Baseline: without the fix the room is plain untracked dirt.
  assert.match(git(root, "status", "--porcelain") ?? "", /\.squad/);

  assert.equal(ensureRoomIgnored(room), excludeOf(root));
  assert.equal(roomEntries(excludeText(root)), 1);
  assert.equal(git(root, "status", "--porcelain"), "");
  assert.match(git(root, "check-ignore", "-v", "--", ".squad/squad.db") ?? "", /info\/exclude/);
});

test("an existing affected checkout self-heals on the next openDb()", { skip: !hasGit }, () => {
  const root = repo("selfheal");
  // Exactly the reported state: a room already on disk from a build that
  // never wrote an ignore entry, in a repo whose .gitignore has none either.
  mkdirSync(join(root, ".squad"), { recursive: true });
  writeFileSync(join(root, ".squad", "squad.db"), "");
  writeFileSync(join(root, ".gitignore"), "node_modules/\n");
  git(root, "add", ".gitignore");
  git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "ignore");
  assert.match(git(root, "status", "--porcelain") ?? "", /\.squad/);

  const prev = process.cwd();
  try {
    process.chdir(root);
    openDb().close();
  } finally {
    process.chdir(prev);
  }

  assert.equal(roomEntries(excludeText(root)), 1);
  assert.equal(git(root, "status", "--porcelain"), "");
  // The tracked .gitignore is never touched — that stays the installer's job.
  assert.equal(readFileSync(join(root, ".gitignore"), "utf8"), "node_modules/\n");
});

test("a repo already ignoring the room via .gitignore is left untouched", { skip: !hasGit }, () => {
  const root = repo("already-gitignore");
  writeFileSync(join(root, ".gitignore"), ".squad/\n");
  const room = join(root, ".squad");
  mkdirSync(room, { recursive: true });

  assert.equal(ensureRoomIgnored(room), null);
  assert.equal(roomEntries(excludeText(root)), 0);
});

test("a .gitignore entry without the trailing slash also suppresses the write", { skip: !hasGit }, () => {
  const root = repo("no-slash");
  writeFileSync(join(root, ".gitignore"), "# state\n.squad\n");
  const room = join(root, ".squad");
  mkdirSync(room, { recursive: true });

  assert.equal(ensureRoomIgnored(room), null);
  assert.equal(roomEntries(excludeText(root)), 0);
});

test("repeated runs never duplicate the exclude entry", { skip: !hasGit }, () => {
  const root = repo("idempotent");
  const room = join(root, ".squad");
  mkdirSync(room, { recursive: true });

  assert.equal(ensureRoomIgnored(room), excludeOf(root));
  const after = excludeText(root);
  assert.equal(ensureRoomIgnored(room), null);
  assert.equal(ensureRoomIgnored(room), null);
  assert.equal(excludeText(root), after);
  assert.equal(roomEntries(after), 1);
});

test("a pre-existing exclude file keeps its own lines", { skip: !hasGit }, () => {
  const root = repo("preexisting");
  const path = excludeOf(root);
  writeFileSync(path, "scratch/\n*.log"); // note: no trailing newline
  const room = join(root, ".squad");
  mkdirSync(room, { recursive: true });

  assert.equal(ensureRoomIgnored(room), path);
  const text = excludeText(root);
  assert.match(text, /^scratch\/$/m);
  assert.match(text, /^\*\.log$/m);
  assert.equal(roomEntries(text), 1);
});

test("a broader pattern that already covers the room suppresses the write", { skip: !hasGit }, () => {
  const root = repo("broad");
  writeFileSync(join(root, ".gitignore"), ".sq*\n");
  const room = join(root, ".squad");
  mkdirSync(room, { recursive: true });

  // Not a literal `.squad` line anywhere, so only `git check-ignore` can know.
  assert.equal(ensureRoomIgnored(room), null);
  assert.equal(roomEntries(excludeText(root)), 0);
});

test("a linked worktree writes to the primary clone's exclude", { skip: !hasGit }, () => {
  const root = repo("wt-main");
  const wt = join(scratch, "wt-linked");
  assert.notEqual(git(root, "worktree", "add", "-q", "-b", "linked", wt), null);

  // The room resolves to the primary clone even when squad runs in the
  // worktree, and info/exclude lives in the shared common dir.
  const prev = process.cwd();
  try {
    process.chdir(wt);
    openDb().close();
  } finally {
    process.chdir(prev);
  }

  assert.equal(roomEntries(excludeText(root)), 1);
  assert.ok(!existsSync(join(wt, ".git", "info", "exclude")), "worktree git dir untouched");
  assert.equal(git(root, "status", "--porcelain"), "");
  assert.equal(git(wt, "status", "--porcelain"), "");
});

test("a worktree with its own room excludes it in the shared common dir", { skip: !hasGit }, () => {
  const root = repo("wt-own-main");
  const wt = join(scratch, "wt-own-linked");
  assert.notEqual(git(root, "worktree", "add", "-q", "-b", "own-linked", wt), null);
  // A worktree that opted into its own room (findRepoRoot stops at .squad).
  const room = join(wt, ".squad");
  mkdirSync(room, { recursive: true });

  assert.equal(ensureRoomIgnored(room), excludeOf(root));
  assert.equal(git(wt, "status", "--porcelain"), "");
});

test("a room outside any repo is a no-op", () => {
  const lone = join(scratch, "no-repo", ".squad");
  mkdirSync(lone, { recursive: true });
  assert.equal(ensureRoomIgnored(lone), null);
});

test("a nested room is excluded by its repo-relative path", { skip: !hasGit }, () => {
  const root = repo("nested");
  const room = join(root, "sub", "dir", ".squad");
  mkdirSync(room, { recursive: true });
  writeFileSync(join(room, "squad.db"), "");

  assert.equal(ensureRoomIgnored(room), excludeOf(root));
  assert.match(excludeText(root), /^\/sub\/dir\/\.squad\/$/m);
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("one heal run fixes a pre-#111 room without opening it; a second run writes nothing (#132)", { skip: !hasGit }, () => {
  const parent = join(scratch, "heal-parent");
  const root = repo(join("heal-parent", "dormant"));
  const room = join(root, ".squad");
  mkdirSync(room, { recursive: true });
  writeFileSync(join(room, "squad.db"), "untouched");
  assert.match(git(root, "status", "--porcelain") ?? "", /\.squad/);
  assert.deepEqual(roomIgnoreState(room), { state: "not-ignored", root, exclude: excludeOf(root) });

  const first = healRooms(parent);
  assert.deepEqual(first.written, [{ room, exclude: excludeOf(root) }]);
  assert.deepEqual(first.failed, []);
  assert.equal(git(root, "status", "--porcelain"), "");
  assert.equal(roomEntries(excludeText(root)), 1);
  assert.deepEqual(roomIgnoreState(room), { state: "ignored", root });
  const after = excludeText(root);

  const second = healRooms(parent);
  assert.deepEqual(second.written, []);
  assert.deepEqual(second.covered, [room]);
  assert.equal(excludeText(root), after);
  // The room was never opened: no WAL sidecars, contents byte-identical.
  assert.deepEqual(readdirSync(room), ["squad.db"]);
  assert.equal(readFileSync(join(room, "squad.db"), "utf8"), "untouched");
});

test("the strict helper surfaces the failure the safe one swallows", { skip: !hasGit }, () => {
  const root = repo("strict-fail");
  const room = join(root, ".squad");
  mkdirSync(room, { recursive: true });
  rmSync(join(root, ".git", "info"), { recursive: true, force: true });
  writeFileSync(join(root, ".git", "info"), "not a directory");

  assert.equal(ensureRoomIgnored(room), null);
  assert.throws(() => ensureRoomIgnoredStrict(room));
  assert.equal(roomIgnoreState(room).state, "not-ignored");
});

test("roomIgnoreState reports a room outside any repo", () => {
  const lone = join(scratch, "state-no-repo", ".squad");
  mkdirSync(lone, { recursive: true });
  assert.deepEqual(roomIgnoreState(lone), { state: "outside-repo" });
});
