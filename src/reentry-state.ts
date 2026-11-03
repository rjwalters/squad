/**
 * Shared persistence and escape-hatch plumbing for **both** re-entry
 * adapters — the Claude Code `Stop` hook (`reentry-hook.ts`) and the Codex
 * supervisor (`codex-reentry.ts` / `codex-reentry-driver.ts`).
 *
 * Extracted so the two adapters cannot drift on the things an operator has
 * to reason about under pressure: *where the state lives* and *how you make
 * it stop*. An operator who has learned `touch .squad/reentry-stop` for
 * Claude must not discover that Codex spells it differently.
 *
 * State is keyed per-persona (`<squadDir>/reentry/<persona>.json`), so a
 * `claude` Stop hook and a `codex` supervisor in the same room keep separate
 * backoff/TTL clocks with no coordination and no shared file.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initialState, type ReentryState } from "./reentry.js";

/**
 * Operator-stop escape hatch. Checked before anything else in `decide()`.
 * Two forms, either sufficient: `SQUAD_REENTRY_STOP=1` (or `true`/`yes`) in
 * the environment, or a marker file the operator can `touch`/`rm` without
 * touching any config — a room-wide `<squadDir>/reentry-stop`, or a
 * persona-scoped `<squadDir>/reentry/<persona>.stop` to pause only one
 * persona's re-entry.
 */
export function operatorStopped(squadDir: string, persona: string): boolean {
  switch ((process.env.SQUAD_REENTRY_STOP ?? "").toLowerCase()) {
    case "1":
    case "true":
    case "yes":
      return true;
  }
  if (existsSync(join(squadDir, "reentry-stop"))) return true;
  if (existsSync(join(squadDir, "reentry", `${persona}.stop`))) return true;
  return false;
}

/** Per-persona state lives under `<squadDir>/<subdir>/`; the Stop hook and Codex use `reentry`, the waker `waker`. */
export type StateSubdir = "reentry" | "waker";

export function stateFile(squadDir: string, persona: string, subdir: StateSubdir = "reentry"): string {
  return join(squadDir, subdir, `${persona}.json`);
}

export function loadState<T extends ReentryState = ReentryState>(
  squadDir: string,
  persona: string,
  nowIso: string,
  subdir: StateSubdir = "reentry",
): T {
  try {
    const raw = readFileSync(stateFile(squadDir, persona, subdir), "utf8");
    const parsed = JSON.parse(raw) as Partial<T>;
    if (
      typeof parsed.attempt === "number" &&
      typeof parsed.firstArmedAt === "string" &&
      (parsed.nextFireAt === null || typeof parsed.nextFireAt === "string") &&
      (parsed.lastFiredAt === null || typeof parsed.lastFiredAt === "string")
    ) {
      return { ...parsed, totalFired: parsed.totalFired ?? parsed.attempt } as T;
    }
  } catch {
    // Missing or corrupt — start a fresh arm cycle below.
  }
  return initialState(nowIso) as T;
}

export function saveState<T extends ReentryState = ReentryState>(
  squadDir: string,
  persona: string,
  state: T,
  subdir: StateSubdir = "reentry",
): void {
  mkdirSync(join(squadDir, subdir), { recursive: true });
  writeFileSync(stateFile(squadDir, persona, subdir), JSON.stringify(state, null, 2) + "\n");
}

/** A lock older than this is presumed orphaned by a crashed holder and taken over. */
export const LOCK_STALE_MS = 60_000;

/**
 * Serialises concurrent processes on one persona (`<squadDir>/<subdir>/<persona>.lock`).
 * Resolves `null` without running `fn` when another holder has the lock; a lock
 * older than `LOCK_STALE_MS` is taken over. Released in `finally`.
 */
export function withPersonaLock<T>(
  squadDir: string,
  persona: string,
  nowMs: number,
  fn: () => Promise<T>,
  subdir: StateSubdir = "waker",
): Promise<T | null> {
  const lock = join(squadDir, subdir, `${persona}.lock`);
  mkdirSync(join(squadDir, subdir), { recursive: true });
  const acquire = (): boolean => {
    try {
      writeFileSync(lock, String(nowMs), { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  };
  if (!acquire()) {
    let ageMs = 0;
    try {
      ageMs = Date.now() - statSync(lock).mtimeMs;
    } catch {
      /* vanished: retry below */
    }
    if (ageMs < LOCK_STALE_MS) return Promise.resolve(null);
    rmSync(lock, { force: true });
    if (!acquire()) return Promise.resolve(null);
  }
  return fn().finally(() => rmSync(lock, { force: true }));
}

/** Persist before publishing: at most one attempt per arm cycle, including retries.
 * If the room write fails, the adapter's terminal remains the stop signal.
 */
export function announceStopOnce(state: ReentryState, save: (s: ReentryState) => void,
  announce: (body: string) => void, body: string, reason = body): ReentryState {
  if (state.stopAnnounced) return state;
  const next = { ...state, stopAnnounced: true, stoppedReason: reason };
  save(next);
  announce(body);
  return next;
}
