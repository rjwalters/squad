import type { DatabaseSync } from "node:sqlite";
import { hostname } from "node:os";

/**
 * Wake-handle registry (#173, phase 1 of #172): a record of *how* a persona's
 * agent session could be resumed -- its runtime, session reference, working
 * directory and host. Nothing here launches a process; `resolveWakeCommand`
 * only builds an argv array for a later waker to run.
 *
 * The table lives outside ROOM_TABLES (src/db.ts): a handle is host-local
 * state about a process on *this* machine, so clear/export/import ignore it
 * and SCHEMA_VERSION does not move.
 */

export type WakeRuntime = "codex" | "claude";

export interface WakeHandle {
  persona: string;
  runtime: WakeRuntime;
  session_ref: string;
  cwd: string | null;
  host: string;
  no_wake: boolean;
  updated_at: string;
}

/** A listed handle plus whether it can be resumed from this host. */
export interface WakeHandleListing extends WakeHandle {
  usable_here: boolean;
}

export interface WakeHandleInput {
  persona: string;
  runtime: string;
  sessionRef: string;
  cwd?: string | null;
  host?: string;
}

interface Row {
  persona: string;
  runtime: string;
  session_ref: string;
  cwd: string | null;
  host: string;
  no_wake: number;
  updated_at: string;
}

export function isWakeRuntime(value: unknown): value is WakeRuntime {
  return value === "codex" || value === "claude";
}

function toHandle(row: Row): WakeHandle {
  return {
    persona: row.persona,
    runtime: row.runtime as WakeRuntime,
    session_ref: row.session_ref,
    cwd: row.cwd,
    host: row.host,
    no_wake: row.no_wake !== 0,
    updated_at: row.updated_at,
  };
}

/**
 * Upsert a persona's handle. Never records a guess: an unknown runtime or an
 * empty/absent session ref writes nothing and returns null. An existing
 * `no_wake` choice survives the upsert -- re-joining must not silently
 * opt a persona back in.
 */
export function upsertWakeHandle(db: DatabaseSync, input: WakeHandleInput): WakeHandle | null {
  const persona = input.persona?.trim();
  const sessionRef = typeof input.sessionRef === "string" ? input.sessionRef.trim() : "";
  if (!persona || !sessionRef || !isWakeRuntime(input.runtime)) return null;
  db.prepare(
    `INSERT INTO wake_handles (persona, runtime, session_ref, cwd, host, no_wake, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT(persona) DO UPDATE SET
       runtime = excluded.runtime,
       session_ref = excluded.session_ref,
       cwd = excluded.cwd,
       host = excluded.host,
       updated_at = excluded.updated_at`,
  ).run(persona, input.runtime, sessionRef, input.cwd ?? null, input.host ?? hostname(), new Date().toISOString());
  return getWakeHandle(db, persona);
}

export function getWakeHandle(db: DatabaseSync, persona: string): WakeHandle | null {
  const row = db.prepare("SELECT * FROM wake_handles WHERE persona = ?").get(persona) as unknown as Row | undefined;
  return row ? toHandle(row) : null;
}

/** True when the handle was recorded on this host, i.e. could be resumed here. */
export function usableHere(handle: WakeHandle, host: string = hostname()): boolean {
  return handle.host === host;
}

/** Every handle, handles for other hosts included but marked `usable_here: false`. */
export function listWakeHandles(db: DatabaseSync, host: string = hostname()): WakeHandleListing[] {
  const rows = db.prepare("SELECT * FROM wake_handles ORDER BY persona").all() as unknown as Row[];
  return rows.map((r) => {
    const handle = toHandle(r);
    return { ...handle, usable_here: usableHere(handle, host) };
  });
}

export function clearWakeHandle(db: DatabaseSync, persona: string): boolean {
  return Number(db.prepare("DELETE FROM wake_handles WHERE persona = ?").run(persona).changes) > 0;
}

/** Set the per-persona no-wake flag. False when the persona has no handle. */
export function setNoWake(db: DatabaseSync, persona: string, noWake: boolean): boolean {
  const res = db
    .prepare("UPDATE wake_handles SET no_wake = ? WHERE persona = ?")
    .run(noWake ? 1 : 0, persona);
  return Number(res.changes) > 0;
}

/**
 * The argv (program first) that resumes the handle's session with `prompt`.
 * Always an array -- never a shell string -- so neither a persona name nor a
 * prompt can reach a shell. Null for an unknown runtime or missing session
 * ref.
 */
export function resolveWakeCommand(
  handle: Pick<WakeHandle, "runtime" | "session_ref">,
  prompt = "",
): string[] | null {
  const ref = typeof handle.session_ref === "string" ? handle.session_ref.trim() : "";
  if (!ref) return null;
  switch (handle.runtime) {
    case "codex":
      return ["codex", "exec", "resume", ref, ...(prompt ? [prompt] : [])];
    case "claude":
      return ["claude", "--resume", ref, "-p", prompt];
    default:
      return null;
  }
}

/** Session id embedded in a Codex rollout filename, `rollout-<timestamp>-<uuid>.jsonl`. */
export function codexSessionFromRollout(path: string): string | null {
  const name = path.split(/[\\/]/).pop() ?? "";
  const m = /^rollout-.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(name);
  return m ? m[1]! : null;
}

export const WAKE_HANDLE_USAGE =
  "usage: squad wake-handle set <persona> <codex|claude> <session-ref> [--cwd <dir>] | " +
  "show <persona> | list | clear <persona> | opt-out <persona> | opt-in <persona>";

/** Runs a `squad wake-handle` subcommand; returns the lines to print. */
export function runWakeHandle(db: DatabaseSync, args: string[]): string[] {
  const [action, ...rest] = args;
  const need = (n: number): void => {
    if (rest.length < n) throw new Error(WAKE_HANDLE_USAGE);
  };
  switch (action) {
    case "set": {
      need(3);
      const [persona, runtime, sessionRef, ...flags] = rest as [string, string, string, ...string[]];
      let cwd: string | null = process.cwd();
      if (flags.length === 2 && flags[0] === "--cwd") cwd = flags[1]!;
      else if (flags.length) throw new Error(WAKE_HANDLE_USAGE);
      if (!isWakeRuntime(runtime)) throw new Error(`wake-handle: runtime must be 'codex' or 'claude', got '${runtime}'`);
      const h = upsertWakeHandle(db, { persona, runtime, sessionRef, cwd });
      if (!h) throw new Error("wake-handle: persona and session-ref must be non-empty");
      return [`wake handle set for ${h.persona} (${h.runtime}, ${h.host})`];
    }
    case "show": {
      need(1);
      const h = getWakeHandle(db, rest[0]!);
      if (!h) return [`no wake handle for ${rest[0]}`];
      return [JSON.stringify({ ...h, usable_here: usableHere(h) }, null, 2)];
    }
    case "list": {
      const all = listWakeHandles(db);
      if (!all.length) return ["no wake handles"];
      return all.map(
        (h) =>
          `${h.persona}\t${h.runtime}\t${h.host}\t${h.no_wake ? "no-wake" : "wake"}\t` +
          `${h.usable_here ? "usable here" : "not usable here (other host)"}`,
      );
    }
    case "clear": {
      need(1);
      return [clearWakeHandle(db, rest[0]!) ? `cleared wake handle for ${rest[0]}` : `no wake handle for ${rest[0]}`];
    }
    case "opt-out":
    case "opt-in": {
      need(1);
      const ok = setNoWake(db, rest[0]!, action === "opt-out");
      if (!ok) throw new Error(`wake-handle: no handle for '${rest[0]}' (record one first with 'wake-handle set')`);
      return [`${rest[0]} ${action === "opt-out" ? "opted out of" : "opted in to"} waking`];
    }
    default:
      throw new Error(WAKE_HANDLE_USAGE);
  }
}
