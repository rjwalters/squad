#!/usr/bin/env node
/**
 * Protocol glue for the Claude Code `Stop` hook installed by
 * `install.sh --reentry` (see `hooks/squad-reentry.sh`, the bash wrapper
 * that invokes this file). All the actual decision logic lives in
 * `reentry.ts`, which is pure and independently unit-tested
 * (`tests/reentry-hook.test.mjs`) — this file only wires that logic to the
 * hook's stdin/stdout contract, the filesystem (persisted state, the
 * operator-stop marker), and the room's database (directed-work detection).
 *
 * Contract (Claude Code Stop hook protocol — mirrors
 * `.loom/hooks/guard-background-subagents.sh`'s documented contract):
 *   stdin:  JSON `{ session_id, transcript_path, stop_hook_active, cwd, ... }`
 *   stdout: to block-and-continue (re-enter), print
 *           `{"decision":"block","reason":"..."}` and exit 0; to allow the
 *           session to stop, print nothing and exit 0.
 *
 * This script must never throw past `main()` — any unexpected error (bad
 * JSON, an unreadable database, a corrupt state file) fails OPEN (allows the
 * stop) rather than wedging the session. That is the same fail-open
 * philosophy `guard-background-subagents.sh` documents for the same reason.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_REENTRY_TTL_MINUTES,
  decide,
  initialState,
  mentionsPersona,
  type ReentryState,
} from "./reentry.js";

/**
 * `stop_hook_active` is true when Claude Code's own loop guard reports this
 * hook already caused a block earlier in the *same* stop sequence (no real
 * assistant turn happened in between). Blocking again there risks wedging
 * the session in an unsatisfiable "you must continue" loop — the exact
 * hazard `guard-background-subagents.sh` names and fixes the same way: never
 * block twice in one stop sequence, always allow on the second pass. Longer
 * re-entry cycles are still achieved because each real re-entry gives the
 * persona a fresh stop sequence once it does real work (e.g. a
 * `/squad:join` check) and tries to stop again later.
 */
function sameSequenceReblock(input: unknown): boolean {
  return (
    typeof input === "object" &&
    input !== null &&
    (input as Record<string, unknown>).stop_hook_active === true
  );
}

function envMinutes(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Operator-stop escape hatch. Checked before anything else in `decide()`.
 * Two forms, either sufficient: `SQUAD_REENTRY_STOP=1` (or `true`/`yes`) in
 * the environment, or a marker file the operator can `touch`/`rm` without
 * touching any config — a room-wide `<squadDir>/reentry-stop`, or a
 * persona-scoped `<squadDir>/reentry/<persona>.stop` to pause only one
 * persona's re-entry.
 */
function operatorStopped(squadDir: string, persona: string): boolean {
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

function stateFile(squadDir: string, persona: string): string {
  return join(squadDir, "reentry", `${persona}.json`);
}

function loadState(squadDir: string, persona: string, nowIso: string): ReentryState {
  try {
    const raw = readFileSync(stateFile(squadDir, persona), "utf8");
    const parsed = JSON.parse(raw) as Partial<ReentryState>;
    if (
      typeof parsed.attempt === "number" &&
      typeof parsed.firstArmedAt === "string" &&
      (parsed.nextFireAt === null || typeof parsed.nextFireAt === "string") &&
      (parsed.lastFiredAt === null || typeof parsed.lastFiredAt === "string")
    ) {
      return parsed as ReentryState;
    }
  } catch {
    // Missing or corrupt — start a fresh arm cycle below.
  }
  return initialState(nowIso);
}

function saveState(squadDir: string, persona: string, state: ReentryState): void {
  mkdirSync(join(squadDir, "reentry"), { recursive: true });
  writeFileSync(stateFile(squadDir, persona), JSON.stringify(state, null, 2) + "\n");
}

/**
 * v1 "directed work" heuristic (see issue #40's Curator enhancement): an
 * unread message that `@mentions` this persona. Reuses the room's existing
 * durable read cursor via a peeking `check()` — peeking, not consuming, so
 * the messages are still there for the persona's own `squad_check` once it
 * re-enters the `/squad:join` loop. v2 (once #39 ships a dedicated
 * pending-directed surface) can swap this detection out without touching
 * `decide()`.
 */
async function hasDirectedWork(persona: string): Promise<boolean> {
  const { openDb } = await import("./db.js");
  const { Squad } = await import("./core.js");
  const squad = new Squad(openDb(), persona);
  const messages = squad.check({ peek: true });
  return messages.some((m) => mentionsPersona(m.body, persona));
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const raw = await readStdin();
  let input: unknown;
  try {
    input = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return; // malformed input — fail open (allow the stop)
  }

  if (sameSequenceReblock(input)) return; // loop guard — see sameSequenceReblock doc

  const cwd =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>).cwd
      : undefined;
  if (typeof cwd === "string") {
    try {
      process.chdir(cwd);
    } catch {
      // best-effort; squadDir() below still falls back to its own cwd walk
    }
  }

  const persona = process.env.SQUAD_PERSONA || "claude";

  let dir: string;
  try {
    const { squadDir } = await import("./db.js");
    dir = squadDir();
  } catch {
    return; // can't even resolve db.js — fail open
  }

  const nowIso = new Date().toISOString();
  const state = loadState(dir, persona, nowIso);
  const nowMs = Date.now();

  let directed: boolean;
  try {
    directed = await hasDirectedWork(persona);
  } catch {
    directed = false; // room unreachable — treat as quiet rather than throwing
  }

  const ttlMinutes = envMinutes("SQUAD_REENTRY_TTL_MINUTES", DEFAULT_REENTRY_TTL_MINUTES);

  const result = decide({
    state,
    nowMs,
    hasDirectedWork: directed,
    operatorStopped: operatorStopped(dir, persona),
    ttlMinutes,
  });

  try {
    saveState(dir, persona, result.nextState);
  } catch {
    // Persistence failure shouldn't block emitting the decision below —
    // worst case the next invocation re-derives from a fresh initial state.
  }

  if (result.sleepMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, result.sleepMs));
  }

  if (result.block) {
    process.stdout.write(JSON.stringify({ decision: "block", reason: result.reason }) + "\n");
  }
}

main().catch(() => {
  // Never let an unexpected error propagate as a non-zero exit — that would
  // read to Claude Code as a hook failure rather than "allow the stop".
});
