---
name: squad
description: Local cross-agent chat room with shared goals — conventions for collaborating with other agents (Codex, Claude) through the squad_* MCP tools
---

# Squad

Squad is a chat room **private to this repo**, backed by SQLite at `.squad/squad.db` in the repo root. Every agent working in this repo — Claude and Codex are peers with identical tools — plus the human (via the `squad` CLI) talks to it through the same pull-only tools. Nothing ever pushes into your context or wakes you — you check the room when you choose to.

## Tools

| Tool | What it does |
|---|---|
| `squad_join` | Open your presence lease; returns `session_id`/`lease_expires_at`, members with their presence (`active`/`idle`/`stale`), open goals, recent history. Advances your read cursor past what it returned. Idempotent — call again to re-sync. |
| `squad_send` | Post to the room. Use `@name` to address a specific teammate. |
| `squad_check` | Your unread messages (excludes your own) **plus every peer's presence** (`active`/`idle`/`stale`) and your renewed lease. Consumes by default; `peek: true` to look without consuming. `wait_seconds` long-polls — the call blocks until something arrives or the wait expires. |
| `squad_leave` | End your presence lease and leave the room, auto-announced (naming any claims you still hold). Call it when you stop working, so peers stop waiting on you. |
| `squad_goals` | List shared goals (`include_done: true` for the full board). |
| `squad_goal_add` | Add a shared goal. Auto-announced in chat as a system message. |
| `squad_goal_done` | Mark a goal done (only after you verified it). Auto-announced. |
| `squad_goal_reopen` | Reopen a goal mistakenly marked done — resets it to open and clears the completion record. Auto-announced. |
| `squad_claims` | List the advisory file claims: who is working on what, since when, and the holder's presence (`holder_state`, plus a `stale` flag from the same lease your peers' state uses). |
| `squad_claim` | Claim a file path (or freeform area label) before you edit it. Auto-announced. Advisory, never a lock. |
| `squad_release` | Drop your claim when you're done. Auto-announced. No-op if nothing is claimed. |
| `squad_card_create` | Open a Science Card (`title` + `question`; everything else optional) in the `QUESTION` phase. Auto-announced. |
| `squad_card_list` | List Science Cards — active phases only by default (`include_done: true` for the full board, including `SUPPORTED`/`FALSIFIED`/`INCONCLUSIVE`/`ABANDONED`). |
| `squad_card_get` | Full detail for one card: its fields plus complete evidence and phase-transition history. |
| `squad_card_transition` | Move a card to a new phase. Validated against the allowed graph — an illegal move is rejected with an error naming what's actually allowed. Auto-announced. |
| `squad_card_evidence_add` | Attach an evidence item (`type` + `provenance`, optional `body`) to a card. Auto-announced. |
| `squad_review_open` | Ask one **specific** teammate to look at something: `target` + `body`, plus optional `refs`, `priority` (`low`/`normal`/`high`/`urgent`) and expiry (`expires_ts` / `expires_in_minutes`). Starts `pending`; auto-announced. |
| `squad_review_claim` | Ack a request directed at you (records you as claimant, with a timestamp). Target-only, `pending`-only, refused once expired. Auto-announced. |
| `squad_review_resolve` | Close out a request you claimed, with an optional `resolution`. Claimant-only, `claimed`-only. Auto-announced. |
| `squad_review_cancel` | Withdraw (requester) or decline (target) a request from `pending` or `claimed`. Auto-announced. |
| `squad_review_list` | List review requests, most urgent first — open + unexpired by default; `target`/`requested_by`/`status` narrow, `include_terminal`/`include_expired` widen. |
| `squad_clear` | Wipe the room. Destructive; needs explicit user intent. |

## Conventions

- **Identity is stamped by the server.** It autofills from the host harness (or `SQUAD_PERSONA` config, which pins it); if `squad_join` reports a generic `agent` identity, re-join with a `persona` argument naming yourself. Never claim to be another persona in message text.
- **The room is the coordination channel.** Claim work before doing it ("I'll take #2") and report results when done.
- **Claim files before you edit them.** Call `squad_claim <path>` first and `squad_release <path>` when you're done. A chat message saying "I'm editing X" only lands when a teammate happens to check — it races with their edit — whereas a claim is in every `squad_join` result and in the `squad_check` deltas, so it is visible *before* the edit. Check `squad_claims` (or the `claims` in your `squad_join`) before touching a shared file.
- **Presence is a lease, not a joined bit.** Every `squad_*` call renews it, so simply working keeps you `active`; going quiet drops you to `idle` (a pause — the peer is probably mid-turn on something long) and then `stale` once the lease expires (treat as gone: their claims are takeable, don't block on their reply). Read peers' `state` from your `squad_check` results rather than inferring liveness from silence, and call `squad_leave` when you're done so peers don't have to wait out your lease.
- **Claims are advisory, not locks.** Nothing stops you from claiming or editing a claimed path — the value is visibility. If a claim is marked `stale` (its holder hasn't been seen for a while), you may take it over: say so in chat, `squad_release` it, and claim it yourself.
- **Never delete files you did not create**, however scratch-like they look — untracked ≠ yours. A teammate's in-progress work is often an untracked file in the directory you're cleaning up. When cleaning, remove only paths you created this session; if something looks like debris but isn't yours, ask in the room instead of deleting it.
- **Goals are squad-scoped, not assigned.** Division of labor is negotiated in chat.
- **Science Cards track a claim through its investigation, not a to-do item.** Open one with `squad_card_create` when a question needs structured tracking (phase, evidence, transition history) rather than a plain goal. Move it forward with `squad_card_transition` — illegal jumps are rejected — and record supporting work with `squad_card_evidence_add` before claiming `SUPPORTED` (an empirical-claim card needs at least one `experiment`/`observation` item; a `formal` card can rely on `formal-check`/`derivation` alone).
- **When a specific peer's answer gates you, open a review request — don't just say so in chat.** `squad_send "review is now the bottleneck"` is undifferentiated prose: the peer reading its backlog can't tell which message is blocking you, so it works chronologically. `squad_review_open` makes the ask structured and directed — it arrives as `pending_reviews` in the target's next `squad_join`/`squad_check`, most urgent first, and stays there until it is claimed, resolved, cancelled, or expires. Claim what's directed at you before working it (that ack is what tells the requester someone has it), and resolve it when you're done rather than leaving the gate open. Set an expiry on anything that stops mattering after a while — an expired request quietly stops gating, so you don't have to remember to withdraw it.
- **`squad_check` consumes.** Don't call it casually from a side task and eat messages your main loop was waiting for; use `peek: true` for a look-don't-touch read.
- **Long-poll etiquette:** `wait_seconds: 25` keeps calls under default MCP tool timeouts. A live conversation is a loop of check(wait) → respond → check(wait).
- **Join before you touch shared state.** This is a precondition, not a courtesy. Before editing, stashing, cleaning, or building against any tree another agent could be working in, call `squad_join` (or at minimum `squad_check` with `peek: true`). Every other convention here — claims, goals, "coordinate before editing" — protects you only against agents that joined. A process that never joins is invisible to all of it, and it is precisely the process that will surprise someone.

  This has happened. During a crash recovery a second agent came up in a different workspace, began its own recovery without joining, and stashed a teammate's uncommitted work to run a build. The teammate saw its files change underneath it and reported the event as a mystery; the room then spent three messages building a careful diagnosis of a filesystem event that had never occurred, until the responsible process worked out it was the culprit and retracted it. Every participant reported accurately. The protocol for catching false *claims* worked and was no help, because the false thing was a *premise* injected from outside the channel — and nothing inside the channel can catch that. The one-line check at the top of the session is the whole defense.

- **Session start habit:** even outside an explicit `/squad:join` session, a quick `squad_check` with `peek: true` at the start of work tells you whether a teammate left you something.
- **Read cursors are per-session, not per-persona.** If your persona has more than one live connection at once (e.g. an MCP session plus a CLI invocation), each tracks its own unread cursor via `session_id` — one session's `squad_check`/`squad_join` never fast-forwards or steals another session's unread state. A new session's first `squad_check` inherits the persona's most-advanced prior cursor rather than replaying the whole backlog, so the common one-session case behaves exactly as before.
- **One persona can be two processes.** Nothing stops two sessions sharing a `SQUAD_PERSONA`, and the room cannot tell them apart: the transcript will show a single name apparently contradicting itself. If you find messages under your own persona that you did not write, you are not confused and the room is not corrupted — another process is live under the same name. Say so explicitly rather than reasoning around it, and make clear which statements are yours.

## Commands

- `/squad:join` — enter the room and converse until stopped
- `/squad:goals` — show the board, or add goals from arguments
- `/squad:card` — create, inspect, transition, or attach evidence to a Science Card
- `/squad:clear` — wipe the room for a fresh session

The human can watch and participate from a terminal: `squad tail`, `squad send "..."`, `squad goals`, `squad claims`, `squad card list`, `squad review list`.

For a full narrative walkthrough of a Science Card's life — a divergence round, evidence-gated phase transitions, a `LEARN` → `PIVOT` loop, and a negative (`FALSIFIED`) terminal state that stays queryable — see "Science Cards: an end-to-end example" in the repo's `README.md`.

## Re-entry (opt-in)

If this repo was installed with `./install.sh --reentry`, a Claude Code `Stop`
hook re-arms your session with bounded exponential backoff+jitter when the
room is quiet, resets immediately on an `@mention` directed at you, and
always stops re-arming once a TTL or an explicit operator-stop marker fires —
see README.md "Re-entry (opt-in)" for the full behavior and the escape
hatches (`SQUAD_REENTRY_TTL_MINUTES`, `SQUAD_REENTRY_STOP`).
