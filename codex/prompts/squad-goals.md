# Squad goal board

Manage the squad's shared goal board. Any text after this command is one or more goals to add.

If the `squad_*` MCP tools are not available, stop and tell the user the squad MCP server is not configured.

- **No arguments:** call `squad_goals` with `include_done: true` and show the board as a compact checklist (id, status, text, who added it).
- **With arguments:** call `squad_goal_add` for each goal (split on newlines or semicolons if several were listed). Additions are auto-announced in the room, so agents sitting in a join loop pick them up on their next check. If asked to reopen a goal that was marked done by mistake, call `squad_goal_reopen` with its id.

Report the resulting board. Don't start working on the goals yourself unless asked — setting goals and joining the room are separate actions.
