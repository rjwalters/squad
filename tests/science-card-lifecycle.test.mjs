import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// End-to-end integration test for Science Cards (issue #25). Unlike
// tests/science-card.test.mjs and tests/diverge.test.mjs (which each exercise
// one scoped slice of the feature), this suite drives ONE card through the
// *entire* lifecycle a real research session would use, against a real
// temp .squad dir: card creation -> a divergence round -> phase transitions
// -> evidence attachment (including a rejected, evidence-gated SUPPORTED
// attempt) -> a LEARN -> PIVOT loop -> a negative terminal state -> and
// confirms the negative-outcome card is still queryable via cardList
// afterward, per #20's "negative outcomes must stay queryable" requirement.
process.env.SQUAD_DIR = mkdtempSync(join(tmpdir(), "squad-card-lifecycle-"));

const { openDb } = await import("../dist/db.js");
const { Squad, CARD_TERMINAL_PHASES } = await import("../dist/core.js");

test.after(() => rmSync(process.env.SQUAD_DIR, { recursive: true, force: true }));

const db = openDb();
const claude = new Squad(db, "claude");
const codex = new Squad(db, "codex");

test("full Science Card lifecycle: QUESTION -> divergence -> evidence-gated transitions -> LEARN/PIVOT -> FALSIFIED, still listable", () => {
  claude.clear();

  // --- 1. Card creation ----------------------------------------------------
  const card = claude.cardCreate({
    title: "Cache invalidation off-by-one",
    question: "Does the LRU evict one entry too many under concurrent access?",
    claim_kind: "empirical",
  });
  assert.equal(card.phase, "QUESTION");
  assert.equal(card.claim_kind, "empirical");

  // --- 2. Divergence round scoped to the card, both personas participate --
  claude.cardTransition(card.id, "DIVERGE");
  const round = claude.divergeOpen("root cause of the extra eviction?", {
    cardId: card.id,
    expectedParticipants: ["claude", "codex"],
  });
  assert.equal(round.card_id, card.id);

  claude.divergeSubmit(round.id, "Suspect the eviction counter increments before the write lock releases");
  // Concurrent-submission isolation: codex's submit must not observe claude's
  // body, and must auto-close the round once every expected participant is in.
  const codexSubmission = codex.divergeSubmit(round.id, "Suspect a stale read of size() during resize");
  assert.ok(!JSON.stringify(codexSubmission).includes("write lock"));

  const revealed = claude.divergeStatus(round.id);
  assert.equal(revealed.round.status, "closed", "round auto-closes once both expected participants submit");
  assert.equal(revealed.submissions.length, 2, "both submissions revealed after close");
  const bodies = revealed.submissions.map((s) => s.body).sort();
  assert.deepEqual(bodies, [
    "Suspect a stale read of size() during resize",
    "Suspect the eviction counter increments before the write lock releases",
  ]);

  // --- 3. Phase transitions + evidence attachment through the main chain --
  claude.cardTransition(card.id, "ORIENT");
  codex.cardTransition(card.id, "HYPOTHESIZE", "stale size() read during resize causes double eviction");
  codex.cardEvidenceAdd(
    card.id,
    "derivation",
    "docs/lru-notes.md#resize",
    "worked through the resize path by hand; confirms size() can read stale mid-resize",
  );
  codex.cardTransition(card.id, "DERIVE");

  claude.cardTransition(card.id, "ATTACK", "checking whether the write-lock theory is ruled out");
  claude.cardEvidenceAdd(
    card.id,
    "literature",
    "docs/lru-notes.md#locking",
    "prior incident report rules out the lock-release theory",
  );
  claude.cardTransition(card.id, "SIMULATE");
  claude.cardEvidenceAdd(card.id, "simulation", "sim-run-9", "resize race reproduces the extra eviction in a harness");
  claude.cardTransition(card.id, "EXPERIMENT");
  claude.cardTransition(card.id, "REPLICATE");

  // --- 4. Evidence-gated phase transition: SUPPORTED is rejected without --
  //        experiment/observation evidence for an empirical-claim card.
  assert.throws(
    () => claude.cardTransition(card.id, "SUPPORTED"),
    /needs at least one experiment or observation evidence/,
    "empirical card cannot reach SUPPORTED on derivation/literature/simulation evidence alone",
  );
  assert.equal(claude.cardGet(card.id).phase, "REPLICATE", "rejected transition leaves phase unchanged");

  // Replication comes back negative for the resize-only theory.
  codex.cardEvidenceAdd(
    card.id,
    "experiment",
    "ci-run-4901",
    "replication on a second machine: off-by-one does NOT reproduce with only the resize race enabled",
  );

  // --- 5. LEARN -> PIVOT loop: the team revises the hypothesis rather than -
  //        force a SUPPORTED that the evidence doesn't actually back.
  claude.cardTransition(card.id, "LEARN", "replication is inconsistent across hosts");
  claude.cardTransition(
    card.id,
    "PIVOT",
    "revising: resize race only manifests when a GC pause stretches the write-lock window",
  );
  const pivoted = claude.cardTransition(card.id, "HYPOTHESIZE", "combined hypothesis: resize race + GC pause");
  assert.equal(pivoted.phase, "HYPOTHESIZE", "PIVOT loops back into the main chain");

  codex.cardTransition(card.id, "DERIVE");
  claude.cardTransition(card.id, "ATTACK");
  claude.cardTransition(card.id, "SIMULATE");
  codex.cardEvidenceAdd(
    card.id,
    "simulation",
    "sim-run-12",
    "injected forced GC pauses during resize in a controlled harness: no excess eviction observed",
  );
  claude.cardTransition(card.id, "EXPERIMENT");
  codex.cardEvidenceAdd(
    card.id,
    "experiment",
    "ci-run-5002",
    "reproduced the controlled GC-pause condition on real hardware: no excess eviction across 200 trials",
  );
  claude.cardTransition(card.id, "REPLICATE");

  // --- 6. Negative terminal state ------------------------------------------
  const falsified = claude.cardTransition(
    card.id,
    "FALSIFIED",
    "combined hypothesis does not hold — the GC-pause condition never reproduces excess eviction",
  );
  assert.equal(falsified.phase, "FALSIFIED");
  assert.ok(CARD_TERMINAL_PHASES.includes("FALSIFIED"));

  // FALSIFIED is itself terminal except for the LEARN escape hatch.
  assert.throws(
    () => claude.cardTransition(card.id, "DIVERGE"),
    /illegal science card transition/,
    "FALSIFIED only permits looping back through LEARN",
  );

  // --- 7. Negative outcomes stay queryable ---------------------------------
  const allCards = claude.cardList();
  assert.ok(
    allCards.some((c) => c.id === card.id && c.phase === "FALSIFIED"),
    "cardList() with no filter still returns the FALSIFIED card",
  );
  const falsifiedOnly = claude.cardList({ phase: "FALSIFIED" });
  assert.equal(falsifiedOnly.length, 1);
  assert.equal(falsifiedOnly[0].id, card.id);

  // The full detail view carries the whole transition + evidence history,
  // including the rejected SUPPORTED attempt's absence (rejected transitions
  // are never recorded) and every legal transition that was recorded.
  const detail = claude.cardGet(card.id);
  assert.equal(detail.phase, "FALSIFIED");
  assert.ok(detail.transitions.length >= 14, "every legal transition across both chain passes was recorded");
  assert.ok(detail.evidence.length >= 6, "evidence from both chain passes was recorded");
  assert.ok(
    detail.transitions.some((t) => t.from_phase === "LEARN" && t.to_phase === "PIVOT"),
    "LEARN -> PIVOT loop is present in the recorded history",
  );
  assert.ok(
    detail.transitions.some((t) => t.from_phase === "REPLICATE" && t.to_phase === "FALSIFIED"),
    "final terminal transition is present in the recorded history",
  );
});

// --- Regression: chat/goals/claims/members behavior unaffected -----------

test("regression: existing chat/goals/claims/members behavior is unaffected by the full lifecycle above", () => {
  claude.clear();

  const goal = claude.goalAdd("ship the science card walkthrough");
  const doneGoal = claude.goalDone(goal.id);
  assert.equal(doneGoal.status, "done");
  const reopened = claude.goalReopen(goal.id);
  assert.equal(reopened.status, "open");

  const claimed = claude.claim("src/core.ts");
  assert.equal(claimed.persona, "claude");
  const released = claude.release("src/core.ts");
  assert.equal(released.length, 1);

  claude.send("hello from claude");
  const seen = codex.check();
  assert.ok(seen.some((m) => m.body === "hello from claude"));

  const members = claude.members();
  assert.ok(members.some((m) => m.persona === "claude"));
  assert.ok(members.some((m) => m.persona === "codex"));

  // A card created alongside all of the above does not perturb any of it,
  // and vice versa — the tables are independent.
  const card = claude.cardCreate({ title: "unrelated", question: "does this interfere?" });
  assert.equal(claude.goals().length, 1);
  assert.equal(claude.claims().length, 0, "claim was released above");
  assert.equal(claude.cardList().length, 1);
  assert.equal(claude.cardList()[0].id, card.id);
});
