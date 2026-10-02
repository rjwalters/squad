/** Shared, non-consuming observations for every live runtime adapter. */
import type { Message, ReviewRequestView, Squad } from "./core.js";
import { mentionsPersona } from "./reentry.js";

/**
 * The one place "is there directed work for this persona?" is decided, so the
 * re-entry adapters (`reentry-hook.ts`, `codex-reentry.ts`) and the mid-turn
 * inbox hook (`inbox-hook.ts`) cannot drift on what counts as directed.
 *
 * Non-consuming by construction: `check({ peek: true })` leaves the persona's
 * read cursor where it was, and `pendingReviews()` is a read. `alsoFor` adds
 * extra mention targets — the inbox hook passes the reserved `repo` broadcast
 * target, which re-entry deliberately does not treat as a wake reason.
 */
export function observeDirectedItems(
  room: Squad,
  persona: string,
  alsoFor: readonly string[] = [],
): { unread: Message[]; directed: Message[]; reviews: ReviewRequestView[] } {
  const unread = room.check({ peek: true });
  return {
    unread,
    directed: unread.filter(
      (m) =>
        mentionsPersona(m.body, persona) ||
        alsoFor.some((t) => mentionsPersona(m.body, t, { exact: true })),
    ),
    reviews: room.pendingReviews(persona),
  };
}

export function observeWakeWork(room: Squad, persona: string): {
  directed: boolean; held: boolean;
} {
  const items = observeDirectedItems(room, persona);
  return {
    directed: items.directed.length > 0 || items.reviews.length > 0,
    held: room.claims().some((claim) => claim.persona === persona),
  };
}
