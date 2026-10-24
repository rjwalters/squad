import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// scripts/release-install.sh installs the `pnpm pack` tarball, so the tarball
// must carry everything install.sh needs to run from the installed release (#168).
test("packed release ships the installer inputs", () => {
  const result = spawnSync("pnpm", ["pack", "--dry-run", "--json"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const files = new Set(
    JSON.parse(result.stdout).files.map((file) => file.path),
  );
  for (const required of [
    "install.sh",
    "uninstall.sh",
    "scripts/install-lifecycle.mjs",
    "VERSION",
    "dist/index.js",
    "hooks/squad-mcp.mjs",
    "skills/squad/SKILL.md",
    "commands/squad/card.md",
    "codex/prompts/squad-card.md",
  ]) {
    assert.ok(files.has(required), `${required} missing from packed release`);
  }
});
