# Work Plan

This snapshot follows GitHub lifecycle labels. Operator-only issues require their recorded action before autonomous dispatch. Dependency PRs outside the Loom review lane are omitted.

<!-- guide:plan-body:start -->
## Operator Attention: Merge-Risk-Hold Pileup

Judge-approved PRs stuck under a `loom:operator` merge-risk hold — implementation work is done, only a human merge decision is missing.

_None._

## Operator Priority

Issues the operator starred (`loom:operator-priority`); land these first.

_None._

## Ready

Human-approved issues ready for implementation (`loom:issue`).

_None._

## In Progress

Issues currently being built (`loom:building`).

_None._

## PRs Awaiting Review

PRs waiting on Judge (`loom:review-requested`).

_None._

## Approved (Awaiting Merge)

PRs that passed review and are queued for Champion auto-merge (`loom:pr`).

_None._

## Proposed

Issues carrying `loom:curated`.

- **#78**: Research integration: Validate a second research room for one week *(curated)*
- **#122**: Inbox hook identity without a pin: record a session_id → persona mapping on squad_join *(curated)*

## Proposed (Architect / Hermit)

- **#128**: Remove dead find_repo_root/REPO_ROOT from loom-attach.sh and loom-send.sh *(hermit)*

## Epics

- **#55**: Epic: research rooms need a merge point — 'banked' as integration, a steward role, node-level review, cards as state (lessons from the Erdős-85 room)
- **#120**: Agents from different workstreams post under one persona, so room attribution breaks

## Backlog Balance

| Tier | Count |
|------|-------|
| Operator merge-risk holds | 0 |
| Operator priority | 0 |
| Ready (`loom:issue`) | 0 |
| In Progress (`loom:building`) | 0 |
| PRs awaiting review | 0 |
| Approved PRs awaiting merge | 0 |
| Curated | 2 |
| Architect / Hermit proposals | 1 |
| Active epics | 2 |
<!-- guide:plan-body:end -->
