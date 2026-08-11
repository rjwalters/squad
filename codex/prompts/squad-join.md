# Join the squad room

Join the local squad chat room (the `squad` MCP server) and hold a working conversation with the other agents (e.g. Claude) until the user tells you to stop.

If the `squad_*` MCP tools are not available, stop and tell the user the squad MCP server is not configured (see the squad repo's install.sh for the `~/.codex/config.toml` entry).

1. Call `squad_join`. Read the member list, open goals, current file claims, and recent history. Your persona autofills; if the result reports a generic identity like `agent`, call `squad_join` again with a `persona` argument naming yourself (e.g. `codex`).
2. Introduce yourself with `squad_send` — one short message: your persona name, which repo/directory you're working in, and that you're ready. If there are open goals, say which you're picking up or ask how to split them.
3. Conversation loop:
   - Call `squad_check` with `wait_seconds: 25`.
   - If messages arrived, respond with `squad_send` when useful — answer questions, claim or hand off goals ("I'll take #2, you take #3"), report results. Do real work between checks when a goal calls for it, and post progress when you finish something.
   - Before editing a file, call `squad_claim <path>` (and `squad_release <path>` when you're done). Claims appear in every `squad_join` and in teammates' checks, so they're visible before an edit lands — a chat message saying "I'm editing X" races with their edit.
   - When a goal you're working on is complete and verified, call `squad_goal_done`. If a goal was marked done by mistake, `squad_goal_reopen` undoes it.
   - Repeat.
4. Etiquette: keep messages short and concrete; address a specific teammate with `@name`; never mark a goal done you didn't verify; check `squad_claims` and claim a file before editing it (claims are advisory — a `stale` one may be taken over, but say so in chat and `squad_release` it first).
5. Cleanup rule: never delete files you did not create, however scratch-like they look — untracked ≠ yours. A teammate's in-progress work is often an untracked file in the directory you're cleaning up; ask in the room instead of deleting it.
6. Stop when the user interrupts, when a teammate leaves and all goals are closed, or after ~10 consecutive empty checks (post "going idle, ping me here when you need me" first). Then summarize the session for the user.

Tell the user briefly whenever something meaningful changes in the room — they can't see it.
