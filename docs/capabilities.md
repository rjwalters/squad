# Squad capabilities across runtimes

Claude Code and Codex load the same Squad MCP server and receive the same tools
and schemas. The native skills and legacy aliases route to the same workflow
references. Any CLI operation is also available from either runtime's shell.
CLI output is text; MCP output is structured JSON.

| Capability             | MCP in Claude Code and Codex                                                                                                      | CLI in either runtime or a human terminal                                                                                          | Difference                                                                                                                                                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Join and identify room | `squad_join`                                                                                                                      | `squad path`, then `squad send` to announce participation                                                                          | MCP join opens a connection lease and returns identity, room, presence, goals, research nodes, claims and recent history. CLI has no `join` command; `send` opens presence.                                                                        |
| Post                   | `squad_send`                                                                                                                      | `squad send`                                                                                                                       | Same server-stamped sender and shared message history.                                                                                                                                                                             |
| Read                   | `squad_check`, `squad_join`                                                                                                       | `squad read`                                                                                                                       | Check consumes unread messages per connection and excludes the sender's own messages; `peek` preserves its cursor. Join returns recent history and advances the cursor. CLI read is repeatable, stateless history, including self. |
| Follow live            | `squad_check` with `wait_seconds`                                                                                                 | `squad tail`                                                                                                                       | MCP long-polls unread messages; CLI streams history and new messages without consuming a cursor. There is no MCP `squad_tail` tool.                                                                                                |
| Presence               | `squad_join`, `squad_check`                                                                                                       | `squad who`                                                                                                                        | MCP returns presence in the collaboration response and renews its lease. CLI `who` observes presence.                                                                                                                              |
| Leave                  | `squad_leave`                                                                                                                     | `squad leave`                                                                                                                      | MCP ends its connection lease; CLI ends all leases for its persona. Both leave claims and history intact.                                                                                                                          |
| Shared goals           | `squad_goals`, `squad_goal_add`, `squad_goal_done`, `squad_goal_reopen`                                                           | `squad goals`, `squad goals add`, `squad goals done`, `squad goals reopen`                                                         | MCP lists open goals by default (`include_done` includes completed goals); CLI lists both. Mutations announce the same events.                                                                                                     |
| Advisory claims        | `squad_claims`, `squad_claim`, `squad_release`                                                                                    | `squad claims`, `squad claim`, `squad release`                                                                                     | Same advisory records; claims do not lock files. Release can explicitly take over a stale peer claim.                                                                                                                              |
| Science Cards          | `squad_card_create`, `squad_card_update`, `squad_card_list`, `squad_card_get`, `squad_card_transition`, `squad_card_evidence_add` | `squad card create`, `squad card edit`, `squad card list`, `squad card show`, `squad card transition`, `squad card evidence`       | Same state machine, evidence gates and data. MCP uses named fields; CLI uses arguments/flags. MCP create requires a title; CLI can derive it from the question.                                                                    |
| Node claims and review | `squad_node_claim`, `squad_node_review` | `squad node claim ID REVISION [TARGET]`, `squad node review REQUEST_ID JSON` | Directed request deduplication, exact bank independent rebuild and durable verdict. Claim the review first. |
| Research nodes | `squad_node_create`, `squad_node_get`, `squad_node_list`, `squad_node_update`, `squad_node_submit` | `squad node create`, `squad node show`, `squad node list`, `squad node update`, `squad node submit` | Same Science Card IDs, dependencies, artifacts, content revisions and bank provenance. CLI metadata uses JSON; MCP uses named fields. Node queries include exploratory/negative outcomes and are read-only. |
| Independent proposals  | `squad_diverge_open`, `squad_diverge_submit`, `squad_diverge_status`, `squad_diverge_close`                                       | `squad diverge open`, `squad diverge submit`, `squad diverge status`, `squad diverge close`                                        | Same hidden-until-reveal rounds.                                                                                                                                                                                                   |
| Directed reviews       | `squad_review_open`, `squad_review_claim`, `squad_review_resolve`, `squad_review_cancel`, `squad_review_list`                     | `squad review open`, `squad review claim`, `squad review resolve`, `squad review cancel`, `squad review list`, `squad review show` | Same requests and permission rules. CLI additionally has single-request `show`; MCP can inspect lists including terminal and expired requests.                                                                                     |
| Integration configuration | `squad_integration_get`, `squad_integration_set`, `squad_integration_unset`, `squad_integration_check` | `squad integration show`, `squad integration set`, `squad integration unset`, `squad integration check` | Same revision-guarded shared target and read-only repository validation. Configuration does not execute integration or build commands. |
| Verified banking | `squad_bank` | `squad bank` | Same isolated integration, exact clean build, non-forcing publication and resumable receipt. Check reports historical verified/pending/failed counts and unobserved local work. |
| Integration attempts | `squad_integration_submit`, `squad_integration_attempt_get`, `squad_integration_attempt_list` | `squad integration submit`, `squad integration attempt`, `squad integration attempts` | Same pending submissions and durable evidence. No public evidence-writing or mark-success operation; submission does not execute banking. |
| Reset room             | `squad_clear`                                                                                                                     | `squad clear`                                                                                                                      | Same reset; the shared workflow requires explicit user intent before invoking it. The tools do not add an interactive confirmation prompt.                                                                                         |
| Export/import room     | None                                                                                                                              | `squad export`, `squad import`                                                                                                     | CLI-only SQLite backup/restore. Unsupported MCP names return errors.                                                                                                                                                               |
| Diagnostics/help       | Tool discovery through MCP                                                                                                        | `squad path`, `squad doctor`, `squad help` (`--help`, `-h`)                                                                        | CLI-only diagnostics; no MCP `squad_doctor` or `squad_path`.                                                                                                                                                                       |
| Remove room directory  | None                                                                                                                              | `squad nuke`                                                                                                                       | Destructive CLI-only administrative operation; separate from uninstalling adapters.                                                                                                                                                |
| Re-entry               | Shared join workflow plus runtime-specific launch support                                                                         | `squad codex-reentry`                                                                                                              | Codex uses the foreground supervisor; Claude's opt-in Stop hook is installed with `--reentry`. They share bounded re-entry logic, but use different harness mechanisms.                                                            |

Unknown CLI commands exit nonzero and name the unsupported command. Unknown MCP
tools return an explicit error. Do not substitute an invented MCP name for a
CLI-only operation. Both runtimes can use the documented CLI when appropriate.

## Two agents, one goal

Install Squad into a scratch repository, then start Claude Code and Codex from
that same repository. Restart existing sessions after changing MCP configuration.
If the CLI is not linked, replace `squad` below with the `node …/dist/index.js`
command printed by the installer.

1. In Claude Code, request `/squad:join`. In Codex, request `$squad Join the room
and collaborate on its shared goal`. Each follows the same join procedure.
   Confirm the returned `db` paths match, and retain each returned `persona`.
2. In a human terminal in that repository, run
   `squad goals add "Document a small change and independently verify it"` and
   `squad tail`. Human CLI messages are stamped `human` by default.
3. Ask Claude to claim `docs/change.md`, write the agreed change, and post its
   result with `squad_send`. Ask Codex to inspect `squad_goals`, claim a distinct
   verification area, and use `squad_check` to receive Claude's result. Address
   messages using the actual returned names, not assumed `claude`/`codex` pins.
4. Codex verifies the change, posts evidence, and marks the shared goal done
   using `squad_goal_done` only after the agreed check succeeds. Claude confirms
   it using `squad_goals` with `include_done: true`. Both release their claims.
5. Each calls `squad_leave` when finished. Stop the human tail with Ctrl-C.

For an agent's CLI handoff, set `SQUAD_SESSION_ID` to its non-null returned
`identity_id` on every invocation. If the agent uses an explicit persona or has
renamed itself, set `SQUAD_PERSONA` to its returned name instead. The connection's
`session_id` is a presence lease, not a resume token. Fresh installs leave
identities unpinned; existing custom pins remain explicit overrides.

## Verification and its limits

`tests/installed-parity.test.mjs` installs into a fresh scratch repository and
isolated Codex home. It launches independent MCP clients using the actual
installed `.mcp.json` and Codex `config.toml`, compares their tool schemas, and
exercises joining the same database, distinct automatic identities, sending,
checking, claims, shared goals, live polling, CLI history/tail and identity
handoff. It also checks explicit failures for unsupported CLI/MCP operations.

These are deterministic installed-adapter/protocol tests. They do not launch
Claude or Codex models or establish that a model will select the skill correctly
for every natural-language request. The walkthrough above is a manual scenario,
not a claimed model-generated transcript. Native Codex skill discovery was also
checked separately with the local Codex app server's `skills/list` against a
fresh installation.

CI runs the adapter generator in `--check` mode and the complete test suite.
Canonical procedure changes reach both installed skill bundles; generated
aliases contain only routing. The installation tests compare installed reference
bytes and shared instruction blocks, so checked-in or installed adapter drift
fails validation.

For shared node discovery, committed artifacts and bank provenance across
worktrees, follow [Durable research nodes](nodes.md).
