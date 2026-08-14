/**
 * Pure decision logic for the opt-in runtime re-entry adapter (installed by
 * `install.sh --reentry`, driven by `reentry-hook.ts` from a Claude Code
 * `Stop` hook). Everything here is a pure function of its inputs (no fs, no
 * clock reads, no randomness unless injected) so it is unit-testable without
 * simulating the actual hook invocation protocol — see
 * `tests/reentry-hook.test.mjs`.
 *
 * Design (documented here since there is no prior precedent for
 * backoff/jitter in this codebase):
 *
 * - **Backoff**: exponential (`baseMs * multiplier^attempt`, capped at
 *   `capMs`) with a symmetric jitter fraction applied on top
 *   (`interval * (1 ± jitterFraction)`), a standard "full exponential +
 *   proportional jitter" shape. Defaults: 30s base, x2 multiplier, 30min cap,
 *   ±20% jitter.
 * - **Chained, capped sleeps**: a single backoff "window" can be much longer
 *   than any one hook invocation should synchronously block for, so a window
 *   is walked across possibly-many `Stop` hook invocations, each sleeping at
 *   most `sleepCapMs` (default 45s) before re-checking the operator-stop and
 *   TTL escape hatches. This bounds how long a runaway condition can go
 *   unnoticed to `sleepCapMs`, not the full backoff interval.
 * - **Directed work resets the window immediately** (`attempt` back to 0,
 *   the window cleared, zero additional sleep) — a peer's mention should not
 *   wait out a possibly-30-minute backoff.
 * - **TTL and operator-stop are checked first, every invocation, and both
 *   override directed work** — a session must never be held open by chatter
 *   alone once its budget is spent or the operator asked it to stop.
 */

/** Exponential-backoff-with-jitter parameters. See module doc for the shape. */
export interface BackoffParams {
  baseMs: number;
  multiplier: number;
  capMs: number;
  /** Symmetric jitter as a fraction of the raw (pre-jitter) interval, e.g. 0.2 = +-20%. */
  jitterFraction: number;
}

export const DEFAULT_BACKOFF: BackoffParams = {
  baseMs: 30_000,
  multiplier: 2,
  capMs: 30 * 60_000,
  jitterFraction: 0.2,
};

/** Per-invocation sleep cap: bounds how long one hook call blocks. See module doc. */
export const DEFAULT_SLEEP_CAP_MS = 45_000;

/** `SQUAD_REENTRY_TTL_MINUTES` default — see README.md "Re-entry (opt-in)". */
export const DEFAULT_REENTRY_TTL_MINUTES = 240;

/**
 * The raw (pre-jitter) exponential interval for `attempt` (0-indexed: the
 * Nth time a backoff window has been *started* since the last reset),
 * capped at `params.capMs`.
 */
export function rawIntervalMs(attempt: number, params: BackoffParams = DEFAULT_BACKOFF): number {
  const n = Math.max(0, attempt);
  return Math.min(params.capMs, params.baseMs * Math.pow(params.multiplier, n));
}

/**
 * The jittered interval for `attempt`. `rand` must return a value in
 * `[0, 1)` (defaults to `Math.random`; tests inject a fixed value for
 * deterministic bounds checks). Never negative.
 */
export function backoffIntervalMs(
  attempt: number,
  params: BackoffParams = DEFAULT_BACKOFF,
  rand: () => number = Math.random,
): number {
  const raw = rawIntervalMs(attempt, params);
  const jitter = raw * params.jitterFraction * (rand() * 2 - 1);
  return Math.max(0, Math.round(raw + jitter));
}

/**
 * True once `ttlMinutes` have elapsed since `firstArmedAt` (ISO timestamp).
 * `ttlMinutes <= 0` is treated as "always exceeded" — an explicit way to
 * disable re-entry without removing the hook.
 */
export function ttlExceeded(firstArmedAt: string, ttlMinutes: number, nowMs: number): boolean {
  if (ttlMinutes <= 0) return true;
  const armed = Date.parse(firstArmedAt);
  if (Number.isNaN(armed)) return true; // corrupt state — fail toward allowing the stop
  return nowMs - armed >= ttlMinutes * 60_000;
}

/** Persisted per-persona-per-room state. Survives across hook invocations (a fresh process each time). */
export interface ReentryState {
  /** Number of backoff windows *fired* (real re-entries) since the last directed-work reset. */
  attempt: number;
  /** ISO timestamp: when this arm cycle's TTL clock started. Never changes once set. */
  firstArmedAt: string;
  /** ISO timestamp the current backoff window ends, or null if no window is in progress. */
  nextFireAt: string | null;
  /** ISO timestamp of the last real re-entry (diagnostics only, not read by `decide`). */
  lastFiredAt: string | null;
}

export function initialState(nowIso: string): ReentryState {
  return { attempt: 0, firstArmedAt: nowIso, nextFireAt: null, lastFiredAt: null };
}

export interface DecideInput {
  state: ReentryState;
  nowMs: number;
  /** True when an unread message directed at this persona (e.g. an @mention) is pending. */
  hasDirectedWork: boolean;
  /** True when the operator's escape hatch (env var or marker file) is set. */
  operatorStopped: boolean;
  ttlMinutes: number;
  backoff?: BackoffParams;
  rand?: () => number;
  sleepCapMs?: number;
}

export interface DecideResult {
  /** Whether the hook should block-and-continue (re-enter) rather than allow the stop. */
  block: boolean;
  /** How long the hook driver should sleep before emitting this decision (already capped). */
  sleepMs: number;
  reason: string;
  nextState: ReentryState;
}

/**
 * The single decision point, called once per `Stop` hook invocation (after
 * the caller has already handled Claude Code's own `stop_hook_active`
 * same-turn loop guard — see `reentry-hook.ts`).
 *
 * Precedence, each checked before the next: operator-stop, then TTL, then
 * directed work, then the ordinary quiet/backoff path. Operator-stop and TTL
 * both unconditionally allow the stop — neither directed work nor an
 * in-progress backoff window can override them.
 */
export function decide(input: DecideInput): DecideResult {
  const { state, nowMs, hasDirectedWork, operatorStopped, ttlMinutes } = input;
  const backoff = input.backoff ?? DEFAULT_BACKOFF;
  const rand = input.rand ?? Math.random;
  const sleepCapMs = input.sleepCapMs ?? DEFAULT_SLEEP_CAP_MS;

  if (operatorStopped) {
    return { block: false, sleepMs: 0, reason: "operator stop requested", nextState: state };
  }

  if (ttlExceeded(state.firstArmedAt, ttlMinutes, nowMs)) {
    return {
      block: false,
      sleepMs: 0,
      reason: `TTL of ${ttlMinutes}m exceeded since ${state.firstArmedAt}`,
      nextState: state,
    };
  }

  if (hasDirectedWork) {
    const nextState: ReentryState = {
      ...state,
      attempt: 0,
      nextFireAt: null,
      lastFiredAt: new Date(nowMs).toISOString(),
    };
    return {
      block: true,
      sleepMs: 0,
      reason: "directed work pending — re-entering immediately, backoff reset",
      nextState,
    };
  }

  // Quiet: no window in progress yet — start one.
  if (!state.nextFireAt) {
    const interval = backoffIntervalMs(state.attempt, backoff, rand);
    const nextFireAt = new Date(nowMs + interval).toISOString();
    return {
      block: true,
      sleepMs: Math.min(interval, sleepCapMs),
      reason: `quiet — starting backoff window of ${interval}ms (attempt ${state.attempt + 1})`,
      nextState: { ...state, nextFireAt },
    };
  }

  // Quiet, window in progress: fire if it has elapsed, otherwise keep waiting
  // (capped) without disturbing the window or the attempt counter.
  const remaining = Date.parse(state.nextFireAt) - nowMs;
  if (remaining <= 0) {
    const nextState: ReentryState = {
      ...state,
      attempt: state.attempt + 1,
      nextFireAt: null,
      lastFiredAt: new Date(nowMs).toISOString(),
    };
    return {
      block: true,
      sleepMs: 0,
      reason: `backoff window elapsed — re-entering (attempt ${nextState.attempt})`,
      nextState,
    };
  }
  return {
    block: true,
    sleepMs: Math.min(remaining, sleepCapMs),
    reason: `quiet — waiting out backoff window, ${remaining}ms remaining (attempt ${state.attempt + 1})`,
    nextState: state,
  };
}

/** `@name` mention detection for the v1 "directed work" heuristic — see reentry-hook.ts. */
export function mentionsPersona(body: string, persona: string): boolean {
  const escaped = persona.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w@])@${escaped}\\b`, "i").test(body);
}
