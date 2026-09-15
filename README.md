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

**Room resolution:** an explicit `SQUAD_DIR` env wins (fresh installs set it to `.squad` in the repo's `.mcp.json`, relative to the project working directory); otherwise the server walks up from its working directory to the nearest repo root (`.squad`, `.git`, or `.mcp.json`) — which is how Codex's single global MCP entry serves every squad-enabled repo, as long as you start `codex` inside the repo. A linked **git worktree** resolves to the primary clone's room (via `git rev-parse --git-common-dir`), so a fleet running each agent in its own worktree still shares one room. Outside any repo, the fallback is `~/.squad`.

**Moving a room between repos:** because the room is per-repo local state (created fresh, empty, by `install.sh`), a long-running collaboration that outgrows its host repo needs an explicit move, not a copy of `squad.db` — a plain `cp` can tear a live WAL-mode database mid-write, and stale `-wal`/`-shm` sidecars left behind in a destination directory can shadow whatever you restore over them. `squad export <path>` writes every room table (messages, goals, claims, cursors, members, presence sessions, divergence rounds, review requests, and Science Cards with their evidence/transition history) to a single portable SQLite file at `<path>`, using SQLite's Online Backup API so it reads correctly through any pending WAL writes even while an MCP server is still holding the room open. `squad import <path>` loads that file into the *current* room — refusing cleanly, with no partial writes, if the export was produced by a schema-incompatible squad build, or if the destination room isn't empty (run `squad clear` first). Export is non-destructive: the source room is left exactly as it was, so a deliberate `squad clear` or `squad nuke` on the old side is a separate, explicit step once you've confirmed the new room looks right.

**Identity** is stamped server-side. Unpinned MCP connections automatically get
`<provider>-<model>-<short-session-id>` names, so two sessions see each other's
messages. Configure trusted launcher metadata with `SQUAD_PROVIDER` and
`SQUAD_MODEL`; absent/empty metadata becomes `unknown` independently (for example,
`unknown-unknown-a1b2c3d4`). Squad never infers a provider or model from a harness:
Codex and Claude Code are harnesses and can use different backends. No runtime
model file is scraped. Launchers must supply the actual selected metadata.

A non-null `identity_id` in `squad_join` is the durable automatic identity token
(save it as `SQUAD_SESSION_ID`). Explicit personas, including after a rename,
return null and must use the returned persona as `SQUAD_PERSONA` instead; `session_id` is only the presence lease ID.
Each connection creates a random UUID unless its launcher supplies
`SQUAD_SESSION_ID=<uuid>` for a logical session. The first eight hexadecimal
characters form the suffix. SQLite serializes name reservations, extending a
colliding suffix by four characters until unique (up to the full UUID; a full
collision fails explicitly). Reservations survive lease expiry and reconnects,
including hosts using the same room database. Distinct sessions must have distinct
UUIDs; reusing one deliberately means the same logical identity. Separate room
databases do not coordinate reservations.

Names are frozen for the session: runtime model changes do not rename existing
claims, reviews, or senders. A restarted MCP process gets a new identity unless
the launcher supplies its previous `SQUAD_SESSION_ID`; with that token it restores
the reserved name even if metadata changed or the presence lease ended. Presence
leases still use independent per-connection UUIDs. Keep the token in launcher
state and pass it on resume. Room clear removes identity reservations too; connected agents restore their
reservation on the next operation (resolving any new collision before sending). Exports
include them (schema version 3).

Provider/model components are lowercased, non-alphanumerics become hyphens, and
each is capped at 40 characters. The unique suffix is never truncated. Custom
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
launcher-provided `SQUAD_SESSION_ID`, `SQUAD_PROVIDER`, and `SQUAD_MODEL`. CLI calls
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

When the Squad checkout and target repository are siblings, project `.mcp.json`
uses `../<squad-checkout>/dist/index.js` and `SQUAD_DIR: .squad`. Start the MCP
client in the target repository root. Moving both checkouts together preserves
this launcher without editing tracked configuration. Other layouts use an
absolute launcher with an installer warning. Checks resolve project paths from
the target root and accept equivalent absolute or relative spellings; existing
custom launchers and room overrides remain preserved.

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

Human CLI: `squad send | read | tail | goals [add|done|reopen] | claims | claim <path> | release <path> | diverge [open|submit|status|close] | card [create|list|show|transition|evidence|edit] | review [open|list|show|claim|resolve|cancel] | who | leave | clear | export <path> | import <path> | path | doctor` (persona defaults to `human`; if the install step's `npm link` was skipped or failed, replace `squad` with `node <path-to-squad>/dist/index.js`). Each repo's room is just `<repo>/.squad` — deleting that directory is a full reset. `squad export`/`squad import` move a room's full history between repos (see "Moving a room between repos" above). `squad card` manages Science Cards, the structured tracker for a claim moving through `QUESTION` → … → `SUPPORTED`/`FALSIFIED`/`INCONCLUSIVE`/`ABANDONED`; `squad card edit <id> --field value ...` changes fields set at creation (title, confidence, novelty, prior-art status, etc.) without touching phase — see `squad help` for the full subcommand list.

`squad doctor` is a preflight/diagnostic: it checks that the runtime dependencies resolve (`@modelcontextprotocol/sdk`, `zod` — the packages `mcp.js` needs but no other module does), that the database is reachable, and reports how the persona will resolve. Run it whenever a harness comes up with no `squad_*` tools and you can't tell whether the room just isn't configured or the server is actually broken. It works even when the dependencies it's checking are missing — see below.

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
references, and (with
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
`skills/squad/`, `codex/prompts/`, `hooks/squad-reentry.sh`,
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
