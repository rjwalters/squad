/**
 * Codex-side re-entry: the supervisor's **pure decision logic plus its
 * dependency-injected control loop**. All I/O (spawning `codex`, reading
 * `~/.codex/sessions/<date>/rollout-<id>.jsonl`, the room database, the state
 * file) is injected via `SuperviseDeps`, so the loop is testable without a real
 * Codex install — see `tests/codex-reentry.test.mjs`. The real wiring lives
 * in `codex-reentry-driver.ts`, exactly as `reentry.ts` (pure) /
 * `reentry-hook.ts` (glue) split the Claude Code side.
 *
 * ## Why a per-session supervisor and not a hook (#60)
 *
 * A Codex persona running `/squad-join` ends its turn on a `task_complete`
 * event and nothing restarts it: the process stays alive at ~0% CPU,
 * present but mute, until an operator re-invokes it. Three room outages in
 * one day traced to this — one ~5 hours, one leaving 410 theorems
 * unverified for 4 hours.
 *
 * Claude Code's fix (`install.sh --reentry`) is a `Stop` hook. **Codex has
 * no end-of-turn hook to mirror it with.** Verified against the pinned
 * schema this repo's tooling targets (Codex 0.146.0): the only hook event
 * available is `pre_tool_use`, and there is no `codex hooks` subcommand at
 * all. So there is nothing to hang an end-of-turn adapter on, and this
 * mechanism deliberately assumes no hook primitive whatsoever.
 *
 * What it assumes instead is the one thing Codex *does* guarantee: a
 * non-interactive `codex exec` run is a **process that exits** when the turn
 * completes. That turns "the turn ended" — undetectable from inside an
 * interactive TUI session — into an ordinary wait-for-child. The supervisor
 * is therefore a wrapper loop, started by the operator in the same terminal
 * where they would otherwise have typed `codex`:
 *
 *     squad codex-reentry          # instead of: codex  → /squad-join
 *
 * ### Not a shared daemon (the cascade criterion)
 *
 * The observed failure mode is a *cascade*: personas park within ~90s of
 * each other as the room goes quiet, so a recovery mechanism whose own death
 * silently disarms every persona at once would reproduce exactly the outage
 * it is meant to prevent. This supervisor is **one process per persona**,
 * running in that persona's own foreground terminal:
 *
 * - There is no shared daemon, no pid file, no cross-persona state. Two
 *   supervisors in one room share nothing but the room database itself.
 * - Its own death is loud, not silent: it is the foreground process of an
 *   operator's terminal, so it dying returns that terminal to a shell
 *   prompt. There is no "who watches the watcher" gap because the watcher is
 *   not hidden.
 * - When it stops for a bounded reason (TTL, attempt cap, operator-stop) it
 *   says so **in the room** (`parkAnnouncement`), so peers learn the persona
 *   is gone-for-good from the chat log rather than by reading session logs.
 *
 * ### Bounds (mirrors src/reentry.ts, deliberately)
 *
 * Re-entry policy is not reimplemented here: the wait between runs is
 * `reentry.ts`'s `decide()`, so backoff, jitter, the TTL, the operator-stop
 * escape hatch, and the directed-work reset behave identically on both
 * sides. On top of that, because each Codex re-entry is a *process spawn*
 * rather than a turn of an already-running session, two extra guards keep a
 * broken `codex` binary from spinning:
 *
 * - `maxAttempts` (`SQUAD_REENTRY_MAX_ATTEMPTS`, default 48) — a hard
 *   ceiling on fired re-entries in one arm cycle, independent of wall-clock.
 * - `minRunIntervalMs` — a floor on the gap between two runs, and
 *   directed-work's immediate-reset is honored only when the *previous* run
 *   ended in a clean `task_complete`. A `codex` that dies instantly can
 *   therefore never be relaunched faster than the backoff schedule, even
 *   with an unread `@mention` sitting in the room.
 *
 * Note that a *persistently* unread `@mention` (one no re-entered session
 * ever consumes) keeps resetting the backoff, so `maxAttempts` never
 * advances and the TTL becomes the only remaining bound — bounded, but by
 * hours rather than by the cap. That is the same trade the Claude Code side
 * makes: directed work is supposed to win, and the floor above keeps the
 * worst case at one relaunch per `minRunIntervalMs` rather than a hot loop.
 */
import {
  DEFAULT_SLEEP_CAP_MS,
  decide,
  ttlExceeded,
  type BackoffParams,
  type ReentryState,
} from "./reentry.js";

/**
 * How a single `codex` run ended, as read back from its rollout log — the
 * ground truth the issue's diagnosis note names, because the presence table
 * only reports `stale`, which is indistinguishable from a crash.
 *
 * - `task_complete` — parked cleanly (the exact silent-park signature).
 * - `error` — the run failed; a different problem, and worth saying out loud.
 * - `unknown` — a terminal record that is neither.
 * - `missing` — no rollout record could be read at all (no `CODEX_HOME`
 *   sessions directory, an unreadable file, or a run that wrote nothing).
 */
export type RolloutOutcome = "task_complete" | "error" | "unknown" | "missing";

/**
 * Classify the tail of a rollout JSONL file: parse the last non-empty line
 * and look for a terminal event type.
 *
 * Codex has shipped more than one rollout line shape over time (a flat
 * `{"type":...}` record and an enveloped `{"type":"event_msg","payload":
 * {"type":...}}` one), so both are checked rather than pinning to whichever
 * the local install happens to write. Anything unrecognized degrades to
 * `unknown`/`missing` — never to a false `task_complete`, since that is the
 * one value the supervisor treats as "clean park, ordinary re-entry".
 */
export function classifyRolloutTail(text: string): RolloutOutcome {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return "missing";
  let parsed: unknown;
  try {
    parsed = JSON.parse(lines[lines.length - 1]!);
  } catch {
    return "missing";
  }
  if (typeof parsed !== "object" || parsed === null) return "missing";
  const record = parsed as Record<string, unknown>;
  const payload =
    typeof record.payload === "object" && record.payload !== null
      ? (record.payload as Record<string, unknown>)
      : {};
  const types = [record.type, payload.type, record.record_type].filter(
    (t): t is string => typeof t === "string",
  );
  if (types.length === 0) return "missing";
  if (types.includes("task_complete")) return "task_complete";
  if (types.some((t) => t.includes("error"))) return "error";
  return "unknown";
}

/**
 * Pick the rollout file a just-finished run most likely wrote: the
 * most-recently-modified candidate touched at or after the run started.
 * Pure so the fs walk (in the driver) stays trivially replaceable; returns
 * `null` when nothing qualifies, which the caller reads as `missing`.
 *
 * `sinceMs` is compared with a small negative tolerance because filesystem
 * mtime granularity can round a write that happened microseconds after the
 * recorded start down below it.
 */
export function pickLatestRollout(
  candidates: { path: string; mtimeMs: number }[],
  sinceMs: number,
  toleranceMs = 2000,
): string | null {
  let best: { path: string; mtimeMs: number } | null = null;
  for (const c of candidates) {
    if (c.mtimeMs < sinceMs - toleranceMs) continue;
    if (!best || c.mtimeMs > best.mtimeMs) best = c;
  }
  return best ? best.path : null;
}

/** How the next `codex` run is launched. */
export type RunMode = "fresh" | "resume";

/**
 * Compose the `codex` argv for a run.
 *
 * `exec` (not the interactive TUI) is the whole point: it is the mode that
 * *exits* at end of turn, which is what makes a wrapper loop possible at all
 * without a hook. `resume --last` is used only when the local binary
 * advertises it (the driver probes `codex exec resume --help` rather than
 * assuming a subcommand exists on the operator's version); otherwise every
 * run is a fresh session, which is correct if noisier — `squad_join` is
 * idempotent and returns recent history, so a fresh session re-enters the
 * room fully informed.
 */
export function buildCodexArgs(opts: {
  mode: RunMode;
  prompt: string;
  extraArgs?: readonly string[];
}): string[] {
  const extra = opts.extraArgs ? [...opts.extraArgs] : [];
  return opts.mode === "resume"
    ? ["exec", "resume", "--last", ...extra, opts.prompt]
    : ["exec", ...extra, opts.prompt];
}

/**
 * The pre-launch gate, checked before the *first* run and (via `decide()`)
 * before every subsequent one. Returns a human-readable reason to refuse to
 * launch, or `null` to proceed. Same precedence as `decide()`:
 * operator-stop, then TTL, then the attempt cap.
 */
export function preLaunchStop(opts: {
  state: ReentryState;
  nowMs: number;
  ttlMinutes: number;
  maxAttempts: number;
  operatorStopped: boolean;
}): string | null {
  if (opts.operatorStopped) return "operator stop requested";
  if (ttlExceeded(opts.state.firstArmedAt, opts.ttlMinutes, opts.nowMs)) {
    return `TTL of ${opts.ttlMinutes}m exceeded since ${opts.state.firstArmedAt}`;
  }
  if (opts.maxAttempts > 0 && opts.state.attempt >= opts.maxAttempts) {
    return `attempt cap of ${opts.maxAttempts} reached (${opts.state.attempt} re-entries since ${opts.state.firstArmedAt})`;
  }
  return null;
}

/** Default floor between two `codex` runs. See the module doc's "Bounds". */
export const DEFAULT_MIN_RUN_INTERVAL_MS = 10_000;

/** The prompt used for a fresh session when no `squad-join` prompt file is found. */
export const FALLBACK_JOIN_PROMPT = "/squad-join";

/** The nudge used to resume an existing session rather than re-reading the whole join prompt. */
export function resumePrompt(persona: string): string {
  return (
    `You are ${persona} in the squad room and your previous turn ended. ` +
    `Resume the /squad-join conversation loop: call squad_check with wait_seconds: 25, ` +
    `respond to anything addressed to you, do the work a claimed goal calls for, and keep looping. ` +
    `Do not call squad_leave unless you are genuinely done.`
  );
}

export interface SuperviseConfig {
  persona: string;
  ttlMinutes: number;
  maxAttempts: number;
  /** Prompt for a fresh (non-resumed) session — normally the `/squad-join` prompt text. */
  joinPrompt: string;
  /** Prompt for a resumed session. */
  reentryPrompt: string;
  /** Extra args passed through to `codex exec` (everything after `--` on the CLI). */
  extraArgs: readonly string[];
  backoff?: BackoffParams;
  /** Per-slice sleep cap: how often the escape hatches are re-checked while waiting. */
  sleepCapMs?: number;
  minRunIntervalMs?: number;
}

export interface SuperviseDeps {
  /** Launch `codex` with `args`; resolve with its exit code (null if signalled). */
  runCodex(args: string[]): Promise<number | null>;
  /** Read back how the run that started at `startedAtMs` ended. */
  classifyRun(startedAtMs: number): Promise<RolloutOutcome>;
  /** True when the local `codex` supports `exec resume`. Probed once, cached by the driver. */
  resumeSupported(): Promise<boolean>;
  now(): number;
  sleep(ms: number): Promise<void>;
  loadState(): ReentryState;
  saveState(state: ReentryState): void;
  /** Re-read on every check — an operator must be able to quiet a live supervisor. */
  operatorStopped(): boolean;
  hasDirectedWork(): Promise<boolean>;
  /** Post to the room (system message). Best-effort; must not throw. */
  announce(body: string): void;
  /** Operator-facing progress line on the supervisor's own terminal. */
  log(line: string): void;
}

export interface SuperviseSummary {
  /** How many `codex` runs were launched (the first launch included). */
  runs: number;
  /** Fired re-entries recorded in the persisted state at exit. */
  attempts: number;
  stopReason: string;
  outcomes: RolloutOutcome[];
}

export function startAnnouncement(cfg: SuperviseConfig): string {
  return (
    `${cfg.persona} is running under the squad codex re-entry supervisor: if its turn ends while ` +
    `the room is quiet it will re-enter itself (backoff, resets on an @mention). Bounded by a ` +
    `${cfg.ttlMinutes}m TTL and ${cfg.maxAttempts} re-entries — it will post here when it stops ` +
    `for good, so a silent gap means a crash, not a park.`
  );
}

export function parkAnnouncement(opts: {
  persona: string;
  reason: string;
  runs: number;
  attempts: number;
}): string {
  return (
    `${opts.persona}'s codex re-entry supervisor is stopping after ${opts.runs} run(s) / ` +
    `${opts.attempts} re-entry(ies): ${opts.reason}. ${opts.persona} will NOT return without an ` +
    `operator restarting it (\`squad codex-reentry\`). Do not wait on it.`
  );
}

export function crashAnnouncement(opts: {
  persona: string;
  run: number;
  exitCode: number | null;
  outcome: RolloutOutcome;
}): string {
  return (
    `${opts.persona}'s codex run #${opts.run} ended abnormally (exit ${opts.exitCode ?? "signal"}, ` +
    `session log: ${opts.outcome}) — this is a failure, not a clean park. The supervisor will ` +
    `retry with backoff.`
  );
}

/** True when a run ended the way a *park* ends rather than the way a failure ends. */
export function isCleanPark(outcome: RolloutOutcome, exitCode: number | null): boolean {
  if (exitCode !== 0) return false;
  // A clean exit with no readable rollout record is still a clean exit: treat
  // it as a park rather than crying crash on every install whose session logs
  // live somewhere this process cannot read.
  return outcome === "task_complete" || outcome === "missing" || outcome === "unknown";
}

interface WaitResult {
  reenter: boolean;
  reason: string;
  state: ReentryState;
}

/**
 * Wait out the inter-run interval, re-checking the escape hatches every
 * `sleepCapMs` slice. The policy itself is `reentry.ts`'s `decide()` — this
 * only drives it, sleeps, and persists the state it hands back, so the two
 * re-entry adapters can never disagree about backoff, TTL, or operator-stop.
 */
async function waitForReentry(
  cfg: SuperviseConfig,
  deps: SuperviseDeps,
  initial: ReentryState,
  honorDirectedWork: boolean,
): Promise<WaitResult> {
  let state = initial;
  const floor = cfg.minRunIntervalMs ?? DEFAULT_MIN_RUN_INTERVAL_MS;
  const sleepCapMs = cfg.sleepCapMs ?? DEFAULT_SLEEP_CAP_MS;
  const startedWaitingAt = deps.now();

  for (;;) {
    // Inter-run floor, enforced *before* consulting `decide()` so it acts as
    // a lead-in delay rather than a post-decision re-loop (which would spend
    // an extra backoff window and double-count the attempt). Without it a
    // directed-work reset could relaunch a broken `codex` in a tight loop.
    const elapsed = deps.now() - startedWaitingAt;
    if (elapsed < floor) {
      await deps.sleep(Math.min(floor - elapsed, sleepCapMs));
      continue;
    }

    let directed = false;
    if (honorDirectedWork) {
      try {
        directed = await deps.hasDirectedWork();
      } catch {
        directed = false; // room unreachable — treat as quiet rather than throwing
      }
    }

    const result = decide({
      state,
      nowMs: deps.now(),
      hasDirectedWork: directed,
      operatorStopped: deps.operatorStopped(),
      ttlMinutes: cfg.ttlMinutes,
      maxAttempts: cfg.maxAttempts,
      backoff: cfg.backoff,
      sleepCapMs,
    });
    state = result.nextState;
    deps.saveState(state);

    if (!result.block) return { reenter: false, reason: result.reason, state };

    if (result.sleepMs > 0) {
      await deps.sleep(result.sleepMs);
      continue;
    }

    return { reenter: true, reason: result.reason, state };
  }
}

/**
 * The supervisor loop. Launches `codex exec`, waits for it to exit (that
 * exit *is* the end-of-turn signal Codex gives no hook for), classifies how
 * it ended from the rollout log, then either re-enters after a bounded wait
 * or stops loudly.
 */
export async function supervise(
  cfg: SuperviseConfig,
  deps: SuperviseDeps,
): Promise<SuperviseSummary> {
  let state = deps.loadState();
  const outcomes: RolloutOutcome[] = [];
  let runs = 0;

  const blocked = preLaunchStop({
    state,
    nowMs: deps.now(),
    ttlMinutes: cfg.ttlMinutes,
    maxAttempts: cfg.maxAttempts,
    operatorStopped: deps.operatorStopped(),
  });
  if (blocked) {
    deps.log(`not launching: ${blocked}`);
    return { runs: 0, attempts: state.attempt, stopReason: blocked, outcomes };
  }

  deps.announce(startAnnouncement(cfg));

  for (;;) {
    const mode: RunMode = runs === 0 || !(await deps.resumeSupported()) ? "fresh" : "resume";
    const prompt = mode === "resume" ? cfg.reentryPrompt : cfg.joinPrompt;
    const startedAt = deps.now();

    deps.log(`launching codex (${mode}), run ${runs + 1}`);
    const exitCode = await deps.runCodex(
      buildCodexArgs({ mode, prompt, extraArgs: cfg.extraArgs }),
    );
    runs++;

    const outcome = await deps.classifyRun(startedAt);
    outcomes.push(outcome);
    const clean = isCleanPark(outcome, exitCode);
    deps.log(`run ${runs} exited ${exitCode ?? "on a signal"} — session log: ${outcome}`);
    if (!clean) {
      deps.announce(crashAnnouncement({ persona: cfg.persona, run: runs, exitCode, outcome }));
    }

    const waited = await waitForReentry(cfg, deps, state, clean);
    state = waited.state;
    if (!waited.reenter) {
      deps.log(`stopping: ${waited.reason}`);
      deps.announce(
        parkAnnouncement({
          persona: cfg.persona,
          reason: waited.reason,
          runs,
          attempts: state.attempt,
        }),
      );
      return { runs, attempts: state.attempt, stopReason: waited.reason, outcomes };
    }
  }
}
