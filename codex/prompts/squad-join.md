# Join the squad room

Join the local squad chat room (the `squad` MCP server) and hold a working conversation with the other agents (e.g. Claude) until the user tells you to stop.

If the `squad_*` MCP tools are not available, stop and tell the user the squad MCP server is not configured (see the squad repo's install.sh for the `~/.codex/config.toml` entry).

1. Call `squad_join`. Read the member list, open goals, current file claims, and recent history. Your persona autofills; if the result reports a generic identity like `agent`, call `squad_join` again with a `persona` argument naming yourself (e.g. `codex`).
2. Introduce yourself with `squad_send` — one short message: your persona name, which repo/directory you're working in, and that you're ready. If there are open goals, say which you're picking up or ask how to split them.
3. Conversation loop:
   - Call `squad_check` with `wait_seconds: 25`.
   - Read the `peers` in the result: `idle` means paused (probably mid-turn on something long), `stale` means gone — don't block on a stale peer's reply, and their claims are takeable.
   - If messages arrived, respond with `squad_send` when useful — answer questions, claim or hand off goals ("I'll take #2, you take #3"), report results. Do real work between checks when a goal calls for it, and post progress when you finish something.
   - Before editing a file, call `squad_claim <path>` (and `squad_release <path>` when you're done). Claims appear in every `squad_join` and in teammates' checks, so they're visible before an edit lands — a chat message saying "I'm editing X" races with their edit.
   - When a goal you're working on is complete and verified, call `squad_goal_done`. If a goal was marked done by mistake, `squad_goal_reopen` undoes it.
   - Repeat.
4. Etiquette: keep messages short and concrete; address a specific teammate with `@name`; never mark a goal done you didn't verify; check `squad_claims` and claim a file before editing it (claims are advisory — a `stale` one may be taken over, but say so in chat and `squad_release` it first).
5. Cleanup rule: never delete files you did not create, however scratch-like they look — untracked ≠ yours. A teammate's in-progress work is often an untracked file in the directory you're cleaning up; ask in the room instead of deleting it.
6. Stopping — always say **which kind of stop** it is, because "quiet" and "dead" look identical from the outside:
   - First find out whether you are supervised: run `echo "${SQUAD_REENTRY_SUPERVISOR:-0}"` in a shell. `1` means `squad codex-reentry` launched you and will re-launch you after a bounded backoff once this turn ends (it resets immediately on an `@mention`). Anything else means nothing will bring you back.
   - **Supervised (`1`)**: after ~10 consecutive empty checks, post "going idle — my re-entry supervisor will bring me back; `@`mention me to wake me sooner" and end the turn. Do **not** call `squad_leave`: you are coming back, and leaving would tell the room the opposite. The supervisor announces in the room when it stops for good, so silence from you is never mistaken for a permanent park.
   - **Unsupervised (`0` or unset)**: after ~10 consecutive empty checks, post "going idle — I will NOT return without an operator re-invoking me; don't wait on me" **before** you stop, then call `squad_leave` so the room knows you're gone rather than merely quiet. Never end an unsupervised turn silently: a silent park is indistinguishable from a crash and has cost this room multi-hour outages.
   - Stop immediately whenever the user interrupts, or when a teammate leaves and all goals are closed — `squad_leave` in both cases, supervised or not. Summarize the session for the user last.

Tell the user briefly whenever something meaningful changes in the room — they can't see it.
