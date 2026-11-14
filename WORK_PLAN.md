# Work Plan

This snapshot follows GitHub lifecycle labels. Operator-only issues require their recorded action before autonomous dispatch. Dependency PRs outside the Loom review lane are omitted.

<!-- guide:plan-body:start -->
## Operator Attention: Merge-Risk-Hold Pileup

Judge-approved PRs under a hold (`loom:blocked` or `loom:operator`) — only a human merge decision is missing.

_None._

## Very Important

`loom:very-important` (one counts per workspace); every stage takes these first.

_None._

## Important

`loom:important`; taken before unlabelled work.

_None._

## Ready

Human-approved issues ready for implementation (`loom:issue`).

- **#310**: Extract the Science Card domain from src/core.ts into its own module
- **#311**: Cover the opencode registration in the installed-parity test and capability doc

## In Progress

Issues currently being built (`loom:building`).

- **#295**: squad review request is not a verb; point users at review open

## PRs Awaiting Review

PRs waiting on Judge (`loom:review-requested`).

- **#309**: docs: roadmap as of 2026-11-13

## Approved (Awaiting Merge)

PRs that passed review and are queued for Champion auto-merge (`loom:pr`).

_None._

## Proposed

Issues carrying `loom:curated`.

- **#78**: Research integration: Validate a second research room for one week *(curated)*
- **#295**: squad review request is not a verb; point users at review open *(curated)*
- **#310**: Extract the Science Card domain from src/core.ts into its own module *(curated)*
- **#311**: Cover the opencode registration in the installed-parity test and capability doc *(curated)*

## Proposed (Architect / Hermit)

_None._

## Epics

_None._

## Backlog Balance

| Bucket | Count |
|------|-------|
| Operator merge-risk holds | 0 |
| Very important | 0 |
| Important | 0 |
| Ready (`loom:issue`) | 2 |
| In Progress (`loom:building`) | 1 |
| PRs awaiting review | 1 |
| Approved PRs awaiting merge | 0 |
| Curated | 4 |
| Architect / Hermit proposals | 0 |
| Active epics | 0 |
<!-- guide:plan-body:end -->
