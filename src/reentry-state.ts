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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

export function stateFile(squadDir: string, persona: string): string {
  return join(squadDir, "reentry", `${persona}.json`);
}

export function loadState(squadDir: string, persona: string, nowIso: string): ReentryState {
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

export function saveState(squadDir: string, persona: string, state: ReentryState): void {
  mkdirSync(join(squadDir, "reentry"), { recursive: true });
  writeFileSync(stateFile(squadDir, persona), JSON.stringify(state, null, 2) + "\n");
}
