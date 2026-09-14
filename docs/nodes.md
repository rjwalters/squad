# Durable research nodes

A research node **is a Science Card**: the same integer ID, question, research
fields, phase, evidence and history in the shared room. There is no second board
or automatic conversion to a different identity. `squad node list` and
`squad_node_list` include every card, including exploratory work and negative
outcomes. `squad_join` includes the node board alongside goals and file claims.

## Discover, create and connect

Follow the shared [join workflow](../skills/squad/references/join.md) from either
runtime. Inspect the returned nodes before creating another card for a question.
For example, in a scratch repository with Squad installed:

```sh
squad node list
squad node create 'Under which assumptions does the lemma hold?'
squad node show 1
```

The matching MCP calls are `squad_node_list`, `squad_node_create` with `title`
and `question`, and `squad_node_get` with `id`. A second runtime or Git worktree
using the same room sees the same ID and content. Installed runtime configuration
pins the shared room; `squad path` identifies the CLI room.

Dependencies and artifacts are optional. Existing card commands remain usable.
For metadata, replace either list using the current content revision:

```sh
squad node update 1 1 '{"dependencies":[2]}'
```

This means node 1 depends on existing node 2. Missing nodes, duplicate IDs, self
references and cycles fail without changing the graph. The current revision is
returned by `node show`; stale edits fail explicitly. `squad node create --json
'<fields>'` accepts the card fields plus `dependencies` and `artifacts`, matching
`squad_node_create`. Research fields still use `squad card edit` /
`squad_card_update`; phases and evidence keep their existing dedicated commands.

## Declare committed artifacts, then bank

An artifact declaration is `{ "path": "Proofs/Lemma.lean", "commit": "<full
lowercase Git object ID>", "theorem": "lemma_name" }`. `theorem` is optional and
explicit; Squad does not parse Lean or infer a theorem from a name. Paths must
be exact repository-relative files, without traversal, absolute paths or glob
expansion. Declaring an artifact does not prove that it exists or is correct:
the banking executor validates committed regular files in the configured Git
repository. Keep uncommitted ideas as card fields/evidence until committed.

```sh
squad node update 1 2 '{"artifacts":[{"path":"Proofs/Lemma.lean","commit":"<full-commit-id>","theorem":"lemma_name"}]}'
squad node submit 1 3 lemma-v1 1
squad bank <returned-attempt-id>
```

`node submit` takes node ID, expected content revision, idempotent request key,
and expected integration configuration revision. Its MCP equivalent is
`squad_node_submit` with `id`, `expected_revision`, `request_key`, and
`config_revision`. All declared artifacts must come from one source commit.
The existing integration target branch must exist for selected-path banking.
Squad derives the exact selected paths from the node declarations and records
an immutable node-revision binding in the same transaction as submission.
`node submit` returns **pending**; only `bank` integrates, builds the exact
candidate and observes publication before returning **verified**.

Advanced direct `integration submit` calls may provide numeric-string
`node_refs` plus `node_revisions` (CLI `--node-revisions '{"1":3}'`). They must
match each node's entire declared path set and source commit, with the expected
content revision. A supplied theorem must match every declared artifact.
Arbitrary unrelated verified attempts cannot be attached to a node. A request
key never rebinds to changed content: use a new key after revising a node.

`node show` exposes each binding's node revision, attempt ID, source commits,
selection, current/stale flag and exact verified integrated commit/tree. The
attempt query retains full ordered build/publication evidence. `banked: true`
means a verified attempt is bound to the **current node content revision** and
current enabled integration configuration. Links report `config_revision` and
`current_configuration`; switching or disabling the target preserves old receipts
without presenting them as current banking.
After a content edit, historical bank evidence remains inspectable but that
binding becomes stale. Banking does not independently review a research claim;
`review_status` stays `unreviewed` until an independent node review completes.

## Revisions and compatibility

Every material card edit, phase transition, evidence addition, dependency
change or artifact change records an immutable snapshot. No-op edits preserve
the content revision. Snapshots retain the actor and session when observed;
these are declared local identities, not proof of independent people or models.
Bank receipts, presence and coordination facts do not revise research content.
Node queries are read-only and do not renew presence or append history.

Schema 6 adds node metadata, snapshots and submission bindings. Opening an old
room adopts each existing card with one explicitly marked `adopted` baseline,
retaining original card/evidence/transition data. The baseline has no invented
historical actor/session or reconstructed edits. Pre-node opaque `node_refs`
remain historical unresolved strings in their original attempts; they do not
create cards or confer node banking status. Explicitly declare the actual node
and submit its artifacts to establish a new provenance binding.

Schema 7 adds directed node request bindings, review receipts and retained
independent builds. Current-version export/import includes these alongside the
graph, snapshots and integration bindings;
`clear` removes them with the rest of the room. As with earlier schema changes,
imports require matching export schema versions. Open an older room with the
current build and re-export it to upgrade its export format.

## Observed workflow gap

Before this change, the canonical join instructions directed agents to goals,
claims and chat, but never told them to discover or create Science Cards. The
`Squad.join()` snapshot likewise omitted cards. Cards required only a title and
question, but their existing interfaces had no dependency graph, declared
artifact map or revision-bound bank provenance. These are observations from the
workflow and source, not results of an adoption study or claims about users'
motives. Join now surfaces nodes, directs reuse or creation for research work,
and points both runtimes to the same discover/edit/bank path.

## Directed independent review

`squad node claim ID REVISION [TARGET]` opens or reuses an active request for
that content revision. TARGET defaults to the configured steward. Exploration
can be claimed before banking. A conflicting active target requires explicit
cancellation by its requester or target; a claim never cancels another ask.
Ordinary path claims retain their advisory behavior.

The target acknowledges with `squad review claim REQUEST_ID`, then runs:

```sh
squad node review REQUEST_ID '{"request_key":"review-v1","attempt_id":"BANK_ID","verdict":"approve","rationale":"Checked the argument and assumptions."}'
```

MCP equivalents are `squad_node_claim` (`id`, `expected_revision`, optional
`target`) and `squad_node_review` (`request_id` and the JSON fields above,
optional `build_timeout_ms`; CLI uses `--build-timeout-ms N`). The latter executes the configured build anew in
an isolated checkout of the exact published bank commit, verifies physical
tracked bytes, HEAD and index, and retains command, output, result, reviewer,
session metadata, revision and scientific rationale. It does not publish.
Build success is required for approval but does not establish scientific
correctness: the verdict is the reviewer's declaration. Identity metadata is
reported as available; persona differences are not cryptographic independence.
Contributing node authors, its bank submitter and request author cannot approve.

Content or configuration changes require a fresh review; historical receipts
remain visible in `node show` with `current: false`. Unrelated branch advances
leave the reviewed content revision intact. The latest completed current verdict
determines status; a later rejection supersedes approval while keeping history.
Builds that finish after edits,
configuration changes or cancellation retain evidence without approval.
Generic prose `review resolve` closes an ask but never grants node approval.
As with ordinary requests, an already claimed request may be completed after
expiry; expiry prevents new claims and releases coordination gating.

Completed request keys replay the same receipt only for the same reviewer and
payload. A process interrupted before durable completion cannot supply proof:
after its renewable two-minute lease expires, retry records failure and a fresh
key can rebuild. Failed builds leave the claimed request open for retry.
