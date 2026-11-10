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

_None._

## In Progress

Issues currently being built (`loom:building`).

- **#295**: squad review request is not a verb; point users at review open
- **#296**: Squad MCP server fails to connect in Claude Code while the CLI works

## PRs Awaiting Review

PRs waiting on Judge (`loom:review-requested`).

_None._

## Approved (Awaiting Merge)

PRs that passed review and are queued for Champion auto-merge (`loom:pr`).

- **#299**: feat: add MCP launcher startup diagnostic and load-failure message
- **#300**: feat: accept 'squad review request' as alias of 'review open'

## Proposed

Issues carrying `loom:curated`.

- **#78**: Research integration: Validate a second research room for one week *(curated)*
- **#295**: squad review request is not a verb; point users at review open *(curated)*
- **#296**: Squad MCP server fails to connect in Claude Code while the CLI works *(curated)*

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
| Ready (`loom:issue`) | 0 |
| In Progress (`loom:building`) | 2 |
| PRs awaiting review | 0 |
| Approved PRs awaiting merge | 2 |
| Curated | 3 |
| Architect / Hermit proposals | 0 |
| Active epics | 0 |
<!-- guide:plan-body:end -->
