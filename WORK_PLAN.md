# Work Plan

This snapshot follows GitHub lifecycle labels. Operator-only issues require their recorded action before autonomous dispatch. Dependency PRs outside the Loom review lane are omitted.

<!-- guide:plan-body:start -->
## Operator Attention: Merge-Risk-Hold Pileup

Judge-approved PRs under a hold (`loom:blocked` or `loom:operator`) — only a human merge decision is missing.

- **#153**: chore(deps): bump @modelcontextprotocol/sdk from 1.30.0 to 1.31.0
- **#155**: chore(deps): bump the npm-minor-patch group across 1 directory with 4 updates
- **#169**: feat(cli): add squad read --unread and send unread notice
- **#170**: feat: run squad MCP from an installed release and check it in doctor

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

- **#166**: `squad send` (CLI) hides peer replies; agents miss messages when the MCP server is down
- **#168**: Run agents' squad MCP from an installed release, not the dev clone (cleanups/edits break every agent)

## PRs Awaiting Review

PRs waiting on Judge (`loom:review-requested`).

_None._

## Approved (Awaiting Merge)

PRs that passed review and are queued for Champion auto-merge (`loom:pr`).

- **#153**: chore(deps): bump @modelcontextprotocol/sdk from 1.30.0 to 1.31.0
- **#155**: chore(deps): bump the npm-minor-patch group across 1 directory with 4 updates
- **#169**: feat(cli): add squad read --unread and send unread notice
- **#170**: feat: run squad MCP from an installed release and check it in doctor

## Proposed

Issues carrying `loom:curated`.

- **#78**: Research integration: Validate a second research room for one week *(curated)*
- **#166**: `squad send` (CLI) hides peer replies; agents miss messages when the MCP server is down *(curated)*
- **#168**: Run agents' squad MCP from an installed release, not the dev clone (cleanups/edits break every agent) *(curated)*

## Proposed (Architect / Hermit)

- **#128**: Remove dead find_repo_root/REPO_ROOT from loom-attach.sh and loom-send.sh *(hermit)*

## Epics

- **#55**: Epic: research rooms need a merge point — 'banked' as integration, a steward role, node-level review, cards as state (lessons from the Erdős-85 room)

## Backlog Balance

| Bucket | Count |
|------|-------|
| Operator merge-risk holds | 4 |
| Very important | 0 |
| Important | 0 |
| Ready (`loom:issue`) | 0 |
| In Progress (`loom:building`) | 2 |
| PRs awaiting review | 0 |
| Approved PRs awaiting merge | 4 |
| Curated | 3 |
| Architect / Hermit proposals | 1 |
| Active epics | 1 |
<!-- guide:plan-body:end -->
