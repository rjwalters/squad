/**
 * The one flag/env parser every `squad agent <runtime>` adapter shares (#261).
 *
 * An adapter supplies only what differs — default persona, the bin env var,
 * the bin flag name and its usage string — via `AgentArgSpec`. Lives apart
 * from `agent.ts` so adapters can import it without a circular import
 * (`agent.ts` imports every adapter).
 */
import { envMinutes } from "./db.js";
import type { AgentOptions } from "./agent.js";
import { DEFAULT_REENTRY_MAX_ATTEMPTS, DEFAULT_REENTRY_TTL_MINUTES } from "./reentry.js";

export interface AgentArgSpec {
  /** Default persona (and bin name) when nothing overrides it, e.g. `codex`. */
  runtime: string;
  /** Env var naming the runtime binary, e.g. `SQUAD_CODEX_BIN`. */
  binEnv: string;
  /** Flag that overrides the binary, e.g. `--codex`. */
  binFlag: string;
  usage: string;
}

/**
 * `envMinutes`'s parsing rule (non-negative finite number, else the
 * fallback) for a var that counts things rather than minutes — same
 * leniency, honest name.
 */
export function envCount(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function parseAgentArgs(rest: string[], spec: AgentArgSpec): AgentOptions {
  const opts: AgentOptions = {
    persona: process.env.SQUAD_PERSONA || spec.runtime,
    bin: process.env[spec.binEnv] || spec.runtime,
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
      if (value === undefined) throw new Error(`${spec.usage} (${flag} needs a value)`);
      return value;
    };
    const needsCount = (): number => {
      const n = Number(needsValue());
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`${spec.usage} (${flag} needs a non-negative number)`);
      }
      return n;
    };
    switch (flag) {
      case "--persona":
        opts.persona = needsValue();
        break;
      case spec.binFlag:
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
        throw new Error(`${spec.usage} (unrecognized flag '${flag ?? ""}')`);
    }
  }
  return opts;
}
