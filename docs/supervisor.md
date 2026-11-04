# Supervisor design: one re-entry policy, three runtimes

Status: design note (issue #230). No runtime code changes here; the child
issues listed at the end carry the implementation.

Facts below were measured against `main` @ `bde6f58` on 2026-11-03.

## Problem

An agent that ends its turn goes quiet: the process stays up (or exits) and
nothing restarts it until a human re-invokes it (#222, #60). Three mechanisms
exist today, each with its own wiring, and a third runtime (opencode, #227) is
coming:

| Piece | Runtime | Mechanism | Code |
|---|---|---|---|
| Stop hook | Claude Code | Blocks the stop inside the live session | `src/reentry-hook.ts`, `hooks/squad-reentry.sh` (`install.sh --reentry`) |
| `squad codex-reentry` | Codex | Foreground wrapper loop around `codex exec` / `codex exec resume` | `src/codex-reentry.ts`, `src/codex-reentry-driver.ts` |
| `squad waker` | Codex, Claude | Resumes a persona with **no live session** when it has directed work | `src/waker.ts`, `src/waker-unit.ts`, `src/wake-handles.ts` (`install.sh --waker`) |

All three already call `decide()` in `src/reentry.ts`, so the policy is mostly
shared. What is not shared is launch/resume/detect-turn-end, which differs per
runtime by necessity.

## Per-runtime contract

Every command below is either marked **verified** (what was run, and against
what) or **unverified**. "Verified (help)" means the flags were confirmed in the
installed CLI's `--help`; it does **not** mean a model turn was run. A live
`claude -p` run on the dispatch host that wrote this note returned
`terminal_reason: api_error` with zero usage (no usable credentials there), and a
live `codex exec` was not attempted for the same reason, so no end-to-end turn is
claimed for either. The Builder of the adapter children must re-run these on a
host with credentials.

> **#236 status:** `squad agent claude` is implemented (`src/claude-reentry-driver.ts`)
> and unit tested against a fake `claude` shim. The live `claude -p` / `--resume`
> run is **not yet recorded** here: it needs a host with working Claude credentials
> and is tracked as an operator step on #236.

### Claude Code

- CLI: `claude 2.1.317 (Claude Code)` (`claude --version`).
- Non-interactive launch: `claude -p "<prompt>" [--output-format json]`.
  Verified (help): `-p, --print` "Print response and exit"; `--output-format`
  "only works with --print". `--session-id <uuid>` pins the id up front.
- Resume: `claude --resume <session-id> -p "<prompt>"`. Verified (help):
  `-r, --resume [value]` "Resume a conversation by session ID". This is exactly
  what `resolveWakeCommand` builds today (`src/wake-handles.ts`).
- Turn end signal: the `Stop` hook payload (`session_id`, `cwd`,
  `stop_hook_active`); under `-p`, the process exit.
- Wake-handle shape: `{persona, runtime:"claude", session_ref:<session_id>, cwd,
  host, no_wake, updated_at}`. Recorded by the Stop hook from the real payload
  `session_id` only, never a guess.

### Codex

- CLI: `codex-cli 0.166.0` (`codex --version`).
- Non-interactive launch: `codex exec [OPTIONS] [PROMPT]`. Verified (help).
  `exec` exits at end of turn, which is what makes a wrapper loop possible.
- Resume: `codex exec resume [SESSION_ID] [PROMPT]`, or `codex exec resume --last
  [PROMPT]`. Verified (help): "Resume a previous session by id or pick the most
  recent with --last"; `--json`, `--skip-git-repo-check` are accepted.
- Turn end signal: process exit; outcome classified from the rollout tail
  (`task_complete` / `error` / `unknown` / `missing`) in `~/.codex/sessions/`.
- Wake-handle shape: `{runtime:"codex", session_ref:<rollout uuid>}`, derived
  with `codexSessionFromRollout`.

### opencode

- Resume argv, verified against `opencode run --help` (opencode 1.18.31,
  2026-11-03): `opencode run --session <id> "<prompt>"` (`-s, --session  session
  id to continue`). `-c, --continue` resumes the *last* session, which is
  ambiguous with several personas, so the waker does not use it. Not exercised
  against a live session. Turn end signal: process exit of `opencode run`.
  Session id source: still unknown; the adapter child (#238) must find how to
  read it (CLI output or its session store) and must not record a handle it
  cannot read (same rule as Claude/Codex).
- Wake-handle shape: same row, `runtime:"opencode"`, `session_ref` the opencode
  session id. `resolveWakeCommand` returns
  `["opencode","run","--session",ref,prompt]`. The `wake_handles.runtime` CHECK
  is rebuilt on open for rooms created before opencode was allowed.

### Edge cases

- **Runtime binary missing from PATH.** The adapter's launch step must fail
  closed with a room system line (`not woken: <persona> -- <bin> not found`)
  and count as a failure for backoff, as `waker.ts` already does for a failed
  spawn. It must not loop at the minimum interval.
- **Persona with no usable wake handle** (none recorded, `no_wake`, other
  host, empty ref). Already handled in `wakeOnce`: skip, post the reason once.
  Unchanged. A persona started *by* the supervisor does not need a handle to
  start; it only needs one to be woken after the supervisor is gone.

## Decisions

### 1. One entry point, runtime adapters behind it

Add `squad agent <runtime>` as the single supervisor entry point. A runtime
adapter is three small functions: `launch(persona, prompt)`,
`resume(handle, prompt)` and `detectTurnEnd(run)`. The loop (wait for turn end,
consult policy, relaunch, announce stop) is runtime-independent and is today's
`supervise()` in `src/codex-reentry.ts`, which already takes all I/O through
`SuperviseDeps`. Rejected: a new policy engine; it would duplicate
`reentry.ts`.

### 2. Claude Stop hook: keep, as the in-place keep-alive adapter

Keep it. It is the only mechanism that continues the *same live session*
without a process spawn, and it needs no wrapper in front of the operator's
terminal. `squad agent claude` is for the case the hook cannot cover (headless
`claude -p` runs, where there is no interactive Stop to block). It is additive,
not a replacement. Reason it cannot be replaced by the waker: the waker only acts
when there is *no* live session.

### 3. The single shared policy is `src/reentry.ts`

TTL, attempt cap, backoff, operator stop and directed-work reset stay exactly
as `decide()` defines them (precedence: operator stop, stored stop reason, TTL,
attempt cap, failure delay, directed work, claim/idle windows). No new knobs.
Three things currently live outside it and should move in:

| Today | Moves to | Why |
|---|---|---|
| `preLaunchStop()` in `codex-reentry.ts` (re-implements operator-stop → TTL → cap precedence before the first launch) | `reentry.ts`, as the pure pre-launch gate, with `decide()` reusing it | Two copies of the same precedence can drift. |
| Quiet-gap arm-cycle reset in `wakeOnce` ("a quiet gap as long as the TTL starts a new arm cycle") | `reentry.ts` as a pure `rearmIfQuiet(state, nowMs, ttlMinutes)` | The Stop hook and Codex loop have no equivalent, so TTL means different things per adapter. |
| State load/save and the persona lock (`loadWakerState`, `saveWakerState`, `withPersonaLock` in `waker.ts`; separate state helpers in the hook and Codex driver) | `reentry-state.ts` | One on-disk shape per persona, one lock. |

Stays adapter-specific: `hasLiveSession` and directed-work observation
(`waker.ts`), rollout classification (`codex-reentry.ts`), `minRunIntervalMs`
(a spawn-only guard).

### 4. Identity

The supervisor does not invent personas. It passes the persona it was given to
the child through `SQUAD_PERSONA` (as `waker.ts` already does) and, once #229
lands, relies on `squad join --as <runtime>-<model>` for unique identity and
catch-up of shell-only agents; `squad agent <runtime>` defaults `--persona` to
that same `<runtime>-<model>` form. Until #229 merges, the existing
`--persona` flag and `SQUAD_PERSONA` env keep working, so the implementation
children that touch identity depend on #229. The resume prompt moves from the
old `squad_check` loop wording to the `/squad:wait` wording when #228 lands.

### 5. Migration of existing installs

Nothing breaks and nothing needs re-running:

- `install.sh --reentry`: hook file and `.claude/settings.json` entry unchanged.
- `install.sh --waker`: unit unchanged; it keeps running `squad waker --follow`.
- `squad codex-reentry` becomes an alias of `squad agent codex` (same flags),
  with a one-line deprecation note on stderr after one release.
- State: `.squad/reentry/<persona>.json` and `.squad/waker/<persona>.json` stay
  readable. The consolidation in decision 3 reads both and writes the shared
  shape; `SQUAD_REENTRY_TTL_MINUTES` / `SQUAD_REENTRY_MAX_ATTEMPTS` and the
  stop files (`.squad/reentry-stop`, `.squad/reentry/<persona>.stop`) keep their
  names.
- `wake_handles` table: unchanged columns; only the allowed `runtime` values
  grow. It sits outside `ROOM_TABLES`, so `SCHEMA_VERSION` does not move.

### 6. Verdict per existing piece

| Piece | Verdict |
|---|---|
| Claude Stop hook (`reentry-hook.ts`) | **Keep as adapter.** In-place keep-alive; policy via `decide()`. Gains shared state helpers. |
| `codex-reentry` | **Keep as adapter**, becoming `squad agent codex`; its loop becomes the generic supervisor loop. Old name stays as an alias. |
| Waker (`waker.ts`) | **Keep as adapter** for the "no live session" case. Becomes runtime-generic through `resolveWakeCommand`. Not retired: nothing else wakes a persona with no process. |

## Child issues

Filed under #230 with `loom:triage`; each is sized to the 2-3 point band and
lists its dependency on #227/#228/#229 where it has one.

1. #232 Consolidate shared re-entry policy and state (decision 3): no dependency.
2. #233 Add `opencode` to wake handles (`WakeRuntime`, `resolveWakeCommand`,
   `wake-handle set`): depends on #227.
3. #234 Extract the runtime adapter interface and add `squad agent <runtime>` with
   Codex as the first adapter, `codex-reentry` as alias: depends on #229, #228.
4. #236 Claude adapter for `squad agent claude` (headless `claude -p` / `--resume`):
   depends on #228, #229.
5. #238 opencode adapter for `squad agent opencode`, including verifying the
   commands marked unverified above: depends on #227, #229.
6. #239 Migration and `squad doctor`/README updates (alias deprecation note, doctor
   reports adapter state): depends on children 3-5.
