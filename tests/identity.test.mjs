import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../dist/db.js";
import { Squad } from "../dist/core.js";
process.env.SQUAD_DIR = mkdtempSync(join(tmpdir(), "squad-identity-"));
test.after(() => rmSync(process.env.SQUAD_DIR, { recursive: true, force: true }));
const db = openDb();
test("automatic identities distinguish sessions and retain routing identity", () => {
  const a = new Squad(db, undefined, { provider: "openai", model: "gpt-6" });
  const b = new Squad(db, undefined, { provider: "openai", model: "gpt-6" });
  assert.match(a.persona, /^openai-gpt-6-[a-f0-9]{8}$/);
  assert.notEqual(a.persona, b.persona);
  const name = a.persona;
  a.join();
  b.join();
  a.send("from a");
  b.send("from b");
  assert.equal(
    a.check().some((m) => m.body === "from a"),
    false,
  );
  assert.equal(a.read().find((m) => m.body === "from b").sender, b.persona);
  a.join();
  assert.equal(a.persona, name);
});
test("colliding shortened UUIDs extend and reservations survive reconnect and model changes", () => {
  const opts = {
    provider: "anthropic",
    model: "sonnet",
    sessionId: "12345678-1111-4111-8111-111111111111",
  };
  const a = new Squad(db, undefined, opts);
  const b = new Squad(db, undefined, {
    ...opts,
    sessionId: "12345678-2222-4222-8222-222222222222",
  });
  assert.equal(a.persona, "anthropic-sonnet-12345678");
  assert.equal(b.persona, "anthropic-sonnet-123456782222");
  a.join();
  a.leave();
  const resumed = new Squad(db, undefined, { ...opts, model: "different" });
  assert.equal(resumed.persona, a.persona);
  resumed.join();
  assert.equal(resumed.session().left_ts, null);
});
test("metadata fallback, normalization, length, and custom namespaces", () => {
  assert.match(new Squad(db).persona, /^unknown-unknown-[a-f0-9]{8}$/);
  const long = new Squad(db, undefined, {
    provider: "Provider / X",
    model: "x".repeat(200),
  });
  assert.match(long.persona, /^provider-x-/);
  assert.ok(long.persona.length <= 128);
  const custom = new Squad(db, "my-agent");
  assert.equal(custom.persona, "my-agent");
  assert.equal(custom.requestPersona("my-agent-worker", "my-agent").applied, true);
});

test("logical identity exposes a reusable token and all ownership surfaces agree", () => {
  const a = new Squad(db, undefined, { provider: "openai", model: "gpt-6" });
  const b = new Squad(db, undefined, { provider: "openai", model: "gpt-6" });
  a.join();
  b.join();
  assert.notEqual(a.identityId, a.sessionId);
  assert.equal(a.claim("identity-file").persona, a.persona);
  const review = a.reviewOpen(b.persona, "review identity");
  assert.equal(b.pendingReviews()[0].id, review.id);
  a.send("identity-a");
  b.send("identity-b");
  assert.deepEqual(
    a
      .check()
      .filter((m) => m.kind === "chat")
      .map((m) => m.body),
    ["identity-b"],
  );
  assert.deepEqual(
    b
      .check()
      .filter((m) => m.kind === "chat")
      .map((m) => m.body),
    ["identity-a"],
  );
  assert.ok(a.members().some((m) => m.persona === b.persona));
  assert.equal(
    new Squad(db, undefined, { sessionId: a.identityId, model: "changed" }).persona,
    a.persona,
  );
});

test("only explicit metadata is used and invalid session tokens fail clearly", async () => {
  const { identityFromEnv, PERSONA_PATTERN } = await import("../dist/identity.js");
  assert.deepEqual(identityFromEnv({ CODEX_THREAD_ID: "x", CLAUDECODE: "1" }), {
    provider: undefined,
    model: undefined,
    sessionId: undefined,
  });
  assert.equal(PERSONA_PATTERN.test("a".repeat(128)), true);
  assert.equal(PERSONA_PATTERN.test("a".repeat(129)), false);
  assert.throws(() => new Squad(db, undefined, { sessionId: "bad" }), /must be a UUID/);
});

test("clear followed by reuse restores an automatic reservation", () => {
  const a = new Squad(db, undefined, { provider: "openai", model: "gpt-6" });
  const name = a.persona;
  a.join();
  a.clear();
  a.send("after clear");
  assert.equal(
    db.prepare("SELECT persona FROM agent_identities WHERE identity_id = ?").get(a.identityId)
      ?.persona,
    name,
  );
  assert.equal(
    new Squad(db, undefined, { sessionId: a.identityId, model: "changed" }).persona,
    name,
  );
});
