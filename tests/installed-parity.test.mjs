import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
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
        "steward",
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
        resolve(repo, joined[0].db),
        resolve(repo, joined[1].db),
        "both installed configurations select the same room",
      );
      assert.equal(resolve(repo, joined[0].db), resolve(repo, cli(["path"]).trim()));
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
      const submission = { request_key: "installed-parity", config_revision: 1, commits: ["a".repeat(40)], node_refs: [] };
      const attempt = await call(clients[0], "squad_integration_submit", submission);
      assert.equal(attempt.status, "pending");
      assert.equal(attempt.submitted_by, joined[0].persona);
      assert.deepEqual(await call(clients[1], "squad_integration_attempt_get", { id: attempt.id }), attempt);
      assert.deepEqual(JSON.parse(cli(["integration", "attempt", attempt.id])), attempt);
      assert.deepEqual(JSON.parse(cli(["integration", "submit", "--request-key", submission.request_key,
        "--config-revision", "1", "--commit", submission.commits[0]])), attempt);
      assert.deepEqual(await call(clients[1], "squad_integration_attempt_list", { status: "pending" }), [attempt]);
      assert.deepEqual(JSON.parse(cli(["integration", "attempts", "--status", "verified"])), []);
      const secondAttempt = JSON.parse(cli(["integration", "submit", "--request-key", "cli-submission",
        "--config-revision", "1", "--commit", "b".repeat(40)]));
      assert.deepEqual(await call(clients[0], "squad_integration_attempt_get", { id: secondAttempt.id }), secondAttempt);
      assert.equal((await call(clients[1], "squad_integration_attempt_list", { limit: 1 })).length, 1);
      const unsupportedVerify = await clients[0].callTool({ name: "squad_integration_verify", arguments: { id: attempt.id } });
      assert.equal(unsupportedVerify.isError, true);
      // Exercise the installed MCP executor against a real remote, including CLI receipt parity.
      const bare = join(scratch, "integration.git");
      assert.equal(spawnSync("git", ["init", "--bare", "-q", bare]).status, 0);
      assert.equal(
        spawnSync("git", ["-C", repo, "remote", "set-url", "origin", bare])
          .status,
        0,
      );
      for (const [key, value] of [
        ["user.name", "test"],
        ["user.email", "test@example.org"],
      ])
        assert.equal(
          spawnSync("git", ["-C", repo, "config", key, value]).status,
          0,
        );
      writeFileSync(join(repo, "bank-base"), "baseline");
      assert.equal(spawnSync("git", ["-C", repo, "add", "bank-base"]).status, 0);
      assert.equal(spawnSync("git", ["-C", repo, "commit", "-qm", "baseline"]).status, 0);
      assert.equal(spawnSync("git", ["-C", repo, "push", "origin", "HEAD:research/integration"]).status, 0);
      writeFileSync(join(repo, "bank-artifact"), "committed artifact");
      assert.equal(
        spawnSync("git", ["-C", repo, "add", "bank-artifact"]).status,
        0,
      );
      assert.equal(
        spawnSync("git", ["-C", repo, "commit", "-qm", "artifact"]).status,
        0,
      );
      const committed = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).stdout.trim();
      await call(clients[0], "squad_integration_set", {
        repository: repo,
        remote: "origin",
        branch: "research/integration",
        build_command: "test -f bank-artifact",
        steward: joined[0].persona,
        expected_revision: 1,
      });
      const node = await call(clients[0], "squad_node_create", {
        title: "Shared durable claim", question: "Is the committed artifact correct?",
        artifacts: [{ path: "bank-artifact", commit: committed, theorem: "declared_claim" }],
      });
      assert.deepEqual(await call(clients[1], "squad_node_get", { id: node.id }), node);
      assert.deepEqual(JSON.parse(cli(["node", "show", String(node.id)])), node);
      const worktree = join(scratch, "peer-worktree");
      assert.equal(spawnSync("git", ["-C", repo, "worktree", "add", "--detach", worktree, committed]).status, 0);
      const fromWorktree = spawnSync(process.execPath, [cliPath, "node", "show", String(node.id)], {
        cwd: worktree, env: baseEnv, encoding: "utf8",
      });
      assert.equal(fromWorktree.status, 0, fromWorktree.stderr);
      assert.deepEqual(JSON.parse(fromWorktree.stdout), node);
      assert.ok((await call(clients[1], "squad_join")).nodes.some(n => n.id === node.id));
      const cliNode = JSON.parse(cli(["node", "create", "A second exploratory question"]));
      const editedNode = await call(clients[1], "squad_node_update", {
        id: cliNode.id, expected_revision: cliNode.revision, dependencies: [node.id],
      });
      assert.deepEqual(JSON.parse(cli(["node", "show", String(cliNode.id)])), editedNode);
      assert.deepEqual(JSON.parse(cli(["node", "list"])), await call(clients[0], "squad_node_list"));
      const invalidNode = await clients[0].callTool({ name: "squad_node_update", arguments: {
        id: node.id, expected_revision: node.revision, dependencies: [999999],
      } });
      assert.equal(invalidNode.isError, true);
      const banking = await call(clients[0], "squad_node_submit", {
        id: node.id, expected_revision: node.revision, request_key: "installed-bank", config_revision: 2,
      });
      assert.deepEqual(JSON.parse(cli(["node", "submit", String(node.id), String(node.revision), "installed-bank", "2"])), banking);
      const unknownSelection = await clients[0].callTool({
        name: "squad_bank",
        arguments: { id: banking.id, theorem: "unknown" },
      });
      assert.equal(unknownSelection.isError, true);
      const unknownSubmission = await clients[0].callTool({
        name: "squad_integration_submit",
        arguments: {
          request_key: "ignored-theorem",
          config_revision: 2,
          commits: [committed],
          theorem: "unknown",
        },
      });
      assert.equal(unknownSubmission.isError, true);
      const banked = await call(clients[0], "squad_bank", { id: banking.id });
      assert.equal(banked.status, "verified", JSON.stringify(banked));
      assert.deepEqual(JSON.parse(cli(["bank", banking.id])), banked);
      const bankedNode = await call(clients[1], "squad_node_get", { id: node.id });
      assert.equal(bankedNode.banked, true);
      assert.equal(bankedNode.review_status, "unreviewed");
      assert.equal(bankedNode.integrations[0].attempt_id, banked.id);
      assert.deepEqual(JSON.parse(cli(["node", "show", String(node.id)])), bankedNode);
      const nodeClaim = await call(clients[0], "squad_node_claim", {
        id: node.id,
        expected_revision: node.revision,
        target: joined[1].persona,
      });
      const cliClaim = JSON.parse(
        cli([
          "node",
          "claim",
          String(node.id),
          String(node.revision),
          joined[1].persona,
        ]),
      );
      assert.equal(cliClaim.review.id, nodeClaim.review.id);
      await call(clients[1], "squad_review_claim", { id: nodeClaim.review.id });
      const reviewInput = {
        request_id: nodeClaim.review.id,
        request_key: "installed-review",
        attempt_id: banking.id,
        verdict: "approve",
        rationale: "Inspected committed artifact.",
      };
      const forged = await clients[1].callTool({
        name: "squad_node_review",
        arguments: { ...reviewInput, build: { exit_code: 0 } },
      });
      assert.equal(forged.isError, true);
      const reviewed = await call(clients[1], "squad_node_review", reviewInput);
      assert.equal(reviewed.status, "approved", JSON.stringify(reviewed));
      assert.equal(reviewed.build.clean, true);
      assert.equal(
        (await call(clients[0], "squad_node_get", { id: node.id })).review_status,
        "approved",
      );
      assert.deepEqual(
        JSON.parse(cli(["node", "show", String(node.id)])),
        await call(clients[1], "squad_node_get", { id: node.id }),
      );
      assert.deepEqual(
        JSON.parse(cli(["steward", "status"])),
        await call(clients[0], "squad_steward_status", {}),
      );
      // squad_room_doctor / `squad doctor --room` (#77): any identity may call
      // it (clients[1] here is not the configured steward), and CLI and MCP
      // observe the same durable state -- the just-banked node's artifact is
      // reported verified-clean in both.
      const roomDoctorReport = await call(clients[1], "squad_room_doctor", {});
      assert.ok(Array.isArray(roomDoctorReport.findings));
      const bankedObservation = roomDoctorReport.branch_observations.find(
        (o) => o.node_id === node.id,
      );
      assert.equal(bankedObservation.classification, "verified_clean");
      const roomDoctorCli = cli(["doctor", "--room"]);
      assert.match(roomDoctorCli, /read-only room drift report/);
      assert.match(roomDoctorCli, new RegExp(`node ${node.id} `));
      for (const name of ["squad_steward_status", "squad_steward_tick"]) {
        const bad = await clients[0].callTool({ name, arguments: { force: true } });
        assert.equal(bad.isError, true);
      }
      const unauthorizedTick = await clients[1].callTool({
        name: "squad_steward_tick", arguments: {},
      });
      assert.equal(unauthorizedTick.isError, true);
      await call(clients[0], "squad_steward_tick", {});
      const repeatedTick = JSON.parse(cli(["steward", "tick"], {
        SQUAD_PERSONA: joined[0].persona,
      }));
      assert.equal(repeatedTick.sent.length, 0);
      assert.deepEqual(
        repeatedTick.status,
        await call(clients[1], "squad_steward_status", {}),
      );
      const outline = await call(clients[0], "squad_outline_render", {});
      assert.deepEqual(JSON.parse(cli(["outline", "render"])), outline);
      assert.deepEqual(await call(clients[1], "squad_outline_render", {}), outline);
      assert.deepEqual(
        JSON.parse(cli(["outline", "status"])),
        await call(clients[1], "squad_outline_status", {}),
      );
      assert.ok(outline.content.includes(banking.id));
      const invalidOutline = await clients[0].callTool({
        name: "squad_outline_publish",
        arguments: { request_key: "invalid", expected_target_blobs: {} },
      });
      assert.equal(invalidOutline.isError, true);
      await call(clients[0], "squad_release", {path:`node:${node.id}`});
      cli(["release",`node:${node.id}`]);
      const summary = await call(clients[1], "squad_check");
      assert.equal(summary.integration.known_submissions.verified, 1);
      assert.equal(summary.integration.known_submissions.pending, 2);
      assert.equal(summary.integration.local_work_visibility, "unobserved");
      const disabled = JSON.parse(
        cli(["integration", "unset", "--expected-revision", "2"]),
      );
      assert.deepEqual(
        await call(clients[0], "squad_integration_get"),
        disabled,
      );
      const reset = JSON.parse(
        cli([
          "integration",
          "set",
          "--expected-revision",
          "3",
          "--repository",
          repo,
          "--remote",
          "origin",
          "--branch",
          "research/integration",
          "--build-command",
          "false",
          "--steward",
          joined[1].persona,
        ]),
      );
      assert.deepEqual(await call(clients[1], "squad_integration_get"), reset);
      await call(clients[1], "squad_integration_unset", {
        expected_revision: 4,
      });

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
