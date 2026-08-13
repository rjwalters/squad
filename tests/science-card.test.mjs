import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

process.env.SQUAD_DIR = mkdtempSync(join(tmpdir(), "squad-card-test-"));

const { openDb } = await import("../dist/db.js");
const { Squad } = await import("../dist/core.js");
const {
  PHASE_TRANSITIONS,
  SCIENCE_CARD_SCHEMA_ID,
  SCIENCE_CARD_SCHEMA_VERSION,
  scienceCardSchema,
  validateScienceCard,
} = await import("../dist/science-card.js");

test.after(() => rmSync(process.env.SQUAD_DIR, { recursive: true, force: true }));

const db = openDb();
const claude = new Squad(db, "claude");
const codex = new Squad(db, "codex");

/** Walk a fresh card down the spine to `target`, one legal hop at a time. */
const SPINE = [
  "DIVERGE",
  "ORIENT",
  "HYPOTHESIZE",
  "DERIVE",
  "ATTACK",
  "SIMULATE",
  "EXPERIMENT",
  "REPLICATE",
];
function advance(squad, id, target) {
  for (const phase of SPINE) {
    squad.cardTransition(id, phase);
    if (phase === target) return;
  }
}

// --- schema -----------------------------------------------------------------

test("the canonical schema carries a stable $id and version", () => {
  const schema = scienceCardSchema();
  assert.equal(schema.$id, SCIENCE_CARD_SCHEMA_ID);
  assert.equal(schema.version, SCIENCE_CARD_SCHEMA_VERSION);
  assert.match(String(schema.$comment), /CANONICAL DEFINITION/);
  assert.equal(schema.additionalProperties, false, "unknown fields make divergence detectable");
});

test("the schema is runtime-neutral (no Claude/Codex/Squad-specific fields)", () => {
  for (const field of Object.keys(scienceCardSchema().properties)) {
    assert.doesNotMatch(field, /claude|codex|anthropic|openai|mcp/i, `field ${field}`);
  }
});

test("a real card round-trips into a document that validates", () => {
  claude.clear();
  const card = claude.cardCreate({
    title: "Knowledge cost floor",
    question: "Does erasing a bit in this regime cost more than kT ln 2?",
    claim_kind: "empirical",
    origin_method: "divergence round 1",
    changed_assumptions: ["quasi-static erasure"],
    proposed_mechanism: "finite-time friction term",
    model_statement: "W >= kT ln 2 + c/tau",
    null_prediction: "W -> kT ln 2 as tau grows",
    discriminating_prediction: "excess work scales as 1/tau",
    decisive_falsifier: "no excess work at tau = 10 ms",
    cheapest_test: "single-bit erasure on the existing rig",
    prior_art_status: "partially-known",
    confidence: 0.4,
    novelty: 0.6,
    attempts: ["read Landauer 1961"],
  });
  claude.cardEvidenceAdd(card.id, "derivation", "notes/derivation.md#L12", "W >= kT ln 2 + c/tau");
  const doc = claude.cardDocument(card.id);

  const result = validateScienceCard(doc);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
  assert.equal(doc.schema_version, SCIENCE_CARD_SCHEMA_VERSION);
  assert.equal(doc.phase, "QUESTION");
  assert.equal(doc.status, "OPEN");
  assert.equal(doc.transitions.length, 1, "genesis transition is in the document");
  assert.equal(doc.transitions[0].from_phase, null);
});

test("invalid card documents are rejected with a reason", () => {
  claude.clear();
  const card = claude.cardCreate({ title: "T", question: "Q?" });
  const good = claude.cardDocument(card.id);

  const cases = [
    ["missing required property", (d) => delete d.question, /missing required property 'question'/],
    ["unknown phase", (d) => (d.phase = "MUSING"), /is not one of/],
    ["unknown status", (d) => (d.status = "TRUE"), /is not one of/],
    ["empty title", (d) => (d.title = ""), /minLength/],
    ["wrong type", (d) => (d.contributors = "claude"), /expected array/],
    ["confidence out of range", (d) => (d.confidence = 1.5), /above maximum/],
    ["unexpected property", (d) => (d.verified = true), /unexpected property/],
    [
      "evidence without provenance",
      (d) => d.evidence.push({ type: "experiment", body: "ran it" }),
      /missing required property 'provenance'/,
    ],
    [
      "evidence with an unknown type",
      (d) => d.evidence.push({ type: "vibes", provenance: "chat", body: "felt right" }),
      /is not one of/,
    ],
  ];

  for (const [name, mutate, pattern] of cases) {
    const doc = structuredClone(good);
    mutate(doc);
    const result = validateScienceCard(doc);
    assert.equal(result.valid, false, `${name} should be invalid`);
    assert.ok(
      result.errors.some((e) => pattern.test(e)),
      `${name}: expected an error matching ${pattern}, got ${JSON.stringify(result.errors)}`,
    );
  }
});

// --- creation ---------------------------------------------------------------

test("cardCreate opens in QUESTION, announces in chat, and seeds history", () => {
  claude.clear();
  const card = claude.cardCreate({ title: "Sharp bound", question: "Is the bound tight?" });
  assert.equal(card.phase, "QUESTION");
  assert.equal(card.status, "OPEN");
  assert.equal(card.claim_kind, "empirical", "the strict default");
  assert.equal(card.prior_art_status, "unknown");
  assert.deepEqual(card.contributors, ["claude"], "creator is the default contributor");
  assert.equal(card.created_by, "claude");

  const seen = codex.check();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, "system");
  assert.match(seen[0].body, /claude created science card #\d+ \(QUESTION\): Sharp bound/);

  const detail = codex.cardGet(card.id);
  assert.equal(detail.transitions.length, 1);
  assert.equal(detail.transitions[0].from_phase, null);
  assert.equal(detail.transitions[0].to_phase, "QUESTION");
  assert.deepEqual(detail.evidence, []);
});

test("cardCreate rejects empty text and out-of-range assessments", () => {
  assert.throws(() => claude.cardCreate({ title: "  ", question: "Q?" }), /title is required/);
  assert.throws(() => claude.cardCreate({ title: "T", question: "" }), /question is required/);
  assert.throws(
    () => claude.cardCreate({ title: "T", question: "Q?", claim_kind: "vibes" }),
    /invalid claim_kind/,
  );
  assert.throws(
    () => claude.cardCreate({ title: "T", question: "Q?", confidence: 4 }),
    /confidence must be between 0 and 1/,
  );
});

test("cardGet on a missing id throws", () => {
  assert.throws(() => claude.cardGet(9999), /no science card with id 9999/);
});

// --- transitions ------------------------------------------------------------

test("a legal transition is applied, announced, and recorded in history", () => {
  claude.clear();
  const card = claude.cardCreate({ title: "Diverge first", question: "What else could explain it?" });
  codex.check();

  const detail = codex.cardTransition(card.id, "DIVERGE", "opening the round");
  assert.equal(detail.phase, "DIVERGE");
  assert.equal(detail.status, "OPEN");
  assert.equal(detail.transitions.length, 2);
  const last = detail.transitions.at(-1);
  assert.equal(last.from_phase, "QUESTION");
  assert.equal(last.to_phase, "DIVERGE");
  assert.equal(last.persona, "codex");
  assert.equal(last.note, "opening the round");
  assert.match(claude.check().at(-1).body, /codex moved science card #\d+ QUESTION -> DIVERGE/);
});

test("an illegal transition is rejected and leaves no trace", () => {
  claude.clear();
  const card = claude.cardCreate({ title: "No shortcuts", question: "Can we skip ahead?" });
  codex.check();

  assert.throws(
    () => claude.cardTransition(card.id, "SUPPORTED"),
    /illegal transition for science card #\d+: QUESTION -> SUPPORTED \(allowed from QUESTION: DIVERGE, ORIENT, ABANDONED\)/,
  );
  assert.throws(() => claude.cardTransition(card.id, "EXPERIMENT"), /illegal transition/);
  assert.throws(() => claude.cardTransition(card.id, "NAPPING"), /invalid phase/);

  const detail = claude.cardGet(card.id);
  assert.equal(detail.phase, "QUESTION", "phase unchanged after a rejected move");
  assert.equal(detail.transitions.length, 1, "only the genesis entry — rejections are not history");
  assert.equal(codex.check().length, 0, "nothing announced for a rejected move");
});

test("the transition graph has no dangling edges", () => {
  for (const [from, targets] of Object.entries(PHASE_TRANSITIONS)) {
    for (const to of targets) {
      assert.ok(PHASE_TRANSITIONS[to], `${from} -> ${to} targets an unknown phase`);
    }
  }
});

test("reaching a terminal phase sets claim status; LEARN reopens it", () => {
  claude.clear();
  const card = claude.cardCreate({ title: "Falsify me", question: "Does the effect exist?" });
  advance(claude, card.id, "EXPERIMENT");
  const falsified = claude.cardTransition(card.id, "FALSIFIED", "no excess work at any tau");
  assert.equal(falsified.phase, "FALSIFIED");
  assert.equal(falsified.status, "FALSIFIED");
  assert.match(codex.check().at(-1).body, /EXPERIMENT -> FALSIFIED \[status FALSIFIED\]/);

  const learning = claude.cardTransition(card.id, "LEARN", "why did we expect it?");
  assert.equal(learning.status, "OPEN", "leaving a terminal phase reopens the claim");
  assert.equal(learning.phase, "LEARN");
  const pivoted = claude.cardTransition(card.id, "PIVOT");
  assert.equal(pivoted.phase, "PIVOT");
  assert.equal(claude.cardTransition(card.id, "HYPOTHESIZE").phase, "HYPOTHESIZE");
  assert.equal(
    claude.cardGet(card.id).transitions.length,
    1 + SPINE.indexOf("EXPERIMENT") + 1 + 4,
    "every legal move is retained in history",
  );
});

test("a card can be abandoned from any live phase and stays readable", () => {
  claude.clear();
  const card = claude.cardCreate({ title: "Dead end", question: "Worth chasing?" });
  claude.cardTransition(card.id, "DIVERGE");
  const abandoned = claude.cardTransition(card.id, "ABANDONED", "out of time");
  assert.equal(abandoned.status, "ABANDONED");
  assert.equal(claude.cardGet(card.id).transitions.at(-1).note, "out of time");
});

// --- evidence status is not claim status ------------------------------------

test("verified formal evidence cannot carry an empirical claim to SUPPORTED", () => {
  claude.clear();
  const card = claude.cardCreate({
    title: "Empirical claim",
    question: "Does the excess work appear on the rig?",
    claim_kind: "empirical",
  });
  claude.cardEvidenceAdd(card.id, "derivation", "notes/proof.md", "algebra checks out", {
    status: "verified",
  });
  claude.cardEvidenceAdd(card.id, "formal-check", "lean/Bound.lean", "no sorries", {
    status: "verified",
  });
  claude.cardEvidenceAdd(card.id, "simulation", "runs/42", "matches to 3%", { status: "verified" });
  advance(claude, card.id, "REPLICATE");

  assert.throws(
    () => claude.cardTransition(card.id, "SUPPORTED"),
    /cannot be SUPPORTED without unrefuted empirical evidence \(experiment or observation\)/,
  );
  assert.equal(claude.cardGet(card.id).status, "OPEN", "still unsettled");

  // Refuted empirical evidence does not count either.
  claude.cardEvidenceAdd(card.id, "experiment", "runs/43", "null result", { status: "refuted" });
  assert.throws(() => claude.cardTransition(card.id, "SUPPORTED"), /cannot be SUPPORTED/);

  claude.cardEvidenceAdd(card.id, "experiment", "runs/44", "excess work at 1/tau", {
    status: "verified",
  });
  const supported = claude.cardTransition(card.id, "SUPPORTED");
  assert.equal(supported.status, "SUPPORTED");
});

test("a formal claim can be SUPPORTED on formal evidence alone", () => {
  claude.clear();
  const card = claude.cardCreate({
    title: "Formal claim",
    question: "Is the inequality provable?",
    claim_kind: "formal",
  });
  claude.cardEvidenceAdd(card.id, "formal-check", "lean/Bound.lean", "theorem closed", {
    status: "verified",
  });
  advance(claude, card.id, "REPLICATE");
  assert.equal(claude.cardTransition(card.id, "SUPPORTED").status, "SUPPORTED");
});

test("a mixed claim is held to the empirical bar", () => {
  claude.clear();
  const card = claude.cardCreate({
    title: "Mixed claim",
    question: "Does the proved bound bind in the lab?",
    claim_kind: "mixed",
  });
  claude.cardEvidenceAdd(card.id, "formal-check", "lean/Bound.lean", "theorem closed", {
    status: "verified",
  });
  advance(claude, card.id, "REPLICATE");
  assert.throws(() => claude.cardTransition(card.id, "SUPPORTED"), /cannot be SUPPORTED/);
});

test("evidence status stays evidence-level and never edits the claim", () => {
  claude.clear();
  const card = claude.cardCreate({ title: "Status split", question: "Are they separate?" });
  const item = claude.cardEvidenceAdd(card.id, "formal-check", "lean/A.lean", "no sorries", {
    status: "verified",
  });
  assert.equal(item.status, "verified");
  const detail = claude.cardGet(card.id);
  assert.equal(detail.status, "OPEN", "a verified item leaves the claim untouched");
  assert.equal(detail.phase, "QUESTION");
  assert.equal(detail.evidence[0].status, "verified");
});

// --- evidence validation ----------------------------------------------------

test("evidence requires a known type, provenance, and a body", () => {
  claude.clear();
  const card = claude.cardCreate({ title: "Evidence rules", question: "What counts?" });
  codex.check();

  const added = claude.cardEvidenceAdd(card.id, "observation", "logbook p.14", "drift at dawn");
  assert.equal(added.type, "observation");
  assert.equal(added.status, "pending", "unreviewed by default");
  assert.equal(added.persona, "claude");
  assert.match(
    codex.check().at(-1).body,
    /claude added observation evidence to science card #\d+ \(pending, source: logbook p\.14\)/,
  );

  assert.throws(
    () => claude.cardEvidenceAdd(card.id, "hunch", "chat", "felt right"),
    /invalid evidence type 'hunch'/,
  );
  assert.throws(
    () => claude.cardEvidenceAdd(card.id, "experiment", "   ", "ran it"),
    /provenance is required/,
  );
  assert.throws(
    () => claude.cardEvidenceAdd(card.id, "experiment", "runs/1", ""),
    /evidence body is required/,
  );
  assert.throws(
    () => claude.cardEvidenceAdd(card.id, "experiment", "runs/1", "ran it", { status: "true" }),
    /invalid evidence status/,
  );
  assert.throws(
    () => claude.cardEvidenceAdd(9999, "experiment", "runs/1", "ran it"),
    /no science card with id 9999/,
  );
  assert.equal(claude.cardGet(card.id).evidence.length, 1, "no rejected item was written");
});

test("every recognised evidence type is accepted", () => {
  claude.clear();
  const card = claude.cardCreate({ title: "All types", question: "Do they all land?" });
  for (const type of [
    "derivation",
    "formal-check",
    "simulation",
    "experiment",
    "literature",
    "observation",
  ]) {
    claude.cardEvidenceAdd(card.id, type, `src/${type}`, `a ${type} item`);
  }
  const detail = claude.cardGet(card.id);
  assert.equal(detail.evidence.length, 6);
  assert.deepEqual(validateScienceCard(claude.cardDocument(card.id)).errors, []);
});

// --- listing: negative results stay queryable -------------------------------

test("cardList returns FALSIFIED, ABANDONED, and INCONCLUSIVE cards by default", () => {
  claude.clear();
  const open = claude.cardCreate({ title: "Still open", question: "Q1?" });
  const falsified = claude.cardCreate({ title: "Falsified", question: "Q2?" });
  const abandoned = claude.cardCreate({ title: "Abandoned", question: "Q3?" });
  const inconclusive = claude.cardCreate({ title: "Inconclusive", question: "Q4?" });

  advance(claude, falsified.id, "EXPERIMENT");
  claude.cardTransition(falsified.id, "FALSIFIED");
  claude.cardTransition(abandoned.id, "ABANDONED");
  advance(claude, inconclusive.id, "SIMULATE");
  claude.cardTransition(inconclusive.id, "INCONCLUSIVE");

  const all = claude.cardList();
  assert.equal(all.length, 4, "the default listing hides nothing");
  assert.deepEqual(
    all.map((c) => c.status).sort(),
    ["ABANDONED", "FALSIFIED", "INCONCLUSIVE", "OPEN"],
    "negative results are first-class",
  );
  assert.equal(all[0].id, inconclusive.id, "newest first");

  assert.deepEqual(
    claude.cardList({ openOnly: true }).map((c) => c.id),
    [open.id],
  );
  assert.deepEqual(
    claude.cardList({ status: "FALSIFIED" }).map((c) => c.title),
    ["Falsified"],
  );
  assert.deepEqual(
    claude
      .cardList({ status: ["FALSIFIED", "INCONCLUSIVE", "ABANDONED"] })
      .map((c) => c.title)
      .sort(),
    ["Abandoned", "Falsified", "Inconclusive"],
  );
  assert.deepEqual(
    claude.cardList({ phase: "QUESTION" }).map((c) => c.id),
    [open.id],
  );
  assert.throws(() => claude.cardList({ status: "DONE" }), /invalid status/);
});

test("a falsified card keeps its evidence and full history", () => {
  claude.clear();
  const card = claude.cardCreate({ title: "Kept", question: "Does anything survive?" });
  claude.cardEvidenceAdd(card.id, "experiment", "runs/9", "null result", { status: "verified" });
  advance(claude, card.id, "EXPERIMENT");
  claude.cardTransition(card.id, "FALSIFIED", "decisive falsifier hit");

  const detail = codex.cardGet(card.id);
  assert.equal(detail.status, "FALSIFIED");
  assert.equal(detail.evidence.length, 1);
  assert.equal(detail.evidence[0].provenance, "runs/9");
  assert.equal(detail.transitions.at(-1).note, "decisive falsifier hit");
  assert.deepEqual(validateScienceCard(codex.cardDocument(card.id)).errors, []);
});

// --- the rest of the room is untouched --------------------------------------

test("cards do not disturb messages, goals, claims, or members", () => {
  claude.clear();
  const goal = claude.goalAdd("ship the card layer");
  claude.claim("src/core.ts");
  const card = claude.cardCreate({ title: "Coexist", question: "Do the old tables still work?" });
  claude.cardEvidenceAdd(card.id, "literature", "doi:10/xyz", "prior art");
  claude.cardTransition(card.id, "DIVERGE");

  assert.equal(claude.goals().length, 1);
  assert.equal(claude.goalDone(goal.id).status, "done");
  assert.equal(claude.goals().length, 0);
  assert.equal(claude.claims().length, 1);
  assert.equal(claude.claims()[0].path, "src/core.ts");
  assert.equal(claude.release("src/core.ts").length, 1);
  assert.ok(codex.check().length > 0, "card activity reaches the same check() loop");
  assert.ok(
    claude.members().some((m) => m.persona === "codex"),
    "presence is still recorded by every card operation",
  );

  const { goals, claims, recent } = codex.join();
  assert.equal(goals.length, 0);
  assert.equal(claims.length, 0);
  assert.ok(recent.length > 0);
});

test("an existing room without card tables gains them and keeps its data", () => {
  // The whole "migration" is that openDb() re-runs CREATE TABLE IF NOT EXISTS
  // on every open, so a room recorded before this feature must pick the new
  // tables up without losing a message.
  const olderRoom = mkdtempSync(join(tmpdir(), "squad-old-room-"));
  const previous = process.env.SQUAD_DIR;
  try {
    process.env.SQUAD_DIR = olderRoom;
    const old = new DatabaseSync(join(olderRoom, "squad.db"));
    old.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT NOT NULL, kind TEXT NOT NULL
        DEFAULT 'chat', body TEXT NOT NULL, ts TEXT NOT NULL);
      CREATE TABLE cursors (persona TEXT PRIMARY KEY, last_seen_id INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE goals (
        id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL, status TEXT NOT NULL
        DEFAULT 'open', created_by TEXT NOT NULL, created_ts TEXT NOT NULL, done_by TEXT,
        done_ts TEXT);
      CREATE TABLE members (
        persona TEXT PRIMARY KEY, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL);
      CREATE TABLE claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, persona TEXT NOT NULL,
        created_ts TEXT NOT NULL);
    `);
    old.prepare("INSERT INTO goals (body, created_by, created_ts) VALUES (?, ?, ?)").run(
      "from before science cards",
      "codex",
      new Date().toISOString(),
    );
    old.close();

    const upgraded = openDb();
    const squad = new Squad(upgraded, "claude");
    assert.deepEqual(
      squad.goals().map((g) => g.body),
      ["from before science cards"],
      "pre-existing rows survive the added tables",
    );
    const card = squad.cardCreate({ title: "After upgrade", question: "Do cards work here?" });
    assert.equal(squad.cardList().length, 1);
    assert.equal(squad.cardGet(card.id).transitions.length, 1);
    upgraded.close();
  } finally {
    process.env.SQUAD_DIR = previous;
    rmSync(olderRoom, { recursive: true, force: true });
  }
});

test("clear wipes cards, evidence, and history along with everything else", () => {
  claude.clear();
  const card = claude.cardCreate({ title: "Wiped", question: "Gone?" });
  claude.cardEvidenceAdd(card.id, "observation", "logbook", "noted");
  assert.equal(claude.cardList().length, 1);

  codex.clear();
  assert.equal(codex.cardList().length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM science_card_evidence").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM science_card_transitions").get().n, 0);
  // ids keep climbing, so a wiped card's number is never silently reused
  const next = codex.cardCreate({ title: "Fresh", question: "New id?" });
  assert.ok(next.id > card.id);
});
