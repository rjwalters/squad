---
description: Create, inspect, transition, or attach evidence to a Science Card
---

Manage Science Cards — squad's structured tracker for a scientific claim moving through `QUESTION` → `DIVERGE` → … → `SUPPORTED`/`FALSIFIED`/`INCONCLUSIVE`/`ABANDONED` (with a `LEARN`/`PIVOT` reflection loop reachable from most active phases). `$ARGUMENTS` describes what to do.

If the `squad_*` MCP tools are not available, stop and tell the user the squad MCP server is not configured for this project.

- **No arguments, or "list"/"show the cards":** call `squad_card_list` (active phases only by default; pass `include_done: true` to also show `SUPPORTED`/`FALSIFIED`/`INCONCLUSIVE`/`ABANDONED` cards) and show a compact list (id, phase, title).
- **"create <question>" or similar:** call `squad_card_create` with at least `title` and `question` (default the title to a short version of the question if the user didn't give one explicitly). Creation is auto-announced in chat.
- **"show #<id>" / "details on #<id>":** call `squad_card_get` and summarize the card's fields plus its evidence and transition history.
- **"move #<id> to <phase>" / "transition #<id>":** call `squad_card_transition` with the card id and target phase (optionally a note). If it's rejected — an illegal transition, or an empirical card lacking `experiment`/`observation` evidence for `SUPPORTED` — report the error rather than retrying blindly; the error names the phases actually allowed from the current one.
- **"add evidence to #<id>":** call `squad_card_evidence_add` with a `type` (`derivation`, `formal-check`, `simulation`, `experiment`, `literature`, or `observation`), `provenance`, and an optional `body`.

Report the resulting card state when done. Every card mutation is announced in chat, so a teammate in a `/squad:join` loop sees it on their next check.
