import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const root = mkdtempSync(join(tmpdir(), "squad-install-identity-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
function install(name, config, claudeEnv) {
  const home = join(root, name);
  const repo = join(home, "repo");
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(repo);
  if (config) writeFileSync(join(home, ".codex/config.toml"), config);
  if (claudeEnv)
    writeFileSync(
      join(repo, ".mcp.json"),
      JSON.stringify({ mcpServers: { squad: { env: claudeEnv } } }),
    );
  const env = { ...process.env, HOME: home };
  delete env.SQUAD_CLAUDE_PERSONA;
  delete env.SQUAD_CODEX_PERSONA;
  const result = spawnSync("bash", ["install.sh", "-y", "--no-link", repo], {
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return {
    claude: JSON.parse(readFileSync(join(repo, ".mcp.json"), "utf8")).mcpServers.squad.env,
    codex: readFileSync(join(home, ".codex/config.toml"), "utf8"),
  };
}
test("fresh installs do not pin either harness", () => {
  const installed = install("fresh");
  assert.equal(installed.claude.SQUAD_PERSONA, undefined);
  assert.doesNotMatch(installed.codex, /SQUAD_PERSONA/);
});
test("reinstall preserves custom and ambiguous legacy pins in all TOML forms", () => {
  for (const [name, env] of Object.entries({
    inline: 'env = { SQUAD_PERSONA = "custom" }',
    table: '[mcp_servers.squad.env]\nSQUAD_PERSONA = "codex"',
    multiline: 'env = {\n SQUAD_PERSONA = "custom"\n}',
  })) {
    const original = `[mcp_servers.squad]\ncommand = "node"\n${env}\n`;
    const installed = install(name, original, {
      SQUAD_PERSONA: "claude",
      SQUAD_MODEL: "custom-model",
    });
    assert.equal(installed.codex, original);
    assert.equal(installed.claude.SQUAD_PERSONA, "claude");
    assert.equal(installed.claude.SQUAD_MODEL, "custom-model");
  }
});

test("agent CLI import does not pre-populate an empty destination", () => {
  const source = join(root, "export-source");
  const destination = join(root, "import-destination");
  const dump = join(root, "room.db");
  const env = { ...process.env, SQUAD_DIR: source };
  delete env.SQUAD_PERSONA;
  delete env.SQUAD_SESSION_ID;
  for (const args of [
    ["send", "exported message"],
    ["export", dump],
  ]) {
    const result = spawnSync(process.execPath, ["dist/index.js", ...args], {
      env,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  }
  const result = spawnSync(process.execPath, ["dist/index.js", "import", dump], {
    env: {
      ...env,
      SQUAD_DIR: destination,
      SQUAD_SESSION_ID: "aaaaaaaa-1111-4111-8111-111111111111",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});
