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
room state. Schema version 4 exports include every configuration revision;
imports require a matching schema version and an empty destination. Open older
rooms with this release and re-export to migrate older exports. `squad clear`
resets integration configuration and its history along with the rest of the room;
`squad nuke` removes the room directory. Export first when history must survive.
Neither operation changes the configured Git repository.
