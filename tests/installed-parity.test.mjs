import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
// Set this to the lifecycle implementation's TOML parser in increment 3.
import { parse } from "smol-toml";

// These are protocol clients launched from the actual installed runtime config.
// They do not represent model-driven Claude Code or Codex sessions.
test(
  "installed Claude and Codex entry points collaborate in one room",
  { timeout: 30000 },
  async () => {
    const scratch = realpathSync(
      mkdtempSync(join(tmpdir(), "squad-installed-parity-")),
    );
    const repo = join(scratch, "repo");
    const codexHome = join(scratch, "codex-home");
    mkdirSync(repo);
    const baseEnv = { ...process.env, HOME: scratch, CODEX_HOME: codexHome };
    for (const key of Object.keys(baseEnv))
      if (key.startsWith("SQUAD_")) delete baseEnv[key];
    const clients = [];
    const followers = [];
    const cliPath = resolve("dist/index.js");
    const call = async (client, name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, JSON.stringify(result));
      return JSON.parse(result.content[0].text);
    };
    const cli = (args, extra = {}) => {
      const result = spawnSync(process.execPath, [cliPath, ...args], {
        cwd: repo,
        env: { ...baseEnv, ...extra },
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    function follow(extra) {
      const child = spawn(process.execPath, [cliPath, "tail"], {
        cwd: repo,
        env: { ...baseEnv, ...extra },
        stdio: ["ignore", "pipe", "pipe"],
      });
      followers.push(child);
      let output = "";
      let errors = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        errors += chunk;
      });
      return async (text) => {
        const deadline = Date.now() + 7000;
        while (!output.includes(text)) {
          assert.equal(child.exitCode, null, errors);
          assert.ok(
            Date.now() < deadline,
            `tail did not receive ${text}: ${output}\n${errors}`,
          );
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      };
    }
    try {
      assert.equal(spawnSync("git", ["init", "-q", repo]).status, 0);
      const installed = spawnSync(
        "bash",
        ["install.sh", "-y", "--no-link", repo],
        {
          env: baseEnv,
          encoding: "utf8",
        },
      );
      assert.equal(installed.status, 0, installed.stderr);
      const guidance = readFileSync(join(repo, "CLAUDE.md"), "utf8");
      assert.equal(guidance, readFileSync(join(repo, "AGENTS.md"), "utf8"));
      assert.ok(
        guidance.includes(
          readFileSync("skills/squad/instructions.md", "utf8").trim(),
        ),
      );
      for (const name of [
        "join",
        "goals",
        "card",
        "clear",
        "fanout",
        "conventions",
      ]) {
        const canonical = readFileSync(
          `skills/squad/references/${name}.md`,
          "utf8",
        );
        for (const runtime of [".claude", ".agents"]) {
          assert.equal(
            readFileSync(
              join(repo, runtime, `skills/squad/references/${name}.md`),
              "utf8",
            ),
            canonical,
          );
        }
      }
      const configs = [
        JSON.parse(readFileSync(join(repo, ".mcp.json"), "utf8")).mcpServers
          .squad,
        parse(readFileSync(join(codexHome, "config.toml"), "utf8")).mcp_servers
          .squad,
      ];
      const joined = [];
      for (const [index, config] of configs.entries()) {
        assert.ok(
          !config.env?.SQUAD_PERSONA,
          "fresh installs must not pin runtime identities",
        );
        const client = new Client({
          name: `installed-adapter-${index}`,
          version: "1",
        });
        clients.push(client);
        await client.connect(
          new StdioClientTransport({
            command: config.command,
            args: config.args,
            cwd: repo,
            env: { ...baseEnv, ...config.env },
            stderr: "pipe",
          }),
        );
        joined.push(await call(client, "squad_join"));
      }
      assert.equal(
        joined[0].db,
        joined[1].db,
        "both installed configurations select the same room",
      );
      assert.equal(joined[0].db, cli(["path"]).trim());
      assert.notEqual(joined[0].persona, joined[1].persona);
      assert.ok(
        joined.every(
          (identity) =>
            identity.identity_id &&
            identity.identity_id !== identity.session_id,
        ),
      );
      assert.deepEqual(
        (await clients[0].listTools()).tools,
        (await clients[1].listTools()).tools,
      );
      const matrixTools = readFileSync("docs/capabilities.md", "utf8")
        .split("\n")
        .filter((line) => line.startsWith("|"))
        .flatMap((line) =>
          [...(line.split("|")[2] ?? "").matchAll(/`(squad_\w+)`/g)].map(
            (match) => match[1],
          ),
        );
      assert.deepEqual(
        [...new Set(matrixTools)].sort(),
        (await clients[0].listTools()).tools.map((tool) => tool.name).sort(),
        "capability matrix must describe every registered MCP tool",
      );

      assert.equal(spawnSync("git", ["-C", repo, "remote", "add", "origin", "https://example.org/research.git"]).status, 0);
      const integration = await call(clients[0], "squad_integration_set", {
        repository: repo, remote: "origin", branch: "research/integration",
        build_command: "false", steward: joined[0].persona, expected_revision: 0,
      });
      assert.deepEqual(await call(clients[1], "squad_integration_get"), integration);
      assert.deepEqual(JSON.parse(cli(["integration", "check"])), integration);
      assert.deepEqual(await call(clients[1], "squad_integration_check"), integration);
      const disabled = JSON.parse(cli(["integration", "unset", "--expected-revision", "1"]));
      assert.deepEqual(await call(clients[0], "squad_integration_get"), disabled);
      const reset = JSON.parse(cli(["integration", "set", "--expected-revision", "2",
        "--repository", repo, "--remote", "origin", "--branch", "research/integration",
        "--build-command", "false", "--steward", joined[1].persona]));
      assert.deepEqual(await call(clients[1], "squad_integration_get"), reset);
      await call(clients[1], "squad_integration_unset", { expected_revision: 3 });

      const goal = await call(clients[0], "squad_goal_add", {
        body: "verify installed collaboration",
      });
      assert.ok(
        (await call(clients[1], "squad_goals")).some(
          (item) => item.id === goal.id,
        ),
      );
      for (const [index, client] of clients.entries()) {
        const peer = clients[1 - index];
        const identityEnv = { SQUAD_SESSION_ID: joined[index].identity_id };
        const path = `participant-${index}.md`;
        await call(client, "squad_claim", { path });
        assert.ok(
          (await call(peer, "squad_claims")).some(
            (item) =>
              item.path === path && item.persona === joined[index].persona,
          ),
        );
        await call(peer, "squad_check");
        const body = `participant ${index} posted progress`;
        await call(client, "squad_send", { body });
        assert.ok(
          (await call(peer, "squad_check", { peek: true })).messages.some(
            (item) => item.body === body,
          ),
        );
        assert.ok(
          (await call(peer, "squad_check")).messages.some(
            (item) =>
              item.body === body && item.sender === joined[index].persona,
          ),
        );
        assert.ok(
          !(await call(peer, "squad_check")).messages.some(
            (item) => item.body === body,
          ),
          "ordinary check consumes unread messages",
        );
        assert.ok(
          !(await call(client, "squad_check")).messages.some(
            (item) => item.body === body,
          ),
          "MCP check excludes self",
        );
        assert.ok(
          cli(["read", "-n", "100"], identityEnv).includes(body),
          "CLI history includes self",
        );
        assert.ok(
          cli(["read", "-n", "100"], identityEnv).includes(body),
          "CLI history is stateless",
        );
        const tailReceives = follow(identityEnv);
        await tailReceives(body); // Receipt of history establishes that tail has started.
        const live = `live update for participant ${index}`;
        await call(peer, "squad_send", { body: live });
        await tailReceives(live);
        await call(client, "squad_check");
        const waiting = call(client, "squad_check", { wait_seconds: 5 });
        await call(peer, "squad_send", { body: `long poll ${index}` });
        assert.ok(
          (await waiting).messages.some(
            (item) => item.body === `long poll ${index}`,
          ),
        );
        cli(["send", `CLI handoff ${index}`], identityEnv);
        assert.ok(
          (await call(peer, "squad_check")).messages.some(
            (item) =>
              item.body === `CLI handoff ${index}` &&
              item.sender === joined[index].persona,
          ),
        );
        await call(client, "squad_release", { path });
      }
      await call(clients[1], "squad_goal_done", { id: goal.id });
      assert.ok(
        !(await call(clients[0], "squad_goals")).some(
          (item) => item.id === goal.id,
        ),
      );
      assert.ok(
        (await call(clients[0], "squad_goals", { include_done: true })).some(
          (item) =>
            item.id === goal.id &&
            item.status === "done" &&
            item.done_by === joined[1].persona,
        ),
      );
      assert.ok(
        cli(["goals"]).includes(goal.body),
        "CLI includes completed goals by default",
      );
      await call(clients[0], "squad_goal_reopen", { id: goal.id });
      assert.ok(
        (await call(clients[1], "squad_goals")).some(
          (item) => item.id === goal.id,
        ),
      );
      await call(clients[0], "squad_goal_done", { id: goal.id });
      assert.equal((await call(clients[1], "squad_claims")).length, 0);

      const missingTitle = await clients[0].callTool({
        name: "squad_card_create",
        arguments: { question: "MCP requires a title" },
      });
      assert.equal(missingTitle.isError, true);
      cli(["card", "create", "CLI can derive this title"]);
      const cards = await call(clients[1], "squad_card_list");
      assert.ok(
        cards.some(
          (card) =>
            card.title === "CLI can derive this title" &&
            card.question === card.title,
        ),
      );

      for (const client of clients) {
        for (const name of [
          "squad_export",
          "squad_import",
          "squad_doctor",
          "squad_path",
          "squad_tail",
          "squad_review_get",
          "squad_nuke",
          "squad_codex_reentry",
        ]) {
          const result = await client.callTool({ name, arguments: {} });
          assert.equal(result.isError, true, `${name} must fail explicitly`);
        }
      }
      for (const command of ["join", "check"]) {
        const result = spawnSync(process.execPath, [cliPath, command], {
          cwd: repo,
          env: baseEnv,
          encoding: "utf8",
        });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /unknown command/);
      }
      await Promise.all(clients.map((client) => call(client, "squad_leave")));
    } finally {
      await Promise.all(
        followers.map(
          (child) =>
            new Promise((resolve) => {
              if (child.exitCode !== null || child.signalCode !== null)
                return resolve();
              child.once("exit", resolve);
              child.kill("SIGTERM");
            }),
        ),
      );
      await Promise.all(clients.map((client) => client.close()));
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);
