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
  assert.match(a.persona, /^openai-gpt-6-[a-f0-9]{4}$/);
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
test("suffixes are random, reroll on collision, and reservations survive reconnect and model changes", async () => {
  const { automaticPersona } = await import("../dist/identity.js");
  const opts = {
    provider: "anthropic",
    model: "sonnet",
    sessionId: "12345678-1111-4111-8111-111111111111",
  };
  const suffixes = (...values) => () => values.shift();
  assert.equal(automaticPersona(db, opts, { suffix: suffixes("1234") }), "anthropic-sonnet-1234");
  // A forced collision rerolls to a different 4-hex suffix; the name never grows
  // and never borrows from the (shared-prefix) session token.
  const second = automaticPersona(
    db,
    { ...opts, sessionId: "12345678-2222-4222-8222-222222222222" },
    { suffix: suffixes("1234", "1234", "beef") },
  );
  assert.equal(second, "anthropic-sonnet-beef");
  assert.throws(
    () =>
      automaticPersona(
        db,
        { ...opts, sessionId: "12345678-3333-4333-8333-333333333333" },
        { suffix: () => "1234" },
      ),
    /Could not reserve a free automatic name/,
  );
  assert.equal(
    db
      .prepare("SELECT 1 FROM agent_identities WHERE identity_id = ?")
      .get("12345678-3333-4333-8333-333333333333"),
    undefined,
    "a failed reservation leaves nothing behind",
  );
  const a = new Squad(db, undefined, opts);
  assert.equal(a.persona, "anthropic-sonnet-1234");
  a.join();
  a.leave();
  const resumed = new Squad(db, undefined, { ...opts, model: "different" });
  assert.equal(resumed.persona, a.persona);
  resumed.join();
  assert.equal(resumed.session().left_ts, null);
});
test("the persona never contains a prefix of the resume token", () => {
  const sessionId = "a1b2c3d4-5555-4555-8555-555555555555";
  // Occupy the one 4-hex name a token-derived suffix could take, so the check is deterministic.
  db.prepare("INSERT INTO agent_identities (identity_id, persona) VALUES (?, ?)").run(
    "ffffffff-5555-4555-8555-555555555555",
    "opus-5-a1b2",
  );
  const s = new Squad(db, undefined, { model: "opus-5", sessionId });
  assert.match(s.persona, /^opus-5-[a-f0-9]{4}$/);
  assert.notEqual(s.persona, "opus-5-a1b2");
  assert.equal(s.persona.includes("a1b2c3d4"), false);
  assert.equal(s.identityId, sessionId);
});
test("old-format reservations resolve unchanged", () => {
  const sessionId = "abcdef01-1111-4111-8111-111111111111";
  db.prepare("INSERT INTO agent_identities (identity_id, persona) VALUES (?, ?)").run(
    sessionId,
    "unknown-unknown-abcdef01",
  );
  const s = new Squad(db, undefined, { model: "opus-5", sessionId });
  assert.equal(s.persona, "unknown-unknown-abcdef01");
  assert.equal(s.requestModelLabel("opus-5").applied, false);
  assert.equal(s.persona, "unknown-unknown-abcdef01");
});
test("self-reported model labels a fresh name; env wins; established names never change", () => {
  const fresh = new Squad(db);
  assert.match(fresh.persona, /^agent-[a-f0-9]{4}$/);
  const outcome = fresh.requestModelLabel("Opus 5");
  assert.equal(outcome.applied, true);
  assert.match(fresh.persona, /^opus-5-[a-f0-9]{4}$/);
  const labelled = fresh.persona;
  assert.equal(
    db.prepare("SELECT persona FROM agent_identities WHERE identity_id = ?").get(fresh.identityId)
      .persona,
    labelled,
  );
  // Same label again is a silent no-op; a different one is refused.
  assert.equal(fresh.requestModelLabel("opus-5").note, undefined);
  assert.match(fresh.requestModelLabel("gpt-6").note, /never renamed/);
  assert.equal(fresh.persona, labelled);
  // Resume with a different self-reported model returns the original name.
  const resumed = new Squad(db, undefined, { sessionId: fresh.identityId });
  assert.equal(resumed.persona, labelled);
  assert.equal(resumed.requestModelLabel("gpt-6").applied, false);
  assert.equal(resumed.persona, labelled);

  const env = new Squad(db, undefined, { model: "opus-5" });
  assert.match(env.requestModelLabel("gpt-6").note, /SQUAD_MODEL/);
  assert.match(env.persona, /^opus-5-[a-f0-9]{4}$/);

  const published = new Squad(db);
  published.join();
  assert.equal(published.requestModelLabel("gpt-6").applied, false);
  assert.match(published.persona, /^agent-[a-f0-9]{4}$/);

  // A clear after relabelling restores the reservation under the same label.
  const cleared = new Squad(db);
  cleared.requestModelLabel("gpt-6");
  cleared.join();
  cleared.clear();
  cleared.send("after clear");
  assert.match(cleared.persona, /^gpt-6-[a-f0-9]{4}$/);
});
test("provider prefixes the label only when set", () => {
  assert.match(new Squad(db, undefined, { provider: "groq", model: "llama-3" }).persona, /^groq-llama-3-[a-f0-9]{4}$/);
  assert.match(new Squad(db, undefined, { provider: "groq" }).persona, /^groq-agent-[a-f0-9]{4}$/);
  const withLabel = new Squad(db, undefined, { provider: "groq" });
  withLabel.requestModelLabel("llama-3");
  assert.match(withLabel.persona, /^groq-llama-3-[a-f0-9]{4}$/);
});
test("metadata fallback, normalization, length, and custom namespaces", () => {
  assert.match(new Squad(db).persona, /^agent-[a-f0-9]{4}$/);
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
