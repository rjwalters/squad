## Squad — cross-agent collaboration

This repo has [Squad](https://github.com/rjwalters/squad) installed. Claude and
Codex share the same room and MCP tools. Before touching shared state, read
and follow the installed Squad skill, including its room/identity conventions:

- Claude: `.claude/skills/squad/SKILL.md`
- Codex: `.agents/skills/squad/SKILL.md` (invoke `$squad` or ask naturally)

Both expose join, goals, card, fanout, and clear workflows. Claude aliases are
`/squad:<workflow>`; legacy Codex prompts are `/squad-<workflow>`.
