/**
 * Real-world wiring for the Codex re-entry supervisor: process spawning,
 * `CODEX_HOME` session-log reading, the room database, and the shared
 * re-entry state file. All decision logic lives in `codex-reentry.ts` (pure
 * + dependency-injected), which is what the tests exercise — this file is
 * the untested-by-design edge, exactly as `reentry-hook.ts` is for the
 * Claude Code `Stop` hook.
 *
 * Entry point: `squad codex-reentry` (see `cli.ts`). Run it in the terminal
 * where you would otherwise have run `codex` and typed `/squad-join`.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { envMinutes, openDb, squadDir } from "./db.js";
import { Squad } from "./core.js";
import {
  DEFAULT_MIN_RUN_INTERVAL_MS,
  FALLBACK_JOIN_PROMPT,
  classifyRolloutTail,
  pickLatestRollout,
  resumePrompt,
  supervise,
  type RolloutOutcome,
  type SuperviseConfig,
  type SuperviseDeps,
  type SuperviseSummary,
} from "./codex-reentry.js";
import {
  DEFAULT_REENTRY_MAX_ATTEMPTS,
  DEFAULT_REENTRY_TTL_MINUTES,
  mentionsPersona,
} from "./reentry.js";
import { loadState, operatorStopped, saveState } from "./reentry-state.js";

export const CODEX_REENTRY_USAGE =
  "usage: squad codex-reentry [--persona <name>] [--codex <bin>] [--prompt <text>]\n" +
  "                           [--ttl-minutes <n>] [--max-attempts <n>] [--no-resume]\n" +
  "                           [-- <extra args passed to `codex exec`>]";

/** `$CODEX_HOME`, or `~/.codex` — the same resolution Codex itself uses. */
export function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

/**
 * Every `rollout-*.jsonl` under `<CODEX_HOME>/sessions` with its mtime.
 * Codex nests these under date directories, so this walks recursively.
 * Never throws — an unreadable or absent sessions tree simply yields no
 * candidates, which the caller reads as `missing`.
 */
function rolloutCandidates(root: string, depth = 0): { path: string; mtimeMs: number }[] {
  if (depth > 6) return [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: { path: string; mtimeMs: number }[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...rolloutCandidates(path, depth + 1));
    } else if (entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
      try {
        found.push({ path, mtimeMs: statSync(path).mtimeMs });
      } catch {
        // vanished between readdir and stat — ignore
      }
    }
  }
  return found;
}

/**
 * Read back how the run that started at `startedAtMs` ended, from its
 * rollout log. This is the issue's "ground truth": the presence table only
 * reports `stale`, which is indistinguishable from a crash, whereas the
 * session log's final record says `task_complete` for a clean park and
 * something else for a real failure.
 */
export function classifyRunFromLogs(startedAtMs: number): RolloutOutcome {
  const sessions = join(codexHome(), "sessions");
  if (!existsSync(sessions)) return "missing";
  const path = pickLatestRollout(rolloutCandidates(sessions), startedAtMs);
  if (!path) return "missing";
  try {
    return classifyRolloutTail(readFileSync(path, "utf8"));
  } catch {
    return "missing";
  }
}

/**
 * The fresh-session prompt. Codex expands `/squad-join` from
 * `~/.codex/prompts/squad-join.md` in its interactive TUI, but `codex exec`
 * takes a prompt string — so the supervisor inlines the prompt file's text
 * when it can find it, and falls back to the literal slash command
 * otherwise (harmless if unexpanded: the persona still gets told what to do
 * by CLAUDE.md/AGENTS.md's squad block).
 */
export function joinPromptText(): string {
  const candidates = [
    join(codexHome(), "prompts", "squad-join.md"),
    join(homedir(), ".codex", "prompts", "squad-join.md"),
  ];
  for (const path of candidates) {
    try {
      const text = readFileSync(path, "utf8").trim();
      if (text) return text;
    } catch {
      // next candidate
    }
  }
  return FALLBACK_JOIN_PROMPT;
}

function runCodexProcess(bin: string, args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      stdio: "inherit",
      env: { ...process.env, SQUAD_REENTRY_SUPERVISOR: "1" },
    });
    child.on("error", (err) => {
      process.stderr.write(`squad codex-reentry: failed to launch ${bin}: ${err.message}\n`);
      resolve(null);
    });
    child.on("close", (code) => resolve(code));
  });
}

/**
 * Probe whether the local `codex` supports `exec resume` rather than
 * assuming it: the subcommand surface has changed across Codex releases, and
 * an unconditional `exec resume --last` on a version without it would turn
 * every re-entry into an instant usage error (a crash loop the backoff would
 * ride out pointlessly).
 */
function probeResumeSupport(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(bin, ["exec", "resume", "--help"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

export interface CodexReentryOptions {
  persona: string;
  bin: string;
  prompt?: string;
  ttlMinutes: number;
  maxAttempts: number;
  allowResume: boolean;
  extraArgs: string[];
  minRunIntervalMs?: number;
}

/**
 * `envMinutes`'s parsing rule (non-negative finite number, else the
 * fallback) for a var that counts things rather than minutes — same
 * leniency, honest name.
 */
function envCount(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function parseCodexReentryArgs(rest: string[]): CodexReentryOptions {
  const opts: CodexReentryOptions = {
    persona: process.env.SQUAD_PERSONA || "codex",
    bin: process.env.SQUAD_CODEX_BIN || "codex",
    ttlMinutes: envMinutes("SQUAD_REENTRY_TTL_MINUTES", DEFAULT_REENTRY_TTL_MINUTES),
    maxAttempts: envCount("SQUAD_REENTRY_MAX_ATTEMPTS", DEFAULT_REENTRY_MAX_ATTEMPTS),
    allowResume: true,
    extraArgs: [],
  };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === "--") {
      opts.extraArgs = rest.slice(i + 1);
      break;
    }
    const needsValue = (): string => {
      const value = rest[++i];
      if (value === undefined) throw new Error(`${CODEX_REENTRY_USAGE} (${flag} needs a value)`);
      return value;
    };
    switch (flag) {
      case "--persona":
        opts.persona = needsValue();
        break;
      case "--codex":
        opts.bin = needsValue();
        break;
      case "--prompt":
        opts.prompt = needsValue();
        break;
      case "--ttl-minutes": {
        const n = Number(needsValue());
        if (!Number.isFinite(n) || n < 0) {
          throw new Error(`${CODEX_REENTRY_USAGE} (--ttl-minutes needs a non-negative number)`);
        }
        opts.ttlMinutes = n;
        break;
      }
      case "--max-attempts": {
        const n = Number(needsValue());
        if (!Number.isFinite(n) || n < 0) {
          throw new Error(`${CODEX_REENTRY_USAGE} (--max-attempts needs a non-negative number)`);
        }
        opts.maxAttempts = n;
        break;
      }
      case "--no-resume":
        opts.allowResume = false;
        break;
      default:
        throw new Error(`${CODEX_REENTRY_USAGE} (unrecognized flag '${flag ?? ""}')`);
    }
  }
  return opts;
}

/**
 * `squad codex-reentry` — start a Codex persona under the re-entry
 * supervisor. Blocks (this is a foreground process, deliberately: see the
 * "not a shared daemon" note in codex-reentry.ts) until a bound fires.
 */
export async function runCodexReentry(rest: string[]): Promise<SuperviseSummary> {
  const opts = parseCodexReentryArgs(rest);
  const dir = squadDir();
  const persona = opts.persona;

  const cfg: SuperviseConfig = {
    persona,
    ttlMinutes: opts.ttlMinutes,
    maxAttempts: opts.maxAttempts,
    joinPrompt: opts.prompt ?? joinPromptText(),
    reentryPrompt: opts.prompt ?? resumePrompt(persona),
    extraArgs: opts.extraArgs,
    minRunIntervalMs: opts.minRunIntervalMs ?? DEFAULT_MIN_RUN_INTERVAL_MS,
  };

  let resumeCache: boolean | null = opts.allowResume ? null : false;

  // One room connection for the whole supervised run, opened lazily on first
  // use and reused until shutdown — the same single-connection pattern
  // `src/mcp.ts` uses for the long-running MCP server.
  //
  // Opening per call would leak: `node:sqlite`'s `DatabaseSync` does not
  // release its file descriptors on GC, and `waitForReentry()` polls
  // `hasDirectedWork()` once per sleep slice (~45s by default) for the whole
  // multi-hour TTL — on the order of hundreds of opens per supervised run,
  // enough to hit a container's `ulimit -n` and crash the supervisor with
  // EMFILE during exactly the long unattended runs it exists to protect. It
  // also minted a fresh `sessions` row per poll, since `Squad` creates its
  // session lazily per instance.
  //
  // Lazy rather than eager so a supervisor that never launches (preLaunchStop
  // blocks it before the first `announce`) still never touches the room, and
  // so an unopenable room degrades exactly as before: `announce` swallows the
  // throw, and `waitForReentry` treats a throwing `hasDirectedWork` as quiet.
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
    // Cleared before the close attempt so a throwing close (or a second call)
    // can never double-close the same handle.
    roomDb = null;
    room = null;
    if (!db) return;
    try {
      db.close();
    } catch {
      // Already closed, or never fully usable — nothing left to release.
    }
  };

  const deps: SuperviseDeps = {
    runCodex: (args) => runCodexProcess(opts.bin, args),
    classifyRun: async (startedAtMs) => classifyRunFromLogs(startedAtMs),
    resumeSupported: async () => {
      if (resumeCache === null) resumeCache = await probeResumeSupport(opts.bin);
      return resumeCache;
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    loadState: () => loadState(dir, persona, new Date().toISOString()),
    saveState: (state) => {
      try {
        saveState(dir, persona, state);
      } catch {
        // Persistence failure must not stop the supervisor — worst case the
        // next start re-derives a fresh arm cycle.
      }
    },
    operatorStopped: () => operatorStopped(dir, persona),
    hasDirectedWork: async () => {
      // Peek, never consume: these messages must still be there for the
      // persona's own squad_check once it re-enters. Same v1 heuristic as
      // the Claude Code Stop hook.
      return openRoom()
        .check({ peek: true })
        .some((m) => mentionsPersona(m.body, persona));
    },
    announce: (body) => {
      try {
        openRoom().send(body, "system");
      } catch {
        // Room unreachable — the terminal log below is still the operator's
        // signal; never let an announcement failure kill the supervisor.
      }
    },
    log: (line) => process.stderr.write(`squad codex-reentry [${persona}]: ${line}\n`),
  };

  try {
    return await supervise(cfg, deps);
  } finally {
    // Release the connection on every exit path — normal stop, throw, or the
    // caller's own error handling. `supervise` is the process's whole
    // lifetime, so this is the shutdown hook.
    closeRoom();
  }
}
