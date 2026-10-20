import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

function squad(args, persona, cwd, env = {}) {
  const e = { ...process.env, SQUAD_PERSONA: persona, ...env };
  delete e.SQUAD_DIR;
  delete e.SQUAD_SESSION_ID;
  Object.assign(e, env);
  return spawnSync(process.execPath, [entry, ...args], { cwd, env: e, encoding: "utf8" });
}
function room() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "squad-unread-")));
  execFileSync("git", ["init", "-q", repo]);
  return repo;
}
const NOTICE = /squad: (\d+) unread message\(s\) waiting -- run 'squad read --unread'/;

test("send notice, peek-only, and read --unread consume", () => {
  const repo = room();
  try {
    assert.equal(squad(["send", "a1"], "alice", repo).status, 0);
    const first = squad(["send", "a2"], "alice", repo);
    assert.doesNotMatch(first.stderr, NOTICE, "own messages are never unread");
    assert.equal(squad(["send", "b1"], "bob", repo).status, 0);
    assert.equal(squad(["send", "b2"], "bob", repo).status, 0);

    const s = squad(["send", "a3"], "alice", repo);
    assert.equal(s.status, 0, s.stderr);
    assert.match(s.stderr, NOTICE);
    assert.equal(s.stderr.match(NOTICE)[1], "2");
    assert.doesNotMatch(s.stdout, /unread/, "stdout unchanged");

    // peek did not consume: a second send still reports them
    assert.match(squad(["send", "a4"], "alice", repo).stderr, NOTICE);

    const r = squad(["read", "--unread"], "alice", repo);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /b1/);
    assert.match(r.stdout, /b2/);
    assert.doesNotMatch(r.stdout, /a[1-4]/);

    assert.equal(squad(["read", "--unread"], "alice", repo).stdout, "");
    assert.doesNotMatch(squad(["send", "a5"], "alice", repo).stderr, NOTICE);

    // plain read is stateless and unchanged
    const plain = squad(["read"], "alice", repo).stdout;
    assert.match(plain, /b1/);
    assert.match(plain, /a1/);
    assert.match(squad(["read"], "alice", repo).stdout, /b1/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a fresh persona's first send does not report the backlog", () => {
  const repo = room();
  try {
    squad(["send", "old1"], "bob", repo);
    squad(["send", "old2"], "bob", repo);
    const s = squad(["send", "hi"], "carol", repo);
    assert.equal(s.status, 0, s.stderr);
    assert.doesNotMatch(s.stderr, NOTICE);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
