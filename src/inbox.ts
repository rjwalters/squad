/**
 * Shared pure logic for mid-turn inbox delivery (#118): the rate limit, the
 * "already notified" high-water mark, and the notice text itself. Runtime
 * adapters supply observations and the clock; nothing here touches the
 * filesystem, the room, or `process`.
 *
 * Squad is pull-only: an agent sees a message when it calls `squad_check`.
 * The re-entry `Stop` hook covers an agent that is *finishing* a turn; this
 * module backs the opt-in `PostToolUse`/`UserPromptSubmit` hook that covers
 * the other common case — an agent in the middle of a long task, which may
 * never have run `/squad:join` at all. The hook only ever *tells* the agent
 * something is waiting; it never consumes the message, so `squad_check` still
 * returns the full text afterwards.
 *
 * The bar for interrupting is deliberately "someone needs *you*", not
 * ordinary room chatter: unread `@mentions` of this persona, unexpired
 * pending/claimed directed review requests, and `@repo` broadcasts (the
 * reserved "everyone working in this repo" target — see
 * `RESERVED_PERSONAS` in `identity.ts`).
 */

/** Minimum seconds between two room peeks for one persona. See `peekDue`. */
export const DEFAULT_INBOX_INTERVAL_SECONDS = 60;

/**
 * The reserved broadcast target. `@repo` means "every agent working in this
 * repo", including sessions that never joined, and reads naturally because the
 * room *is* the repo. `identity.ts` reserves the literal name so no persona
 * (automatic or pinned) can claim it and shadow the broadcast.
 */
export const REPO_BROADCAST = "repo";

/** How many items a notice quotes before the rest collapse into a count. */
export const INBOX_NOTICE_ITEMS = 3;

/** Per-item quote budget, so one long message cannot flood the context. */
export const INBOX_QUOTE_LENGTH = 120;

/** A peeked room message, narrowed to what a notice needs. */
export interface InboxMessage {
  id: number;
  sender: string;
  body: string;
}

/** An open directed review request, narrowed to what a notice needs. */
export interface InboxReview {
  id: number;
  requested_by: string;
  priority: string;
  body: string;
}

/**
 * One non-consuming observation of the room, as produced by
 * `observeDirectedItems()` (`reentry-room.ts`).
 *
 * `directed` must be a subset of `unread`: the high-water mark advances past
 * everything *seen*, which is what makes a directed message reported exactly
 * once even though the agent's own read cursor has not moved.
 */
export interface InboxObservation {
  /** Every unread, non-self message in this peek — directed or not. */
  unread: readonly InboxMessage[];
  /** The subset addressed to this persona (or to `@repo`). */
  directed: readonly InboxMessage[];
  /** Open, unexpired review requests targeting this persona. */
  reviews: readonly InboxReview[];
}

/**
 * Persisted per-persona-per-room state. Deliberately separate from the
 * `squad_check` consume cursor: this mark only records what the *hook* has
 * already said out loud, so the agent is not nagged on every tool call while
 * `squad_check` still returns the whole message.
 */
export interface InboxState {
  /** ISO timestamp of the last peek — the rate-limit clock. */
  lastPeekAt: string | null;
  /** Highest message id already surfaced (or already seen and skipped). */
  notifiedMessageId: number;
  /** Review request ids already surfaced; pruned as requests close. */
  notifiedReviewIds: number[];
}

export function initialInboxState(): InboxState {
  return { lastPeekAt: null, notifiedMessageId: 0, notifiedReviewIds: [] };
}

export interface InboxDecision {
  /** The `additionalContext` text, or null when there is nothing new to say. */
  notice: string | null;
  nextState: InboxState;
}

/**
 * Is a peek allowed yet? This is the whole cost control: most tool calls
 * answer "no" here and never open the room's database at all.
 *
 * `intervalSeconds <= 0` disables the limit (every invocation peeks), and a
 * missing or corrupt `lastPeekAt` fails toward peeking — the failure mode that
 * costs latency rather than the one that drops a directed message.
 */
export function peekDue(
  state: InboxState,
  nowMs: number,
  intervalSeconds: number = DEFAULT_INBOX_INTERVAL_SECONDS,
): boolean {
  if (intervalSeconds <= 0) return true;
  if (!state.lastPeekAt) return true;
  const last = Date.parse(state.lastPeekAt);
  if (Number.isNaN(last)) return true;
  return nowMs - last >= intervalSeconds * 1000;
}

/** Collapse whitespace and clip to `INBOX_QUOTE_LENGTH`. */
function quote(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > INBOX_QUOTE_LENGTH
    ? flat.slice(0, INBOX_QUOTE_LENGTH - 1) + "…"
    : flat;
}

function listing(items: string[], total: number): string {
  const extra = total - items.length;
  return items.join("; ") + (extra > 0 ? `; +${extra} more` : "");
}

/**
 * The notice text for the items that have not been announced yet, or null
 * when there is nothing new. Kept short on purpose: it is injected into a
 * working agent's context mid-task, so it says who wants what and how to
 * fetch it, not the whole conversation.
 */
export function renderNotice(
  messages: readonly InboxMessage[],
  reviews: readonly InboxReview[],
): string | null {
  if (!messages.length && !reviews.length) return null;
  const parts: string[] = [];
  if (messages.length) {
    const shown = messages
      .slice(0, INBOX_NOTICE_ITEMS)
      .map((m) => `${m.sender}: "${quote(m.body)}"`);
    parts.push(
      `${messages.length} directed message${messages.length === 1 ? "" : "s"} — ` +
        listing(shown, messages.length),
    );
  }
  if (reviews.length) {
    const shown = reviews
      .slice(0, INBOX_NOTICE_ITEMS)
      .map((r) => `#${r.id} from ${r.requested_by} (${r.priority}): "${quote(r.body)}"`);
    parts.push(
      `${reviews.length} pending review${reviews.length === 1 ? "" : "s"} — ` +
        listing(shown, reviews.length),
    );
  }
  return (
    `\u{1F4EC} squad: ${parts.join(" · ")}. Nothing was consumed — run squad_check` +
    (reviews.length ? " / squad_review open" : "") +
    " to read and act on it."
  );
}

/**
 * The single decision point, called once per peek. Returns what to say (if
 * anything) and the state to persist.
 *
 * `notifiedMessageId` advances past every message *seen*, not only the ones
 * announced, so an item is reported once and ordinary chatter never queues up
 * behind it. `notifiedReviewIds` keeps only ids that are still open, so the
 * list is bounded by the number of live requests rather than growing forever.
 */
export function decideInbox(
  observation: InboxObservation,
  state: InboxState,
  nowIso: string,
): InboxDecision {
  const messages = observation.directed.filter((m) => m.id > state.notifiedMessageId);
  const alreadyTold = new Set(state.notifiedReviewIds);
  const reviews = observation.reviews.filter((r) => !alreadyTold.has(r.id));
  const stillOpen = new Set(observation.reviews.map((r) => r.id));
  const notifiedMessageId = observation.unread.reduce(
    (highest, m) => Math.max(highest, m.id),
    state.notifiedMessageId,
  );
  return {
    notice: renderNotice(messages, reviews),
    nextState: {
      lastPeekAt: nowIso,
      notifiedMessageId,
      notifiedReviewIds: [
        ...new Set([
          ...state.notifiedReviewIds.filter((id) => stillOpen.has(id)),
          ...reviews.map((r) => r.id),
        ]),
      ].sort((a, b) => a - b),
    },
  };
}
