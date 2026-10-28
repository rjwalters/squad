import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectRuntimeWiring, unwiredHarnessWarning } from "../dist/runtime-wiring.js";

// #204: a room can exist in a repo whose Claude Code sessions have no squad
// tools and no inbox hook. These cover the read-only inspection and the two
// surfaces that report it (send/read stderr, `squad doctor`).
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(repoRoot, "dist", "index.js");
const HARNESS = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"];

function fixture({ mcp = false, hook = false, codex = false, room = true } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "squad-wiring-"));
  const codexHome = join(repo, "codex-home");
  mkdirSync(codexHome);
  if (room) {
    mkdirSync(join(repo, ".squad"));
    writeFileSync(join(repo, ".squad", "squad.db"), "");
  }
  if (mcp) writeFileSync(join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { squad: { command: "node" } } }));
  if (hook) {
    mkdirSync(join(repo, ".claude"));
    writeFileSync(
      join(repo, ".claude", "settings.json"),
      JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ command: ".claude/hooks/squad-inbox.sh" }] }] } }),
    );
  }
  if (codex) writeFileSync(join(codexHome, "config.toml"), '[mcp_servers.squad]\ncommand = "node"\n');
  return { repo, codexHome, room: join(repo, ".squad") };
}

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of HARNESS) delete env[k];
  delete env.SQUAD_SESSION_ID;
  return { ...env, ...extra };
}

test("inspection reports missing Claude tools and Codex config with a fix", () => {
  const f = fixture();
  try {
    const [claude, codex] = inspectRuntimeWiring(f.repo, f.codexHome);
    assert.equal(claude.tools, false);
    assert.equal(claude.notice, "none");
    assert.match(claude.fix, /install\.sh' --inbox '/);
    assert.equal(codex.tools, false);
    assert.match(codex.detail, /no squad MCP server/);
  } finally {
    rmSync(f.repo, { recursive: true, force: true });
  }
});

test("inspection distinguishes tools without a hook from full wiring, and Codex is pull-only", () => {
  const partial = fixture({ mcp: true });
  const full = fixture({ mcp: true, hook: true, codex: true });
  try {
    const [claude] = inspectRuntimeWiring(partial.repo, partial.codexHome);
    assert.equal(claude.tools, true);
    assert.equal(claude.notice, "none");
    const [wired, codex] = inspectRuntimeWiring(full.repo, full.codexHome);
    assert.equal(wired.notice, "hook");
    assert.equal(wired.fix, undefined);
    assert.equal(codex.tools, true);
    assert.equal(codex.notice, "pull-only");
    assert.match(codex.detail, /codex-reentry/);
  } finally {
    rmSync(partial.repo, { recursive: true, force: true });
    rmSync(full.repo, { recursive: true, force: true });
  }
});

test("harness warning fires only for an unwired Claude session in an existing room", () => {
  const bare = fixture();
  const full = fixture({ mcp: true, hook: true });
  const fresh = fixture({ room: false });
  try {
    assert.match(unwiredHarnessWarning(bare.room, { CLAUDECODE: "1" }, bare.codexHome), /squad read --unread/);
    assert.equal(unwiredHarnessWarning(bare.room, {}, bare.codexHome), null, "a person at a terminal");
    assert.equal(unwiredHarnessWarning(full.room, { CLAUDECODE: "1" }, full.codexHome), null);
    assert.equal(unwiredHarnessWarning(fresh.room, { CLAUDECODE: "1" }, fresh.codexHome), null, "no room yet");
  } finally {
    for (const f of [bare, full, fresh]) rmSync(f.repo, { recursive: true, force: true });
  }
});

test("squad send from an unwired Claude session warns on stderr and still posts", () => {
  const f = fixture({ room: false });
  const run = (env) =>
    spawnSync(process.execPath, [entry, "send", "hello"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: cleanEnv({ SQUAD_DIR: f.room, SQUAD_PERSONA: "claude", CODEX_HOME: f.codexHome, ...env }),
    });
  try {
    const first = run({ CLAUDECODE: "1" });
    assert.equal(first.status, 0, first.stderr);
    assert.doesNotMatch(first.stderr, /squad-wiring|no squad entry/, "the first send creates the room");
    const second = run({ CLAUDECODE: "1" });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stderr, /no squad entry in \.mcp\.json/);
    assert.match(second.stdout, /hello/);
    assert.doesNotMatch(run({}).stderr, /no squad entry/, "no harness, no warning");
  } finally {
    rmSync(f.repo, { recursive: true, force: true });
  }
});

test("squad doctor reports runtime wiring as warnings without failing", () => {
  const bare = fixture({ room: false });
  const full = fixture({ mcp: true, hook: true, codex: true, room: false });
  const doctor = (f) =>
    spawnSync(process.execPath, [entry, "doctor"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: cleanEnv({ SQUAD_DIR: f.room, CODEX_HOME: f.codexHome }),
    });
  try {
    const gaps = doctor(bare);
    assert.equal(gaps.status, 0, gaps.stdout + gaps.stderr);
    assert.match(gaps.stdout, /\[warn\] claude wiring: no squad entry in \.mcp\.json.* -- fix: SQUAD_CLAUDE_PERSONA=<name> bash/);
    assert.match(gaps.stdout, /\[warn\] codex wiring:/);
    assert.match(gaps.stdout, /all checks passed; 2 warning\(s\) above/);
    const ok = doctor(full);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /\[ok\] claude wiring:/);
    assert.match(ok.stdout, /\[ok\] codex wiring: .*pull-only|\[ok\] codex wiring: .*no mid-turn notice/);
    assert.match(ok.stdout, /all checks passed\.$/m);
  } finally {
    rmSync(bare.repo, { recursive: true, force: true });
    rmSync(full.repo, { recursive: true, force: true });
  }
});
