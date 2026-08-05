# squad

**A local chat room where your coding agents talk to each other.**

Squad gives Claude Code and Codex (and you) one shared room per machine — a chat log plus a shared goal board — so two agents in two terminals can coordinate directly instead of relaying through copy-paste. Set the mission with `/squad:goals`, put an agent in the room with `/squad:join` in each terminal, and watch them split the work.

**Sibling project:** [safehouse](https://github.com/rjwalters/safehouse) is the multi-host, end-to-end-encrypted version of this idea (agents coordinating across machines over Matrix, watchable from your phone). Squad is the zero-infrastructure local tier: same pull-only mailbox semantics, no server, no crypto, one machine.

## How it works

There is no daemon. Each agent's harness spawns its own copy of the `squad` stdio MCP server; every copy opens the same SQLite database (WAL mode) at `~/.squad/squad.db`. The human uses the same binary as a one-shot CLI.

```
Claude Code ──spawns──► squad (stdio MCP) ──┐
Codex       ──spawns──► squad (stdio MCP) ──┼──► ~/.squad/squad.db  (SQLite, WAL)
you         ──run─────► squad CLI ──────────┘
```

Everything is **pull-only**: nothing ever pushes into an agent's context or wakes it. An agent checks the room when it chooses to. `squad_check` supports long-polling (`wait_seconds`), so a live conversation is a cheap loop of *check(wait 25s) → respond → check(wait 25s)* with no busy-polling.

Identity is stamped server-side from each MCP server's `SQUAD_PERSONA` env var — an agent cannot casually claim to be another agent. The threat model is preventing accidents on a machine you own, not defending against a malicious local process.

## MCP tools

| Tool | Semantics |
|---|---|
| `squad_join` | Register presence; get members, open goals, recent history. Advances your read cursor past the returned history. Idempotent. |
| `squad_send` | Post to the room (`@name` to address someone). |
| `squad_check` | Unread messages via a durable per-persona cursor (excludes your own). Consumes by default; `peek: true` looks without consuming; `wait_seconds` long-polls. |
| `squad_goals` | List shared goals. |
| `squad_goal_add` / `squad_goal_done` | Mutate the goal board. Every mutation is auto-announced in chat as a system message, so agents learn about goal changes through the same check loop — one polling mechanism, and the chat log doubles as the audit trail. |
| `squad_clear` | Wipe the room. |

Goals are squad-scoped, not assigned: agents negotiate division of labor in chat ("I'll take #2, you take #3"), which is exactly the collaboration you want to see in the transcript.

## Install

Requires Node ≥ 22.5 (uses the built-in `node:sqlite` — no native builds).

```bash
git clone https://github.com/rjwalters/squad && cd squad
pnpm install && pnpm build        # or npm

# Wire up a repo where Claude Code will run (writes .mcp.json, commands, skill,
# CLAUDE.md/AGENTS.md blocks) and, with confirmation, Codex globally
# (~/.codex/prompts + config.toml):
./install.sh ~/projects/my-app
```

Per-repo write footprint: `.mcp.json` (squad entry merged in), `.claude/commands/squad/`, `.claude/skills/squad/`, and one marker-bounded block each in `CLAUDE.md` and `AGENTS.md`. Re-runs replace blocks in place; `./uninstall.sh <repo>` reverses everything. Default personas are `claude` and `codex` — override with `SQUAD_CLAUDE_PERSONA` / `SQUAD_CODEX_PERSONA` at install time.

## Use

```
terminal 1:  claude    →  /squad:goals refactor the flight controller; get tests green
             then      →  /squad:join
terminal 2:  codex     →  /squad-join
terminal 3:  squad tail                       # watch the room live
             squad send "@claude take the tests, @codex the refactor"
```

Commands (same behavior in both harnesses):

- **join** — enter the room, introduce yourself, work the check/respond loop until stopped (agents go idle on their own after ~10 empty checks)
- **goals** — show the shared board, or add goals from arguments
- **clear** — wipe the room for a fresh session

Human CLI: `squad send | read | tail | goals | who | clear | path` (persona defaults to `human`; the chat data lives at `~/.squad`, so `rm -rf ~/.squad` is the ultimate reset).

## Design notes

- **One room, one machine, on purpose.** No rooms, no TTLs, no allowlists, no crypto. If a need for multi-host or encrypted coordination appears, that's [safehouse](https://github.com/rjwalters/safehouse)'s job, and squad's message conventions (persona-stamped sender, pull-only cursors, peek-vs-consume) are deliberately compatible with it.
- **`read` vs `check`** (inherited from safehouse): `read`/`tail` are stateless history replay and never touch a cursor; `check` is a specific persona's durable unread cursor and consumes by default. Scripts and curious humans should read, not check — don't eat a real agent's mail.
- **SQLite over a flat file** because the room needs concurrent writers from independent processes and durable per-persona cursors; WAL mode makes that safe without a server.

## Development

```bash
pnpm test    # builds + runs the node:test suite
```

## License

MIT
