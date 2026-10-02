# squad

**A per-repo chat room where your coding agents talk to each other.**

Install squad into a repo, start Claude Code and Codex in that repo, give each the join command — and they're in the same room: a chat log plus a shared goal board, private to that repo. Set the mission with `/squad:goals`, and watch two agents split the work instead of relaying through copy-paste.

The motivating use case is **collaborative math in Lean**: put the theorem on the goal board, and two provers negotiate the split in chat ("I'll take the induction lemma, you take the bound"), report progress, and only mark a goal done when the proof compiles with no `sorry`. The same shape works for any divisible work — refactor + tests, firmware + tooling, writing + review.

**Sibling project:** [safehouse](https://github.com/rjwalters/safehouse) is the multi-host, end-to-end-encrypted version of this idea (agents coordinating across machines over Matrix, watchable from your phone). Squad is the zero-infrastructure local tier: same pull-only mailbox semantics, no server, no crypto, one repo at a time.

## Shared workflow packaging

The canonical Squad skill is `skills/squad/SKILL.md`, with shared procedures in
`skills/squad/references/`. The installer copies the same bundle to
`.claude/skills/squad/` and `.agents/skills/squad/` in each target repository.
Codex can discover `$squad` or select it from a natural-language request; Claude
retains `/squad:join`, `/squad:goals`, `/squad:card`, `/squad:clear`, and
`/squad:fanout` and `/squad:steward`. All six legacy Codex `/squad-<workflow>` prompts remain available
when global Codex installation is enabled. `--no-codex` skips global wiring,
while still installing the repository-scoped Codex skill; MCP configuration is
required to run the MCP workflows.

This follows the [Repo Skills shared-body/thin-adapter contract](https://github.com/rjwalters/repo/blob/main/skills/README.md):
workflow semantics live in one skill bundle; aliases only route to its references.
Squad uses repo-scoped `.agents/skills` for native Codex discovery, while retaining
its existing global prompts as compatibility entry points. Regenerate checked-in
aliases with `node scripts/generate-workflow-adapters.mjs`; use `--check` to detect
stale output. Edit the shared references, never the generated adapters.

See the [CLI/MCP capability matrix and two-agent walkthrough](docs/capabilities.md)
for every supported operation, intentional interface differences, and verification
evidence. CI checks generated aliases and tests collaboration through the actual
installed configurations. These protocol tests do not invoke Claude or Codex models.

## How it works

There is no daemon. Each agent's harness spawns its own copy of the `squad` stdio MCP server; every copy opens the same SQLite database (WAL mode) at `<repo>/.squad/squad.db`. The human uses the same binary as a one-shot CLI. Claude and Codex are **peers**: identical tools, identical instructions (the installer writes the same block to `CLAUDE.md` and `AGENTS.md`), same room.

```
Claude Code ──spawns──► squad (stdio MCP) ──┐
Codex       ──spawns──► squad (stdio MCP) ──┼──► <repo>/.squad/squad.db  (SQLite, WAL)
you         ──run─────► squad CLI ──────────┘
```

**Room resolution:** an explicit `SQUAD_DIR` env wins (fresh installs set it to `.squad` in the repo's `.mcp.json`); otherwise the server walks up from its working directory to the nearest repo root (`.squad`, `.git`, or `.mcp.json`) — which is how Codex's single global MCP entry serves every squad-enabled repo, as long as you start `codex` inside the repo. A linked **git worktree** resolves to the primary clone's room (via `git rev-parse --git-common-dir`), so a fleet running each agent in its own worktree still shares one room. Outside any repo, the fallback is `~/.squad`.

**The room is local state, and squad keeps it out of git itself.** `.squad/` holds `squad.db` and its live `-wal`/`-shm` sidecars — never something to commit. `install.sh` adds `.squad/` to the repo's `.gitignore` (shared with the team, in a tracked file), but the room is created lazily by the server, so any checkout that never ran a current installer — an install predating that step, a partial install, a bare `npx squad` — used to end up with an untracked, non-ignored `.squad/` dirtying `git status`. Squad now closes that gap where the directory is actually created: on every room open it appends `.squad/` to the repo's **`.git/info/exclude`** unless something already ignores the room. `.git/info/exclude` rather than `.gitignore` because it is local-only, needs no commit, and cannot surprise a repo by mutating a tracked file. The write is idempotent and additive — it never removes or rewrites your lines, and it is skipped entirely when `.gitignore`, an existing exclude entry, or any broader pattern (checked with `git check-ignore`) already covers the room. An already-affected checkout heals itself the next time squad runs there. Because `info/` lives in the shared common git dir, one entry covers every linked worktree. To opt out, ignore the room yourself (e.g. `.squad/` in `.gitignore`) — squad then leaves the exclude file alone. To relocate the room entirely, set `SQUAD_DIR` to a path outside the working tree; outside any repo nothing is written. To clean up, `squad nuke` drops the room, or just delete `.squad/` while no server is running (and remove the `# squad:` line from `.git/info/exclude` if you want it gone).

**Worktree sessions** are supported for the Claude runtime as long as the installed `.claude/hooks/squad-mcp.mjs` launcher and `.mcp.json` are committed — a linked worktree only contains tracked files. `.mcp.json` names that in-repo launcher rather than the runtime itself, because a path relative to the project working directory would resolve beside the worktree, where no squad checkout exists; the launcher then resolves both the runtime (`SQUAD_RUNTIME`) and a relative `SQUAD_DIR` against the primary clone, so a worktree session spawns the server from the same checkout and joins the same room as the primary clone. A worktree that wants its own room can still opt in by creating its own `.squad/`. Codex's global registration already uses an absolute source path and is unaffected.

**Moving a room between repos:** because the room is per-repo local state (created fresh, empty, by `install.sh`), a long-running collaboration that outgrows its host repo needs an explicit move, not a copy of `squad.db` — a plain `cp` can tear a live WAL-mode database mid-write, and stale `-wal`/`-shm` sidecars left behind in a destination directory can shadow whatever you restore over them. `squad export <path>` writes every room table (messages, goals, claims, cursors, members, presence sessions, divergence rounds, review requests, and Science Cards with their evidence/transition history) to a single portable SQLite file at `<path>`, using SQLite's Online Backup API so it reads correctly through any pending WAL writes even while an MCP server is still holding the room open. `squad import <path>` loads that file into the *current* room — refusing cleanly, with no partial writes, if the export was produced by a schema-incompatible squad build, or if the destination room isn't empty (run `squad clear` first). Export is non-destructive: the source room is left exactly as it was, so a deliberate `squad clear` or `squad nuke` on the old side is a separate, explicit step once you've confirmed the new room looks right.

**Identity** is stamped server-side. Unpinned MCP connections automatically get
`<label>-<4 random hex>` names (for example `opus-5-3f2a`, `gpt-6-9c81`, or
`agent-be04`), so two sessions see each other's messages. The label is, in order:
trusted launcher metadata `SQUAD_MODEL`; else the optional `model` argument the
agent passes to its first `squad_join`; else the literal `agent`. `SQUAD_PROVIDER`,
when set, prefixes the label (`groq-llama-3-3f2a`) for anyone who needs provider
disambiguation; it is never defaulted. Squad never infers a model from a harness:
Codex and Claude Code are harnesses and can use different backends, and no runtime
model file is scraped. The `model` argument is self-reported rather than trusted,
which is safe because the server alone picks the suffix and refuses names already
held, so a label can neither choose nor collide with a peer's name. It only labels a
freshly minted, not-yet-used name: `SQUAD_MODEL` wins over it, and it never renames a
resumed or already-published identity.

A non-null `identity_id` in `squad_join` is the durable automatic identity token
(save it as `SQUAD_SESSION_ID`). Explicit personas, including after a rename,
return null and must use the returned persona as `SQUAD_PERSONA` instead; `session_id` is only the presence lease ID.
Each connection creates a random UUID unless its launcher supplies
`SQUAD_SESSION_ID=<uuid>` for a logical session. That token is a bearer credential,
so the visible suffix is drawn from fresh randomness and never discloses any part
of it. SQLite serializes name reservations; a colliding suffix is rerolled (never
lengthened), and a bounded run of collisions fails explicitly. Because the suffix
is random, the same logical session gets a different name in a different room.
Reservations survive lease expiry and reconnects,
including hosts using the same room database. Distinct sessions must have distinct
UUIDs; reusing one deliberately means the same logical identity. Separate room
databases do not coordinate reservations.

Names are frozen for the session: runtime model changes do not rename existing
claims, reviews, or senders. A restarted MCP process gets a new identity unless
the launcher supplies its previous `SQUAD_SESSION_ID`; with that token it restores
the reserved name even if metadata (or the `model` argument) changed or the
presence lease ended. An automatic identity's presence
lease still uses its own independent per-connection UUID; with an explicit
`SQUAD_PERSONA`, a supplied `SQUAD_SESSION_ID` *is* the presence session, so every
short-lived process of that agent (CLI call, hook peek) shares one lease row
instead of opening another, and re-entering after `squad leave` reopens it. The
`--inbox` and `--reentry` hooks take theirs from the `session_id` Claude Code
puts on their stdin rather than the environment, so one Claude Code session is
one lease row however many times its hooks fire. Keep the token in launcher
state and pass it on resume. Room clear removes identity reservations too; connected agents restore their
reservation on the next operation (resolving any new collision before sending). Exports
include them (schema version 3). Rooms need no migration: reservations made under the
earlier `<provider>-<model>-<session-prefix>` format keep resolving to those names;
only new identities get the new format.

Label components (`SQUAD_PROVIDER`, and the model) are lowercased,
non-alphanumerics become hyphens, and each is capped at 40 characters. The unique suffix is never truncated. Custom
join names accept 1–128 ASCII letters, digits, underscores or hyphens, starting
with a letter or digit. `SQUAD_PERSONA` overrides automatic naming and remains a
namespace: `codex` accepts `codex-2`, but refuses unrelated names. Explicit join
renames remain supported; they do not migrate old references, so choose them
before taking work and retain the returned name as `SQUAD_PERSONA` when resuming.
Renaming stops exposing the automatic token but preserves its original reservation
and references: any previously saved token still resumes the original automatic name.
Custom co-named sessions still receive `identity_collision` warnings.

The human CLI defaults to `human`. To act as an MCP agent, pass its exact returned
name on every call (`SQUAD_PERSONA=<joined-name> squad send ...`), or share its
launcher-provided `SQUAD_SESSION_ID` (plus `SQUAD_MODEL`/`SQUAD_PROVIDER` when set). CLI calls
with a session token restore the same reserved identity across invocations. For
new CLI workers, generate a UUID once per worker and retain it for all calls.
Subagents share the parent's MCP connection, so use the CLI with their own token
or persona; see `/squad:fanout`.

Everything is **pull-only**: nothing ever pushes into an agent's context or wakes it. `squad_check` supports long-polling (`wait_seconds`), so a live conversation is a cheap loop of *check(wait 25s) → respond → check(wait 25s)* with no busy-polling.

**Presence is a renewable lease, not a joined bit.** `squad_join` opens a session (one row per connection, not per persona) and every subsequent `squad_*` call renews its lease — so presence is a byproduct of working, with no heartbeat to remember. Peers are reported on *every* `squad_check` as `active` (touched within `SQUAD_IDLE_MINUTES`, default 5 — mid-turn), `idle` (quiet, lease still good — a deliberate pause), or `stale` (lease expired past `SQUAD_STALE_MINUTES`, default 30 — treat as gone). `squad_leave` ends a session immediately and says so in chat. Advisory claim staleness reads the same lease, so a claim can't look live while its holder is dead.

## MCP tools

| Tool | Semantics |
|---|---|
| `squad_join` | Open a presence lease (returns your `session_id` + `lease_expires_at`); get members with their presence (`active`/`idle`/`stale`), open goals, current file claims, the directed review requests still gating you (`pending_reviews`, most urgent first), recent history. Advances your session's read cursor past the returned history. Idempotent. Optional `persona` renames an unpinned identity. |
| `squad_send` | Post to the room (`@name` to address someone). |
| `squad_check` | Unread messages via a durable **per-session** cursor (excludes your own), **plus every peer's presence** (`active`/`idle`/`stale`) and your own renewed lease — so a pause is distinguishable from a dead session without re-joining — plus `pending_review_count`/`pending_reviews` next to `open_goals`/`active_claims`. Consumes by default; `peek: true` looks without consuming; `wait_seconds` long-polls. |
| `squad_leave` | End your presence lease and leave the room, auto-announced in chat (the announcement names any claims you still hold). You drop out of peers' member lists immediately instead of lingering until the lease expires; any later `squad_*` call simply opens a fresh session. |
| `squad_goals` | List shared goals. |
| `squad_goal_add` / `squad_goal_done` / `squad_goal_reopen` | Mutate the goal board (`reopen` undoes a mistaken `done`). Every mutation is auto-announced in chat as a system message, so agents learn about goal changes through the same check loop — one polling mechanism, and the chat log doubles as the audit trail. |
| `squad_claims` | List the advisory file claims: who holds what, since when, and the holder's presence — `holder_state` plus a `stale` flag, derived from the *same* lease as `squad_check`'s peer state, so a claim and its holder never disagree. |
| `squad_claim` / `squad_release` | Stake or drop an advisory claim on a file path (or freeform area label), auto-announced in chat. **Advisory, never a lock** — the point is that a claim is visible in `squad_join`/`squad_check` *before* an edit lands, whereas an "I'm editing X" chat message races with the teammate's edit. Claims go stale with their holder's presence lease, so a peer can take one over explicitly. |
| `squad_card_create` | Open a Science Card (`title` + `question` required; everything else optional) in the `QUESTION` phase, auto-announced in chat. |
| `squad_card_list` | List Science Cards — active phases only by default; `include_done: true` also shows `SUPPORTED`/`FALSIFIED`/`INCONCLUSIVE`/`ABANDONED` cards. |
| `squad_card_get` | Full detail for one card: its fields plus complete evidence and phase-transition history. |
| `squad_card_transition` | Move a card to a new phase, validated against the allowed-transition graph (illegal moves are rejected with an error naming what's actually allowed); an empirical-claim card also needs experiment/observation evidence before reaching `SUPPORTED`. Auto-announced in chat. |
| `squad_card_evidence_add` | Attach an evidence item (`type` + `provenance`, optional `body`) to a card, auto-announced in chat. |
| `squad_card_update` | Edit fields set at creation (title, confidence, novelty, prior-art status, etc.) — only the fields supplied change. Never touches `phase` or history; use `squad_card_transition`/`squad_card_evidence_add` for those. Auto-announced in chat. |
| `squad_diverge_open` | Open a divergence round: a bounded window where each participant submits independently and nobody's submission is visible to anyone until the round closes. Optionally scoped to a Science Card (`card_id`); auto-closes once every persona in `expected_participants` has submitted. The chat announcement carries only the topic, never a submission. |
| `squad_diverge_submit` / `squad_diverge_status` / `squad_diverge_close` | Submit your independent entry to an open round (resubmitting overwrites your own, never reveals anyone else's); check a round (while open: who has submitted, never what; once closed: every submission); explicitly close a round, revealing all submissions with the reveal announced in chat (idempotent). |
| `squad_review_open` | Ask **one specific** teammate to look at something: a durable directed request with `target`, `refs`, `priority` (`low`/`normal`/`high`/`urgent`), a body, and an optional expiry (`expires_ts` or `expires_in_minutes`). Starts `pending`, auto-announced in chat, and shows up in the target's `squad_join`/`squad_check` — so "this is what's gating me" doesn't have to compete with ordinary prose in the log. |
| `squad_review_claim` | Acknowledge a request directed at you: records you as claimant with a claim timestamp (the ack/lease the requester is waiting on). Target-only, `pending`-only, and refused once the request has expired. Auto-announced in chat. |
| `squad_review_resolve` | Close out a request you claimed, with an optional `resolution`. Claimant-only, and only from `claimed` — a `pending` request must be acked first, so the ack is never skipped. Auto-announced in chat. |
| `squad_review_cancel` | Withdraw (requester) or decline (target) a request from `pending` or `claimed`. Nobody else may cancel someone else's gate. Auto-announced in chat. |
| `squad_review_list` | List review requests, most urgent first — open and unexpired by default; narrow by `target`/`requested_by`/`status`, widen with `include_terminal`/`include_expired`. |
| `squad_clear` | Wipe the room. |

Goals are squad-scoped, not assigned: agents negotiate division of labor in chat, which is exactly the collaboration you want to see in the transcript.

## Install

Requires Node ≥ 22.16.0 (uses the built-in `node:sqlite` — no native builds).

```bash
git clone https://github.com/rjwalters/squad && cd squad
CI=true pnpm install --frozen-lockfile && pnpm build

./install.sh ~/projects/my-lean-proof
```

Per-repo installation copies the canonical skill and references to both
`.claude/skills/squad/` and `.agents/skills/squad/`, preserves Claude command
aliases, adds identical Squad blocks to `CLAUDE.md` and `AGENTS.md`, and configures
the repo's MCP room. Fresh installs omit persona pins: sessions choose unique
automatic identities. Existing pins, custom launchers, environment values, and
unrelated settings remain intact. `SQUAD_CLAUDE_PERSONA` and
`SQUAD_CODEX_PERSONA` explicitly supply pins for fresh configuration.

Global setup is separate: with confirmation (or `-y`), installation writes all
six compatibility prompts and an MCP registration under `$CODEX_HOME`, defaulting
to `~/.codex`, and optionally runs `npm link`. `--no-codex` skips all global
setup; `--no-link` skips only linking. Repo-scoped Codex skills always install.
Global wiring is shared by every consumer repository on the machine. Its Codex
launcher uses an absolute source path so it works from any project directory;
refresh global setup on each machine after moving the Squad checkout.

Project `.mcp.json` runs `node .claude/hooks/squad-mcp.mjs` with
`SQUAD_DIR: .squad`; when the Squad checkout and target repository are siblings
it records `SQUAD_RUNTIME: ../<squad-checkout>/dist/index.js`. The launcher is a
byte-identical installed artifact — everything machine-local stays in
`.mcp.json` — and resolves the runtime and a relative room path against the
primary clone, so linked git worktrees work too (see "Worktree sessions" above).
Start the MCP client in the target repository root or any of its worktrees.
Moving both checkouts together preserves this launcher without editing tracked
configuration. Other layouts record an absolute runtime path with an installer
warning. Checks resolve project paths from the target root and accept equivalent
absolute or relative spellings; existing custom launchers and room overrides
remain preserved, and an unmanaged launcher is never given a `SQUAD_RUNTIME`.

### Check, update, remove, and develop locally

```bash
./install.sh --check ~/projects/my-lean-proof  # read-only; nonzero = attention needed
./install.sh --dry-run --no-link ~/projects/my-lean-proof
./install.sh -y --no-link ~/projects/my-lean-proof  # refresh unchanged managed files
./uninstall.sh ~/projects/my-lean-proof             # repo artifacts only
./uninstall.sh -y --global ~/projects/my-lean-proof  # also remove machine-wide Codex wiring
```

`--check` compares actual artifact hashes, source version/commit, and selected
global Codex prompts/configuration. It reports stale, missing, modified, unmanaged,
or broken installations, including same-version source edits. It never builds,
installs dependencies, or changes files. `--no-codex --check` checks local artifacts
only. Custom MCP launchers require operator verification and are reported as
unmanaged rather than silently certified current.

Both runtime skill directories carry deterministic `install-metadata.json`
(version, commit, layout, and ownership hashes). The gitignored
`.claude/skills/squad/.install-local.json` also records the source checkout and
owned configuration fragments. Global prompts and MCP configuration have their
own machine-wide receipt, `$CODEX_HOME/.squad-install.json`. Installing a second
repo does not make the first repo's uninstall own those shared global files.
Tracked hashes allow adapter updates on another machine without claiming ownership
of that machine's existing MCP configuration.

Installation validates every destination and configuration before writing. It
refuses symlink destinations, malformed JSON/TOML, malformed markers, and conflicting
files. Updates replace only unchanged owned files; removal preserves user-added
files, user edits, custom configuration, and hook scripts still referenced by
surviving hooks. Per-file writes are atomic, and write failures restore previously
written file contents. This is not a filesystem lock: do not edit installation
files concurrently with an update. Room data, ignore entries, and machine-wide
CLI links remain after uninstall.

Conflicts produce a nonzero exit and identify the exact file or field. Back up
customized artifacts and move conflicting generated files aside before rerunning.
For a configuration field intentionally taken over by the user, back up the local
receipt and remove that field's entry from its `fragments` ownership record;
custom launchers must relinquish both `command` and `args`. The installer then
preserves it as external configuration. Do not delete receipts indiscriminately:
they are the evidence used for safe removal. Legacy installations lacking hashes
can adopt exact matching artifacts; unknown old prompts or modified blocks are
preserved for review. Existing unmanaged Codex config is never rewritten; update
its source path manually if moving the checkout.

Development uses the same checkout-backed installation: edit the canonical
`skills/squad/` sources, regenerate aliases with
`node scripts/generate-workflow-adapters.mjs`, build with `pnpm build`, then rerun
installation into a scratch consumer repo. The runtime remains at this source
checkout's `dist/index.js`; adapters are copies refreshed by the installer, with
no destination symlinks. Keep that checkout and its dependencies available.
Before installing from a clean checkout run
`CI=true pnpm install --frozen-lockfile && pnpm build`; missing dependencies or a
broken runtime fail clearly before any target configuration is written.

If CLI linking is declined or unavailable, use
`node /absolute/path/to/squad/dist/index.js <command>` instead of `squad`.

### Re-entry (opt-in)

The hook requires an explicit unique `SQUAD_CLAUDE_PERSONA`, matching its MCP
configuration; its separate process cannot discover an automatically generated
session identity. Existing managed hooks remain installed on ordinary refresh.

A Claude Code session's own conversation loop (`/squad:join`) is turn-based: it
goes idle and stops after ~10 empty checks, and nothing brings it back without
a human re-invoking it. `./install.sh --reentry` (off by default — the flag
must be passed explicitly) installs a Claude Code `Stop` hook
(`.claude/hooks/squad-reentry.sh`, wired into `.claude/settings.json`) that
re-arms the session itself, bounded so it can never hold a session open
forever on unread chatter alone:

- **Shared wake policy** (`src/reentry.ts`): checks target five minutes while
  holding claims, or an idle heartbeat uniformly jittered between 30 and 45
  minutes. Each window samples jitter once. Acquiring or releasing a claim
  reschedules the window for the new workload. Unread `@mentions` and unexpired
  pending/claimed directed review requests take priority as soon as observed;
  peeking does not consume the persona's messages or reviews.
- **Actual latency and runtime limits**: Codex's live supervisor polls at most
  every 45 seconds while waiting (plus room I/O), and has a 10-second inter-run
  floor. Claude observes only when its Stop hook is invoked. Each invocation
  sleeps at most 45 seconds and emits a blocking continuation, including while
  a policy window is still pending. Those intermediate model turns mean a
  30–45-minute idle policy is **not** 30–45 minutes of passive Claude sleep.
  Model execution time adds to detection latency. The `stop_hook_active` loop
  guard still allows a repeated stop in the same sequence. Neither adapter
  provides push delivery or wakes a stopped process without a running controller.
- **Failure backoff**: Codex retries failed runs with exponential delays
  (30 seconds base, ×2, 30-minute pre-jitter cap, ±20% jitter). Claims and
  directed work cannot shorten that delay. A successful wake resets the
  failure counter, not the lifetime count.
- **Hard bounds**: `SQUAD_REENTRY_TTL_MINUTES` defaults to `240` (four hours)
  since arming; `0` disables re-entry. `SQUAD_REENTRY_MAX_ATTEMPTS` defaults
  to `48` policy fires per arm cycle, including directed wakes; `0` disables
  the count cap. Claude's intermediate waiting blocks are not policy fires,
  so TTL also bounds those continuations. Stop/TTL checks happen when the
  adapter regains control; they do not interrupt an active model run.
- **Operator stop**: `SQUAD_REENTRY_STOP=1`, `<repo>/.squad/reentry-stop`
  (all personas), or `<repo>/.squad/reentry/<persona>.stop` (one persona)
  overrides work and waiting windows at the next adapter check.
- **Persisted arm cycle and permanent stop**: state is stored in
  `<repo>/.squad/reentry/<persona>.json`, including `totalFired` and the final
  `stoppedReason`. Both adapters attempt one permanent-stop room announcement
  per arm cycle, recording it before posting to prevent retry duplicates;
  room-write failure leaves the terminal stop reason as the fallback.
  Restarting alone does not reset a spent TTL or cap. To re-arm, stop the
  controller, remove the persona's JSON state and any stop marker, then restart.
  Legacy state migrates its existing `attempt` into `totalFired` without
  restarting TTL. Earlier directed resets cannot be reconstructed, so this
  migrated count is only a lower bound on pre-upgrade fires.

### Mid-turn inbox delivery (opt-in)

The `Stop` hook above covers an agent that is *finishing* a turn. The common
case it cannot reach is an agent **in the middle of a long task** in its own
repo — one that may never have run `/squad:join`, and will not call
`squad_check` for another hour. Squad is pull-only, so a directed message sent
from outside that session (`SQUAD_DIR=<repo>/.squad squad send "@<persona>
…"`) sits unread with nothing to put it in front of the agent.

`./install.sh --inbox` (off by default; same `SQUAD_CLAUDE_PERSONA`
requirement as `--reentry`, for the same reason) installs
`.claude/hooks/squad-inbox.sh` and wires it into `.claude/settings.json`'s
`PostToolUse` **and** `UserPromptSubmit` arrays. On each eligible invocation it
peeks the room *without consuming* and, when something is waiting, emits a
`hookSpecificOutput.additionalContext` notice — so the agent reads it mid-task
without anything being stopped, woken, or blocked:

```
📬 squad: 1 directed message — opus-5-3f2a: "disk triage: pause writes".
Nothing was consumed — run squad_check to read and act on it.
```

Both hooks are additive and opt-in; `--reentry` and `--inbox` can be installed
together or separately, and an ordinary refresh keeps whichever is already
installed.

- **What it surfaces, deliberately narrowly**: unread `@mentions` of this
  persona, unexpired pending/claimed directed review requests, and `@repo`
  broadcasts. Not ordinary chatter — this hook interrupts, so the bar is
  "someone needs *you*". Detection is literally the re-entry adapters' own
  (`observeDirectedItems()` in `src/reentry-room.ts`), so the two can never
  disagree about what counts as directed.
- **`@repo` is a reserved broadcast target**: it means "every agent working in
  this repo", including sessions that never joined, and it reads naturally
  because the room *is* the repo. Every inbox hook treats it as a mention of
  itself, so it needs no persona and works for automatically named
  `<label>-<hex>` sessions too. The literal name `repo` is reserved room-wide
  (`src/identity.ts`): automatic minting skips it, a `squad_join` rename is
  refused with a note, and a `SQUAD_PERSONA=repo` pin fails at open time rather
  than silently shadowing the broadcast. Refinements are unaffected —
  `repo-doctor` is an ordinary name.
- **Nothing is consumed**: the peek leaves the read cursor where it was, so
  `squad_check` still returns the full message. The hook keeps its own
  "already said this" high-water mark, separate from that cursor, in
  `<repo>/.squad/inbox/<persona>.json` — so one item is announced once rather
  than on every tool call.
- **Cost**: at most one peek per `SQUAD_INBOX_INTERVAL_SECONDS` (default `60`;
  `0` peeks on every invocation). Inside that window the bash wrapper
  short-circuits on the state file's mtime *before* spawning node — about 6 ms
  on a loaded 8-core Linux box, versus ~50 ms when node runs and ~1 peek/minute
  that opens SQLite at all. The wrapper's check is skip-only and conservative:
  `src/inbox.ts`'s `peekDue()` remains the authority.
- **It never blocks, fails, or creates**: no decision field is ever emitted, a
  malformed payload / missing build / unreadable or locked database / corrupt
  state file all fail *silent* with exit 0, and a cwd with no room gets no
  inbox and no side effects (the hook never creates a `.squad/`). A corrupt
  state file costs at most one repeated notice, never a dropped message.
  The peek does renew the persona's presence lease — a busy agent shows as
  `active` rather than drifting to `stale` while it works.
- **Operator stop**: `SQUAD_INBOX_STOP=1`, `<repo>/.squad/inbox-stop` (all
  personas), or `<repo>/.squad/inbox/<persona>.stop` (one persona), mirroring
  the re-entry stop markers.
- **Claude-only, like the `Stop` hook and for the same reason**: Codex's only
  hook event is `pre_tool_use` (verified against Codex 0.146.0), which fires
  *before* a tool runs and is a permission decision, not a context channel —
  there is no `post_tool_use` or prompt-submit event to carry a notice on. A
  Codex persona still receives directed work through
  `squad codex-reentry`'s between-run observation, which is the Codex-side
  answer to the same problem.
- **One pin, one inbox**: the rate limit and the notified mark are keyed per
  persona per room. Two concurrent Claude sessions sharing a single pinned
  name share that mark, so only one of them is told; give each session a
  refinement (`<pinned>-2`) — the convention `/squad:fanout` already uses — if
  both must be notified.

### Re-entry for Codex: `squad codex-reentry`

Codex has **no end-of-turn hook** to mirror the `Stop` hook above with — its
only hook event is `pre_tool_use`, and there is no `codex hooks` subcommand at
all (verified against Codex 0.146.0). A Codex persona running `/squad-join`
therefore ends its turn on a `task_complete` event and stays alive at ~0% CPU,
present but mute, until an operator re-invokes it. That silent park caused
three room outages in one day — one ~5 hours, one leaving 410 theorems
unverified for 4 hours (#60).

The fix assumes no hook primitive at all. It uses the one thing Codex does
guarantee: **a `codex exec` run is a process that exits when the turn
completes.** `squad codex-reentry` is a supervisor around that — start it in
the terminal where you would otherwise have run `codex` and typed
`/squad-join`:

```bash
squad codex-reentry                      # instead of: codex → /squad-join
squad codex-reentry --persona codex-2    # a second worker (see /squad:fanout)
squad codex-reentry -- --model o3        # everything after -- goes to `codex exec`
```

Each time the turn ends, the supervisor reads back *how* it ended from the
session log (`$CODEX_HOME/sessions/.../rollout-*.jsonl` — the ground truth the
presence table can't give you, since `stale` is indistinguishable from a
crash), then re-launches after a bounded wait. A clean `task_complete` is an
ordinary park; anything else is announced in the room as a failure, not a
park.

- **The same bounds as the Claude side, from the same code**: the wait between
  runs is `src/reentry.ts`'s `decide()`, so backoff+jitter, the
  `SQUAD_REENTRY_TTL_MINUTES` TTL, the `SQUAD_REENTRY_STOP` / `.squad/reentry-stop`
  / `.squad/reentry/<persona>.stop` operator-stop escape hatch, and the
  priority of observed mentions/reviews all behave identically. State lives in the
  same `.squad/reentry/<persona>.json` file.
- **Launch failure guard**: a 10-second floor between runs and failure backoff
  prevent a broken binary from spinning, even with persistent unread work.
  The shared lifetime cap counts directed re-entries as well as timer fires.
- **One supervisor per persona, in that persona's own foreground terminal — not
  a shared daemon.** The failure this fixes is a *cascade* (personas parking
  within ~90s of each other as the room goes quiet), so a single watcher whose
  own death silently disarmed every persona would reproduce the outage it
  prevents. There is no pid file and no cross-persona state; a supervisor dying
  returns exactly one terminal to a shell prompt, and only that persona loses
  re-entry.
- **It parks loudly.** On start it tells the room it will self-re-enter; when a
  bound fires (TTL, attempt cap, operator-stop) it posts that the persona will
  *not* return without an operator. `skills/squad/references/join.md` step 5 reads
  `SQUAD_REENTRY_SUPERVISOR` (exported into every supervised run) so the
  persona's own idle message says the matching thing.

`squad codex-reentry --help` lists the flags: `--persona`, `--codex <bin>`,
`--prompt`, `--ttl-minutes`, `--max-attempts`,
`--no-resume`. It uses `codex exec resume --last` when the local binary
advertises that subcommand (probed, not assumed) and a fresh `codex exec`
session otherwise.

## Use

```
cd ~/projects/my-lean-proof
terminal 1:  claude  →  /squad:goals prove lemma exp_bound; prove lemma sum_split; main theorem
             then    →  /squad:join
terminal 2:  codex   →  $squad Join the room and work on the shared goals
             or      →  squad codex-reentry   # same thing, but it re-enters itself
terminal 3:  squad tail                    # watch the room live
             squad who                     # find the actual joined names
             squad send "@<joined-name> take exp_bound"
```

All six workflows use the same references in both harnesses. Claude retains
`/squad:<workflow>`; Codex can use `$squad` with a natural-language request or the
legacy `/squad-<workflow>` prompts when installed:

- **join** — enter the room, introduce yourself, work the check/respond loop until stopped (agents go idle on their own after ~10 empty checks)
- **goals** — show the shared board, or add goals from arguments
- **card** — create, inspect, transition, or attach evidence to a Science Card
- **steward** — inspect durable bank/review/map state and send bounded reminders as the configured steward
- **fanout** — coordinate separately identified workers on distinct assignments
- **clear** — wipe the room for a fresh session when the user explicitly requests a reset

Human CLI: `squad send | read | tail | goals [add|done|reopen] | claims | claim <path> | release <path> | diverge [open|submit|status|close] | card [create|list|show|transition|evidence|edit] | review [open|list|show|claim|resolve|cancel] | who | leave | clear | export <path> | import <path> | relay [--once|--follow|status] | path | doctor` (persona defaults to `human`; if the install step's `npm link` was skipped or failed, replace `squad` with `node <path-to-squad>/dist/index.js`). Each repo's room is just `<repo>/.squad` — deleting that directory is a full reset. `squad export`/`squad import` move a room's full history between repos (see "Moving a room between repos" above). `squad card` manages Science Cards, the structured tracker for a claim moving through `QUESTION` → … → `SUPPORTED`/`FALSIFIED`/`INCONCLUSIVE`/`ABANDONED`; `squad card edit <id> --field value ...` changes fields set at creation (title, confidence, novelty, prior-art status, etc.) without touching phase — see `squad help` for the full subcommand list.

`squad doctor` is a preflight/diagnostic: it checks that the runtime dependencies resolve (`@modelcontextprotocol/sdk`, `zod` — the packages `mcp.js` needs but no other module does), that the database is reachable, and reports how the persona will resolve. Run it whenever a harness comes up with no `squad_*` tools and you can't tell whether the room just isn't configured or the server is actually broken. It works even when the dependencies it's checking are missing — see below.

### Relaying room chat to an observability host (opt-in)

A room normally never leaves the machine it lives on. Squad can also **relay room messages to any OTLP/HTTP logs endpoint** — SigNoz, or any other OpenTelemetry collector — so a room's conversation can be watched from a dashboard elsewhere. Relaying is **off by default**, and it is one-way: nothing on the dashboard side can write back into the room.

> **Enabling relay sends message bodies off this machine.** Every relayed message is shipped verbatim (plus sender, kind, room, repo path and host name) to the endpoint you configure. Only enable it for rooms whose chat you are comfortable storing on that host, and use `SQUAD_RELAY_KINDS` to narrow what leaves.

| Variable | Meaning |
|---|---|
| `SQUAD_RELAY_ENDPOINT` | OTLP/HTTP logs endpoint, e.g. `https://ingest.us.signoz.cloud:443/v1/logs` or `http://localhost:4318/v1/logs`. Unset means relay is off. |
| `SQUAD_RELAY_HEADERS` | Auth headers, `name=value,name=value` (the `OTEL_EXPORTER_OTLP_HEADERS` convention), e.g. `signoz-ingestion-key=<key>`. Read from the environment on each pass and never written to `squad.db`, an export, or `.mcp.json` by the installer. |
| `SQUAD_RELAY_ROOM_NAME` | The `squad.room` attribute on every record. Defaults to the name of the directory holding the room (the repo directory for `<repo>/.squad`), so all worktrees of a repo share one name. |
| `SQUAD_RELAY_KINDS` | Comma-separated message kinds to relay, e.g. `chat` to skip system notices. Default: every kind. |

Ways to run it:

- `squad relay` (or `squad relay --once`) — ship everything past the relay cursor and exit. On a newly-enabled room the cursor starts at message 0, so the first run **backfills the full history**. Exits non-zero if the endpoint rejected or could not be reached.
- `squad relay --follow [--interval <seconds>]` — keep shipping new messages (every 5 s by default) until Ctrl-C / `SIGTERM`. Stopping mid-backfill is safe: the cursor only advances past batches the collector accepted, so the next run resumes where this one stopped.
- **Automatically, from a live MCP server**: when `SQUAD_RELAY_ENDPOINT` is in the MCP server's environment, every message it inserts schedules a background relay pass. That pass is fire-and-forget — a slow, down or misconfigured collector never delays or fails the agent's tool call, and it simply catches up on a later pass. (Put the variables in the environment the harness starts the server with; keep the ingestion key out of any committed `.mcp.json`.)
- `squad relay status` — the configured target, the cursor, how many messages are still unshipped (lag), and the last error (or `none`). With no configuration it says `not configured` (and lists any endpoint this room has relayed to before).

Delivery is at-least-once: a record can be re-sent if an acknowledgement is lost, so each carries a stable `squad.message_id` to de-duplicate on. Each OTLP log record's body is the message text; its attributes are `squad.room`, `squad.repo_path`, `squad.host`, `squad.message_id`, `squad.sender`, `squad.kind` and `squad.occurrences` (resource attributes `service.name=squad`, `host.name`). The relay cursor is per endpoint and per machine — `squad clear`, `export` and `import` leave it alone.

**SigNoz: "room chat by repo".** In the Logs Explorer, filter with the query builder on `service.name = squad` and `squad.room = my-repo`, add `squad.sender` and `squad.kind` as columns, and save it as a view (e.g. *squad / my-repo*); group by `squad.room` instead to see every relayed room side by side. For a dashboard panel, a ClickHouse query along these lines (SigNoz's v2 logs schema; column names can differ across SigNoz versions) renders the chat de-duplicated by message id:

```sql
SELECT
  fromUnixTimestamp64Nano(timestamp)          AS time,
  attributes_string['squad.room']             AS room,
  attributes_string['squad.sender']           AS sender,
  attributes_string['squad.kind']             AS kind,
  body
FROM signoz_logs.distributed_logs_v2
WHERE resources_string['service.name'] = 'squad'
  AND attributes_string['squad.room'] = 'my-repo'
  AND timestamp BETWEEN {{.start_timestamp_nano}} AND {{.end_timestamp_nano}}
ORDER BY time DESC
LIMIT 1 BY attributes_number['squad.message_id']
LIMIT 500
```

## Science Cards: an end-to-end example

Science Cards are squad's structured tracker for a claim under investigation: `QUESTION` → `DIVERGE` → `ORIENT` → `HYPOTHESIZE` → `DERIVE` → `ATTACK` → `SIMULATE` → `EXPERIMENT` → `REPLICATE` → `SUPPORTED` / `FALSIFIED` / `INCONCLUSIVE`, with a `LEARN` → `PIVOT` reflection loop reachable from most active phases and an `ABANDONED` escape hatch. Each `squad card` / `squad_card_*` call below is exactly what the corresponding agent's MCP tool call does (`squad_card_create`, `squad_card_transition`, `squad_card_evidence_add`, `squad_diverge_*`) — shown as `SQUAD_PERSONA`-prefixed CLI commands so the whole walkthrough is copy-pasteable in one terminal instead of split across two live agent sessions. Claude and Codex are peers here: identical tools, no special casing.

The example below is a real reproducer, not aspirational — every command is exercised end-to-end (divergence round, phase transitions, evidence attachment, an evidence-gated transition, a `LEARN` → `PIVOT` loop, and a negative terminal state) by `tests/science-card-lifecycle.test.mjs`, so it stays true to the actual behavior rather than drifting from it.

```
# claude opens the investigation
$ SQUAD_PERSONA=claude squad card create --title "Cache invalidation off-by-one" \
    "Does the LRU evict one entry too many under concurrent access?"
opened card #1 [QUESTION]: Cache invalidation off-by-one

# claude moves to DIVERGE and opens a round scoped to the card — each
# persona proposes a root cause independently; nobody sees the other's
# entry until the round closes
$ SQUAD_PERSONA=claude squad card transition 1 DIVERGE
card #1 -> DIVERGE
$ SQUAD_PERSONA=claude squad diverge open --card 1 --expect claude,codex \
    "root cause of the extra eviction?"
opened divergence round #1: root cause of the extra eviction?

$ SQUAD_PERSONA=claude squad diverge submit 1 \
    "Suspect the eviction counter increments before the write lock releases"
submitted to round #1 (claude)
$ SQUAD_PERSONA=codex squad diverge submit 1 \
    "Suspect a stale read of size() during resize"
submitted to round #1 (codex)   # round auto-closes: both expected participants have submitted

$ SQUAD_PERSONA=claude squad diverge status 1
round #1: root cause of the extra eviction? [closed]
submitted: claude, codex
  <claude> Suspect the eviction counter increments before the write lock releases
  <codex> Suspect a stale read of size() during resize

# they settle on codex's resize theory and drive it through the chain,
# attaching evidence as they go
$ SQUAD_PERSONA=claude squad card transition 1 ORIENT
$ SQUAD_PERSONA=codex squad card transition 1 HYPOTHESIZE \
    "stale size() read during resize causes double eviction"
$ SQUAD_PERSONA=codex squad card evidence 1 derivation docs/lru-notes.md#resize \
    "worked through the resize path by hand; confirms size() can read stale mid-resize"
$ SQUAD_PERSONA=codex squad card transition 1 DERIVE

$ SQUAD_PERSONA=claude squad card transition 1 ATTACK
$ SQUAD_PERSONA=claude squad card evidence 1 literature docs/lru-notes.md#locking \
    "prior incident report rules out the lock-release theory"
$ SQUAD_PERSONA=claude squad card transition 1 SIMULATE
$ SQUAD_PERSONA=claude squad card evidence 1 simulation sim-run-9 \
    "resize race reproduces the extra eviction in a harness"
$ SQUAD_PERSONA=claude squad card transition 1 EXPERIMENT
$ SQUAD_PERSONA=claude squad card transition 1 REPLICATE

# evidence-gated transition: an empirical claim can't reach SUPPORTED on
# derivation/literature/simulation evidence alone — this is rejected
$ SQUAD_PERSONA=claude squad card transition 1 SUPPORTED
squad: card 1 declares an empirical claim and needs at least one experiment or observation
evidence item before it can be marked SUPPORTED (derivation/formal-check/simulation/literature
evidence alone is not sufficient)     # one real line, wrapped here for width; exit code 1

# codex runs the real replication — and it comes back negative for the
# resize-only theory
$ SQUAD_PERSONA=codex squad card evidence 1 experiment ci-run-4901 \
    "replication on a second machine: off-by-one does NOT reproduce with only the resize race enabled"

# LEARN -> PIVOT: rather than force a SUPPORTED the evidence doesn't back,
# the team reflects and revises the hypothesis
$ SQUAD_PERSONA=claude squad card transition 1 LEARN \
    "replication is inconsistent across hosts"
$ SQUAD_PERSONA=claude squad card transition 1 PIVOT \
    "revising: resize race only manifests when a GC pause stretches the write-lock window"
$ SQUAD_PERSONA=claude squad card transition 1 HYPOTHESIZE \
    "combined hypothesis: resize race + GC pause"

# ... back through DERIVE / ATTACK / SIMULATE / EXPERIMENT / REPLICATE with
# fresh evidence for the combined hypothesis (omitted here for brevity; see
# tests/science-card-lifecycle.test.mjs for the full second pass) ...

$ SQUAD_PERSONA=codex squad card evidence 1 experiment ci-run-5002 \
    "reproduced the controlled GC-pause condition on real hardware: no excess eviction across 200 trials"
$ SQUAD_PERSONA=claude squad card transition 1 REPLICATE
$ SQUAD_PERSONA=claude squad card transition 1 FALSIFIED \
    "combined hypothesis does not hold — the GC-pause condition never reproduces excess eviction"
card #1 -> FALSIFIED

# the negative outcome stays queryable — it is not silently hidden
$ squad card list --all
[FALSIFIED] #1 Cache invalidation off-by-one (empirical)
```

Two things worth calling out: the `SUPPORTED` gate only checks that a qualifying evidence *type* (`experiment`/`observation` for an empirical claim) exists — it can't judge whether the evidence's content actually supports the hypothesis, which is why the team's own judgment (not the system) is what turns this into a `LEARN` → `PIVOT` instead of a premature `SUPPORTED`. And `squad card list` hides terminal-phase cards by default (`--all` / `squad_card_list`'s `include_done: true` shows them) — but the underlying `cardList()` / `squad_card_get` never delete or lock away a `FALSIFIED`/`INCONCLUSIVE`/`ABANDONED` card; negative results are exactly as durable and queryable as positive ones.

## Design notes

- **One room per repo, on purpose.** The room's scope matches the work's scope, several projects can run squads independently, and `rm -rf .squad` resets exactly one of them. No named rooms, no TTLs, no allowlists, no crypto — if multi-host or encrypted coordination is ever needed, that's [safehouse](https://github.com/rjwalters/safehouse)'s job, and squad's conventions (persona-stamped sender, pull-only cursors, peek-vs-consume) are deliberately compatible with it.
- **`read` vs `check`** (inherited from safehouse): `read`/`tail` are stateless history replay and never touch a cursor; `check` is a specific session's durable unread cursor and consumes by default. Scripts and curious humans should read, not check — don't eat a real agent's mail.
- **SQLite over a flat file** because the room needs concurrent writers from independent processes and durable per-session cursors; WAL mode makes that safe without a server.
- **Read cursors are per-session, not per-persona (#41).** One persona can hold multiple live sessions at once — an MCP connection and a one-shot CLI invocation, or two concurrent MCP clients — and each session (identified by the `session_id` `squad_join`/`squad_check` return) tracks its own unread cursor. Two sessions of the same persona never consume or fast-forward each other's unread state: session A's `squad_check` result is unaffected by session B calling `squad_join`/`squad_check` in between. A brand-new session's first cursor read is seeded once from the persona's most-advanced other session (live or recently-ended), falling back to the persona's durable high-water mark — see the next bullet — and only to the room's start (everything unread) if this is the persona's very first session ever. So the common case of one persona with one session at a time keeps today's steady-state UX, while a second concurrent session gets its own independent unread stream from that point forward. Messages sent by your own persona are still never returned as unread, regardless of which of your sessions sent them.
- **Session cursors are swept, the persona's high-water mark is not (#41).** `session_cursors` rows are per-connection state and are pruned with their session row after `SESSION_RETENTION_HOURS` (24h), so a machine that has opened thousands of sessions doesn't keep a row for each forever. Cursor *durability* doesn't ride on that retention, though: every cursor advance also bumps a monotonic per-persona high-water mark in the long-lived `cursors` table, which is never pruned. A persona that goes quiet for days and comes back — every one of its sessions long swept — seeds its new session from that mark and sees only what actually arrived while it was away, rather than replaying the entire room history as unread.
- **Review-request expiry is lazy, like presence staleness.** A request past its `expires_ts` stops counting toward the target's `pending_reviews` the moment anyone reads them — nothing is mutated, no status transition is recorded, and no scheduler exists (or is needed) to drive one. The stored state stays exactly what a persona put there: expiry is a *derived* view of a timestamp, so it can never drift from it. It also means an expired request can still be resolved or cancelled to close the record out honestly; only *claiming* one is refused, since a late ack would re-gate a requester who has already been released. Requester-or-target for cancel, target-only for claim, claimant-only for resolve: the two personas with a stake can always end the ask, and nobody else can end it for them.
- **`dist/` is a gitignored build artifact, not bundled, and `node_modules` is required at runtime.** For the running server, only `mcp.ts` (two dependencies: `@modelcontextprotocol/sdk`, `zod`) needs `node_modules` (the installer separately uses `smol-toml` for configuration validation) — `db.ts`/`core.ts`/`cli.ts` use nothing but Node built-ins (`node:sqlite` needs no native build). `index.ts` exploits that split by importing `mcp.js` lazily, only when actually starting the MCP server, so a missing/broken `node_modules` (e.g. wiped by a host reboot, as happened once — every agent reaches the room through this one `node dist/index.js` entry point, so that single missing directory silently took squad down for all of them at once) degrades the CLI instead of crashing it outright: `squad doctor`, `squad --help`, and every other CLI command still run and report the problem plainly, and a failed MCP startup leaves a system message in the room itself so any teammate already there sees *why* this persona never showed up with tools. Bundling `mcp.js`'s two dependencies into a single self-contained `dist/index.js` (esbuild/rollup) would remove the `node_modules` runtime dependency entirely and was considered, but wasn't worth the added build-tooling surface given the mitigations above (plus `install.sh` verifying the dependencies actually resolve before writing any config, not just that `dist/` exists) close the same gap more simply. Revisit if this class of failure recurs.

## Development

```bash
pnpm test    # builds + runs the node:test suite
node scripts/generate-workflow-adapters.mjs --check  # fail on stale generated aliases
```

CI runs both commands on Node 22 and 24. The installed collaboration test loads
the real Claude JSON and Codex TOML registrations in an isolated repository,
exercises both MCP connections and CLI handoffs, and checks the capability matrix
against the registered tool list. Installer tests verify matching skill references
and ownership preservation. See [verification limits](docs/capabilities.md#verification-and-its-limits)
for what these deterministic checks establish.

### VERSION bumps for consumer-visible changes

`install.sh` copies `commands/squad/*.md`, `skills/squad/SKILL.md`, its workflow
references, `hooks/squad-mcp.mjs` (the project MCP launcher), and (with
`--reentry`) `hooks/squad-reentry.sh` into every consumer repo, and
`codex/prompts/squad-*.md` globally into `$CODEX_HOME/prompts/` (default
`~/.codex/prompts/`); every installed
`.mcp.json` also runs the compiled MCP server straight out of this repo's
`src/` (via `dist/`), so a server-behavior change reaches consumers as soon as
this repo updates. `install-metadata.json` records `VERSION` at install time,
and `/repo:update-tools` compares it against this repo's current `VERSION` to
detect drift — so a `VERSION` that never moves makes every consumer look
falsely "current."

**If your PR touches the installed surface** (`commands/squad/`,
`skills/squad/`, `codex/prompts/`, `hooks/`,
`install.sh`, `uninstall.sh`, `scripts/install-lifecycle.mjs`,
`scripts/generate-workflow-adapters.mjs`, or `src/`) — bump `VERSION` (keep
`package.json`'s `"version"` and the `McpServer` version string in
`src/mcp.ts` in sync; `pnpm test` enforces this) via `/loom:bump`, or, if the
change genuinely does not alter installed behavior (a comment, a typo fix, a
test-only edit), add this exact marker to the PR body or a commit message
instead:

```
<!-- loom:no-surface-change -->
```

CI (`.github/workflows/version-check.yml`) runs
`scripts/check-surface-version-bump.sh` on every PR and fails when the
watched surface changed without either a `VERSION` bump or the marker.

## License

MIT

Research rooms can opt into a [shared integration target](docs/integration.md).
Its repository, remote, branch, build command and steward are revisioned in the
room. Submit committed work, then run `squad bank <attempt-id>` (MCP `squad_bank`)
to integrate in isolation, build the exact candidate and publish without force.
Authors may use independent clones: make submitted commit objects available in
the configured repository; its selected paths must be clean against its own HEAD.
Banking reads exact submitted blobs even when that checkout is at another revision.
Only a verified receipt means banked; configuration and chat claims do not.

### Durable research nodes

Science Cards now share their IDs with [research nodes](docs/nodes.md): discover
them in `squad_join` or `squad node list`, connect dependencies and declared
committed artifacts, and inspect revision-bound bank provenance. Old cards and
evidence remain usable; exploratory work stays visible alongside banked results.


### Authoritative generated outline

Use `squad_outline_render` / `squad outline render` for a deterministic JSON snapshot
with Markdown `content` and a SHA-256 `version`. `squad_outline_status` / `squad
outline status [path]` compares current research state with the latest verified
publication. These are pure room reads; freshness does not observe remote Git.
The snapshot includes exploratory, falsified and abandoned outcomes, current and
historical node revisions, exact verified bank commit/tree citations and separate
independent review receipts. Declared source artifacts and pending attempts are
visibly unbanked. Presence, chat, reader identity and outline publication bookkeeping
do not change the snapshot version.

Use `squad_outline_publish` with `request_key` and optional `path`, or `squad outline
publish <request-key> [path] [--build-timeout-ms N]`. The default path is
`SQUAD_OUTLINE.md`. An existing integration branch is required. Generation occurs
in an isolated repository, then the ordinary bank pipeline integrates, builds the
entire candidate and publishes it without force. The research checkout is untouched.
An existing file must exactly match a prior verified generated publication for
this target/path; separately edited prose is rejected, even with a generated header.
Use a different explicit path to retain such prose. Concurrent target edits are
checked again during reconciliation.

Reuse a request key to retry its archived snapshot and exact generated source
commit after failure or interruption; use a new key for updated research state.
A node edit during the build leaves an honest historical publication with
`fresh: false`. Query its `attempt` for build/publication evidence and diagnostics.
Publication records survive room export/import and are removed by room reset;
reset does not delete remote files or preserve their ownership records.

### Shared steward

`/squad:steward` and the canonical `$squad` steward workflow use the same room
records in Claude and Codex. `squad steward status` (MCP `squad_steward_status`)
answers what is banked, what is independently reviewed, and whether the default
outline matches the latest verified publication. It includes failed/pending
attempts, exact build evidence, declared unbanked artifacts, advisory claim
hygiene, and reminder history. Any peer may read it while the steward is offline.
Unobserved local work and remote visibility remain explicitly unknown.

`squad steward tick` (`squad_steward_tick`) requires the configured integration
steward identity. It atomically commits at most five chat reminders and their
ledger entries per pass; each condition/object/revision key can send at most
three times, separated by at least 24 hours. Repeated or restarted invocations
reuse that ledger. A new material/configuration revision can create new keys.
No process scheduler, bank, review approval or claim cleanup runs automatically.
Follow [the shared steward workflow](skills/squad/references/steward.md) to resume
existing bank attempts, review request keys and outline publications explicitly.
Schema 9 exports/imports/resets include the reminder ledger.

### Room drift report

`squad doctor --room` (MCP `squad_room_doctor`) is a read-only, evidence-first
drift report over the same durable state `squad steward status` reads, plus a
bounded scan of chat for informal "banked" claims cross-checked against the
verified integration ledger. Every finding cites its evidence, an age, and a
concrete next command -- never a bare conclusion. Declared artifact commits
are classified `verified_clean` (backed by a verified integration record),
`observed_unbanked` (the commit exists in the configured integration
repository but the node is not yet banked), `unreachable` (the commit is not
present in that repository's object database; remote branches remain unobserved), or `unobserved` (no integration target is
configured, or the reachability check itself could not be performed, e.g. an
inaccessible repository path) -- an unreachable or unobserved branch is never
reported as if it were verified clean. Two runs against one unchanged observed
revision/state and observation time agree, provided local repository visibility also agrees. Chat findings are heuristic warnings requiring verification, never proof that a participant falsely claimed banking. The default scan covers the latest 2,000 chat messages. Any identity may run it; it never writes to the
room, sends chat, or renews presence.
