import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { openDb, SCHEMA_VERSION } from "../dist/db.js";
import { Squad } from "../dist/core.js";

for (const format of ["sha1", "sha256"])
  test(`outline ${format} failed build resumes archived snapshot after restart and export/import`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "squad-outline-retry-"));
    const repo = join(root, "repo"),
      remote = join(root, "remote.git"),
      gate = join(root, "gate");
    const git = (cwd, ...args) =>
      execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    execFileSync("git", [
      "init",
      "-q",
      "--bare",
      `--object-format=${format}`,
      remote,
    ]);
    execFileSync("git", [
      "init",
      "-q",
      "-b",
      "main",
      `--object-format=${format}`,
      repo,
    ]);
    git(repo, "config", "user.name", "Test");
    git(repo, "config", "user.email", "test@example.org");
    writeFileSync(join(repo, "base"), "base\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "base");
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "origin", "main");
    const old = process.env.SQUAD_DIR;
    process.env.SQUAD_DIR = join(root, "room");
    let db = openDb(),
      squad = new Squad(db, "author");
    t.after(() => {
      if (db.isOpen) db.close();
      if (old === undefined) delete process.env.SQUAD_DIR;
      else process.env.SQUAD_DIR = old;
      rmSync(root, { recursive: true, force: true });
    });
    squad.integrationSet(
      {
        repository: repo,
        remote: "origin",
        branch: "main",
        build_command: `test -f '${gate}'`,
        steward: "author",
      },
      0,
    );
    const node = squad.nodeCreate({
      title: "negative investigation",
      question: "Does it fail?",
    });
    squad.cardTransition(
      node.id,
      "ABANDONED",
      "Disproved the proposed mechanism",
    );
    assert.match(squad.outlineRender().content, /ABANDONED/);
    assert.match(
      squad.outlineRender().content,
      /Disproved the proposed mechanism/,
    );
    const failed = await squad.outlinePublish({
      request_key: "retry",
      path: "generated/outline.md",
    });
    assert.equal(failed.attempt.status, "failed");
    squad.cardUpdate(node.id, { question: "Changed while build failed" });
    db.close();
    db = openDb();
    squad = new Squad(db, "peer");
    writeFileSync(gate, "pass");
    const resumed = await squad.outlinePublish({
      request_key: "retry",
      path: "generated/outline.md",
    });
    assert.equal(resumed.attempt.status, "verified");
    assert.equal(resumed.fresh, false);
    assert.equal(resumed.source_commit, failed.source_commit);
    assert.equal(resumed.version, failed.version);
    assert.equal(
      git(remote, "show", `main:generated/outline.md`),
      failed.content.trim(),
    );
    await assert.rejects(
      squad.outlinePublish({ request_key: "retry", path: "other.md" }),
      /different path/,
    );
    const backup = join(root, "backup.db");
    const counts = await squad.exportRoom(backup);
    assert.equal(counts.outline_publications, 1);
    assert.equal(SCHEMA_VERSION, 9);
    squad.clear();
    assert.equal(
      squad.outlineStatus("generated/outline.md").publications.length,
      0,
    );
    squad.importRoom(backup);
    assert.equal(
      squad.outlineStatus("generated/outline.md").publications[0].source_commit,
      failed.source_commit,
    );
  });

test("outline CLI rejects unsupported options and reads without adding presence", (t) => {
  const root = mkdtempSync(join(tmpdir(), "squad-outline-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = (...args) =>
    spawnSync(
      process.execPath,
      [resolve("dist/index.js"), "outline", ...args],
      {
        env: { ...process.env, SQUAD_DIR: root, SQUAD_PERSONA: "reader" },
        encoding: "utf8",
      },
    );
  assert.equal(cli("render").status, 0);
  assert.equal(cli("status").status, 0);
  const db = new DatabaseSync(join(root, "squad.db"), { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 0);
  } finally {
    db.close();
  }
  for (const args of [
    ["render", "--fake"],
    ["status", "--fake"],
    ["publish", "key", "--fake"],
    ["publish", "key", "--build-timeout-ms", "NaN"],
  ])
    assert.notEqual(cli(...args).status, 0);
});

test("outline MCP exposes strict render/status/publish contracts", async (t) => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/stdio.js"
  );
  const root = mkdtempSync(join(tmpdir(), "squad-outline-mcp-"));
  const client = new Client({ name: "outline-test", version: "1" });
  t.after(async () => {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve("dist/index.js")],
      env: { ...process.env, SQUAD_DIR: root, SQUAD_PERSONA: "reader" },
      stderr: "pipe",
    }),
  );
  const { tools } = await client.listTools();
  for (const name of [
    "squad_outline_render",
    "squad_outline_status",
    "squad_outline_publish",
  ])
    assert.ok(tools.some((tool) => tool.name === name));
  const render = await client.callTool({
    name: "squad_outline_render",
    arguments: {},
  });
  assert.ok(!render.isError);
  const invalid = await client.callTool({
    name: "squad_outline_render",
    arguments: { fake: true },
  });
  assert.equal(invalid.isError, true);
  const invalidPublish = await client.callTool({
    name: "squad_outline_publish",
    arguments: { request_key: "x", expected_target_blobs: {} },
  });
  assert.equal(invalidPublish.isError, true);
});
