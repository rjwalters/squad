import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("both installed skill bundles resolve all five workflow adapters across reinstalls", () => {
  const scratch = mkdtempSync(join(tmpdir(), "squad-workflows-"));
  const repo = join(scratch, "repo");
  mkdirSync(repo);
  try {
    const env = { ...process.env, HOME: scratch };
    for (let i = 0; i < 2; i++) {
      const result = spawnSync("bash", ["install.sh", "-y", "--no-link", repo], { env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      for (const runtime of [".claude", ".agents"]) {
        const bundle = join(repo, runtime, "skills/squad");
        assert.equal(readFileSync(join(bundle, "SKILL.md"), "utf8"), readFileSync("skills/squad/SKILL.md", "utf8"));
        for (const workflow of ["join", "goals", "card", "clear", "fanout"]) {
          const reference = `references/${workflow}.md`;
          assert.equal(readFileSync(join(bundle, reference), "utf8"), readFileSync(`skills/squad/${reference}`, "utf8"));
          const adapter = runtime === ".claude" ? join(repo, ".claude/commands/squad", `${workflow}.md`) : join(scratch, ".codex/prompts", `squad-${workflow}.md`);
          assert.ok(readFileSync(adapter, "utf8").includes(`${runtime}/skills/squad/${reference}`));
        }
      }
    }
    const result = spawnSync("bash", ["uninstall.sh", repo], { env, input: "y\n", encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(repo, ".agents/skills/squad/SKILL.md")), false);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
