# Science Card schema

`science-card.schema.json` is the **canonical definition of a Science Card**
for the whole cross-project effort — Squad ([#20][squad20]), Loom
([rjwalters/loom#6109][loom]), and Lean Genius
([rjwalters/lean-genius#43705][lg]) — not one of three independently authored
copies.

- `$id`: `https://raw.githubusercontent.com/rjwalters/squad/main/schema/science-card.schema.json`
- `version`: `1.0.0` (top-level in the schema document; each card instance
  records the version it was written against in `schema_version`)

## If you are another repository

Do one of these two things. Do not write your own Science Card schema.

1. **Reference it** by `$id`, if your validator can fetch or resolve remote
   schemas; or
2. **Vendor it** — copy this file verbatim, keeping `$id` and `version`
   unchanged, and add a provenance note next to it saying where it came from:

   ```
   Vendored from rjwalters/squad schema/science-card.schema.json
   $id     https://raw.githubusercontent.com/rjwalters/squad/main/schema/science-card.schema.json
   version 1.0.0
   ```

Because a vendored copy keeps `$id` and `version`, divergence is detectable
later by comparing those two fields against this file — that is the whole
point of carrying them. Automated cross-repo syncing is deliberately out of
scope for now; the schema is simply *built to be copied*.

## If you need a field this schema does not have

Change it **here** and bump `version`, then let the vendoring repositories
re-copy. A field added downstream is invisible to everyone else and turns a
shared abstraction back into three dialects.

## Design rules this schema encodes

- **Runtime-neutral.** No Claude-, Codex-, MCP-, or Squad-specific fields.
  Identities are plain strings.
- **Negative results are results.** `FALSIFIED`, `INCONCLUSIVE`, and
  `ABANDONED` are ordinary statuses on the same record, reached through the
  same recorded transitions — nothing is deleted, and Squad's `cardList()`
  returns them by default.
- **Claim status and evidence status are different axes.** A card's `status`
  is the claim-level verdict (`OPEN` → `SUPPORTED` / `FALSIFIED` /
  `INCONCLUSIVE` / `ABANDONED`). Each evidence item carries its *own* status
  (`pending` / `verified` / `refuted` / `inconclusive`), which says only that
  the item itself checks out. A `verified` derivation never means the claim is
  scientifically true.
- **`claim_kind` decides what would count.** An `empirical` or `mixed` claim
  needs empirical evidence (`experiment` or `observation`) before it can be
  `SUPPORTED`; a `formal` claim can rest on `derivation` / `formal-check`.
  Squad enforces this in `Squad.cardTransition` (`src/core.ts`).
- **Evidence must be traceable.** `type` and a non-empty `provenance` are both
  required — evidence nobody can trace to a file, run, or paper is an
  assertion.
- **History is append-only.** `transitions` is the full phase history, oldest
  first, beginning with a genesis entry whose `from_phase` is `null`.

The phase cycle is `QUESTION → DIVERGE → ORIENT → HYPOTHESIZE → DERIVE →
ATTACK → SIMULATE → EXPERIMENT → REPLICATE → SUPPORTED | FALSIFIED |
INCONCLUSIVE`, with `LEARN → PIVOT` loops back into the cycle and `ABANDONED`
reachable from any live phase. The schema defines the vocabulary; the legal
edges between phases live in `PHASE_TRANSITIONS` in
[`../src/science-card.ts`](../src/science-card.ts), which is also where
Squad's dependency-free validator for this schema lives.

[squad20]: https://github.com/rjwalters/squad/issues/20
[loom]: https://github.com/rjwalters/loom/issues/6109
[lg]: https://github.com/rjwalters/lean-genius/issues/43705
