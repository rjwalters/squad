/**
 * The opencode adapter for `squad agent opencode` (#238, `docs/supervisor.md`).
 *
 * Plugs `opencode run` into the shared `supervise()` loop through the
 * `AgentAdapter` seam. Turn end is process exit of `opencode run`: there is no
 * session log to classify, so `detectTurnEnd` reports `unknown` and the exit
 * code alone decides clean park vs. failure (`isCleanPark`).
 *
 * No `recordWakeHandle`: opencode's session id source is not verified (see
 * `docs/supervisor.md`), and a handle must never be a guess. Until a stable
 * source is confirmed on a live host, this adapter records none.
 */
import { spawn } from "node:child_process";
import { envMinutes } from "./db.js";
import type { AgentAdapter, AgentOptions } from "./agent.js";
import { resumePrompt, type RolloutOutcome } from "./codex-reentry.js";
import { DEFAULT_REENTRY_MAX_ATTEMPTS, DEFAULT_REENTRY_TTL_MINUTES } from "./reentry.js";

export const OPENCODE_AGENT_USAGE =
  "usage: squad agent opencode [--persona <name>] [--opencode <bin>] [--prompt <text>]\n" +
  "                            [--ttl-minutes <n>] [--max-attempts <n>] [--no-resume]\n" +
  "                            [-- <extra args passed to `opencode run`>]";

/** Fresh-session prompt: `opencode run` takes a message and does not expand slash commands. */
export function opencodeJoinPrompt(persona: string): string {
  return (
    `You are ${persona}. Join the squad room by following the squad-join command ` +
    `(opencode/commands/squad-join.md, or the squad block in AGENTS.md) and hold the live conversation loop.`
  );
}

/** Argv (program excluded) for a fresh run: `run [extra…] <prompt>`. */
export function buildOpencodeArgs(opts: {
  mode: "fresh" | "resume";
  prompt: string;
  extraArgs: readonly string[];
  sessionId?: string;
}): string[] {
  if (opts.mode === "resume") {
    return ["run", "--session", opts.sessionId ?? "", ...opts.extraArgs, opts.prompt];
  }
  return ["run", ...opts.extraArgs, opts.prompt];
}

export function parseOpencodeAgentArgs(rest: string[]): AgentOptions {
  const countEnv = (name: string, fallback: number): number => {
    const n = Number(process.env[name]);
    return process.env[name] && Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const opts: AgentOptions = {
    persona: process.env.SQUAD_PERSONA || "opencode",
    bin: process.env.SQUAD_OPENCODE_BIN || "opencode",
    ttlMinutes: envMinutes("SQUAD_REENTRY_TTL_MINUTES", DEFAULT_REENTRY_TTL_MINUTES),
    maxAttempts: countEnv("SQUAD_REENTRY_MAX_ATTEMPTS", DEFAULT_REENTRY_MAX_ATTEMPTS),
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
      if (value === undefined) throw new Error(`${OPENCODE_AGENT_USAGE} (${flag} needs a value)`);
      return value;
    };
    const needsCount = (): number => {
      const n = Number(needsValue());
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`${OPENCODE_AGENT_USAGE} (${flag} needs a non-negative number)`);
      }
      return n;
    };
    switch (flag) {
      case "--persona":
        opts.persona = needsValue();
        break;
      case "--opencode":
        opts.bin = needsValue();
        break;
      case "--prompt":
        opts.prompt = needsValue();
        break;
      case "--ttl-minutes":
        opts.ttlMinutes = needsCount();
        break;
      case "--max-attempts":
        opts.maxAttempts = needsCount();
        break;
      case "--no-resume":
        opts.allowResume = false;
        break;
      default:
        throw new Error(`${OPENCODE_AGENT_USAGE} (unrecognized flag '${flag ?? ""}')`);
    }
  }
  return opts;
}

function runOpencodeProcess(
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
      process.stderr.write(`squad agent opencode: failed to launch ${bin}: ${err.message}\n`);
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

export const opencodeAdapter: AgentAdapter = {
  runtime: "opencode",
  usage: OPENCODE_AGENT_USAGE,
  parseArgs: parseOpencodeAgentArgs,
  joinPrompt: (opts) => opts.prompt ?? opencodeJoinPrompt(opts.persona),
  resumePrompt: (opts) => opts.prompt ?? resumePrompt(opts.persona),
  launch: (prompt, extraArgs) => buildOpencodeArgs({ mode: "fresh", prompt, extraArgs }),
  // The session id is not readable from a verified source (docs/supervisor.md),
  // so resume is not offered: supportsResume is false and supervise() relaunches fresh.
  // `buildOpencodeArgs({mode:"resume", sessionId})` is the argv once a source is verified.
  resume: () => {
    throw new Error("opencode resume needs a session id; none is recorded (supportsResume is false)");
  },
  supportsResume: async () => false,
  run: runOpencodeProcess,
  detectTurnEnd: async (): Promise<RolloutOutcome> => "unknown",
};
