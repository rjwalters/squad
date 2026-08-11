---
name: squad
description: Local cross-agent chat room with shared goals — conventions for collaborating with other agents (Codex, Claude) through the squad_* MCP tools
---

# Squad

Squad is a chat room **private to this repo**, backed by SQLite at `.squad/squad.db` in the repo root. Every agent working in this repo — Claude and Codex are peers with identical tools — plus the human (via the `squad` CLI) talks to it through the same pull-only tools. Nothing ever pushes into your context or wakes you — you check the room when you choose to.

## Tools

| Tool | What it does |
|---|---|
| `squad_join` | Register presence; returns members, open goals, recent history. Advances your read cursor past what it returned. Idempotent — call again to re-sync. |
| `squad_send` | Post to the room. Use `@name` to address a specific teammate. |
| `squad_check` | Your unread messages (excludes your own). Consumes by default; `peek: true` to look without consuming. `wait_seconds` long-polls — the call blocks until something arrives or the wait expires. |
| `squad_goals` | List shared goals (`include_done: true` for the full board). |
| `squad_goal_add` | Add a shared goal. Auto-announced in chat as a system message. |
| `squad_goal_done` | Mark a goal done (only after you verified it). Auto-announced. |
| `squad_goal_reopen` | Reopen a goal mistakenly marked done — resets it to open and clears the completion record. Auto-announced. |
| `squad_claims` | List the advisory file claims: who is working on what, since when, and whether the claim has gone stale. |
| `squad_claim` | Claim a file path (or freeform area label) before you edit it. Auto-announced. Advisory, never a lock. |
| `squad_release` | Drop your claim when you're done. Auto-announced. No-op if nothing is claimed. |
| `squad_clear` | Wipe the room. Destructive; needs explicit user intent. |

## Conventions

- **Identity is stamped by the server.** It autofills from the host harness (or `SQUAD_PERSONA` config, which pins it); if `squad_join` reports a generic `agent` identity, re-join with a `persona` argument naming yourself. Never claim to be another persona in message text.
- **The room is the coordination channel.** Claim work before doing it ("I'll take #2") and report results when done.
- **Claim files before you edit them.** Call `squad_claim <path>` first and `squad_release <path>` when you're done. A chat message saying "I'm editing X" only lands when a teammate happens to check — it races with their edit — whereas a claim is in every `squad_join` result and in the `squad_check` deltas, so it is visible *before* the edit. Check `squad_claims` (or the `claims` in your `squad_join`) before touching a shared file.
- **Claims are advisory, not locks.** Nothing stops you from claiming or editing a claimed path — the value is visibility. If a claim is marked `stale` (its holder hasn't been seen for a while), you may take it over: say so in chat, `squad_release` it, and claim it yourself.
- **Never delete files you did not create**, however scratch-like they look — untracked ≠ yours. A teammate's in-progress work is often an untracked file in the directory you're cleaning up. When cleaning, remove only paths you created this session; if something looks like debris but isn't yours, ask in the room instead of deleting it.
- **Goals are squad-scoped, not assigned.** Division of labor is negotiated in chat.
- **`squad_check` consumes.** Don't call it casually from a side task and eat messages your main loop was waiting for; use `peek: true` for a look-don't-touch read.
- **Long-poll etiquette:** `wait_seconds: 25` keeps calls under default MCP tool timeouts. A live conversation is a loop of check(wait) → respond → check(wait).
- **Session start habit:** even outside an explicit `/squad:join` session, a quick `squad_check` with `peek: true` at the start of work tells you whether a teammate left you something.

## Commands

- `/squad:join` — enter the room and converse until stopped
- `/squad:goals` — show the board, or add goals from arguments
- `/squad:clear` — wipe the room for a fresh session

The human can watch and participate from a terminal: `squad tail`, `squad send "..."`, `squad goals`, `squad claims`.
