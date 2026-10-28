import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(repoRoot, "dist", "index.js");

function setup({ mcp, settings } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "squad-rtsetup-"));
  const codexHome = mkdtempSync(join(tmpdir(), "squad-codexhome-"));
  mkdirSync(join(repo, ".squad"));
  mkdirSync(join(repo, ".claude"));
  if (mcp !== undefined) writeFileSync(join(repo, ".mcp.json"), mcp);
  if (settings !== undefined) writeFileSync(join(repo, ".claude", "settings.json"), settings);
  return { repo, codexHome };
}

function run(repo, codexHome, args, env = {}) {
  const clean = { ...process.env };
  delete clean.CLAUDECODE;
  delete clean.CLAUDE_CODE_ENTRYPOINT;
  delete clean.SQUAD_DIR;
  return spawnSync(process.execPath, [entry, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...clean, SQUAD_PERSONA: "claude", CODEX_HOME: codexHome, ...env },
  });
}

const FULL_MCP = JSON.stringify({ mcpServers: { squad: { command: "node" } } });
const FULL_SETTINGS = JSON.stringify({
  hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "${CLAUDE_PROJECT_DIR}/.claude/hooks/squad-inbox.sh" }] }] },
});

function cleanup(...dirs) {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

test("warns once on stderr when a harness runs send in a repo with no setup", () => {
  const { repo, codexHome } = setup();
  try {
    const res = run(repo, codexHome, ["send", "hi"], { CLAUDECODE: "1" });
    assert.equal(res.status, 0, res.stderr);
    const lines = res.stderr.split("\n").filter((l) => l.includes("Claude Code in this repo"));
    assert.equal(lines.length, 1, res.stderr);
    assert.match(lines[0], /\.mcp\.json/);
    assert.match(lines[0], /install\.sh --inbox /);
    assert.doesNotMatch(res.stdout, /Claude Code in this repo/);
    const read = run(repo, codexHome, ["read"], { CLAUDE_CODE_ENTRYPOINT: "cli" });
    assert.equal(read.status, 0, read.stderr);
    assert.match(read.stderr, /install\.sh --inbox /);
  } finally {
    cleanup(repo, codexHome);
  }
});

test("names the missing hook when only tools are configured", () => {
  const { repo, codexHome } = setup({ mcp: FULL_MCP });
  try {
    const res = run(repo, codexHome, ["read"], { CLAUDECODE: "1" });
    assert.match(res.stderr, /inbox\/reentry hook/);
    assert.doesNotMatch(res.stderr, /no squad entry in \.mcp\.json/);
  } finally {
    cleanup(repo, codexHome);
  }
});

test("silent when setup is complete, no harness marker is set, or files are malformed", () => {
  const complete = setup({ mcp: FULL_MCP, settings: FULL_SETTINGS });
  const malformed = setup({ mcp: "{nope", settings: "{nope" });
  const bare = setup();
  try {
    assert.doesNotMatch(run(complete.repo, complete.codexHome, ["read"], { CLAUDECODE: "1" }).stderr, /Claude Code in this repo/);
    assert.doesNotMatch(run(malformed.repo, malformed.codexHome, ["read"], { CLAUDECODE: "1" }).stderr, /Claude Code in this repo/);
    assert.doesNotMatch(run(bare.repo, bare.codexHome, ["read"]).stderr, /Claude Code in this repo/);
  } finally {
    cleanup(complete.repo, complete.codexHome, malformed.repo, malformed.codexHome, bare.repo, bare.codexHome);
  }
});

test("doctor reports claude and codex setup lines and still exits 0", () => {
  const { repo, codexHome } = setup();
  try {
    writeFileSync(join(codexHome, "config.toml"), '[mcp_servers.squad]\ncommand = "node"\n');
    const res = run(repo, codexHome, ["doctor"]);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /\[info\] claude code: tools no .*fix: install\.sh --inbox /);
    assert.match(res.stdout, /\[info\] codex: tools yes .*notice none, by design/);
    assert.match(res.stdout, /all checks passed/);
  } finally {
    cleanup(repo, codexHome);
  }
});
