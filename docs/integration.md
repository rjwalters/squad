# Shared integration target

Research integration is opt-in. Existing rooms need no configuration. All
participants using the same room database read the same configuration, independent
of their current working directory. This release provides configuration only;
banking execution is a subsequent capability.

Read the current configuration and its revision:

```sh
squad integration show
```

An unconfigured room returns `config: null` and revision 0. Configure the complete
target explicitly, quoting the build command as one argument:

```sh
squad integration set --expected-revision 0 \
  --repository /absolute/path/to/research \
  --remote origin --branch research/integration \
  --build-command 'lake build' --steward researcher
squad integration check
```

`repository` must name an existing Git working-tree root using an absolute path.
Squad resolves symlinks and stores that root, its Git common directory, and the
remote's effective URL. It requires a single identical fetch/push destination,
using an absolute local path, supported URL (HTTP(S), SSH, Git, file), or
`user@host:path`. Relative remote paths and remote helpers are rejected. Keep
credentials in Git's credential helper: credential-bearing HTTP URLs, passwords,
URL query strings and fragments are rejected before storage or announcement.
The integration branch must be a valid branch name; it need not exist yet.
`steward` uses the existing persona-name syntax and need not be online.
The build command is recorded as text; configuring or checking never runs it.

Every update requires the current `--expected-revision`, writes an immutable
configuration revision, and posts the revision, target and steward in a system message
attributed to the caller's existing identity. Full configuration, including the
build command, is available through the getter; keep secrets out of build commands. Concurrent stale updates fail;
read again and deliberately apply a complete replacement. To disable integration:

```sh
squad integration unset --expected-revision 1
```

Disabling records a new null configuration and keeps earlier revisions. Reading
configuration performs no Git inspection, so an exported or relocated room stays
inspectable. Checking fails explicitly for missing configuration, missing
repositories, changed canonical paths, or changed remote destinations. It uses
only read-only Git commands; it does not contact the remote, fetch, switch branches,
edit user files or establish that the build succeeds. A changed target requires
an explicit revision-guarded replacement, never a fallback to the caller's cwd.
Environment variables overriding Git repository/config selection are ignored by
validation. Local Git configuration itself remains in effect.

MCP has matching tools: `squad_integration_get`, `squad_integration_set`,
`squad_integration_unset`, and `squad_integration_check`. Set takes `repository`,
`remote`, `branch`, `build_command`, `steward`, and `expected_revision`;
unset takes `expected_revision`. Both CLI and MCP return the same JSON state.

Configuration history lives in the room's `integration_configs` table. Opening an
older room adds the empty table without changing existing identities or other
room state. Schema version 5 exports include every configuration revision;
imports require a matching schema version and an empty destination. Open older
rooms with this release and re-export to migrate older exports. `squad clear`
resets integration configuration and its history along with the rest of the room;
`squad nuke` removes the room directory. Export first when history must survive.
Neither operation changes the configured Git repository.

## Durable submissions and evidence

Submit exact full lowercase Git commit IDs (40 or 64 hexadecimal characters), in
integration order, against the current configured revision:

```sh
squad integration submit --request-key lemma-17-v1 --config-revision 1 \
  --commit <full-commit-id> --node lemma-17
squad integration attempt <attempt-id>
squad integration attempts --status pending --limit 50
```

Repeat `--commit` for multiple commits and `--node` for optional stable research
node references. Node references are reserved links, not evidence that a node,
Science Card or independent review exists. Submission validates ID syntax only;
the banking executor must prove the commits exist in the configured repository.
Submission never runs Git, executes the build, publishes work or marks it banked.
Queries report known submissions, not unobserved local edits.

MCP equivalents are `squad_integration_submit` (`request_key`, `config_revision`,
`commits`, optional `node_refs`), `squad_integration_attempt_get` (`id`), and
`squad_integration_attempt_list` (optional `status`, `limit`). Status is `pending`,
`failed` or `verified`; list limits are 1–1000, default 50, newest first.

A room-wide request key identifies one ordered commit selection, node-reference
set and configuration revision. Identical retries return the same attempt even
after configuration changes; conflicting reuse fails. Each attempt pins its full
configuration snapshot, stable ID, submitting actor and timestamps. Configuration
changes never retarget it. Queries remain available when its repository is missing.
A chat message saying “banked” has no effect on integration state.

Only the internal trusted executor API can append evidence or finalize a verified
record. It must supply the exact candidate commit/tree/base, a successful build of
that commit/tree using the configured command with observed clean tracked inputs,
and a subsequent publication intent and receipt for the configured remote and
branch. A receipt observing a later descendant additionally requires the executor
to prove candidate ancestry. This ledger checks evidence consistency, not Git or
build truth; the executor owns those observations. No CLI or MCP operation accepts
claimed build/publication success. Banking and independent node review are separate.

Every evidence event records its actor, run identity, sequence and timestamp.
Build output is stored in the room (first 65,536 JavaScript string characters,
with an explicit truncation flag), not only at an ephemeral logfile path. Keep
secrets out of build output. Failed attempts retain their diagnostics. An explicit
retry starts a new run and requires fresh verification evidence; an interrupted
pending run can resume its existing evidence after safely recovering publication.
Verified records are immutable, and finalization retries return the original receipt.

Executor claims use an opaque token, expiry and revision checks to fence concurrent
writers. A takeover after expiry preserves the interrupted run identity; renewals
must happen during long builds. Claims do not fence external Git pushes, so the
executor must also use non-forcing remote updates and reconcile publication before
retrying. Claim tokens are excluded from public attempt queries.

The `integration_attempts`, `integration_events` and `integration_runners` tables
travel with configuration in schema-5 exports and are covered by explicit room
reset. Opening an older room adds empty ledger tables without changing existing
room state. Exported active claims retain their expiry; a restored room can reclaim
them after expiry. Do not run two restored copies as concurrent executors against
the same target. Attempts do not contain or fabricate independent-review evidence.
