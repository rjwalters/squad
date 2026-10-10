import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const launcher = new URL("../hooks/squad-mcp.mjs", import.meta.url).pathname;

function setup(mcpEnv) {
  const repo = mkdtempSync(join(tmpdir(), "squad-launcher-"));
  mkdirSync(join(repo, ".claude/hooks"), { recursive: true });
  cpSync(launcher, join(repo, ".claude/hooks/squad-mcp.mjs"));
  for (const name of ["fallback", "real"])
    writeFileSync(join(repo, `${name}.mjs`), `console.log("ran-${name}");\n`);
  if (mcpEnv)
    writeFileSync(
      join(repo, ".mcp.json"),
      JSON.stringify({ mcpServers: { squad: { env: mcpEnv } } }),
    );
  return repo;
}

function run(repo, env) {
  const clean = { ...process.env };
  delete clean.SQUAD_RUNTIME;
  delete clean.SQUAD_DIR;
  return spawnSync(process.execPath, [join(repo, ".claude/hooks/squad-mcp.mjs")], {
    encoding: "utf8",
    cwd: repo,
    env: { ...clean, ...env },
  });
}

test("env set: real env value wins over .mcp.json", () => {
  const repo = setup({ SQUAD_RUNTIME: "fallback.mjs" });
  const r = run(repo, { SQUAD_RUNTIME: "real.mjs" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ran-real/);
});

test("env unset: falls back to .mcp.json, relative to repo root", () => {
  const repo = setup({ SQUAD_RUNTIME: "fallback.mjs" });
  const r = run(repo, {});
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ran-fallback/);
});

test("neither source: the original error still fires", () => {
  for (const repo of [setup(null), setup({ OTHER: "x" })]) {
    const r = run(repo, {});
    assert.equal(r.status, 1);
    assert.match(r.stderr, /SQUAD_RUNTIME is not set/);
  }
});

test("partial: SQUAD_RUNTIME from env, SQUAD_DIR from .mcp.json", () => {
  const repo = setup({ SQUAD_RUNTIME: "fallback.mjs", SQUAD_DIR: ".squad-room" });
  writeFileSync(
    join(repo, "real.mjs"),
    `console.log("ran-real"); console.log("dir=" + process.env.SQUAD_DIR);\n`,
  );
  const r = run(repo, { SQUAD_RUNTIME: "real.mjs" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ran-real/);
  // The fallback relative SQUAD_DIR is anchored to the repo root, not the cwd.
  assert.match(r.stdout, /^dir=\/.*[\\/]\.squad-room$/m);
});
