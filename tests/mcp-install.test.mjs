import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredEntries, checkMcpInstall, RUNTIME_PACKAGES } from "../dist/mcp-install.js";

// Direct unit coverage for src/mcp-install.ts (#290). Every case passes an
// explicit env with a non-empty temp CODEX_HOME so nothing reads the real
// home directory (an empty CODEX_HOME would fall back to it).

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "squad-mcp-install-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const codexHome = join(root, "codex");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  return {
    root,
    cwd,
    codexHome,
    env: { CODEX_HOME: codexHome },
    toml: (body) => writeFileSync(join(codexHome, "config.toml"), body),
    tomlPath: join(codexHome, "config.toml"),
  };
}

test("codex config.toml [mcp_servers.squad] args yields one entry from that file", (t) => {
  const f = fixture(t);
  f.toml('[mcp_servers.squad]\nargs = ["/abs/dist/index.js"]\n');
  assert.deepEqual(configuredEntries(f.cwd, f.env), [
    { source: f.tomlPath, runtime: "/abs/dist/index.js" },
  ]);
});

test("codex section followed by another section, with command before args, still parses", (t) => {
  const f = fixture(t);
  f.toml(
    '[mcp_servers.squad]\ncommand = "node"\nargs = ["/abs/dist/index.js", "--x"]\n\n[mcp_servers.other]\nargs = ["/other/index.js"]\n',
  );
  const entries = configuredEntries(f.cwd, f.env);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].runtime, "/abs/dist/index.js");
});

test("an args line belonging to a later section is not picked up", (t) => {
  const f = fixture(t);
  f.toml('[mcp_servers.squad]\ncommand = "node"\n\n[mcp_servers.other]\nargs = ["/other/index.js"]\n');
  assert.deepEqual(configuredEntries(f.cwd, f.env), []);
});

test("escaped backslashes and quotes in the codex arg are unescaped", (t) => {
  const f = fixture(t);
  // TOML text: "/tmp/a\\b/index.js" -> /tmp/a\b/index.js (absolute on POSIX)
  f.toml('[mcp_servers.squad]\nargs = ["/tmp/a\\\\b/index.js"]\n');
  assert.equal(configuredEntries(f.cwd, f.env)[0].runtime, "/tmp/a\\b/index.js");
  f.toml('[mcp_servers.squad]\nargs = ["/tmp/a\\"q/index.js"]\n');
  assert.equal(configuredEntries(f.cwd, f.env)[0].runtime, '/tmp/a"q/index.js');
});

test("a relative first codex arg is ignored", (t) => {
  const f = fixture(t);
  f.toml('[mcp_servers.squad]\nargs = ["dist/index.js"]\n');
  assert.deepEqual(configuredEntries(f.cwd, f.env), []);
});

test(".mcp.json relative SQUAD_RUNTIME resolves against the .mcp.json directory", (t) => {
  const f = fixture(t);
  const mcp = join(f.cwd, ".mcp.json");
  writeFileSync(mcp, JSON.stringify({ mcpServers: { squad: { env: { SQUAD_RUNTIME: "rt/dist/index.js" } } } }));
  assert.deepEqual(configuredEntries(f.cwd, f.env), [
    { source: mcp, runtime: join(f.cwd, "rt/dist/index.js") },
  ]);
});

test("unparseable .mcp.json yields no entry and does not throw", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.cwd, ".mcp.json"), "{ not json");
  assert.deepEqual(configuredEntries(f.cwd, f.env), []);
});

test("both sources present give two entries", (t) => {
  const f = fixture(t);
  writeFileSync(
    join(f.cwd, ".mcp.json"),
    JSON.stringify({ mcpServers: { squad: { env: { SQUAD_RUNTIME: "/a/dist/index.js" } } } }),
  );
  f.toml('[mcp_servers.squad]\nargs = ["/b/dist/index.js"]\n');
  const entries = configuredEntries(f.cwd, f.env);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.runtime).sort(), ["/a/dist/index.js", "/b/dist/index.js"]);
});

test("a codex arg with a non-JSON escape does not throw out of configuredEntries", (t) => {
  const f = fixture(t);
  f.toml('[mcp_servers.squad]\nargs = ["/tmp/\\x41/index.js"]\n');
  assert.doesNotThrow(() => configuredEntries(f.cwd, f.env));
});

// --- checkMcpInstall ---------------------------------------------------

function install(root, { packages = RUNTIME_PACKAGES, nodeModulesAt = root, git = false } = {}) {
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  const runtime = join(dist, "index.js");
  writeFileSync(runtime, "");
  for (const p of packages) {
    const dir = join(nodeModulesAt, "node_modules", p);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), "{}");
  }
  if (git) mkdirSync(join(root, ".git"));
  return runtime;
}

test("checkMcpInstall: no entries is ok with the 'no configured' detail", () => {
  const r = checkMcpInstall([]);
  assert.equal(r.name, "mcp-install");
  assert.equal(r.ok, true);
  assert.match(r.detail, /no configured squad MCP entry/);
});

test("checkMcpInstall: a missing runtime path is not ok and names the path", (t) => {
  const f = fixture(t);
  const runtime = join(f.root, "gone", "dist", "index.js");
  const r = checkMcpInstall([{ source: "src-x", runtime }]);
  assert.equal(r.ok, false);
  assert.ok(r.detail.includes(runtime));
  assert.match(r.detail, /does not exist/);
});

test("checkMcpInstall: packages resolved from a parent node_modules are ok", (t) => {
  const f = fixture(t);
  const inst = join(f.root, "outer", "inner");
  const runtime = install(inst, { nodeModulesAt: join(f.root, "outer") });
  const r = checkMcpInstall([{ source: "s", runtime }]);
  assert.equal(r.ok, true);
  assert.match(r.detail, /1 configured entry resolve/);
});

test("checkMcpInstall: unresolvable packages are not ok", (t) => {
  const f = fixture(t);
  const runtime = install(join(f.root, "inst"), { packages: ["zod"] });
  const r = checkMcpInstall([{ source: "s", runtime }]);
  assert.equal(r.ok, false);
  assert.match(r.detail, /cannot resolve @modelcontextprotocol\/sdk/);
});

test("checkMcpInstall: .git beside dist/ is ok with a warning detail", (t) => {
  const f = fixture(t);
  const runtime = install(join(f.root, "clone"), { git: true });
  const r = checkMcpInstall([{ source: "s", runtime }]);
  assert.equal(r.ok, true);
  assert.match(r.detail, /^warning: /);
  assert.match(r.detail, /development clone/);
});
