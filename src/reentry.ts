/** Shared pure wake policy. Runtime adapters supply observations, time and randomness.
 * Normal windows target five minutes with claims and 30–45 minutes idle.
 * Failure backoff, operator stop, TTL and lifetime re-entry limits take precedence.
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

/** Default lifetime policy-fire cap per arm cycle, shared by both adapters.
 * Claude's intermediate waiting blocks are not policy fires; TTL also bounds them.
 */
export const DEFAULT_REENTRY_MAX_ATTEMPTS = 48;

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

export interface WakeParams {
  claimMs: number;
  idleMinMs: number;
  idleMaxMs: number;
}
export const DEFAULT_WAKE: WakeParams = {
  claimMs: 5 * 60_000, idleMinMs: 30 * 60_000, idleMaxMs: 45 * 60_000,
};
export function wakeIntervalMs(held: boolean, params = DEFAULT_WAKE, rand = Math.random): number {
  return held ? params.claimMs : Math.round(params.idleMinMs + rand() * (params.idleMaxMs - params.idleMinMs));
}

/** Persisted per-persona-per-room state. Survives across hook invocations (a fresh process each time). */
export interface ReentryState {
  /** Consecutive failure retry windows fired; reset by a successful wake. */
  attempt: number;
  /** Monotonic fired re-entries; legacy state migrates from attempt (a lower bound). */
  totalFired?: number;
  stopAnnounced?: boolean;
  stoppedReason?: string;
  windowKind?: "claim" | "idle" | "failure";
  /** ISO timestamp: when this arm cycle's TTL clock started. Never changes once set. */
  firstArmedAt: string;
  /** ISO timestamp the current backoff window ends, or null if no window is in progress. */
  nextFireAt: string | null;
  /** ISO timestamp of the last real re-entry (diagnostics only, not read by `decide`). */
  lastFiredAt: string | null;
}

export function initialState(nowIso: string): ReentryState {
  return { totalFired: 0, attempt: 0, firstArmedAt: nowIso, nextFireAt: null, lastFiredAt: null };
}

export interface DecideInput {
  state: ReentryState;
  nowMs: number;
  /** True when an unread message directed at this persona (e.g. an @mention) is pending. */
  hasDirectedWork: boolean;
  hasHeldClaims?: boolean;
  /** A failed prior run must finish its delay even if directed work is pending. */
  failureBackoff?: boolean;
  wake?: WakeParams;
  /** True when the operator's escape hatch (env var or marker file) is set. */
  operatorStopped: boolean;
  ttlMinutes: number;
  /** Hard cap on totalFired in this arm cycle; <= 0 disables it. */
  maxAttempts?: number;
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
 * the attempt cap, then failure delay, then directed work, then claims/idle.
 * Operator-stop, TTL, and the attempt cap all unconditionally allow the
 * stop — neither directed work nor an in-progress backoff window can
 * override them.
 */
export function decide(input: DecideInput): DecideResult {
  const { state, nowMs, hasDirectedWork, operatorStopped, ttlMinutes } = input;
  const totalFired = state.totalFired ?? state.attempt;
  const backoff = input.backoff ?? DEFAULT_BACKOFF;
  const rand = input.rand ?? Math.random;
  const sleepCapMs = Math.max(0, Math.min(input.sleepCapMs ?? DEFAULT_SLEEP_CAP_MS,
    Date.parse(state.firstArmedAt) + ttlMinutes * 60_000 - nowMs));

  if (operatorStopped) {
    return { block: false, sleepMs: 0, reason: "operator stop requested", nextState: state };
  }

  if (state.stoppedReason) {
    return { block: false, sleepMs: 0, reason: state.stoppedReason, nextState: state };
  }

  if (ttlExceeded(state.firstArmedAt, ttlMinutes, nowMs)) {
    return {
      block: false,
      sleepMs: 0,
      reason: `TTL of ${ttlMinutes}m exceeded since ${state.firstArmedAt}`,
      nextState: state,
    };
  }

  const maxAttempts = input.maxAttempts ?? 0;
  if (maxAttempts > 0 && totalFired >= maxAttempts) {
    return {
      block: false,
      sleepMs: 0,
      reason: `attempt cap of ${maxAttempts} reached (${totalFired} re-entries since ${state.firstArmedAt})`,
      nextState: state,
    };
  }

  if (hasDirectedWork && !input.failureBackoff) {
    const nextState: ReentryState = {
      ...state,
      attempt: 0,
      totalFired: totalFired + 1,
      nextFireAt: null,
      lastFiredAt: new Date(nowMs).toISOString(),
    };
    return {
      block: true,
      sleepMs: 0,
      reason: "directed work pending — re-entering immediately, idle window reset",
      nextState,
    };
  }

  const kind = input.failureBackoff ? "failure" : input.hasHeldClaims ? "claim" : "idle";
  // Reclassify on claim acquisition/release. Never resample jitter on a polling slice.
  if (!state.nextFireAt || (state.windowKind && state.windowKind !== kind)) {
    const interval = input.failureBackoff
      ? backoffIntervalMs(state.attempt, backoff, rand)
      : wakeIntervalMs(Boolean(input.hasHeldClaims), input.wake, rand);
    // Claim acquisition may shorten idle waiting, but must not postpone a
    // heartbeat already due sooner. Failure transitions always get their delay.
    const deadline = kind === "claim" && state.windowKind === "idle" && state.nextFireAt
      ? Math.min(Date.parse(state.nextFireAt), nowMs + interval) : nowMs + interval;
    if (deadline <= nowMs) {
      return { block: true, sleepMs: 0, reason: `${kind} wake due — re-entering`,
        nextState: { ...state, totalFired: totalFired + 1,
          attempt: input.failureBackoff ? state.attempt + 1 : 0,
          nextFireAt: null, windowKind: kind, lastFiredAt: new Date(nowMs).toISOString() } };
    }
    const nextFireAt = new Date(deadline).toISOString();
    return {
      block: true,
      sleepMs: Math.max(0, Math.min(deadline - nowMs, sleepCapMs)),
      reason: `${kind} — starting wake window of ${interval}ms (attempt ${state.attempt + 1})`,
      nextState: { ...state, nextFireAt, windowKind: kind },
    };
  }

  // Quiet, window in progress: fire if it has elapsed, otherwise keep waiting
  // (capped) without disturbing the window or the attempt counter.
  const remaining = Date.parse(state.nextFireAt) - nowMs;
  if (remaining <= 0) {
    const nextState: ReentryState = {
      ...state,
      attempt: input.failureBackoff ? state.attempt + 1 : 0,
      totalFired: totalFired + 1,
      nextFireAt: null,
      lastFiredAt: new Date(nowMs).toISOString(),
    };
    return {
      block: true,
      sleepMs: 0,
      reason: `wake window elapsed — re-entering (attempt ${nextState.attempt})`,
      nextState,
    };
  }
  return {
    block: true,
    sleepMs: Math.min(remaining, sleepCapMs),
    reason: `${kind} — waiting out wake window, ${remaining}ms remaining (attempt ${state.attempt + 1})`,
    nextState: state,
  };
}

/** `@name` mention detection for the v1 "directed work" heuristic — see reentry-hook.ts. */
export function mentionsPersona(body: string, persona: string): boolean {
  const escaped = persona.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w@])@${escaped}\\b`, "i").test(body);
}
