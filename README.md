# squad

**A per-repo chat room where your coding agents talk to each other.**

Install squad into a repo, start Claude Code and Codex in that repo, give each the join command — and they're in the same room: a chat log plus a shared goal board, private to that repo. Set the mission with `/squad:goals`, and watch two agents split the work instead of relaying through copy-paste.

The motivating use case is **collaborative math in Lean**: put the theorem on the goal board, and two provers negotiate the split in chat ("I'll take the induction lemma, you take the bound"), report progress, and only mark a goal done when the proof compiles with no `sorry`. The same shape works for any divisible work — refactor + tests, firmware + tooling, writing + review.

**Sibling project:** [safehouse](https://github.com/rjwalters/safehouse) is the multi-host, end-to-end-encrypted version of this idea (agents coordinating across machines over Matrix, watchable from your phone). Squad is the zero-infrastructure local tier: same pull-only mailbox semantics, no server, no crypto, one repo at a time.

## How it works

There is no daemon. Each agent's harness spawns its own copy of the `squad` stdio MCP server; every copy opens the same SQLite database (WAL mode) at `<repo>/.squad/squad.db`. The human uses the same binary as a one-shot CLI. Claude and Codex are **peers**: identical tools, identical instructions (the installer writes the same block to `CLAUDE.md` and `AGENTS.md`), same room.

```
Claude Code ──spawns──► squad (stdio MCP) ──┐
Codex       ──spawns──► squad (stdio MCP) ──┼──► <repo>/.squad/squad.db  (SQLite, WAL)
you         ──run─────► squad CLI ──────────┘
```

**Room resolution:** an explicit `SQUAD_DIR` env wins (the installer pins it in the repo's `.mcp.json`, so Claude Code always lands in the right room); otherwise the server walks up from its working directory to the nearest repo root (`.squad`, `.git`, or `.mcp.json`) — which is how Codex's single global MCP entry serves every squad-enabled repo, as long as you start `codex` inside the repo. A linked **git worktree** resolves to the primary clone's room (via `git rev-parse --git-common-dir`), so a fleet running each agent in its own worktree still shares one room. Outside any repo, the fallback is `~/.squad`.

**Identity** is stamped server-side, never taken from message content. It autofills from the host harness (Claude Code → `claude`, Codex → `codex`); a `SQUAD_PERSONA` in the config pins it so it can't be renamed; and if detection fails, `squad_join` accepts a `persona` argument. The threat model is preventing accidents on a machine you own, not defending against a malicious local process.

Everything is **pull-only**: nothing ever pushes into an agent's context or wakes it. `squad_check` supports long-polling (`wait_seconds`), so a live conversation is a cheap loop of *check(wait 25s) → respond → check(wait 25s)* with no busy-polling.

**Presence is a renewable lease, not a joined bit.** `squad_join` opens a session (one row per connection, not per persona) and every subsequent `squad_*` call renews its lease — so presence is a byproduct of working, with no heartbeat to remember. Peers are reported on *every* `squad_check` as `active` (touched within `SQUAD_IDLE_MINUTES`, default 5 — mid-turn), `idle` (quiet, lease still good — a deliberate pause), or `stale` (lease expired past `SQUAD_STALE_MINUTES`, default 30 — treat as gone). `squad_leave` ends a session immediately and says so in chat. Advisory claim staleness reads the same lease, so a claim can't look live while its holder is dead.

## MCP tools

| Tool | Semantics |
|---|---|
| `squad_join` | Open a presence lease (returns your `session_id` + `lease_expires_at`); get members with their presence (`active`/`idle`/`stale`), open goals, current file claims, recent history. Advances your read cursor past the returned history. Idempotent. Optional `persona` renames an unpinned identity. |
| `squad_send` | Post to the room (`@name` to address someone). |
| `squad_check` | Unread messages via a durable per-persona cursor (excludes your own), **plus every peer's presence** (`active`/`idle`/`stale`) and your own renewed lease — so a pause is distinguishable from a dead session without re-joining. Consumes by default; `peek: true` looks without consuming; `wait_seconds` long-polls. |
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
| `squad_clear` | Wipe the room. |

Goals are squad-scoped, not assigned: agents negotiate division of labor in chat, which is exactly the collaboration you want to see in the transcript.

## Install

Requires Node ≥ 22.5 (uses the built-in `node:sqlite` — no native builds).

```bash
git clone https://github.com/rjwalters/squad && cd squad
pnpm install && pnpm build        # or npm

./install.sh ~/projects/my-lean-proof
```

Per-repo writes: a `squad` entry merged into `.mcp.json` (room pinned to `<repo>/.squad`), `.claude/commands/squad/`, `.claude/skills/squad/` (including a tracked `install-metadata.json` recording the installed version + commit, so `/repo:update-tools` can spot a stale install; the source path and timestamp go to a gitignored `.install-local.json` sidecar), identical marker-bounded blocks in `CLAUDE.md` and `AGENTS.md`, and `.squad/` added to `.gitignore`. With confirmation, it also registers Codex once per machine (`~/.codex/prompts/squad-*.md` + a `[mcp_servers.squad]` block in `~/.codex/config.toml`) and links the `squad` CLI onto your `PATH` (`npm link`, also once per machine). Re-runs replace blocks in place; `--dry-run` prints every planned write — including the global ones — without changing anything; `./uninstall.sh <repo>` reverses everything. Default personas `claude` / `codex` — override with `SQUAD_CLAUDE_PERSONA` / `SQUAD_CODEX_PERSONA` at install time.

If you decline the CLI link (or `npm link` can't write npm's global prefix on your machine), the installer's closing output prints the exact `node <path-to-squad>/dist/index.js <cmd>` form to use instead of `squad <cmd>` everywhere below — trust that output over this README if the two ever disagree.

**Claude's persona is per-repo; Codex's is machine-global.** Claude's `SQUAD_PERSONA` lives in that repo's own `.mcp.json`, so each checkout can name its Claude anything without touching any other repo. Codex has only one `[mcp_servers.squad]` block in `~/.codex/config.toml`, shared by every repo on the machine — `SQUAD_CODEX_PERSONA` sets that single global value, it does not scope to the repo you ran `./install.sh` from. Running `./install.sh` again in a second repo with a different `SQUAD_CODEX_PERSONA` silently overwrites the first repo's choice; there is currently no way to give Codex a different persona per room.

## Use

```
cd ~/projects/my-lean-proof
terminal 1:  claude  →  /squad:goals prove lemma exp_bound; prove lemma sum_split; main theorem
             then    →  /squad:join
terminal 2:  codex   →  /squad-join
terminal 3:  squad tail                    # watch the room live
             squad send "@claude take exp_bound, @codex take sum_split"
```

Commands (`join` and `goals` behave the same in both harnesses):

- **join** — enter the room, introduce yourself, work the check/respond loop until stopped (agents go idle on their own after ~10 empty checks)
- **goals** — show the shared board, or add goals from arguments
- **clear** — wipe the room for a fresh session (Claude only; from Codex or a terminal, use `squad clear`)

Human CLI: `squad send | read | tail | goals [add|done|reopen] | claims | claim <path> | release <path> | card [create|list|show|transition|evidence|edit] | who | leave | clear | path | doctor` (persona defaults to `human`; if the install step's `npm link` was skipped or failed, replace `squad` with `node <path-to-squad>/dist/index.js`). Each repo's room is just `<repo>/.squad` — deleting that directory is a full reset. `squad card` manages Science Cards, the structured tracker for a claim moving through `QUESTION` → … → `SUPPORTED`/`FALSIFIED`/`INCONCLUSIVE`/`ABANDONED`; `squad card edit <id> --field value ...` changes fields set at creation (title, confidence, novelty, prior-art status, etc.) without touching phase — see `squad help` for the full subcommand list.

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
- **`read` vs `check`** (inherited from safehouse): `read`/`tail` are stateless history replay and never touch a cursor; `check` is a specific persona's durable unread cursor and consumes by default. Scripts and curious humans should read, not check — don't eat a real agent's mail.
- **SQLite over a flat file** because the room needs concurrent writers from independent processes and durable per-persona cursors; WAL mode makes that safe without a server.
- **`dist/` is a gitignored build artifact, not bundled, and `node_modules` is required at runtime.** Only `mcp.ts` (two dependencies: `@modelcontextprotocol/sdk`, `zod`) needs `node_modules` — `db.ts`/`core.ts`/`cli.ts` use nothing but Node built-ins (`node:sqlite` needs no native build). `index.ts` exploits that split by importing `mcp.js` lazily, only when actually starting the MCP server, so a missing/broken `node_modules` (e.g. wiped by a host reboot, as happened once — every agent reaches the room through this one `node dist/index.js` entry point, so that single missing directory silently took squad down for all of them at once) degrades the CLI instead of crashing it outright: `squad doctor`, `squad --help`, and every other CLI command still run and report the problem plainly, and a failed MCP startup leaves a system message in the room itself so any teammate already there sees *why* this persona never showed up with tools. Bundling `mcp.js`'s two dependencies into a single self-contained `dist/index.js` (esbuild/rollup) would remove the `node_modules` runtime dependency entirely and was considered, but wasn't worth the added build-tooling surface given the mitigations above (plus `install.sh` verifying the dependencies actually resolve before writing any config, not just that `dist/` exists) close the same gap more simply. Revisit if this class of failure recurs.

## Development

```bash
pnpm test    # builds + runs the node:test suite
```

## License

MIT
