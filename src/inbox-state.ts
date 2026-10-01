/**
 * Persistence and escape-hatch plumbing for the mid-turn inbox hook (#118),
 * deliberately shaped like `reentry-state.ts`: an operator who has learned
 * `touch .squad/reentry-stop` must be able to guess
 * `touch .squad/inbox-stop`, and find the state in the matching place.
 *
 * State is keyed per-persona (`<squadDir>/inbox/<persona>.json`) for the same
 * reason the re-entry state is: two personas in one room keep independent
 * rate-limit clocks and notified marks with no coordination.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initialInboxState, type InboxState } from "./inbox.js";

/**
 * Operator-stop escape hatch, checked before the room is touched at all.
 * Three forms, any one sufficient: `SQUAD_INBOX_STOP=1` (or `true`/`yes`) in
 * the environment, a room-wide `<squadDir>/inbox-stop` marker file, or a
 * persona-scoped `<squadDir>/inbox/<persona>.stop` to quiet one persona.
 */
export function inboxStopped(squadDir: string, persona: string): boolean {
  switch ((process.env.SQUAD_INBOX_STOP ?? "").toLowerCase()) {
    case "1":
    case "true":
    case "yes":
      return true;
  }
  if (existsSync(join(squadDir, "inbox-stop"))) return true;
  if (existsSync(join(squadDir, "inbox", `${persona}.stop`))) return true;
  return false;
}

export function inboxStateFile(squadDir: string, persona: string): string {
  return join(squadDir, "inbox", `${persona}.json`);
}

/**
 * Read persisted state, falling back to a fresh one for anything unreadable
 * or malformed. A corrupt state file therefore costs at most one repeated
 * notice (and one re-derived rate-limit window), never a dropped message.
 */
export function loadInboxState(squadDir: string, persona: string): InboxState {
  try {
    const parsed = JSON.parse(
      readFileSync(inboxStateFile(squadDir, persona), "utf8"),
    ) as Partial<InboxState>;
    if (
      typeof parsed.notifiedMessageId === "number" &&
      Number.isFinite(parsed.notifiedMessageId)
    ) {
      return {
        lastPeekAt: typeof parsed.lastPeekAt === "string" ? parsed.lastPeekAt : null,
        notifiedMessageId: parsed.notifiedMessageId,
        notifiedReviewIds: Array.isArray(parsed.notifiedReviewIds)
          ? parsed.notifiedReviewIds.filter((id): id is number => typeof id === "number")
          : [],
      };
    }
  } catch {
    // Missing or corrupt — start fresh below.
  }
  return initialInboxState();
}

export function saveInboxState(squadDir: string, persona: string, state: InboxState): void {
  mkdirSync(join(squadDir, "inbox"), { recursive: true });
  writeFileSync(inboxStateFile(squadDir, persona), JSON.stringify(state, null, 2) + "\n");
}
