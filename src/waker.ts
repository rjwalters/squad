import type { DatabaseSync } from "node:sqlite";
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { presenceState } from "./core.js";
import { envMinutes, squadDir } from "./db.js";
import {
  DEFAULT_REENTRY_MAX_ATTEMPTS,
  DEFAULT_REENTRY_TTL_MINUTES,
  decide,
  initialState,
  mentionsPersona,
  type ReentryState,
} from "./reentry.js";
import { operatorStopped } from "./reentry-state.js";
import { writeWakerHeartbeat } from "./waker-unit.js";
import { getWakeHandle, resolveWakeCommand, usableHere, type WakeHandle } from "./wake-handles.js";

/**
 * The opt-in waker (#174, phase 2 of #172): wakes a persona that has no live
 * session when it is directed work -- an `@mention` or a pending review
 * request -- by running its wake handle's resume argv (#173).
 *
 * Nothing runs unless an operator starts `squad waker`; the MCP server never
 * wakes anyone (it dies with the session, which is the case to fix). The
 * policy is `reentry.ts`'s `decide()` plus `reentry-state.ts`'s stop files,
 * not a second copy: operator stop, TTL, attempt cap and failure backoff all
 * come from there.
 *
 * Observation here is read-only SQL on purpose. `Squad.check()` /
 * `pendingReviews()` touch the caller's presence lease, and opening a `Squad`
 * as the persona being woken would make it look live and cancel its own wake.
 */

/** Sender of the waker's own room lines; its messages never count as directed work. */
export const WAKER_SENDER = "waker";

export const DEFAULT_WAKER_COOLDOWN_MINUTES = 10;
export const DEFAULT_WAKER_INTERVAL_MS = 15_000;
const LOCK_STALE_MS = 60_000;

export const WAKER_USAGE =
  "usage: squad waker [--once] | squad waker --follow [--interval <seconds>] | squad waker status";

export type WakerCommand =
  | { mode: "once" }
  | { mode: "follow"; intervalMs: number }
  | { mode: "status" }
  | { mode: "help" };

/** Parse `squad waker ...` arguments. Throws the usage string on anything else. */
export function parseWakerArgs(args: string[]): WakerCommand {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return { mode: "help" };
  if (args.length === 1 && args[0] === "status") return { mode: "status" };
  if (args.length === 0 || (args.length === 1 && args[0] === "--once")) return { mode: "once" };
  if (args[0] === "--follow") {
    if (args.length === 1) return { mode: "follow", intervalMs: DEFAULT_WAKER_INTERVAL_MS };
    if (args.length === 3 && args[1] === "--interval") {
      const seconds = Number(args[2]);
      if (Number.isFinite(seconds) && seconds > 0 && args[2]!.trim() !== "")
        return { mode: "follow", intervalMs: Math.round(seconds * 1000) };
    }
  }
  throw new Error(WAKER_USAGE);
}

export interface WakeProcess {
  pid: number | null;
}

export interface WakerDeps {
  /** Room directory (holds squad.db); stop files and waker state live under it. */
  squadDir: string;
  /** Launches the argv; rejects/throws when the process could not be started. Injected so tests launch nothing real. */
  spawn: (argv: string[], opts: { cwd: string | null; env: Record<string, string> }) => Promise<WakeProcess> | WakeProcess;
  /** Clock in epoch ms. */
  now: () => number;
  /** True while `pid` is a running process (an in-flight wake). */
  alive?: (pid: number) => boolean;
  host?: string;
  /** Short room name used in the wake prompt. */
  roomLabel?: string;
  cooldownMs: number;
  ttlMinutes: number;
  maxAttempts: number;
  rand?: () => number;
}

export function wakerDepsFromEnv(overrides: Partial<WakerDeps> = {}): WakerDeps {
  const dir = overrides.squadDir ?? squadDir();
  return {
    squadDir: dir,
    spawn: spawnDetached,
    now: Date.now,
    cooldownMs: envMinutes("SQUAD_WAKER_COOLDOWN_MINUTES", DEFAULT_WAKER_COOLDOWN_MINUTES) * 60_000,
    ttlMinutes: envMinutes("SQUAD_REENTRY_TTL_MINUTES", DEFAULT_REENTRY_TTL_MINUTES),
    maxAttempts: envMinutes("SQUAD_REENTRY_MAX_ATTEMPTS", DEFAULT_REENTRY_MAX_ATTEMPTS),
    ...overrides,
  };
}

/** The real spawner: detached, no stdio, survives the waker. Rejects on a launch error (e.g. ENOENT). */
export function spawnDetached(
  argv: string[],
  opts: { cwd: string | null; env: Record<string, string> },
): Promise<WakeProcess> {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn(argv[0]!, argv.slice(1), {
      cwd: opts.cwd && existsSync(opts.cwd) ? opts.cwd : undefined,
      env: { ...process.env, ...opts.env },
      detached: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve({ pid: child.pid ?? null });
    });
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Per-persona waker state: a re-entry arm cycle plus what was last woken for. */
export interface WakerState extends ReentryState {
  /** A spawn failed; the next wake waits out `decide()`'s failure backoff. */
  failing?: boolean;
  /** Highest directed message id already woken for. */
  wokenThrough?: number;
  /** Highest directed review request id already woken for. */
  wokenReview?: number;
  /** Pid of the last launched wake process, for the in-flight check. */
  wakePid?: number | null;
  /** The last skip reason posted to the room; an identical one is not re-posted. */
  lastSkip?: string | null;
  lastError?: string | null;
}

function wakerStatePath(dir: string, persona: string): string {
  return join(dir, "waker", `${persona}.json`);
}

function loadWakerState(dir: string, persona: string, nowIso: string): WakerState {
  try {
    const parsed = JSON.parse(readFileSync(wakerStatePath(dir, persona), "utf8")) as Partial<WakerState>;
    if (
      typeof parsed.attempt === "number" &&
      typeof parsed.firstArmedAt === "string" &&
      (parsed.nextFireAt === null || typeof parsed.nextFireAt === "string") &&
      (parsed.lastFiredAt === null || typeof parsed.lastFiredAt === "string")
    ) {
      return parsed as WakerState;
    }
  } catch {
    // Missing or corrupt -- start a fresh arm cycle.
  }
  return initialState(nowIso);
}

function saveWakerState(dir: string, persona: string, state: WakerState): void {
  mkdirSync(join(dir, "waker"), { recursive: true });
  writeFileSync(wakerStatePath(dir, persona), JSON.stringify(state, null, 2) + "\n");
}

/** Serialises concurrent wakers on one persona; a lock older than LOCK_STALE_MS is taken over. */
function withPersonaLock<T>(dir: string, persona: string, nowMs: number, fn: () => Promise<T>): Promise<T | null> {
  const lock = join(dir, "waker", `${persona}.lock`);
  mkdirSync(join(dir, "waker"), { recursive: true });
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

interface DirectedWork {
  /** Directed message ids (an @mention, or a reply to a review the persona filed). */
  messageIds: number[];
  /** Pending review requests targeted at the persona. */
  reviewIds: number[];
}

/** Whether the persona has any session that is not left and not stale. */
export function hasLiveSession(db: DatabaseSync, persona: string, nowMs: number): boolean {
  const rows = db
    .prepare("SELECT last_seen, lease_expires_at FROM sessions WHERE persona = ? AND left_ts IS NULL")
    .all(persona) as unknown as Array<{ last_seen: string; lease_expires_at: string }>;
  return rows.some((r) => presenceState(r.last_seen, r.lease_expires_at, nowMs) !== "stale");
}

/** The persona's read high-water mark across its durable cursor and any session cursors. */
function readCursor(db: DatabaseSync, persona: string): number {
  const row = db
    .prepare(
      `SELECT MAX(
                COALESCE((SELECT last_seen_id FROM cursors WHERE persona = ?), 0),
                COALESCE((SELECT MAX(sc.last_seen_id) FROM session_cursors sc
                            JOIN sessions s ON s.session_id = sc.session_id
                           WHERE s.persona = ?), 0)
              ) AS m`,
    )
    .get(persona, persona) as { m: number };
  return row.m;
}

/**
 * Non-consuming, non-touching directed-work observation, matching
 * `observeWakeWork`'s definition (`@persona` mention in an unread message, or
 * a pending review request) plus the departure hint: a message about a review
 * request the persona itself filed -- the answer to its ask -- counts too.
 * The waker's own lines are never directed work, or its "woke X for @X"
 * notice would wake X again.
 */
export function observeDirectedWork(db: DatabaseSync, persona: string, nowMs: number): DirectedWork {
  const cursor = readCursor(db, persona);
  const unread = db
    .prepare("SELECT id, body FROM messages WHERE id > ? AND sender != ? AND sender != ? ORDER BY id ASC")
    .all(cursor, persona, WAKER_SENDER) as unknown as Array<{ id: number; body: string }>;
  const filed = (
    db.prepare("SELECT id FROM review_requests WHERE requested_by = ?").all(persona) as unknown as Array<{ id: number }>
  ).map((r) => r.id);
  const replyTo = filed.length ? new RegExp(`\\breview #(?:${filed.join("|")})\\b`) : null;
  const messageIds = unread
    .filter((m) => mentionsPersona(m.body, persona) || (replyTo !== null && replyTo.test(m.body)))
    .map((m) => m.id);
  const reviews = db
    .prepare(
      `SELECT id, expires_ts FROM review_requests
        WHERE target = ? AND status IN ('pending', 'claimed') ORDER BY id ASC`,
    )
    .all(persona) as unknown as Array<{ id: number; expires_ts: string | null }>;
  const reviewIds = reviews
    .filter((r) => !r.expires_ts || Date.parse(r.expires_ts) > nowMs)
    .map((r) => r.id);
  return { messageIds, reviewIds };
}

function postSystemLine(db: DatabaseSync, body: string, nowMs: number): void {
  db.prepare(
    "INSERT INTO messages (sender, kind, body, ts, occurrences, session_id) VALUES (?, 'system', ?, ?, 1, NULL)",
  ).run(WAKER_SENDER, body, new Date(nowMs).toISOString());
}

export interface WakeOutcome {
  persona: string;
  /** "woke" or the reason it was not. */
  result: "woke" | "skipped" | "failed";
  reason: string;
}

export interface WakeResult {
  outcomes: WakeOutcome[];
}

/** Personas worth considering: anyone with a wake handle or a membership record. */
function candidatePersonas(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT persona FROM wake_handles UNION SELECT persona FROM members ORDER BY persona")
    .all() as unknown as Array<{ persona: string }>;
  return rows.map((r) => r.persona).filter((p) => p !== WAKER_SENDER);
}

/**
 * One waker pass. For every persona with no live session and directed work it
 * either launches the handle's resume command or posts why not, always as a
 * system line from `waker`. A plain function (like `relayOnce`): the spawner
 * and clock come in through `deps`.
 */
export async function wakeOnce(db: DatabaseSync, deps: WakerDeps): Promise<WakeResult> {
  const outcomes: WakeOutcome[] = [];
  const alive = deps.alive ?? pidAlive;
  const host = deps.host ?? hostname();
  const roomLabel = deps.roomLabel ?? (basename(deps.squadDir) === ".squad" ? basename(dirname(deps.squadDir)) : basename(deps.squadDir));

  for (const persona of candidatePersonas(db)) {
    const startMs = deps.now();
    if (hasLiveSession(db, persona, startMs)) continue;
    const peek = observeDirectedWork(db, persona, startMs);
    if (!peek.messageIds.length && !peek.reviewIds.length) continue;

    const outcome = await withPersonaLock(deps.squadDir, persona, startMs, async (): Promise<WakeOutcome | null> => {
      const nowMs = deps.now();
      const nowIso = new Date(nowMs).toISOString();
      let state = loadWakerState(deps.squadDir, persona, nowIso);
      // A quiet gap as long as the TTL starts a new arm cycle; a continuous
      // wake chain longer than the TTL is what the TTL is there to cut off.
      const lastActive = Date.parse(state.lastFiredAt ?? state.firstArmedAt);
      if (deps.ttlMinutes > 0 && !Number.isNaN(lastActive) && nowMs - lastActive >= deps.ttlMinutes * 60_000) {
        state = { ...initialState(nowIso), lastSkip: state.lastSkip };
      }

      // Re-observe under the lock: another waker may have just handled it.
      if (hasLiveSession(db, persona, nowMs)) return null;
      const work = observeDirectedWork(db, persona, nowMs);
      const messageIds = work.messageIds.filter((id) => id > (state.wokenThrough ?? 0));
      const reviewIds = work.reviewIds.filter((id) => id > (state.wokenReview ?? 0));
      if (!messageIds.length && !reviewIds.length) return null;

      const skip = (reason: string, next: WakerState = state): WakeOutcome => {
        if (next.lastSkip !== reason) {
          postSystemLine(db, `not woken: ${persona} -- ${reason}`, nowMs);
        }
        saveWakerState(deps.squadDir, persona, { ...next, lastSkip: reason });
        return { persona, result: "skipped", reason };
      };

      const handle: WakeHandle | null = getWakeHandle(db, persona);
      if (!handle) return skip("no wake handle recorded");
      if (handle.no_wake) return skip("persona opted out");
      if (!usableHere(handle, host)) return skip("wake handle belongs to another host");
      const count = messageIds.length + reviewIds.length;
      const prompt =
        `you have ${count} directed message${count === 1 ? "" : "s"} in ${roomLabel}; ` +
        "read them (`squad read`) and act";
      const argv = resolveWakeCommand(handle, prompt);
      if (!argv) return skip("no usable wake handle");
      if (state.wakePid && alive(state.wakePid)) return skip("a wake is already in flight");
      if (state.lastFiredAt && nowMs - Date.parse(state.lastFiredAt) < deps.cooldownMs) return skip("cooldown");

      const decision = decide({
        state,
        nowMs,
        hasDirectedWork: true,
        failureBackoff: state.failing === true,
        operatorStopped: operatorStopped(deps.squadDir, persona),
        ttlMinutes: deps.ttlMinutes,
        maxAttempts: deps.maxAttempts,
        rand: deps.rand,
      });
      if (!decision.block) return skip(decision.reason);
      if (decision.sleepMs > 0) return skip("backing off after a failed wake", decision.nextState as WakerState);

      const what = messageIds.length ? `@mention #${messageIds[0]}` : `review request #${reviewIds[0]}`;
      try {
        const proc = await deps.spawn(argv, {
          cwd: handle.cwd,
          env: { SQUAD_PERSONA: persona, SQUAD_DIR: deps.squadDir },
        });
        saveWakerState(deps.squadDir, persona, {
          ...(decision.nextState as WakerState),
          attempt: 0,
          failing: false,
          wokenThrough: Math.max(state.wokenThrough ?? 0, ...messageIds),
          wokenReview: Math.max(state.wokenReview ?? 0, ...reviewIds),
          wakePid: proc.pid,
          lastSkip: null,
          lastError: null,
        });
        postSystemLine(db, `woke ${persona} for ${what}`, nowMs);
        return { persona, result: "woke", reason: what };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // A failed launch is not a wake: keep lastFiredAt so no cooldown applies,
        // but the attempt still counts toward the cap and arms the failure backoff.
        saveWakerState(deps.squadDir, persona, {
          ...(decision.nextState as WakerState),
          lastFiredAt: state.lastFiredAt,
          failing: true,
          nextFireAt: null,
          lastError: message,
          lastSkip: `wake failed: ${message}`,
        });
        if (state.lastSkip !== `wake failed: ${message}`) {
          postSystemLine(db, `not woken: ${persona} -- wake failed: ${message}`, nowMs);
        }
        return { persona, result: "failed", reason: message };
      }
    });
    if (outcome) outcomes.push(outcome);
  }
  return { outcomes };
}

/** Human-readable `squad waker status` lines. */
export function wakerStatus(db: DatabaseSync, deps: WakerDeps): string[] {
  const nowMs = deps.now();
  const host = deps.host ?? hostname();
  const personas = new Set(candidatePersonas(db));
  const stateDir = join(deps.squadDir, "waker");
  if (existsSync(stateDir)) {
    for (const f of readdirSync(stateDir)) if (f.endsWith(".json")) personas.add(f.slice(0, -".json".length));
  }
  const lines: string[] = [];
  for (const persona of [...personas].sort()) {
    const handle = getWakeHandle(db, persona);
    if (!handle) continue;
    const state = loadWakerState(deps.squadDir, persona, new Date(nowMs).toISOString());
    const live = hasLiveSession(db, persona, nowMs);
    const work = observeDirectedWork(db, persona, nowMs);
    lines.push(
      `${persona}\t${handle.runtime}\t` +
        `${handle.no_wake ? "opted out" : usableHere(handle, host) ? "wakeable" : "other host"}\t` +
        `${live ? "live" : "no live session"}\t` +
        `${work.messageIds.length + work.reviewIds.length} directed\t` +
        `${state.totalFired ?? 0} wake(s)` +
        `${state.lastFiredAt ? `, last ${state.lastFiredAt}` : ""}` +
        `${operatorStopped(deps.squadDir, persona) ? ", STOPPED" : ""}` +
        `${state.failing ? `, failing (${state.lastError ?? "unknown"})` : ""}`,
    );
  }
  return lines.length ? lines : ["waker: no wake handles recorded (see 'squad wake-handle')"];
}

/** `squad waker [--once|--follow|status]`. */
export async function runWakerCommand(command: WakerCommand): Promise<void> {
  if (command.mode === "help") {
    console.log(WAKER_USAGE);
    return;
  }
  const { openDb } = await import("./db.js");
  const db = openDb();
  try {
    const deps = wakerDepsFromEnv();
    if (command.mode === "status") {
      for (const line of wakerStatus(db, deps)) console.log(line);
      return;
    }
    const report = (r: WakeResult): void => {
      for (const o of r.outcomes) console.log(`waker: ${o.result} ${o.persona}: ${o.reason}`);
    };
    if (command.mode === "once") {
      const r = await wakeOnce(db, deps);
      report(r);
      if (!r.outcomes.length) console.log("waker: nothing to wake");
      if (r.outcomes.some((o) => o.result === "failed")) process.exitCode = 1;
      return;
    }
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    console.log(`waker: following every ${command.intervalMs / 1000}s (Ctrl-C to stop)`);
    try {
      while (!controller.signal.aborted) {
        report(await wakeOnce(db, deps));
        writeWakerHeartbeat(deps.squadDir, deps.now(), command.intervalMs);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, command.intervalMs);
          function done() {
            clearTimeout(timer);
            controller.signal.removeEventListener("abort", done);
            resolve();
          }
          controller.signal.addEventListener("abort", done, { once: true });
        });
      }
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
    console.log("waker: stopped");
  } finally {
    db.close();
  }
}
