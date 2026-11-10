import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

function squad(args, repo) {
  const e = { ...process.env, SQUAD_PERSONA: "alice" };
  delete e.SQUAD_DIR;
  delete e.SQUAD_SESSION_ID;
  return spawnSync(process.execPath, [entry, ...args], { cwd: repo, env: e, encoding: "utf8" });
}
function room() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "squad-claim-")));
  execFileSync("git", ["init", "-q", repo]);
  return repo;
}

for (const cmd of ["claim", "release"]) {
  test(`${cmd} rejects flags, extra args, blanks; writes nothing`, () => {
    const repo = room();
    try {
      for (const args of [
        [cmd, "a", "-m", "note"],
        [cmd, "-m", "x"],
        [cmd, "-"],
        [cmd, "a", "b"],
        [cmd, ""],
        [cmd],
      ]) {
        const r = squad(args, repo);
        assert.notEqual(r.status, 0, JSON.stringify(args));
        assert.match(r.stderr, new RegExp(`usage: squad ${cmd} <path>`), JSON.stringify(args));
      }
      assert.match(squad(["claims"], repo).stdout, /no claims/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
}

test("quoted path with spaces and ./-x round-trip", () => {
  const repo = room();
  try {
    for (const p of ["dir with space/f", "./-x"]) {
      assert.equal(squad(["claim", p], repo).status, 0);
      assert.ok(squad(["claims"], repo).stdout.split("\n").some((l) => l.startsWith(p + "\t")));
      const r = squad(["release", p], repo);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /released/);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
