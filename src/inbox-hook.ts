#!/usr/bin/env node
/**
 * Protocol glue for the Claude Code `PostToolUse` / `UserPromptSubmit` hooks
 * installed by `install.sh --inbox` (see `hooks/squad-inbox.sh`, the bash
 * wrapper that invokes this file). All the decision logic lives in `inbox.ts`,
 * which is pure and independently unit-tested (`tests/inbox-hook.test.mjs`);
 * this file only wires that logic to the hook's stdin/stdout contract, the
 * filesystem (persisted state and the operator-stop marker, both in
 * `inbox-state.ts`), and the room's database.
 *
 * Contract (Claude Code hook protocol, verified against Claude Code 2.1.267,
 * whose own output schema declares `additionalContext` for both events):
 *   stdin:  JSON `{ session_id, hook_event_name, cwd, ... }`
 *   stdout: to surface a notice, print
 *           `{"hookSpecificOutput":{"hookEventName":"<event>",
 *             "additionalContext":"..."}}` and exit 0; to stay silent, print
 *           nothing and exit 0.
 *
 * `hookEventName` is echoed back from stdin because Claude Code drops a
 * `hookSpecificOutput` whose event does not match the firing event.
 *
 * Three invariants, in priority order over anything else this file does:
 *
 *  1. **It never blocks or fails a tool call.** No `decision`/`permissionDecision`
 *     is ever emitted, and any unexpected error (bad JSON, an unreadable or
 *     locked database, a corrupt state file) fails SILENT — the same fail-open
 *     philosophy `reentry-hook.ts` applies to the `Stop` hook.
 *  2. **It never consumes.** Observation goes through
 *     `observeDirectedItems()`, i.e. `check({ peek: true })`, so
 *     `squad_check` still returns the full message afterwards.
 *  3. **It never creates a room.** A cwd with no room gets no inbox and no
 *     side effects, so installing the hook cannot litter unrelated
 *     directories with `.squad/` databases.
 *
 * Identity comes from `SQUAD_PERSONA` (substituted into the wrapper at install
 * time from `SQUAD_CLAUDE_PERSONA`, exactly as the `--reentry` hook does): a
 * separate hook process cannot discover an automatically generated
 * `<label>-<hex>` session identity, so without a pin there is nothing to match
 * `@mentions` against and the hook stays silent.
 *
 * The *session* half of that identity comes from stdin: `session_id` names the
 * one logical Claude Code session all these short-lived hook processes belong
 * to, so passing it to `Squad` keeps them on one `sessions` row instead of
 * minting a live row per tool call (#126, completing #124 for the hooks). A
 * missing or non-string `session_id` simply falls back to the old behavior —
 * a row per process — rather than failing the tool call (invariant 1).
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import { envMinutes } from "./db.js";
import { DEFAULT_INBOX_INTERVAL_SECONDS, REPO_BROADCAST, decideInbox, peekDue } from "./inbox.js";
import { inboxStopped, loadInboxState, saveInboxState } from "./inbox-state.js";
import { observeDirectedItems } from "./reentry-room.js";

/** Events this hook is wired to; any other event is not ours to answer. */
const SUPPORTED_EVENTS = ["PostToolUse", "UserPromptSubmit"];

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const raw = await readStdin();
  let input: Record<string, unknown> = {};
  try {
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    if (parsed !== null && typeof parsed === "object") input = parsed as Record<string, unknown>;
  } catch {
    return; // malformed input — stay silent
  }

  const event = input.hook_event_name;
  if (typeof event !== "string" || !SUPPORTED_EVENTS.includes(event)) return;

  if (typeof input.cwd === "string") {
    try {
      process.chdir(input.cwd);
    } catch {
      // best-effort; squadDir() below still falls back to its own cwd walk
    }
  }

  const persona = (process.env.SQUAD_PERSONA ?? "").trim();
  if (!persona) return; // no pinned identity — see module doc

  // Narrowed, never coerced: a payload without a usable `session_id` leaves
  // this undefined, which `Squad` treats as "mint your own" (see module doc).
  const sessionId = typeof input.session_id === "string" ? input.session_id : undefined;

  let dir: string;
  try {
    const { squadDir } = await import("./db.js");
    dir = squadDir();
  } catch {
    return; // can't even resolve db.js — stay silent
  }

  if (inboxStopped(dir, persona)) return;
  // Observe only an existing room; never create one (invariant 3).
  if (!existsSync(join(dir, "squad.db"))) return;

  const state = loadInboxState(dir, persona);
  const intervalSeconds = envMinutes(
    "SQUAD_INBOX_INTERVAL_SECONDS",
    DEFAULT_INBOX_INTERVAL_SECONDS,
  );
  if (!peekDue(state, Date.now(), intervalSeconds)) return;

  // Stamp the rate-limit clock *before* opening the room, so a room that
  // fails to open (or a hook killed mid-peek) still costs at most one attempt
  // per window rather than one per tool call.
  const nowIso = new Date().toISOString();
  try {
    saveInboxState(dir, persona, { ...state, lastPeekAt: nowIso });
  } catch {
    // An unwritable state directory degrades the rate limit, not correctness.
  }

  let notice: string | null = null;
  try {
    const { openDb } = await import("./db.js");
    const { Squad } = await import("./core.js");
    const db = openDb();
    try {
      const room = new Squad(db, persona, { sessionId });
      const decision = decideInbox(
        observeDirectedItems(room, persona, [REPO_BROADCAST]),
        state,
        nowIso,
      );
      notice = decision.notice;
      try {
        saveInboxState(dir, persona, decision.nextState);
      } catch {
        // Worst case the next peek repeats this notice once.
      }
    } finally {
      db.close();
    }
  } catch {
    return; // unreachable room, locked WAL, schema surprise — stay silent
  }

  if (notice)
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: event, additionalContext: notice },
      }) + "\n",
    );
}

main().catch(() => {
  // Never let an unexpected error propagate as a non-zero exit — that would
  // read to Claude Code as a hook failure on an ordinary tool call.
});
