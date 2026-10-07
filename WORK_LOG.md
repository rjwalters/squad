# Work Log

Merged PRs and closed issues from the last 30 days when this log was initialized. Guide appends subsequent unrecorded events.

### 2026-10-06

- **PR #145**: feat: route replies to cross-room requests back to the asking room (#144)
- **PR #142**: Squad room is the default channel; built-in cross-session messaging is pointer/fallback (#141)
- **Issue #144** (closed): Cross-room replies: route answers to a --room send back to the sender's room
- **Issue #141** (closed): Know about Claude's built-in cross-session messaging, but keep the squad room the default when installed — so history survives for later joiners (e.g. Codex)

### 2026-10-03

- **PR #140**: feat: add squad heal and run it from install/update (#132)
- **PR #139**: who/squad_join/squad_check: list live sessions of a shared persona separately (#136)
- **PR #138**: Record posting session_id on messages (schema v10)
- **PR #137**: docs: out-of-cast agents post under own persona/room or not at all
- **PR #133**: feat: squad send --room <repo-path> (#123)
- **Issue #136** (closed): who/squad_join/squad_check: list live sessions of a shared persona separately
- **Issue #135** (closed): Record posting session_id on messages (schema bump, send, export/import)
- **Issue #134** (closed): Docs: how an agent outside a room's cast should post (own persona, own room, or not at all)
- **Issue #132** (closed): Rooms created before #111's fix never heal: ensureRoomIgnored only runs when the room is reopened
- **Issue #123** (closed): squad send --room <repo-path>: cross-repo addressing, and refuse to create a room nobody watches

### 2026-10-02

- **PR #131**: fix: sub-action --help/-h prints usage (#130)
- **PR #129**: fix: answer `squad <cmd> --help` with usage instead of running the command
- **PR #127**: fix: thread the hooks' stdin session_id into Squad construction
- **PR #125**: fix: honour a caller-supplied session id for explicit personas (#124)
- **PR #121**: feat: mid-turn inbox delivery via opt-in PostToolUse/UserPromptSubmit hook
- **Issue #130** (closed): squad goals add --help adds a goal named "--help": sub-action flags are still content
- **Issue #126** (closed): Thread hook-supplied session_id into Squad construction in inbox-hook.ts / reentry-hook.ts
- **Issue #124** (closed): Explicit-persona Squad instances mint a new presence session row per process, ignoring SQUAD_SESSION_ID
- **Issue #119** (closed): squad send --help posts "--help" to the room as human
- **Issue #118** (closed): Mid-turn inbox delivery: opt-in PostToolUse/UserPromptSubmit hook that surfaces directed messages to a busy agent

### 2026-09-30

- **PR #117**: feat: squad relay CLI, status, and opportunistic MCP relay hook (#109 Phase 2)
- **PR #116**: fix: keep .squad/ out of git from the runtime that creates it
- **PR #115**: feat: relay room messages to an OTLP logs endpoint via a cursor-based outbox
- **PR #110**: chore(deps): bump vulnerable transitive deps (15 Dependabot alerts)
- **PR #93**: chore(deps): bump the npm-minor-patch group across 1 directory with 2 updates
- **Issue #113** (closed): Relay CLI, opportunistic hook, status, and docs (#109 Phase 2)
- **Issue #112** (closed): Relay engine: outbox schema, OTLP sink, and delivery core (#109 Phase 1)
- **Issue #111** (closed): squad writes its .squad/ SQLite database into repo checkouts, untracked and not ignored
- **Issue #109** (closed): Relay room messages to a remote observability host (SigNoz/OTLP) for dashboard viewing

### 2026-09-28

- **PR #108**: docs(conventions): add room-visibility rule for non-participants
- **PR #106**: fix: room-split advisory no longer fires when SQUAD_DIR is set explicitly
- **PR #105**: fix: raise installed-parity test timeout to fit its real cost
- **PR #104**: docs(conventions): three room rules from a two-agent session
- **PR #102**: test(doctor): probe missing dependencies from a dist copy outside the repo
- **PR #100**: fix: spawn the MCP server through an in-repo launcher so linked worktrees work
- **PR #98**: feat(identity): name automatic agents <label>-<4 random hex>
- **Issue #107** (closed): conventions: the room is invisible to agents outside it, so negotiated decisions need repo state
- **Issue #103** (closed): Room-split advisory fires even when SQUAD_DIR is set explicitly
- **Issue #101** (closed): tests/doctor.test.mjs fails when the suite is run from a linked git worktree
- **Issue #99** (closed): Tests: installed-parity exceeds its 30s timeout; node_modules-degradation tests fail from nested worktrees
- **Issue #97** (closed): conventions: three rules from a two-agent session (yielding collisions, claiming the wrong object, swallowed failures)
- **Issue #96** (closed): Automatic agent identity: use <label>-<short random hex> and populate the label
- **Issue #95** (closed): Relative MCP server path in .mcp.json cannot resolve from a linked worktree

### 2026-09-15

- **PR #91**: fix: bank committed artifacts from independent author checkouts
- **PR #89**: fix: keep sibling project MCP launchers portable
- **PR #88**: feat: report room drift from durable integration evidence
- **Issue #90** (closed): Bank committed node artifacts from independent author checkouts
- **Issue #87** (closed): install-lifecycle writes absolute machine paths into consumer .mcp.json — write repo-relative paths
- **Issue #77** (closed): Research integration: Report room drift

### 2026-09-14

- **PR #86**: feat: add durable steward status and bounded reminders
- **PR #85**: feat: publish deterministic verified research outlines
- **PR #84**: feat: share claim and review aware wake policy
- **PR #83**: feat: independently rebuild and review claimed node revisions
- **PR #82**: feat: add durable research nodes on Science Cards
- **PR #81**: feat: execute verified research banking
- **PR #80**: feat: persist integration attempts and verified evidence
- **PR #79**: feat: configure a shared room integration target
- **PR #68**: test: verify installed Claude and Codex collaboration
- **PR #67**: feat: preserve ownership across Squad install and removal
- **PR #66**: feat: install shared Squad workflows for Claude and Codex
- **PR #65**: feat: assign durable provider-model-session agent identities
- **PR #63**: chore(deps): bump the npm-minor-patch group across 1 directory with 2 updates
- **PR #17**: docs: require joining the correct room before touching shared work
- **Issue #76** (closed): Research integration: Implement a shared claim/review-aware wake policy
- **Issue #75** (closed): Research integration: Provide the steward workflow
- **Issue #74** (closed): Research integration: Generate the authoritative research outline
- **Issue #73** (closed): Research integration: Bind node claims to independent review evidence
- **Issue #72** (closed): Research integration: Make research nodes durable Science Card records
- **Issue #71** (closed): Research integration: Implement verified banking through CLI and MCP
- **Issue #70** (closed): Research integration: Record durable integration attempts and evidence
- **Issue #69** (closed): Research integration: Configure one room integration target
- **Issue #64** (closed): Default agent identities to provider-model-short-session-id
- **Issue #48** (closed): Add package-lock.json — Loom's npm-ci-based MCP auto-rebuild can never succeed without it
- **Issue #26** (closed): Add first-class Claude/Codex skill packaging and capability parity
- **Issue #21** (closed): CLI persona stamping inconsistent: goals add honors SQUAD_PERSONA, send stamps the operator identity
- **Issue #19** (closed): Ship Squad as a bilingual Claude and Codex skill pack
- **Issue #16** (closed): A process that never joins the room can mutate shared state invisibly
