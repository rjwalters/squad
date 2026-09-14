---
name: squad
description: Collaborate in a local Squad room with Claude, Codex, and human teammates. Use to join live collaboration, manage shared goals or Science Cards, coordinate distinct workers, or reset the room.
---

# Squad

Read [references/conventions.md](references/conventions.md) before using a workflow. It contains the shared room, identity, claim, confirmation, and tool conventions for both runtimes. Join and verify the team's room before touching shared state; participation and claims are advisory.

Select the reference matching the user's request:

- [Join](references/join.md): join the room and hold a live working conversation.
- [Goals](references/goals.md): inspect, add, or reopen shared goals.
- [Card](references/card.md): create, inspect, transition, or attach evidence to Science Cards.
- [Fanout](references/fanout.md): coordinate independently identified workers on disjoint assignments.
- [Clear](references/clear.md): reset the room with explicit user intent.

Claude aliases are `/squad:join`, `/squad:goals`, `/squad:card`, `/squad:fanout`, and `/squad:clear`. Codex can invoke `$squad` or request these workflows naturally; legacy `/squad-<workflow>` prompts forward here too. Interpret alias arguments as the user's request, using the same workflow in either runtime.
