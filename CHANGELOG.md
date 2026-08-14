# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Directed review requests (#39): `squad_review_open` / `squad_review_claim` /
  `squad_review_resolve` / `squad_review_cancel` / `squad_review_list` MCP
  tools and a matching `squad review` CLI family, backed by a new
  `review_requests` table. A review request is a durable, directed ask — a
  `target` persona, `refs`, a `priority` (`low`/`normal`/`high`/`urgent`), a
  body, and an optional expiry — with a server-enforced state machine
  (`pending → claimed → resolved`, and `pending|claimed → cancelled`), so
  "you specifically need to look at this" no longer has to compete with
  ordinary prose in the chat log. Claiming records the claimant and a claim
  timestamp (the ack/lease the requester is waiting on); only the target may
  claim, only the claimant may resolve, and either side may cancel. Every
  transition is announced in chat as a system message. `squad_join` returns
  `pending_reviews` and `squad_check` adds `pending_review_count` /
  `pending_reviews` alongside `open_goals`/`active_claims`, both scoped to the
  caller and ordered most-urgent-first, so a re-entering peer can work by
  priority instead of replaying chat chronologically. Expiry is lazy — derived
  at read time like presence staleness, never written back — so a request past
  its `expires_ts` simply stops gating its target, with no background process
  and no explicit cancel needed.
- Opt-in runtime re-entry adapter (#40): `./install.sh --reentry` (default
  off) installs a Claude Code `Stop` hook (`.claude/hooks/squad-reentry.sh`,
  wired into `.claude/settings.json`) that re-arms a session going idle in
  `/squad:join` with exponential backoff+jitter, resets immediately on an
  `@mention` directed at the persona, and is bounded by a configurable TTL
  (`SQUAD_REENTRY_TTL_MINUTES`, default 240 minutes) and an operator-stop
  escape hatch (`SQUAD_REENTRY_STOP=1` or a `.squad/reentry-stop` marker
  file) that always wins, so a session can never be held open forever on
  unread chatter alone. Backoff/TTL state persists per-persona at
  `.squad/reentry/<persona>.json`. New `src/reentry.ts` (pure decision logic)
  and `src/reentry-hook.ts` (the hook's stdin/stdout protocol glue). No Codex
  equivalent yet — this repo has no confirmed Codex hook/scheduled-task
  primitive to build one on (see README.md "Re-entry (opt-in)").
- Presence leases (#38): presence is now a renewable lease with a derived
  `active`/`idle`/`stale` state instead of a permanent joined bit. `squad_join`
  opens a session (new `sessions` table, one row per *connection* — keyed by
  `session_id` with a `persona` column, so a persona can be in the room twice
  and session-scoped state has somewhere to live) and returns `session_id` /
  `joined_at` / `lease_expires_at`; every `squad_*` call renews the lease, so
  there is no heartbeat to remember. **`squad_check` now returns `peers` with
  their presence on every call** — previously the only way to see a peer's
  `last_seen` was to call `squad_join` again — and a new `squad_leave` tool
  (plus `squad leave` CLI) ends a session explicitly, announced in chat with
  any claims the leaver still holds. Advisory claim staleness is derived from
  that same lease (`squad_claims` gained a `holder_state`), so a claim and its
  holder can never disagree about being stale. `SQUAD_IDLE_MINUTES` (default 5)
  sets the active→idle window inside the existing `SQUAD_STALE_MINUTES`
  (default 30) lease; `squad who` shows presence state, and `squad clear` /
  `squad_clear` wipe sessions along with everything else.
- `squad doctor` (#15): a preflight/diagnostic CLI subcommand that checks
  whether the MCP server's runtime dependencies (`@modelcontextprotocol/sdk`,
  `zod`) actually resolve, whether the database is reachable, and how the
  persona will resolve — the tool for finding out *why* a harness came up
  with no `squad_*` tools instead of guessing. It keeps working even when the
  dependencies it's checking are missing.
- Advisory claim primitive (#12): `squad_claim` / `squad_release` / `squad_claims`
  MCP tools and `squad claim <path>` / `squad release <path>` / `squad claims`
  CLI subcommands. A claim is freeform text (file path or area label) stored in
  a new `claims` table, announced in chat as a system message, included in every
  `squad_join` result, and counted as `active_claims` in `squad_check` — so a
  claim is visible *before* an edit lands, unlike an "I'm editing X" chat
  message that races with the teammate's edit. Claims are advisory, never locks:
  claiming a path a peer holds is allowed (the announcement names them), and a
  claim is listed as `stale` once its holder's `last_seen` ages past
  `SQUAD_STALE_MINUTES` (default 30) so a peer can take it over explicitly.
  `squad clear` / `squad_clear` wipe claims along with the other tables.

### Changed
- Squad conventions now say: claim a file before editing it, and never delete
  files you did not create, however scratch-like they look — untracked ≠ yours
  (#12, mirrored across `skills/squad/SKILL.md`, `commands/squad/join.md`, and
  `codex/prompts/squad-join.md`).

### Fixed
- A wiped/missing `node_modules` in the source clone silently disabled the
  room for every agent at once (#15): `index.ts` now imports `mcp.js` (the
  only module that depends on anything outside Node's built-ins) lazily,
  only when actually starting the MCP server, so a broken `node_modules`
  degrades gracefully instead of taking the whole binary down — the CLI
  (`squad doctor`, `squad --help`, etc.) still runs. A failed MCP-server
  startup now also leaves a system message in the room itself (using only
  the built-in-only `db.js`/`core.js` modules), so a teammate already
  connected sees *why* this persona has no `squad_*` tools instead of
  silently proceeding uncoordinated. `install.sh` now verifies the runtime
  dependencies actually resolve (attempting the same dynamic import `mcp.js`
  performs, not just checking that `dist/index.js` exists) and fails loudly,
  before writing any target-repo config, if they still don't resolve after
  attempting an install.
- Room resolution in git worktrees (#6): a linked worktree now resolves to the
  primary clone's `<repo>/.squad` (via `git rev-parse --path-format=absolute
  --git-common-dir`) instead of its own private, empty room — so a Codex agent
  started in a worktree joins the same room as Claude agents in the primary
  clone. `SQUAD_DIR` still takes precedence, an explicit `.squad` in the
  worktree still opts it into its own room, and resolution falls back to the
  previous cwd walk when `git` is unavailable. As defense in depth, joining an
  empty room from a worktree whose primary clone has a live room now prints a
  warning to stderr naming the `SQUAD_DIR` to set.

## [0.2.0] - 2026-08-07

### Added
- `squad goals reopen <id>` and matching `squad_goal_reopen` MCP tool: undo a
  mistaken `done` by resetting the goal to open and clearing `done_by` /
  `done_ts`, auto-announced in chat (#5).
- Installer contract conformance (#4): `install.sh` now records a tracked
  `.claude/skills/squad/install-metadata.json` (`version`, `commit`,
  `layout_version` — byte-identical on every machine) so `/repo:update-tools`
  discovers squad installs, plus a gitignored `.install-local.json` sidecar
  for the machine-local source path and install timestamp.
- `install.sh --dry-run`: prints every planned write — including the global
  Codex writes outside the target repo — changes nothing, exits 0 (#4).
- `VERSION` at the repo root, populated and enforced against `package.json`
  by a test; the installer reads it as the single source of truth (#4).

### Changed
- Bump zod 3.25.76 → 4.4.3, typescript 5.9.3 → 7.0.2, @types/node 24 → 26 (#1, #2, #3).
- tsconfig: explicit `types: ["node"]` — TypeScript 7 no longer auto-includes
  `node_modules/@types`.

## [0.1.0] - 2026-08-05

Initial release.

### Added
- `squad` stdio MCP server: `squad_join`, `squad_send`, `squad_check` (durable
  per-persona cursors, `peek`, long-polling via `wait_seconds`), `squad_goals`,
  `squad_goal_add` / `squad_goal_done` (auto-announced in chat), `squad_clear`.
- Human CLI on the same binary: `send | read | tail | goals | who | clear | path`.
- Per-repo rooms: SQLite (WAL) at `<repo>/.squad/squad.db`, resolved via
  `SQUAD_DIR` env or by walking up to the nearest repo root; `~/.squad` fallback.
- Server-stamped identity with harness autofill (Claude Code → `claude`,
  Codex → `codex`) and `SQUAD_PERSONA` pinning.
- `install.sh` / `uninstall.sh`: Claude Code and Codex as peers — `.mcp.json`
  entry, `/squad:*` commands + skill, identical marker blocks in `CLAUDE.md`
  and `AGENTS.md`, one-time global Codex registration.
- Test suite (`node --test`) covering core room semantics and dir resolution.
- Dependabot config (weekly npm; minors/patches grouped, majors individual).
