import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// Our schema declares "$schema": draft 2020-12, so use ajv's 2020 build
// (plain "ajv" only ships the draft-07 meta-schema by default).
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

process.env.SQUAD_DIR = mkdtempSync(join(tmpdir(), "squad-card-test-"));

const { openDb } = await import("../dist/db.js");
const { Squad } = await import("../dist/core.js");

test.after(() => rmSync(process.env.SQUAD_DIR, { recursive: true, force: true }));

const db = openDb();
const claude = new Squad(db, "claude");
const codex = new Squad(db, "codex");

// --- Schema validation ---------------------------------------------------

const schemaPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "schema",
  "science-card.schema.json",
);
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));

// The schema carries a custom root-level `version` field (not a standard
// JSON Schema keyword), so compile with strict mode off.
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validateCard = ajv.compile(schema);

function validCardInstance(overrides = {}) {
  const ts = new Date().toISOString();
  return {
    id: 1,
    title: "Does X cause Y?",
    question: "Does X cause Y under condition Z?",
    phase: "QUESTION",
    claim_kind: "empirical",
    origin_method: "human",
    origin_contributors: ["claude"],
    changed_assumptions: [],
    proposed_mechanism: null,
    math_model: null,
    standard_prediction: null,
    discriminating_prediction: null,
    decisive_falsifier: null,
    cheapest_test: null,
    prior_art_status: null,
    confidence: 0.5,
    novelty: 0.5,
    attempts: [],
    attacks: [],
    insights: [],
    post_mortems: [],
    created_by: "claude",
    created_ts: ts,
    updated_ts: ts,
    evidence: [],
    transitions: [],
    ...overrides,
  };
}

test("schema has an explicit $id and version", () => {
  assert.equal(typeof schema.$id, "string");
  assert.ok(schema.$id.length > 0);
  assert.equal(typeof schema.version, "string");
  assert.match(schema.version, /^\d+\.\d+\.\d+$/);
});

test("schema validates a well-formed card instance", () => {
  const ok = validateCard(validCardInstance());
  assert.equal(ok, true, JSON.stringify(validateCard.errors));
});

test("schema validates a card with evidence and transitions", () => {
  const instance = validCardInstance({
    phase: "SUPPORTED",
    evidence: [
      {
        id: 1,
        card_id: 1,
        type: "experiment",
        provenance: "lab notebook p.12",
        body: "measured effect",
        persona: "claude",
        ts: new Date().toISOString(),
      },
    ],
    transitions: [
      {
        id: 1,
        card_id: 1,
        from_phase: "QUESTION",
        to_phase: "DIVERGE",
        persona: "claude",
        ts: new Date().toISOString(),
        note: "kicked off",
      },
    ],
  });
  assert.equal(validateCard(instance), true, JSON.stringify(validateCard.errors));
});

test("schema rejects a card missing required fields", () => {
  const instance = validCardInstance();
  delete instance.question;
  assert.equal(validateCard(instance), false);
  assert.ok(validateCard.errors.some((e) => e.instancePath === "" && e.keyword === "required"));
});

test("schema rejects an unknown phase", () => {
  const instance = validCardInstance({ phase: "NOT_A_REAL_PHASE" });
  assert.equal(validateCard(instance), false);
});

test("schema rejects an invalid claim_kind", () => {
  const instance = validCardInstance({ claim_kind: "vibes" });
  assert.equal(validateCard(instance), false);
});

test("schema rejects an evidence item with an invalid type", () => {
  const instance = validCardInstance({
    evidence: [
      {
        id: 1,
        card_id: 1,
        type: "vibes",
        provenance: "somewhere",
        body: null,
        persona: "claude",
        ts: new Date().toISOString(),
      },
    ],
  });
  assert.equal(validateCard(instance), false);
});

test("schema rejects a card with an additional/unknown property", () => {
  const instance = validCardInstance({ unexpected_field: "nope" });
  assert.equal(validateCard(instance), false);
});

// --- cardCreate / cardList / cardGet -------------------------------------

test("cardCreate opens a card in QUESTION phase and announces in chat", () => {
  claude.clear();
  const card = claude.cardCreate({ title: "Speed of light in medium X", question: "Is c/n exact?" });
  assert.equal(card.phase, "QUESTION");
  assert.equal(card.claim_kind, "empirical");
  assert.equal(card.created_by, "claude");
  assert.deepEqual(card.origin_contributors, []);

  const seen = codex.check();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, "system");
  assert.match(seen[0].body, /opened science card #\d+/);
});

test("cardCreate rejects missing title/question", () => {
  claude.clear();
  assert.throws(() => claude.cardCreate({ title: "", question: "q" }), /title is required/);
  assert.throws(() => claude.cardCreate({ title: "t", question: "" }), /question is required/);
});

test("cardCreate rejects an invalid claim_kind", () => {
  claude.clear();
  assert.throws(
    () => claude.cardCreate({ title: "t", question: "q", claim_kind: "vibes" }),
    /invalid claim_kind/,
  );
});

test("cardList returns cards in every phase by default (negative outcomes stay queryable)", () => {
  claude.clear();
  const a = claude.cardCreate({ title: "A", question: "qA" });
  const b = claude.cardCreate({ title: "B", question: "qB" });
  claude.cardTransition(b.id, "DIVERGE");
  claude.cardTransition(b.id, "ABANDONED");

  const all = claude.cardList();
  assert.equal(all.length, 2);
  assert.ok(all.some((c) => c.id === a.id && c.phase === "QUESTION"));
  assert.ok(all.some((c) => c.id === b.id && c.phase === "ABANDONED"));
});

test("cardList can filter to specific phases (e.g. only terminal/negative outcomes)", () => {
  claude.clear();
  const a = claude.cardCreate({ title: "A", question: "qA" });
  const b = claude.cardCreate({ title: "B", question: "qB" });
  claude.cardTransition(b.id, "DIVERGE");
  claude.cardTransition(b.id, "ABANDONED");

  const onlyAbandoned = claude.cardList({ phase: "ABANDONED" });
  assert.equal(onlyAbandoned.length, 1);
  assert.equal(onlyAbandoned[0].id, b.id);

  const onlyQuestion = claude.cardList({ phases: ["QUESTION"] });
  assert.equal(onlyQuestion.length, 1);
  assert.equal(onlyQuestion[0].id, a.id);
});

test("cardGet returns full detail including evidence and transition history", () => {
  claude.clear();
  const card = claude.cardCreate({ title: "Detail card", question: "q" });
  claude.cardTransition(card.id, "DIVERGE", "starting divergence");
  claude.cardEvidenceAdd(card.id, "literature", "prior survey", "background reading");

  const detail = claude.cardGet(card.id);
  assert.equal(detail.id, card.id);
  assert.equal(detail.phase, "DIVERGE");
  assert.equal(detail.transitions.length, 1);
  assert.equal(detail.transitions[0].from_phase, "QUESTION");
  assert.equal(detail.transitions[0].to_phase, "DIVERGE");
  assert.equal(detail.transitions[0].note, "starting divergence");
  assert.equal(detail.evidence.length, 1);
  assert.equal(detail.evidence[0].type, "literature");
  assert.equal(detail.evidence[0].provenance, "prior survey");
});

test("cardGet on missing id throws", () => {
  assert.throws(() => claude.cardGet(999999), /no science card/);
});

// --- cardTransition: legal / illegal graph -------------------------------

test("a legal transition succeeds, is recorded in history, and is announced", () => {
  claude.clear();
  const card = claude.cardCreate({ title: "T", question: "q" });
  codex.check();

  const updated = claude.cardTransition(card.id, "DIVERGE");
  assert.equal(updated.phase, "DIVERGE");

  const detail = claude.cardGet(card.id);
  assert.equal(detail.transitions.length, 1);
  assert.equal(detail.transitions[0].from_phase, "QUESTION");
  assert.equal(detail.transitions[0].to_phase, "DIVERGE");
  assert.equal(detail.transitions[0].persona, "claude");

  const seen = codex.check();
  assert.equal(seen.length, 1);
  assert.match(seen[0].body, /moved card #\d+ QUESTION -> DIVERGE/);
});

test("an illegal transition (QUESTION -> SUPPORTED) is rejected and not recorded", () => {
  claude.clear();
  const card = claude.cardCreate({ title: "T", question: "q" });
  codex.check();

  assert.throws(() => claude.cardTransition(card.id, "SUPPORTED"), /illegal science card transition/);

  const detail = claude.cardGet(card.id);
  assert.equal(detail.phase, "QUESTION", "phase unchanged after a rejected transition");
  assert.equal(detail.transitions.length, 0, "no history entry for a rejected transition");
  assert.equal(codex.check().length, 0, "no announcement for a rejected transition");
});

test("the full chain QUESTION..REPLICATE can proceed one legal step at a time", () => {
  claude.clear();
  const card = claude.cardCreate({ title: "Chain", question: "q" });
  const chain = [
    "DIVERGE",
    "ORIENT",
    "HYPOTHESIZE",
    "DERIVE",
    "ATTACK",
    "SIMULATE",
    "EXPERIMENT",
    "REPLICATE",
  ];
  for (const phase of chain) {
    const updated = claude.cardTransition(card.id, phase);
    assert.equal(updated.phase, phase);
  }
  assert.equal(claude.cardGet(card.id).transitions.length, chain.length);
});

test("LEARN -> PIVOT loops back into the chain", () => {
  claude.clear();
  const card = claude.cardCreate({ title: "Loop", question: "q" });
  claude.cardTransition(card.id, "DIVERGE");
  claude.cardTransition(card.id, "LEARN");
  claude.cardTransition(card.id, "PIVOT");
  const updated = claude.cardTransition(card.id, "HYPOTHESIZE");
  assert.equal(updated.phase, "HYPOTHESIZE");
});

test("ABANDONED is reachable from an active phase and is terminal", () => {
  claude.clear();
  const card = claude.cardCreate({ title: "Give up", question: "q" });
  claude.cardTransition(card.id, "DIVERGE");
  const abandoned = claude.cardTransition(card.id, "ABANDONED");
  assert.equal(abandoned.phase, "ABANDONED");
  assert.throws(() => claude.cardTransition(card.id, "DIVERGE"), /illegal science card transition/);
});

test("cardTransition on missing id throws", () => {
  assert.throws(() => claude.cardTransition(999999, "DIVERGE"), /no science card/);
});

// --- cardEvidenceAdd: type/provenance enforcement ------------------------

test("cardEvidenceAdd accepts a valid type and provenance, and announces", () => {
  claude.clear();
  const card = claude.cardCreate({ title: "Ev", question: "q" });
  codex.check();

  const ev = claude.cardEvidenceAdd(card.id, "derivation", "worked proof appendix B", "QED");
  assert.equal(ev.type, "derivation");
  assert.equal(ev.provenance, "worked proof appendix B");
  assert.equal(ev.card_id, card.id);

  const seen = codex.check();
  assert.equal(seen.length, 1);
  assert.match(seen[0].body, /added derivation evidence to card #\d+/);
});

test("cardEvidenceAdd rejects an invalid type", () => {
  claude.clear();
  const card = claude.cardCreate({ title: "Ev", question: "q" });
  assert.throws(
    () => claude.cardEvidenceAdd(card.id, "vibes", "somewhere"),
    /invalid evidence type/,
  );
});

test("cardEvidenceAdd rejects empty/whitespace provenance", () => {
  claude.clear();
  const card = claude.cardCreate({ title: "Ev", question: "q" });
  assert.throws(() => claude.cardEvidenceAdd(card.id, "literature", ""), /provenance is required/);
  assert.throws(() => claude.cardEvidenceAdd(card.id, "literature", "   "), /provenance is required/);
});

test("cardEvidenceAdd on a missing card throws", () => {
  assert.throws(
    () => claude.cardEvidenceAdd(999999, "literature", "somewhere"),
    /no science card/,
  );
});

// --- claim-status vs evidence-status: the empirical-claim SUPPORTED gate --

test("an empirical card cannot be SUPPORTED on derivation/formal-check evidence alone", () => {
  claude.clear();
  const card = claude.cardCreate({ title: "Empirical claim", question: "q", claim_kind: "empirical" });
  for (const phase of ["DIVERGE", "ORIENT", "HYPOTHESIZE", "DERIVE", "ATTACK", "SIMULATE", "EXPERIMENT", "REPLICATE"]) {
    claude.cardTransition(card.id, phase);
  }
  claude.cardEvidenceAdd(card.id, "derivation", "worked the math");
  claude.cardEvidenceAdd(card.id, "formal-check", "proof-checker verified it");

  assert.throws(
    () => claude.cardTransition(card.id, "SUPPORTED"),
    /needs at least one experiment or observation evidence/,
  );
  assert.equal(claude.cardGet(card.id).phase, "REPLICATE", "still at REPLICATE, not SUPPORTED");
});

test("an empirical card CAN be SUPPORTED once experiment/observation evidence exists", () => {
  claude.clear();
  const card = claude.cardCreate({ title: "Empirical claim 2", question: "q", claim_kind: "empirical" });
  for (const phase of ["DIVERGE", "ORIENT", "HYPOTHESIZE", "DERIVE", "ATTACK", "SIMULATE", "EXPERIMENT", "REPLICATE"]) {
    claude.cardTransition(card.id, phase);
  }
  claude.cardEvidenceAdd(card.id, "derivation", "worked the math");
  claude.cardEvidenceAdd(card.id, "experiment", "ran the trial, effect observed");

  const updated = claude.cardTransition(card.id, "SUPPORTED");
  assert.equal(updated.phase, "SUPPORTED");
});

test("a formal card can be SUPPORTED on formal-check evidence alone", () => {
  claude.clear();
  const card = claude.cardCreate({ title: "Formal claim", question: "q", claim_kind: "formal" });
  for (const phase of ["DIVERGE", "ORIENT", "HYPOTHESIZE", "DERIVE", "ATTACK", "SIMULATE", "EXPERIMENT", "REPLICATE"]) {
    claude.cardTransition(card.id, phase);
  }
  claude.cardEvidenceAdd(card.id, "formal-check", "proof-checker verified it");

  const updated = claude.cardTransition(card.id, "SUPPORTED");
  assert.equal(updated.phase, "SUPPORTED");
});

// --- regression: existing tables/behavior are untouched -------------------

test("clear() wipes science cards along with everything else, leaving chat/goals/claims intact behavior", () => {
  claude.clear();
  claude.goalAdd("existing goal behavior still works");
  claude.claim("existing/claim/behavior.ts");
  claude.cardCreate({ title: "to be wiped", question: "q" });
  assert.equal(claude.cardList().length, 1);

  codex.clear();
  assert.equal(codex.cardList().length, 0);
  assert.equal(codex.goals(true).length, 0);
  assert.equal(codex.claims().length, 0);
  assert.equal(codex.read().length, 0);
});

test("science cards do not interfere with goals/claims/messages tables", () => {
  claude.clear();
  const goal = claude.goalAdd("unrelated goal");
  claude.claim("unrelated/path.ts");
  const card = claude.cardCreate({ title: "unrelated card", question: "q" });

  assert.equal(claude.goals().length, 1);
  assert.equal(claude.goals()[0].id, goal.id);
  assert.equal(claude.claims().length, 1);
  assert.equal(claude.claims()[0].path, "unrelated/path.ts");
  assert.equal(claude.cardList().length, 1);
  assert.equal(claude.cardList()[0].id, card.id);
});
