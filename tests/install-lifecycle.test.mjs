import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  symlinkSync,
  readdirSync,
  lstatSync,
  cpSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const scratch = mkdtempSync(join(tmpdir(), "squad-lifecycle-"));
test.after(() => rmSync(scratch, { recursive: true, force: true }));
function fixture(name) {
  const home = join(scratch, name),
    repo = join(home, "repo");
  mkdirSync(repo, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    CODEX_HOME: join(home, "custom-codex"),
  };
  delete env.SQUAD_CLAUDE_PERSONA;
  delete env.SQUAD_CODEX_PERSONA;
  const run = (script = "install.sh", args = [], code = 0) => {
    const result = spawnSync(
      "bash",
      [script, "-y", "--no-link", ...args, repo],
      { env, encoding: "utf8" },
    );
    assert.equal(result.status, code, result.stderr + result.stdout);
    return result.stdout + result.stderr;
  };
  return { home, repo, env, run };
}
test("check detects modified files, update preserves them, uninstall removes only owned files", () => {
  const { repo, env, run } = fixture("ownership");
  run();
  run("install.sh", ["--check"]);
  const file = join(repo, ".agents/skills/squad/SKILL.md");
  writeFileSync(file, "user customization\n");
  writeFileSync(join(repo, ".agents/skills/squad/custom.md"), "mine");
  run("install.sh", ["--check"], 1);
  run("install.sh", [], 1);
  assert.equal(readFileSync(file, "utf8"), "user customization\n");
  run("uninstall.sh", [], 1);
  assert.equal(readFileSync(file, "utf8"), "user customization\n");
  assert.ok(existsSync(join(repo, ".agents/skills/squad/custom.md")));
  assert.ok(existsSync(join(env.CODEX_HOME, "prompts/squad-join.md")));
});
test("malformed config and destination symlinks fail before any target writes", () => {
  const a = fixture("invalid");
  writeFileSync(join(a.repo, ".mcp.json"), "{");
  a.run("install.sh", [], 1);
  assert.equal(existsSync(join(a.repo, ".agents")), false);
  const b = fixture("symlink");
  mkdirSync(join(b.home, "elsewhere"));
  symlinkSync(join(b.home, "elsewhere"), join(b.repo, ".agents"));
  b.run("install.sh", [], 1);
  assert.equal(existsSync(join(b.repo, ".claude")), false);
});
test("CODEX_HOME is respected and one repo uninstall leaves global wiring intact", () => {
  const { repo, home, env, run } = fixture("global");
  run();
  assert.ok(existsSync(join(env.CODEX_HOME, "prompts/squad-join.md")));
  assert.equal(existsSync(join(home, ".codex")), false);
  run("uninstall.sh");
  assert.ok(existsSync(join(env.CODEX_HOME, "config.toml")));
  run("uninstall.sh", ["--global"]);
  assert.equal(
    existsSync(join(env.CODEX_HOME, "prompts/squad-join.md")),
    false,
  );
});
test("custom launchers, pins, unrelated servers and quoted TOML remain intact", () => {
  const { repo, env, run } = fixture("custom-config");
  const custom = {
    mcpServers: {
      other: { command: "other" },
      squad: {
        command: "my-wrapper",
        timeout: 42,
        env: { SQUAD_PERSONA: "legacy", SQUAD_DIR: "/my/room" },
      },
    },
  };
  writeFileSync(join(repo, ".mcp.json"), JSON.stringify(custom));
  mkdirSync(env.CODEX_HOME);
  const toml =
    '# custom\n[mcp_servers."squad"]\ncommand = "wrapper"\n[mcp_servers."squad".env]\nSQUAD_PERSONA = "custom"\n';
  writeFileSync(join(env.CODEX_HOME, "config.toml"), toml);
  run();
  run();
  assert.deepEqual(JSON.parse(readFileSync(join(repo, ".mcp.json"))), custom);
  assert.equal(readFileSync(join(env.CODEX_HOME, "config.toml"), "utf8"), toml);
  assert.match(run("install.sh", ["--check"], 1), /unmanaged Claude launcher/);
  run("uninstall.sh", ["--global"]);
  assert.deepEqual(JSON.parse(readFileSync(join(repo, ".mcp.json"))), custom);
  assert.equal(readFileSync(join(env.CODEX_HOME, "config.toml"), "utf8"), toml);
});
test("user configuration added after installation survives uninstall", () => {
  const { repo, env, run } = fixture("config-edits");
  run();
  const path = join(repo, ".mcp.json");
  const cfg = JSON.parse(readFileSync(path));
  cfg.mcpServers.squad.env.SQUAD_MODEL = "custom";
  cfg.mcpServers.squad.timeout = 321;
  cfg.mcpServers.other = { command: "other" };
  writeFileSync(path, JSON.stringify(cfg));
  const doc = join(repo, "AGENTS.md");
  const before = readFileSync(doc, "utf8");
  writeFileSync(doc, "my instructions\n" + before + "my footer\n");
  run("uninstall.sh");
  assert.deepEqual(JSON.parse(readFileSync(path)), {
    mcpServers: {
      squad: { env: { SQUAD_MODEL: "custom" }, timeout: 321 },
      other: { command: "other" },
    },
  });
  assert.equal(readFileSync(doc, "utf8"), "my instructions\nmy footer\n");
  assert.ok(existsSync(join(env.CODEX_HOME, "config.toml")));
});
test("owned pins survive refresh and hooks preserve neighboring settings", () => {
  const f = fixture("hooks");
  f.env.SQUAD_CLAUDE_PERSONA = "claude-worker";
  f.env.SQUAD_CODEX_PERSONA = "codex-worker";
  mkdirSync(join(f.repo, ".claude"));
  const original = {
    custom: true,
    hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] },
  };
  writeFileSync(
    join(f.repo, ".claude/settings.json"),
    JSON.stringify(original),
  );
  f.run("install.sh", ["--reentry"]);
  delete f.env.SQUAD_CLAUDE_PERSONA;
  delete f.env.SQUAD_CODEX_PERSONA;
  f.run();
  f.run("install.sh", ["--check"]);
  assert.match(
    readFileSync(join(f.repo, ".claude/hooks/squad-reentry.sh"), "utf8"),
    /claude-worker/,
  );
  assert.match(
    readFileSync(join(f.env.CODEX_HOME, "config.toml"), "utf8"),
    /codex-worker/,
  );
  f.run("uninstall.sh", ["--global"]);
  assert.deepEqual(
    JSON.parse(readFileSync(join(f.repo, ".claude/settings.json"))),
    original,
  );
});
test("preflight rejects malformed markers, TOML and receipt traversal with no payload writes", () => {
  for (const kind of ["markers", "toml", "receipt"]) {
    const f = fixture("bad-" + kind);
    if (kind === "markers")
      writeFileSync(
        join(f.repo, "AGENTS.md"),
        "before\n<!-- BEGIN SQUAD -->\nuser content",
      );
    if (kind === "toml") {
      mkdirSync(f.env.CODEX_HOME);
      writeFileSync(join(f.env.CODEX_HOME, "config.toml"), "broken = [");
    }
    if (kind === "receipt") {
      mkdirSync(join(f.repo, ".claude/skills/squad"), { recursive: true });
      writeFileSync(
        join(f.repo, ".claude/skills/squad/.install-local.json"),
        JSON.stringify({
          layout_version: 2,
          package: "@rjwalters/squad",
          files: { "../outside": "0".repeat(64) },
          fragments: {},
        }),
      );
    }
    f.run("install.sh", [], 1);
    assert.equal(existsSync(join(f.repo, ".agents")), false);
    assert.equal(existsSync(join(f.repo, ".mcp.json")), false);
  }
});
test("global prompt customization and unrelated prompt files survive explicit global removal", () => {
  const f = fixture("global-edits");
  f.run();
  const path = join(f.env.CODEX_HOME, "prompts/squad-join.md");
  writeFileSync(path, "my prompt");
  writeFileSync(join(f.env.CODEX_HOME, "prompts/squad-extra.md"), "extra");
  f.run("install.sh", ["--check"], 1);
  f.run("uninstall.sh", ["--global"], 1);
  assert.equal(readFileSync(path, "utf8"), "my prompt");
  assert.equal(
    readFileSync(join(f.env.CODEX_HOME, "prompts/squad-extra.md"), "utf8"),
    "extra",
  );
});
test("legacy matching artifacts migrate; unknown stale global prompts are not silently overwritten", () => {
  const f = fixture("legacy");
  mkdirSync(join(f.repo, ".claude/skills/squad"), { recursive: true });
  writeFileSync(
    join(f.repo, ".claude/skills/squad/install-metadata.json"),
    JSON.stringify({ version: "0.5.0", commit: "old", layout_version: 1 }),
  );
  writeFileSync(
    join(f.repo, ".claude/skills/squad/.install-local.json"),
    JSON.stringify({ source: "/old", installed_at: "then" }),
  );
  writeFileSync(
    join(f.repo, ".claude/skills/squad/SKILL.md"),
    readFileSync("skills/squad/SKILL.md"),
  );
  mkdirSync(join(f.env.CODEX_HOME, "prompts"), { recursive: true });
  const old = join(f.env.CODEX_HOME, "prompts/squad-join.md");
  writeFileSync(old, "historical unknown prompt");
  f.run("install.sh", ["--check"], 1);
  f.run("install.sh", [], 1);
  assert.equal(readFileSync(old, "utf8"), "historical unknown prompt");
  rmSync(old);
  f.run();
  assert.equal(
    JSON.parse(
      readFileSync(join(f.repo, ".agents/skills/squad/install-metadata.json")),
    ).layout_version,
    2,
  );
});
test("customized hook entries retain the script they still invoke", () => {
  const f = fixture("custom-hook");
  f.env.SQUAD_CLAUDE_PERSONA = "hook-worker";
  f.run("install.sh", ["--reentry"]);
  const path = join(f.repo, ".claude/settings.json");
  const cfg = JSON.parse(readFileSync(path));
  cfg.hooks.Stop[0].hooks[0].timeout = 5;
  writeFileSync(path, JSON.stringify(cfg));
  f.run("uninstall.sh", [], 1);
  assert.ok(existsSync(join(f.repo, ".claude/hooks/squad-reentry.sh")));
  assert.deepEqual(JSON.parse(readFileSync(path)), cfg);
});
test("customized MCP launcher retains its command and argument pair", () => {
  const f = fixture("custom-installed-launcher");
  f.run();
  const path = join(f.repo, ".mcp.json");
  const cfg = JSON.parse(readFileSync(path));
  cfg.mcpServers.squad.args = ["/custom/server.js"];
  writeFileSync(path, JSON.stringify(cfg));
  f.run("uninstall.sh", [], 1);
  const after = JSON.parse(readFileSync(path));
  assert.equal(after.mcpServers.squad.command, "node");
  assert.deepEqual(after.mcpServers.squad.args, ["/custom/server.js"]);
});
test("tracked ownership allows another machine to refresh copies without taking its launcher", () => {
  const f = fixture("clone");
  f.run();
  rmSync(join(f.repo, ".claude/skills/squad/.install-local.json"));
  f.run();
  const cfg = JSON.parse(readFileSync(join(f.repo, ".mcp.json")));
  f.run("uninstall.sh");
  assert.deepEqual(JSON.parse(readFileSync(join(f.repo, ".mcp.json"))), cfg);
});
function snapshot(root) {
  const result = {};
  function walk(dir) {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name),
        stat = lstatSync(path);
      if (stat.isDirectory()) walk(path);
      else
        result[path.slice(root.length)] = {
          bytes: readFileSync(path).toString("base64"),
          mode: stat.mode,
          mtime: stat.mtimeMs,
        };
    }
  }
  walk(root);
  return result;
}
test("check and dry-run preserve file bytes, modes, and mtimes", () => {
  const f = fixture("read-only");
  f.run();
  const before = snapshot(f.home);
  f.run("install.sh", ["--check"]);
  f.run("install.sh", ["--dry-run"]);
  assert.deepEqual(snapshot(f.home), before);
  writeFileSync(
    join(f.repo, ".agents/skills/squad/references/join.md"),
    "edited",
  );
  const modified = snapshot(f.home);
  f.run("install.sh", ["--check"], 1);
  f.run("install.sh", ["--dry-run"], 1);
  assert.deepEqual(snapshot(f.home), modified);
});
test("checkout-backed development detects same-version edits and refreshes owned artifacts", () => {
  const f = fixture("development"),
    checkout = join(f.home, "source");
  mkdirSync(checkout);
  for (const path of [
    "scripts",
    "skills",
    "commands",
    "codex",
    "hooks",
    "dist",
    "VERSION",
    "package.json",
    "install.sh",
    "uninstall.sh",
  ])
    cpSync(path, join(checkout, path), { recursive: true });
  symlinkSync(realpathSync("node_modules"), join(checkout, "node_modules"));
  const run = (args = [], code = 0) => {
    const result = spawnSync(
      "bash",
      [join(checkout, "install.sh"), "-y", "--no-link", ...args, f.repo],
      { env: f.env, encoding: "utf8" },
    );
    assert.equal(result.status, code, result.stdout + result.stderr);
    return result.stdout + result.stderr;
  };
  run();
  run(["--check"]);
  const canonical = join(checkout, "skills/squad/references/join.md");
  writeFileSync(
    canonical,
    readFileSync(canonical, "utf8") + "\nDevelopment change.\n",
  );
  run(["--check"], 1);
  run();
  run(["--check"]);
  assert.match(
    readFileSync(
      join(f.repo, ".agents/skills/squad/references/join.md"),
      "utf8",
    ),
    /Development change/,
  );
  writeFileSync(join(checkout, "VERSION"), "9.0.0\n");
  run(["--check"], 1);
  run();
  run(["--check"]);
  assert.equal(
    JSON.parse(readFileSync(join(f.env.CODEX_HOME, ".squad-install.json")))
      .version,
    "9.0.0",
  );
  rmSync(join(checkout, "dist/index.js"));
  assert.match(run(["--check"], 1), /broken (Claude|Codex) runtime path/);
});
test("Codex ancestor symlinks outside HOME are rejected without writes", () => {
  const f = fixture("outside-home");
  const elsewhere = join(scratch, "outside");
  mkdirSync(elsewhere);
  const link = join(scratch, "external-link");
  symlinkSync(elsewhere, link);
  f.env.CODEX_HOME = join(link, "codex");
  f.run("install.sh", [], 1);
  assert.equal(existsSync(join(f.repo, ".agents")), false);
  assert.deepEqual(readdirSync(elsewhere), []);
});
test("valid TOML that cannot accept a squad table fails before any writes", () => {
  for (const [name, config] of Object.entries({
    sealed: 'mcp_servers = { other = { command = "other" } }\n',
    scalar: "mcp_servers = 5\n",
  })) {
    const f = fixture("toml-" + name);
    mkdirSync(f.env.CODEX_HOME);
    writeFileSync(join(f.env.CODEX_HOME, "config.toml"), config);
    f.run("install.sh", [], 1);
    assert.equal(
      readFileSync(join(f.env.CODEX_HOME, "config.toml"), "utf8"),
      config,
    );
    assert.equal(existsSync(join(f.repo, ".agents")), false);
  }
});

test("sibling project launcher survives relocation and preserves equivalent path edits", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const { resolve } = await import("node:path");
  const original = join(scratch, "portable original");
  const sourceCopy = join(original, "squad source");
  const repo = join(original, "consumer");
  mkdirSync(sourceCopy, { recursive: true });
  mkdirSync(repo);
  for (const path of ["scripts", "skills", "commands", "codex", "dist", "VERSION", "install.sh", "uninstall.sh"])
    cpSync(resolve(path), join(sourceCopy, path), { recursive: true });
  symlinkSync(realpathSync("node_modules"), join(sourceCopy, "node_modules"));
  const env = { ...process.env, HOME: original };
  for (const key of Object.keys(env)) if (key.startsWith("SQUAD_")) delete env[key];
  function install(sourceRoot, target, args = []) {
    const result = spawnSync("bash", [join(sourceRoot, "install.sh"), "--no-codex", ...args, target], {
      cwd: scratch, env, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout + result.stderr;
  }
  install(sourceCopy, repo);
  const configPath = join(repo, ".mcp.json");
  const config = JSON.parse(readFileSync(configPath));
  assert.deepEqual(config.mcpServers.squad.args, ["../squad source/dist/index.js"]);
  assert.equal(config.mcpServers.squad.env.SQUAD_DIR, ".squad");
  assert.ok(!readFileSync(configPath, "utf8").includes(original));
  install(sourceCopy, repo, ["--check"]);

  // A pre-fix receipt plus the user's relative correction must remain healthy.
  const receiptPath = join(repo, ".claude/skills/squad/.install-local.json");
  const receipt = JSON.parse(readFileSync(receiptPath));
  receipt.fragments[".mcp.json"].values["mcpServers/squad/args"].installed = [join(sourceCopy, "dist/index.js")];
  receipt.fragments[".mcp.json"].values["mcpServers/squad/env/SQUAD_DIR"].installed = join(repo, ".squad");
  const legacyConfig = structuredClone(config);
  legacyConfig.mcpServers.squad.args = [join(sourceCopy, "dist/index.js")];
  legacyConfig.mcpServers.squad.env.SQUAD_DIR = join(repo, ".squad");
  writeFileSync(configPath, JSON.stringify(legacyConfig));
  writeFileSync(receiptPath, JSON.stringify(receipt));
  install(sourceCopy, repo);
  assert.deepEqual(JSON.parse(readFileSync(configPath)), config);

  // Keep the old receipt while leaving the user's relative spelling in place.
  writeFileSync(receiptPath, JSON.stringify(receipt));
  const corrected = readFileSync(configPath, "utf8");
  install(sourceCopy, repo);
  install(sourceCopy, repo, ["--check"]);
  assert.equal(readFileSync(configPath, "utf8"), corrected);

  const relocated = join(scratch, "portable relocated");
  cpSync(original, relocated, { recursive: true });
  rmSync(original, { recursive: true });
  const newRepo = join(relocated, "consumer");
  const client = new Client({ name: "relocated-project", version: "1" });
  const server = JSON.parse(readFileSync(join(newRepo, ".mcp.json"))).mcpServers.squad;
  try {
    await client.connect(new StdioClientTransport({
      command: server.command, args: server.args, cwd: newRepo,
      env: { ...env, ...server.env }, stderr: "pipe",
    }));
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "squad_join"));
    const joined = await client.callTool({ name: "squad_join", arguments: {} });
    assert.ok(!joined.isError, JSON.stringify(joined));
    assert.ok(existsSync(join(newRepo, ".squad/squad.db")));
  } finally {
    await client.close();
  }
  install(join(relocated, "squad source"), newRepo);
  install(join(relocated, "squad source"), newRepo, ["--check"]);
  assert.equal(readFileSync(join(newRepo, ".mcp.json"), "utf8"), corrected);
});

test("non-sibling launcher warns and unchanged legacy paths migrate safely", () => {
  const f = fixture("absolute-fallback");
  assert.match(f.run(), /not a sibling.*absolute path/);
  const configPath = join(f.repo, ".mcp.json");
  const cfg = JSON.parse(readFileSync(configPath));
  cfg.mcpServers.squad.env.SQUAD_DIR = join(f.repo, ".squad");
  writeFileSync(configPath, JSON.stringify(cfg));
  const receiptPath = join(f.repo, ".claude/skills/squad/.install-local.json");
  const receipt = JSON.parse(readFileSync(receiptPath));
  receipt.fragments[".mcp.json"].values["mcpServers/squad/env/SQUAD_DIR"].installed = join(f.repo, ".squad");
  writeFileSync(receiptPath, JSON.stringify(receipt));
  f.run();
  assert.equal(JSON.parse(readFileSync(configPath)).mcpServers.squad.env.SQUAD_DIR, ".squad");
  f.run("install.sh", ["--check"]);
});


test("relative global Codex launchers remain preserved and require cwd verification", () => {
  const f = fixture("relative-global");
  mkdirSync(f.env.CODEX_HOME);
  const configPath = join(f.env.CODEX_HOME, "config.toml");
  const config = '[mcp_servers.squad]\ncommand = "node"\nargs = ["../squad/dist/index.js"]\n';
  writeFileSync(configPath, config);
  f.run();
  const output = f.run("install.sh", ["--check"], 1);
  assert.match(output, /relative global Codex runtime path depends on each project's working directory/);
  assert.equal(readFileSync(configPath, "utf8"), config);
});
