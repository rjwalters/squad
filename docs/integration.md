# Shared integration target

Research integration is opt-in. Existing rooms need no configuration. All
participants using the same room database read the same configuration, independent
of their current working directory. Banking executes integration, an exact candidate
build and publication through this shared target.

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

## Execute banking

`squad bank <attempt-id>` and MCP `squad_bank` (`id`) execute or resume an attempt.
They return the same durable attempt JSON. CLI exits nonzero for failed/pending
results. MCP callers must inspect `status`; only `verified` is banked.
The default build timeout is 30 minutes, configurable per call with
`--build-timeout-ms` / `build_timeout_ms` (1,000–86,400,000 ms). Git operations
have a separate 60 second timeout. Configure dependency setup explicitly, for
example `pnpm install --frozen-lockfile && pnpm test`; source `node_modules`,
untracked inputs and local configuration are not copied. No Loom installation
is required in consumer repositories.

Without `selection`, every submitted commit and its ancestry is merged in listed
order with `--no-ff` into the fetched target. This can include unrelated ancestor
changes: use artifact selection when only particular files should be integrated.
An absent target branch starts from the first submitted commit. Full IDs must be
commit objects available in the pinned source repository; no HEAD, branch-name,
caller-directory, path or theorem guessing occurs. Dirty source files are excluded
from full-commit execution and remain untouched.

For only declared committed artifacts, submit exactly one commit with repeated
`--path` flags. Optional `--theorem` declares the label's artifact mapping:

```sh
squad integration submit --request-key lemma-17-artifacts --config-revision 1 \
  --commit <full-commit-id> --path Proofs/Lemma17.lean --theorem lemma17
squad bank <returned-attempt-id>
```

MCP submission uses `selection: {paths: ["Proofs/Lemma17.lean"], theorem: "lemma17"}`.
This is an explicit caller declaration stored immutably with the request, not a
Lean symbol lookup or evidence the theorem is proved. A theorem without declared
paths is rejected. Paths are exact literal repository-relative regular files,
not globs, directories, symlinks or Git pathspec expressions. Traversal is rejected.
SHA-1 and SHA-256 repositories are supported; every commit in a submission must
use the same object algorithm, matching its source repository. Recovery chooses
the same algorithm from the durable IDs even when the source is unavailable.
Files must exist at the submitted commit; selected deletions require full-commit
mode. Selected files must have no staged/unstaged/untracked changes and their
working contents must match the submitted commit. Unrelated dirty files remain
untouched. The target must exist and share a merge base with the submitted commit.
Only selected changes from that merge base to the submitted commit are applied
using Git's three-way indexed patch application, then committed in isolation.
Conflicts fail; unrelated changes in the same source commit are excluded.
Normalized artifact paths and theorem declaration participate in retry identity.

The runner creates its own temporary repository and fetches committed objects
without altering source refs, index, config or files. It disables inherited Git
environment overrides and hooks for owned Git operations, and suppresses optional
source index refreshes. Global/system credential helpers and SSH settings remain
available; source-local transport settings are not copied. Effective isolated
fetch/push URLs must still match the pinned destination after URL rewriting. It
renews ownership and presence while asynchronous builds run. Timeout, CLI signals
and MCP cancellation terminate the subprocess group. Abrupt process death leaves
a reclaimable lease; it may leave a runner-owned temporary directory.

Each candidate records the fetched base and exact commit/tree. A build must exit
zero and leave HEAD, tracked files and index unchanged. Physical tracked bytes,
executable modes and symlink targets are hashed directly against the committed
blobs, independently of Git trust flags or stat caching. The same direct check
rejects hidden selected-source edits without changing the source index. Hashing
streams asynchronously so cancellation and ownership renewal remain responsive.
Checkout conversions/filters that change stored blob bytes and Git submodules
are explicitly unsupported and fail closed. Untracked build outputs
are allowed; they are never copied from source. Build output and timing are durable
ledger evidence. Before publication the runner revalidates configuration and its
lease, records intent, and pushes without force. A competing target advancement
requires a new integrated candidate and fresh build, bounded to three candidates.
A changed/disabled configuration blocks new publication and requires a new request. Cancellation or configuration changes cannot retract an
already accepted in-flight remote update; recovery records the observed historical
publication.

After a failed or interrupted push, the executor fetches the remote and checks
whether the exact candidate is present or an ancestor of the observed target.
An uncertain outcome stays pending with diagnostics. Calling bank again recovers
matching durable build/intent evidence without integrating twice, including when
configuration was subsequently disabled. Recovery only observes that historical
target; it cannot publish under stale configuration. If no publication is found,
an explicit retry rebuilds. Build failures and conflicts remain failed with useful
diagnostics. Failed, pending and verified records all remain queryable offline.

`squad_check` returns `integration.configuration`, total `known_submissions`
counts (`pending`, `failed`, `verified`) across historical configurations, and
`local_work_visibility: "unobserved"`. Historical verified counts do not assert
that commits remain on a remotely rewritten target. An empty ledger never certifies
that local work is absent. Banking never confers independent node review.

Internal artifact producers can reuse `executeIntegration` with a
`PreparedIntegrationSource` after establishing ownership/provenance for their
isolated source repository. Its config revision and ordered commits must match the
immutable submission. This source override is not a CLI/MCP parameter; public
banking always resolves the configured source. Producers must retain or recreate
prepared objects for retries and pass the same executor rather than assert success.
