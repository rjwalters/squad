---
description: Create and discover research nodes, connect artifacts, or update Science Cards
---

Manage Science Cards — squad's structured tracker for a scientific claim moving through `QUESTION` → `DIVERGE` → … → `SUPPORTED`/`FALSIFIED`/`INCONCLUSIVE`/`ABANDONED` (with a `LEARN`/`PIVOT` reflection loop reachable from most active phases). The user’s request describes what to do.

If the `squad_*` MCP tools are not available, stop and tell the user the squad MCP server is not configured for this project.

Research nodes reuse these same card IDs. For research discovery call
`squad_node_list`, then `squad_node_get` to inspect dependencies, declared
artifacts, immutable content revisions and current/stale bank links. Create a
node with `squad_node_create` (`title`, `question`, optional dependencies/artifacts).
Update metadata with `squad_node_update` (`id`, `expected_revision`, replacement
`dependencies` and/or `artifacts` lists). Each artifact declares `path`, full
source `commit`, and optional `theorem`; this is an explicit mapping, not symbol
lookup. Dependencies must resolve and cannot form cycles. All artifacts for a
node submission must share one source commit.

Call `squad_node_submit` with `id`, `expected_revision`, `request_key`, and
`config_revision` to create a pending attempt from those declarations. Follow
with `squad_bank` to integrate/build/publish; inspect the exact receipt separately
from independent review. Historical bank links become stale after material
content changes. The card operations below update the same node and revision
history. Existing cards are already nodes; do not duplicate them.

- **No arguments, or "list"/"show the cards":** call `squad_card_list` (active phases only by default; pass `include_done: true` to also show `SUPPORTED`/`FALSIFIED`/`INCONCLUSIVE`/`ABANDONED` cards) and show a compact list (id, phase, title).
- **"create <question>" or similar:** call `squad_card_create` with at least `title` and `question` (default the title to a short version of the question if the user didn't give one explicitly). Creation is auto-announced in chat.
- **"show #<id>" / "details on #<id>":** call `squad_card_get` and summarize the card's fields plus its evidence and transition history.
- **"move #<id> to <phase>" / "transition #<id>":** call `squad_card_transition` with the card id and target phase (optionally a note). If it's rejected — an illegal transition, or an empirical card lacking `experiment`/`observation` evidence for `SUPPORTED` — report the error rather than retrying blindly; the error names the phases actually allowed from the current one.
- **"add evidence to #<id>":** call `squad_card_evidence_add` with a `type` (`derivation`, `formal-check`, `simulation`, `experiment`, `literature`, or `observation`), `provenance`, and an optional `body`.

Report the resulting card state when done. Every card mutation is announced in chat, so a teammate in a the join workflow loop sees it on their next check.

For a full narrative walkthrough — a divergence round, phase transitions with evidence attached, a rejected evidence-gated `SUPPORTED` attempt, a `LEARN` → `PIVOT` loop, and a `FALSIFIED` terminal state that stays queryable — see "Science Cards: an end-to-end example" in the repo's `README.md`.
