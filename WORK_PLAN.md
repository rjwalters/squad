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

- **#248**: Installer cannot adopt a receipt-less v0.1.0 install even when files are byte-identical to that release
- **#249**: Release installs record commit "unknown" in install-metadata.json

## In Progress

Issues currently being built (`loom:building`).

- **#234**: feat: squad agent <runtime> supervisor entry point with Codex adapter
- **#247**: release-install.sh: packed release's install.sh loses its exec bit, so the printed install command fails

## PRs Awaiting Review

PRs waiting on Judge (`loom:review-requested`).

- **#244**: feat: add AgentAdapter seam and squad agent <runtime> with Codex adapter
- **#250**: fix: chmod install.sh and uninstall.sh in release-install

## Approved (Awaiting Merge)

PRs that passed review and are queued for Champion auto-merge (`loom:pr`).

_None._

## Proposed

Issues carrying `loom:curated`.

- **#78**: Research integration: Validate a second research room for one week *(curated)*
- **#234**: feat: squad agent <runtime> supervisor entry point with Codex adapter *(curated)*
- **#247**: release-install.sh: packed release's install.sh loses its exec bit, so the printed install command fails *(curated)*
- **#248**: Installer cannot adopt a receipt-less v0.1.0 install even when files are byte-identical to that release *(curated)*
- **#249**: Release installs record commit "unknown" in install-metadata.json *(curated)*

## Proposed (Architect / Hermit)

- **#128**: Remove dead find_repo_root/REPO_ROOT from loom-attach.sh and loom-send.sh *(hermit)*
- **#193**: Split src/core.ts (3.8k lines, one 2.8k-line Squad class) into domain modules *(hermit)*

## Epics

- **#55**: Epic: research rooms need a merge point — 'banked' as integration, a steward role, node-level review, cards as state (lessons from the Erdős-85 room)

## Backlog Balance

| Bucket | Count |
|------|-------|
| Operator merge-risk holds | 0 |
| Very important | 0 |
| Important | 0 |
| Ready (`loom:issue`) | 2 |
| In Progress (`loom:building`) | 2 |
| PRs awaiting review | 2 |
| Approved PRs awaiting merge | 0 |
| Curated | 5 |
| Architect / Hermit proposals | 2 |
| Active epics | 1 |
<!-- guide:plan-body:end -->
