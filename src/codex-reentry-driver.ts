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
import { findRepoRoot, openDb } from "./db.js";
import type { AgentAdapter } from "./agent.js";
import {
  FALLBACK_JOIN_PROMPT,
  NATIVE_JOIN_PROMPT,
  classifyRolloutTail,
  pickLatestRollout,
  buildCodexArgs,
  resumePrompt,
  type RolloutOutcome,
  type SuperviseSummary,
} from "./codex-reentry.js";
import { parseAgentArgs } from "./agent-args.js";
import { codexSessionFromRollout, upsertWakeHandle } from "./wake-handles.js";

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
 * Record the Codex session of the run that started at `startedAtMs` as the
 * persona's wake handle (#173), when its rollout file names a session id.
 * Best-effort: a missing log, unparseable name or unreachable room records
 * nothing -- never a guessed handle, never a supervisor failure.
 */
export function recordCodexWakeHandle(persona: string, startedAtMs: number): void {
  try {
    const sessions = join(codexHome(), "sessions");
    if (!existsSync(sessions)) return;
    const path = pickLatestRollout(rolloutCandidates(sessions), startedAtMs);
    const sessionRef = path ? codexSessionFromRollout(path) : null;
    if (!sessionRef) return;
    const db = openDb();
    try {
      upsertWakeHandle(db, { persona, runtime: "codex", sessionRef, cwd: process.cwd() });
    } finally {
      db.close();
    }
  } catch {
    // best-effort
  }
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
 * The fresh-session prompt. `codex exec` takes a prompt string and does not
 * expand slash commands, so resolution order is:
 *  1. non-empty global `prompts/squad-join.md` text (installed or customized),
 *     inlined verbatim;
 *  2. if `<repoRoot>/.agents/skills/squad/SKILL.md` exists (the native bundle
 *     present even after `--no-codex`), `NATIVE_JOIN_PROMPT`;
 *  3. the literal `/squad-join` (harmless if unexpanded: the persona still
 *     gets told what to do by AGENTS.md's squad block).
 * An explicit `--prompt` bypasses this entirely (see `runCodexReentry`).
 */
export function joinPromptText(repoRoot: string | null = findRepoRoot(process.cwd())): string {
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
  if (repoRoot && existsSync(join(repoRoot, ".agents", "skills", "squad", "SKILL.md"))) {
    return NATIVE_JOIN_PROMPT;
  }
  return FALLBACK_JOIN_PROMPT;
}

function runCodexProcess(
  bin: string,
  args: string[],
  onSpawnError?: (err: NodeJS.ErrnoException) => void,
): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      stdio: "inherit",
      env: { ...process.env, SQUAD_REENTRY_SUPERVISOR: "1" },
    });
    child.on("error", (err) => {
      process.stderr.write(`squad codex-reentry: failed to launch ${bin}: ${err.message}\n`);
      try {
        onSpawnError?.(err);
      } catch {
        // best-effort announcement
      }
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
export function probeResumeSupport(bin: string): Promise<boolean> {
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

export function parseCodexReentryArgs(rest: string[]): CodexReentryOptions {
  return parseAgentArgs(rest, {
    runtime: "codex",
    binEnv: "SQUAD_CODEX_BIN",
    binFlag: "--codex",
    usage: CODEX_REENTRY_USAGE,
  });
}

/** The Codex adapter: the existing helpers behind the `AgentAdapter` seam, no logic change. */
export const codexAdapter: AgentAdapter = {
  runtime: "codex",
  usage: CODEX_REENTRY_USAGE,
  parseArgs: parseCodexReentryArgs,
  joinPrompt: (opts) => opts.prompt ?? joinPromptText(),
  resumePrompt: (opts) => opts.prompt ?? resumePrompt(opts.persona),
  launch: (prompt, extraArgs) => buildCodexArgs({ mode: "fresh", prompt, extraArgs }),
  resume: (prompt, extraArgs) => buildCodexArgs({ mode: "resume", prompt, extraArgs }),
  supportsResume: probeResumeSupport,
  run: runCodexProcess,
  detectTurnEnd: async (startedAtMs) => classifyRunFromLogs(startedAtMs),
  recordWakeHandle: recordCodexWakeHandle,
};

/**
 * `squad codex-reentry` — alias for `squad agent codex`. Kept as a thin
 * wrapper so existing callers and tests keep their import.
 */
export async function runCodexReentry(rest: string[]): Promise<SuperviseSummary> {
  const { runAgent } = await import("./agent.js");
  return runAgent("codex", rest);
}
