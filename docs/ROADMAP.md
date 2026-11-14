# squad roadmap

squad is a per-repo chat room, goal board and research-integration layer that
coding agents join through one MCP server and a matching CLI.

Status as of 2026-11-13, `main` @ `0995fcd`, `VERSION` 0.19.38.

The tracker owns individual work items; [`WORK_PLAN.md`](../WORK_PLAN.md)
mirrors its labels.

## Where it stands

Shipped and covered by the `node:test` suite (57 test files under `tests/`, run
by CI on Node 22 and 24):

- **Room core.** Messages, per-session read cursors, presence, goals, advisory
  claims, export/import, cross-room requests and replies with an optional
  `routing.json` policy (`src/core.ts`, `src/db.ts`, `src/routing.ts`).
- **One capability surface, two front ends.** The MCP tools and the CLI verbs
  are listed side by side in [`capabilities.md`](capabilities.md);
  `tests/installed-parity.test.mjs` installs into a scratch repository and
  checks that matrix against the registered tool list for the Claude Code and
  Codex registrations.
- **Science Cards, divergence rounds, directed reviews.** State machine with
  evidence gates; reviews and divergence rounds already live in their own
  modules (`src/reviews.ts`, #193; `src/diverge.ts`, #301 / PR #303).
- **Research integration** (epic #55, closed as implemented): shared
  integration target, durable research nodes, node review, verified banking,
  generated outline, shared steward, room drift report
  ([`integration.md`](integration.md), [`nodes.md`](nodes.md)).
- **Re-entry.** One supervisor entry point, `squad agent <runtime>`, with
  Codex, Claude and opencode adapters (#230 and children, all closed;
  [`supervisor.md`](supervisor.md)). `squad codex-reentry` remains as a
  deprecated alias. The Claude Stop hook, the mid-turn inbox hook and the waker
  are separate opt-in installs.
- **Room loop in code.** `squad wait` and the `/squad:wait` workflow (#222).
- **Install lifecycle.** `install.sh` / `uninstall.sh`, release installs, room
  healing, and a CI check that an installed-surface change carries a `VERSION`
  bump (`scripts/check-surface-version-bump.sh`).
- **opencode as a third installed runtime** (#227): `opencode.json` merge and
  `.opencode/commands/`, covered by `tests/install-lifecycle.test.mjs`.

What is implemented but **not** evidenced:

- The `claude` and `opencode` adapters behind `squad agent` are unit tested
  against shims only. No live launch or resume is recorded
  (`supervisor.md`, "Per-runtime contract"); tracked on #265.
- The opencode adapter records no wake handle and reports `supportsResume`
  false, because the source of the opencode session id is unknown
  (`src/opencode-agent.ts`).
- The installed-parity test does not load the opencode registration, and
  `capabilities.md` still describes two runtimes.
- The research-integration layer has no accepted week-long room trial (#78).

## Now

Both items below were filed as issues on 2026-11-14, the day after this
file's status date, and both are curated and dispatchable today.

1. **Extract the Science Card domain from `src/core.ts`.**
   `core.ts` is 3,342 lines and cards are the largest domain still inside it.
   Follow `src/reviews.ts` and `src/diverge.ts` (explicit context object).
   Done when: `src/cards.ts` exists, `Squad.card*` delegate to it, `core.ts`
   re-exports the card types so imports do not change, and `pnpm test` passes
   with no test file edited. Issue: #310. Blocked by: nothing.
2. **Cover the opencode registration in the installed-parity test.**
   Done when: `tests/installed-parity.test.mjs` launches an MCP client from the
   installed `opencode.json`, asserts its tool list and schemas equal the Claude
   and Codex ones, and `docs/capabilities.md` names opencode wherever it says
   which runtimes load the server. Issue: #311. Blocked by: nothing.

## Next

- **Land `squad review request` as an alias of `review open`** (#295, PR #300).
  Done when PR #300 is merged with `VERSION`, `package.json` and the
  `McpServer` version string moved together and its CHANGELOG entry in a new
  section. Waits on: the operator-confirmed bump (see below).
- **Record live `squad agent claude` output.** Done when `supervisor.md` no
  longer carries the "not yet recorded" note and the `session_id` / `is_error`
  field names in `src/claude-reentry-driver.ts` are confirmed against real
  `--output-format json` output, or a fix issue is filed. Waits on: #265.
- **Enable resume for the opencode adapter.** Done when the adapter calls
  `recordWakeHandle` with `runtime:"opencode"`, `supportsResume` is true, and a
  shim test covers a `--session <id>` re-entry. Waits on: #265 establishing
  where the session id can be read.

## Later

Direction only. Each needs its question answered first.

- **Continue splitting `core.ts`** (goals and claims, cross-room delivery,
  identity and presence). Question: after cards are out, which remaining
  domain can take an explicit context object without threading `touch()` and
  cursor state through it?
- **Remove the `squad codex-reentry` alias.** Question: how long does the
  deprecation note (0.19.33) stand before removal, and does removal need a
  minor-version bump?
- **A single-request review read over MCP.** The CLI has `squad review show`;
  MCP has only `squad_review_list`. Question: is the gap intentional, as
  export/import and `doctor` being CLI-only are, or a parity miss?
- **Model-level verification.** The parity tests do not launch a model
  (`capabilities.md`, "Verification and its limits"). Question: is there a
  repeatable two-agent scenario CI could run without credentials?

## Blocked and waiting

- **PR #300 (`loom:operator`)**: code-complete, tests green, CI red only on
  `check-version-bump`. The Doctor role may not hand-bump `VERSION`; the bump
  level and changelog text need operator confirmation. `main` has since moved
  to 0.19.38, so the bump must now go past that.
- **#265 (`loom:operator`)**: the live checks need a person at a host that has
  the runtime binaries and working credentials. The dispatch hosts have neither.
- **#78 (`loom:blocked`)**: the first trial was rejected (about 42 of 168 hours
  observed). Per the rulings recorded on the issue, a restart needs a viable
  steward/quota plan and a durable destination for new evidence. No agent work
  is available on it until that plan exists.

On this file's status date the repo had **no dispatchable issue**: one PR
waited on an operator action, and both Now items were unfiled. They were filed
the next day as #310 and #311, which are now the only dispatchable work.

## Not planned

- **Named rooms, TTLs, allowlists, encryption, multi-host rooms.** One room per
  repo is deliberate; multi-host or encrypted coordination belongs to the
  sibling project [safehouse](https://github.com/rjwalters/safehouse).
- **A scheduler for review expiry or presence**; both are derived on read.
- **MCP twins for `export`, `import`, `doctor`, `path`, `nuke`**; CLI-only by
  design (`capabilities.md`).
- **Bundling `dist/`**, and **retiring the waker or the Claude Stop hook**
  (README "Design notes"; `supervisor.md` "Verdict per existing piece").
