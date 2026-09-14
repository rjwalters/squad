/** Shared, non-consuming observations for both live runtime adapters. */
import type { Squad } from "./core.js";
import { mentionsPersona } from "./reentry.js";

export function observeWakeWork(room: Squad, persona: string): {
  directed: boolean; held: boolean;
} {
  return {
    directed: room.check({ peek: true }).some((m) => mentionsPersona(m.body, persona)) ||
      room.pendingReviews(persona).length > 0,
    held: room.claims().some((claim) => claim.persona === persona),
  };
}
