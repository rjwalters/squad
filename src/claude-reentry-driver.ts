/**
 * The Claude adapter for `squad agent claude` (#236, `docs/supervisor.md`).
 *
 * This covers headless `claude -p` runs, where there is no interactive `Stop`
 * to block; the Stop hook (`reentry-hook.ts`) stays the in-place keep-alive.
 * The loop is the shared `supervise()`; this file only supplies the
 * runtime-specific edge: argv, spawning with stdout captured, and reading the
 * `--output-format json` result for the session id and the turn outcome.
 *
 * Like `codex-reentry-driver.ts`, this is the untested-by-design process edge;
 * the pure parts (`parseClaudeResult`, `buildClaudeArgs`, `parseClaudeArgs`)
 * are exported and unit tested.
 */
import { spawn } from "node:child_process";
import { openDb } from "./db.js";
import type { AgentAdapter, AgentOptions } from "./agent.js";
import { FALLBACK_JOIN_PROMPT, resumePrompt, type RolloutOutcome } from "./codex-reentry.js";
import { parseAgentArgs } from "./agent-args.js";
import { upsertWakeHandle } from "./wake-handles.js";

export const CLAUDE_REENTRY_USAGE =
  "usage: squad agent claude [--persona <name>] [--claude <bin>] [--prompt <text>]\n" +
  "                          [--ttl-minutes <n>] [--max-attempts <n>] [--no-resume]\n" +
  "                          [-- <extra args passed to `claude -p`>]";

/** Cap on captured stdout so a chatty run cannot grow the supervisor without bound. */
const MAX_CAPTURE_CHARS = 16 * 1024 * 1024;

export interface ClaudeResult {
  outcome: RolloutOutcome;
  /** `session_id` from the run output; null when it could not be read. */
  sessionId: string | null;
}

/**
 * Read a `claude -p --output-format json` result. The CLI prints one JSON
 * object (`type:"result"`); an array of messages is tolerated too, taking its
 * last `result` entry. Anything unrecognized degrades to `missing`/`unknown`,
 * never to a false `task_complete`.
 */
export function parseClaudeResult(stdout: string): ClaudeResult {
  const none: ClaudeResult = { outcome: "missing", sessionId: null };
  const text = stdout.trim();
  if (!text) return none;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    try {
      parsed = JSON.parse(lines[lines.length - 1]!);
    } catch {
      return none;
    }
  }
  if (Array.isArray(parsed)) {
    const results = parsed.filter(
      (e) => typeof e === "object" && e !== null && (e as Record<string, unknown>).type === "result",
    );
    parsed = results.length ? results[results.length - 1] : parsed[parsed.length - 1];
  }
  if (typeof parsed !== "object" || parsed === null) return none;
  const rec = parsed as Record<string, unknown>;
  const sessionId =
    typeof rec.session_id === "string" && rec.session_id.trim() ? rec.session_id.trim() : null;
  if (rec.type !== "result") return { outcome: "unknown", sessionId };
  const subtype = typeof rec.subtype === "string" ? rec.subtype : "";
  const failed =
    rec.is_error === true || rec.terminal_reason === "api_error" || subtype.startsWith("error");
  return { outcome: failed ? "error" : "task_complete", sessionId };
}

/**
 * Child argv. Resume needs an explicit session id (Claude has no `--last`
 * equivalent we can trust); with none recorded it degrades to a fresh launch
 * rather than resuming a guessed session.
 */
export function buildClaudeArgs(opts: {
  mode: "fresh" | "resume";
  prompt: string;
  sessionId?: string | null;
  extraArgs?: readonly string[];
}): string[] {
  const extra = opts.extraArgs ? [...opts.extraArgs] : [];
  const tail = ["-p", opts.prompt, "--output-format", "json", ...extra];
  return opts.mode === "resume" && opts.sessionId ? ["--resume", opts.sessionId, ...tail] : tail;
}

export function parseClaudeArgs(rest: string[]): AgentOptions {
  return parseAgentArgs(rest, {
    runtime: "claude",
    binEnv: "SQUAD_CLAUDE_BIN",
    binFlag: "--claude",
    usage: CLAUDE_REENTRY_USAGE,
  });
}

// One supervisor drives one run at a time per process, so the adapter keeps
// the latest run's captured result here (the AgentAdapter hooks only get a
// start time, not the child's output).
let lastResult: ClaudeResult = { outcome: "missing", sessionId: null };
/** Session id of the most recent run that reported one; what `resume` targets. */
let resumeSessionId: string | null = null;

/** Test hook: forget any captured run. */
export function resetClaudeAdapterState(): void {
  lastResult = { outcome: "missing", sessionId: null };
  resumeSessionId = null;
}

function runClaudeProcess(
  bin: string,
  args: string[],
  onSpawnError?: (err: NodeJS.ErrnoException) => void,
): Promise<number | null> {
  lastResult = { outcome: "missing", sessionId: null };
  return new Promise((resolve) => {
    let captured = "";
    const child = spawn(bin, args, {
      stdio: ["inherit", "pipe", "inherit"],
      env: { ...process.env, SQUAD_REENTRY_SUPERVISOR: "1" },
    });
    child.stdout.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      captured += chunk.toString("utf8");
      if (captured.length > MAX_CAPTURE_CHARS) captured = captured.slice(-MAX_CAPTURE_CHARS);
    });
    child.on("error", (err) => {
      process.stderr.write(`squad agent claude: failed to launch ${bin}: ${err.message}\n`);
      try {
        onSpawnError?.(err);
      } catch {
        // best-effort announcement
      }
      resolve(null);
    });
    child.on("close", (code) => {
      lastResult = parseClaudeResult(captured);
      if (lastResult.sessionId) resumeSessionId = lastResult.sessionId;
      resolve(code);
    });
  });
}

/** Probe `claude --help` for `--resume` rather than assuming the installed CLI has it. */
export function probeClaudeResumeSupport(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(bin, ["--help"], { stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0 && /--resume\b/.test(out)));
  });
}

/** Record the run's real `session_id` as the persona's wake handle (#173). Best-effort. */
export function recordClaudeWakeHandle(persona: string): void {
  const sessionRef = lastResult.sessionId;
  if (!sessionRef) return;
  try {
    const db = openDb();
    try {
      upsertWakeHandle(db, { persona, runtime: "claude", sessionRef, cwd: process.cwd() });
    } finally {
      db.close();
    }
  } catch {
    // best-effort
  }
}

export const claudeAdapter: AgentAdapter = {
  runtime: "claude",
  usage: CLAUDE_REENTRY_USAGE,
  parseArgs: parseClaudeArgs,
  joinPrompt: (opts) => opts.prompt ?? FALLBACK_JOIN_PROMPT,
  resumePrompt: (opts) => opts.prompt ?? resumePrompt(opts.persona),
  launch: (prompt, extraArgs) => buildClaudeArgs({ mode: "fresh", prompt, extraArgs }),
  resume: (prompt, extraArgs) =>
    buildClaudeArgs({ mode: "resume", prompt, sessionId: resumeSessionId, extraArgs }),
  supportsResume: probeClaudeResumeSupport,
  run: runClaudeProcess,
  detectTurnEnd: async () => lastResult.outcome,
  recordWakeHandle: (persona) => recordClaudeWakeHandle(persona),
};
