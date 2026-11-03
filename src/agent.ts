/**
 * The agent-runtime adapter seam (#234, `docs/supervisor.md` decision 1).
 *
 * `supervise()` (codex-reentry.ts) is the runtime-agnostic loop: wait for turn
 * end, ask `decide()`, relaunch, announce the stop. Everything a runtime has
 * to supply — how to build its argv, whether it can resume, how to tell a
 * clean park from a crash — is an `AgentAdapter`. Adding a runtime (#236
 * Claude, #238 opencode) is one entry in `ADAPTERS`; nothing in the loop
 * changes.
 *
 * Entry point: `squad agent <runtime>`; `squad codex-reentry` is an alias for
 * `squad agent codex`.
 */
import { openDb, squadDir } from "./db.js";
import { Squad } from "./core.js";
import {
  DEFAULT_MIN_RUN_INTERVAL_MS,
  supervise,
  type RolloutOutcome,
  type SuperviseConfig,
  type SuperviseDeps,
  type SuperviseSummary,
} from "./codex-reentry.js";
import { observeWakeWork } from "./reentry-room.js";
import { loadState, operatorStopped, saveState } from "./reentry-state.js";
import { codexAdapter } from "./codex-reentry-driver.js";

/** Flags every adapter's parser yields (the Codex flag set is the baseline). */
export interface AgentOptions {
  persona: string;
  bin: string;
  prompt?: string;
  ttlMinutes: number;
  maxAttempts: number;
  allowResume: boolean;
  extraArgs: string[];
  minRunIntervalMs?: number;
}

export interface AgentAdapter {
  runtime: string;
  usage: string;
  parseArgs(rest: string[]): AgentOptions;
  /** Prompt for a fresh session. */
  joinPrompt(opts: AgentOptions): string;
  /** Prompt for a resumed session. */
  resumePrompt(opts: AgentOptions): string;
  /** Child argv for a fresh run. */
  launch(prompt: string, extraArgs: readonly string[]): string[];
  /** Child argv for a resumed run. */
  resume(prompt: string, extraArgs: readonly string[]): string[];
  supportsResume(bin: string): Promise<boolean>;
  /** Spawn the child; resolve with its exit code (null on signal / spawn error). */
  run(
    bin: string,
    args: string[],
    onSpawnError?: (err: NodeJS.ErrnoException) => void,
  ): Promise<number | null>;
  /** How the run that started at `startedAtMs` ended. */
  detectTurnEnd(startedAtMs: number): Promise<RolloutOutcome>;
  /** Optional: record the run's session as the persona's wake handle. */
  recordWakeHandle?(persona: string, startedAtMs: number): void;
}

const ADAPTERS: ReadonlyMap<string, AgentAdapter> = new Map([[codexAdapter.runtime, codexAdapter]]);

export function registeredRuntimes(): string[] {
  return [...ADAPTERS.keys()];
}

export function getAdapter(runtime: string): AgentAdapter | undefined {
  return ADAPTERS.get(runtime.toLowerCase());
}

export function agentUsage(): string {
  return (
    "usage: squad agent <runtime> [flags] [-- <extra args>]\n" +
    `registered runtimes: ${registeredRuntimes().join(", ")}\n` +
    "run `squad agent <runtime> --help` for that runtime's flags"
  );
}

/** Run `runtime` under the re-entry supervisor. Throws (usage text) on an unknown runtime. */
export async function runAgent(runtime: string, rest: string[]): Promise<SuperviseSummary> {
  const adapter = getAdapter(runtime);
  if (!adapter) throw new Error(`${agentUsage()} (no adapter for runtime '${runtime}')`);
  const opts = adapter.parseArgs(rest);
  const dir = squadDir();
  const persona = opts.persona;

  const cfg: SuperviseConfig = {
    persona,
    runtime: adapter.runtime,
    ttlMinutes: opts.ttlMinutes,
    maxAttempts: opts.maxAttempts,
    joinPrompt: adapter.joinPrompt(opts),
    reentryPrompt: adapter.resumePrompt(opts),
    extraArgs: opts.extraArgs,
    minRunIntervalMs: opts.minRunIntervalMs ?? DEFAULT_MIN_RUN_INTERVAL_MS,
  };

  let resumeCache: boolean | null = opts.allowResume ? null : false;

  // One lazily-opened room connection for the whole run (a per-poll open leaks
  // file descriptors over a multi-hour TTL, and a supervisor that never
  // launches must not touch the room). Unchanged from the Codex driver.
  let roomDb: import("node:sqlite").DatabaseSync | null = null;
  let room: Squad | null = null;
  const openRoom = (): Squad => {
    if (!room) {
      const db = openDb();
      roomDb = db;
      room = new Squad(db, persona);
    }
    return room;
  };
  const closeRoom = (): void => {
    const db = roomDb;
    roomDb = null;
    room = null;
    if (!db) return;
    try {
      db.close();
    } catch {
      // Already closed, or never fully usable.
    }
  };
  const announce = (body: string): void => {
    try {
      openRoom().send(body, "system");
    } catch {
      // Room unreachable — the terminal log is still the operator's signal.
    }
  };

  const deps: SuperviseDeps = {
    runAgent: (args) =>
      adapter.run(opts.bin, args, (err) => {
        // Fail closed: say why this persona was not woken. The null exit code
        // counts as a failure for backoff, never a minimum-interval loop.
        announce(
          err.code === "ENOENT"
            ? `not woken: ${persona} -- ${opts.bin} not found`
            : `not woken: ${persona} -- ${opts.bin} failed to launch (${err.message})`,
        );
      }),
    buildArgs: ({ mode, prompt, extraArgs }) =>
      mode === "resume" ? adapter.resume(prompt, extraArgs) : adapter.launch(prompt, extraArgs),
    classifyRun: async (startedAtMs) => {
      adapter.recordWakeHandle?.(persona, startedAtMs);
      return adapter.detectTurnEnd(startedAtMs);
    },
    resumeSupported: async () => {
      if (resumeCache === null) resumeCache = await adapter.supportsResume(opts.bin);
      return resumeCache;
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    loadState: () => loadState(dir, persona, new Date().toISOString()),
    saveState: (state) => {
      try {
        saveState(dir, persona, state);
      } catch {
        // Persistence failure must not stop the supervisor.
      }
    },
    operatorStopped: () => operatorStopped(dir, persona),
    hasDirectedWork: async () => observeWakeWork(openRoom(), persona).directed,
    hasHeldClaims: async () => observeWakeWork(openRoom(), persona).held,
    announce,
    log: (line) => process.stderr.write(`squad ${legacyName(adapter.runtime)} [${persona}]: ${line}\n`),
  };

  try {
    return await supervise(cfg, deps);
  } finally {
    closeRoom();
  }
}

/** Codex logs keep their historical `codex-reentry` prefix so the alias is not a visible change. */
function legacyName(runtime: string): string {
  return runtime === "codex" ? "codex-reentry" : `agent ${runtime}`;
}
