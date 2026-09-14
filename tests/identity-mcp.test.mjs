import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
test("real MCP sessions and CLI calls retain server-stamped identities", async () => {
  const room = mkdtempSync(join(tmpdir(), "squad-mcp-identity-"));
  const clients = [];
  async function connect(extra = {}) {
    const env = {
      ...process.env,
      SQUAD_DIR: room,
      SQUAD_PROVIDER: "openai",
      SQUAD_MODEL: "gpt-6",
      ...extra,
    };
    delete env.SQUAD_PERSONA;
    if (!extra.SQUAD_SESSION_ID) delete env.SQUAD_SESSION_ID;
    const client = new Client({ name: "identity-test", version: "1" });
    clients.push(client);
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve("dist/index.js")],
        env,
        stderr: "pipe",
      }),
    );
    return client;
  }
  const call = async (client, name, args = {}) =>
    JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  try {
    const a = await connect();
    const b = await connect();
    const first = await call(a, "squad_join");
    const second = await call(b, "squad_join");
    assert.match(first.persona, /^openai-gpt-6-[a-f0-9]{8}$/);
    assert.notEqual(first.persona, second.persona);
    assert.notEqual(first.identity_id, first.session_id);
    assert.equal((await call(a, "squad_join")).persona, first.persona);
    await call(a, "squad_send", { body: "mcp a" });
    await call(b, "squad_send", { body: "mcp b" });
    assert.deepEqual(
      (await call(a, "squad_check")).messages.filter((m) => m.kind === "chat").map((m) => m.body),
      ["mcp b"],
    );
    assert.deepEqual(
      (await call(b, "squad_check")).messages.filter((m) => m.kind === "chat").map((m) => m.body),
      ["mcp a"],
    );
    for (const body of ["cli one", "cli two"]) {
      const env = {
        ...process.env,
        SQUAD_DIR: room,
        SQUAD_SESSION_ID: first.identity_id,
        SQUAD_MODEL: "changed",
      };
      delete env.SQUAD_PERSONA;
      const result = spawnSync(process.execPath, [resolve("dist/index.js"), "send", body], {
        env,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
    }
    const history = (await call(b, "squad_check")).messages;
    assert.deepEqual(
      history.filter((m) => m.body.startsWith("cli ")).map((m) => m.body),
      ["cli one", "cli two"],
    );
    assert.equal(
      history.filter((m) => m.body.startsWith("cli ")).every((m) => m.sender === first.persona),
      true,
    );
    await a.close();
    const resumed = await connect({
      SQUAD_SESSION_ID: first.identity_id,
      SQUAD_MODEL: "different",
    });
    assert.equal((await call(resumed, "squad_join")).persona, first.persona);
    const invalid = await b.callTool({
      name: "squad_join",
      arguments: { persona: "a".repeat(129) },
    });
    assert.equal(invalid.isError, true);
    assert.equal((await call(b, "squad_join", { persona: "a".repeat(128) })).persona.length, 128);
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    rmSync(room, { recursive: true, force: true });
  }
});
