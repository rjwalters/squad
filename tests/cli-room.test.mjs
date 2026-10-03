import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

function squad(args, { cwd, env = {} } = {}) {
  const e = { ...process.env, SQUAD_PERSONA: "tester", ...env };
  delete e.SQUAD_DIR;
  if (env.SQUAD_DIR) e.SQUAD_DIR = env.SQUAD_DIR;
  return spawnSync(process.execPath, [entry, ...args], { cwd, env: e, encoding: "utf8" });
}
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "squad-room-")));
function repoWithRoom() {
  const repo = tmp();
  execFileSync("git", ["init", "-q", repo]);
  const r = squad(["send", "seed"], { cwd: repo });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(repo, ".squad", "squad.db")));
  return repo;
}

test("--room delivers into that repo's room from an unrelated cwd", () => {
  const repo = repoWithRoom();
  const other = tmp();
  try {
    const r = squad(["send", "--room", repo, "hello", "there"], { cwd: other });
    assert.equal(r.status, 0, r.stderr);
    assert.match(squad(["read"], { cwd: repo }).stdout, /hello there/);
    assert.ok(!existsSync(join(other, ".squad")));
    // trailing slash and the .squad dir itself both resolve to the same room
    assert.equal(squad(["send", "--room", repo + "/", "slash"], { cwd: other }).status, 0);
    assert.equal(squad(["send", "--room", join(repo, ".squad"), "dot"], { cwd: other }).status, 0);
    const out = squad(["read"], { cwd: repo }).stdout;
    assert.match(out, /slash/);
    assert.match(out, /dot/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test("--room with a linked worktree path resolves to the primary room", () => {
  const repo = repoWithRoom();
  const wt = join(tmp(), "wt");
  try {
    execFileSync("git", ["-C", repo, "-c", "user.email=a@b", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "x"]);
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", wt]);
    const r = squad(["send", "--room", wt, "from-wt"], { cwd: tmp() });
    assert.equal(r.status, 0, r.stderr);
    assert.match(squad(["read"], { cwd: repo }).stdout, /from-wt/);
    assert.ok(!existsSync(join(wt, ".squad")));
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(dirname(wt), { recursive: true, force: true });
  }
});

test("--room with no existing room fails loudly and creates nothing", () => {
  const repo = tmp();
  try {
    execFileSync("git", ["init", "-q", repo]);
    const r = squad(["send", "--room", repo, "msg"], { cwd: tmp() });
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes(join(repo, ".squad")), r.stderr);
    assert.ok(!existsSync(join(repo, ".squad")));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("--room with missing path, bad path or no body errors", () => {
  const cwd = tmp();
  try {
    assert.notEqual(squad(["send", "--room"], { cwd }).status, 0);
    const r = squad(["send", "--room", join(cwd, "nope"), "x"], { cwd });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /usage: squad send/);
    assert.ok(!existsSync(join(cwd, ".squad")));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("--room mid-message is sent verbatim; plain send unchanged", () => {
  const dir = tmp();
  try {
    const env = { SQUAD_DIR: dir };
    assert.equal(squad(["send", "try", "--room", "x"], { env, cwd: dir }).status, 0);
    assert.match(squad(["read"], { env, cwd: dir }).stdout, /try --room x/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
