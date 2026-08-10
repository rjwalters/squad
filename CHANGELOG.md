# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- Room resolution in git worktrees (#6): a linked worktree now resolves to the
  primary clone's `<repo>/.squad` (via `git rev-parse --path-format=absolute
  --git-common-dir`) instead of its own private, empty room — so a Codex agent
  started in a worktree joins the same room as Claude agents in the primary
  clone. `SQUAD_DIR` still takes precedence, an explicit `.squad` in the
  worktree still opts it into its own room, and resolution falls back to the
  previous cwd walk when `git` is unavailable. As defense in depth, joining an
  empty room from a worktree whose primary clone has a live room now prints a
  warning to stderr naming the `SQUAD_DIR` to set.

## [0.2.0] - 2026-08-07

### Added
- `squad goals reopen <id>` and matching `squad_goal_reopen` MCP tool: undo a
  mistaken `done` by resetting the goal to open and clearing `done_by` /
  `done_ts`, auto-announced in chat (#5).
- Installer contract conformance (#4): `install.sh` now records a tracked
  `.claude/skills/squad/install-metadata.json` (`version`, `commit`,
  `layout_version` — byte-identical on every machine) so `/repo:update-tools`
  discovers squad installs, plus a gitignored `.install-local.json` sidecar
  for the machine-local source path and install timestamp.
- `install.sh --dry-run`: prints every planned write — including the global
  Codex writes outside the target repo — changes nothing, exits 0 (#4).
- `VERSION` at the repo root, populated and enforced against `package.json`
  by a test; the installer reads it as the single source of truth (#4).

### Changed
- Bump zod 3.25.76 → 4.4.3, typescript 5.9.3 → 7.0.2, @types/node 24 → 26 (#1, #2, #3).
- tsconfig: explicit `types: ["node"]` — TypeScript 7 no longer auto-includes
  `node_modules/@types`.

## [0.1.0] - 2026-08-05

Initial release.

### Added
- `squad` stdio MCP server: `squad_join`, `squad_send`, `squad_check` (durable
  per-persona cursors, `peek`, long-polling via `wait_seconds`), `squad_goals`,
  `squad_goal_add` / `squad_goal_done` (auto-announced in chat), `squad_clear`.
- Human CLI on the same binary: `send | read | tail | goals | who | clear | path`.
- Per-repo rooms: SQLite (WAL) at `<repo>/.squad/squad.db`, resolved via
  `SQUAD_DIR` env or by walking up to the nearest repo root; `~/.squad` fallback.
- Server-stamped identity with harness autofill (Claude Code → `claude`,
  Codex → `codex`) and `SQUAD_PERSONA` pinning.
- `install.sh` / `uninstall.sh`: Claude Code and Codex as peers — `.mcp.json`
  entry, `/squad:*` commands + skill, identical marker blocks in `CLAUDE.md`
  and `AGENTS.md`, one-time global Codex registration.
- Test suite (`node --test`) covering core room semantics and dir resolution.
- Dependabot config (weekly npm; minors/patches grouped, majors individual).
