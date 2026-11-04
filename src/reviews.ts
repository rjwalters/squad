import type { DatabaseSync } from "node:sqlite";

/**
 * Review-request domain: directed, acknowledgeable asks between personas.
 * Extracted from `core.ts`; `Squad.review*` / `Squad.pendingReviews` delegate
 * here. Shared room state is passed in as an explicit {@link ReviewContext}
 * rather than reached through `Squad` internals.
 */

const now = () => new Date().toISOString();

/**
 * What the review operations need from the room: the db handle, the acting
 * persona, and a way to announce a system message in chat. `Squad` calls
 * `touch()` itself before delegating, so it is not part of the context.
 */
export interface ReviewContext {
  db: DatabaseSync;
  persona: string;
  send(body: string, kind: "system"): unknown;
}

/**
 * How urgent a directed review request is. A small fixed enum rather than
 * free text so the pending-directed ordering stays meaningful. Declared
 * least- to most-urgent; `pendingReviews`/`reviewList` sort the other way.
 */
export type ReviewPriority = "low" | "normal" | "high" | "urgent";

/** Every `ReviewPriority`, least urgent first — the runtime source of truth. */
export const REVIEW_PRIORITIES: readonly ReviewPriority[] = ["low", "normal", "high", "urgent"];

/** Sort key for `REVIEW_PRIORITIES`: higher wins, so `urgent` sorts first. */
const PRIORITY_RANK: Record<ReviewPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
  urgent: 3,
};

/**
 * A directed review request's lifecycle: `pending` (asked, nobody has acked),
 * `claimed` (the target acked and is on it), `resolved` (done), `cancelled`
 * (withdrawn or declined). `resolved`/`cancelled` are terminal.
 */
export type ReviewStatus = "pending" | "claimed" | "resolved" | "cancelled";

/**
 * Explicit allowed-transition graph, mirroring Science Cards' TRANSITIONS: a
 * transition not listed for the request's current status is rejected. Note
 * that `pending -> resolved` is deliberately absent — a request must be
 * claimed (acked) before it can be resolved, which is what makes the claim a
 * lease rather than a formality.
 */
const REVIEW_TRANSITIONS: Record<ReviewStatus, readonly ReviewStatus[]> = {
  pending: ["claimed", "cancelled"],
  claimed: ["resolved", "cancelled"],
  resolved: [],
  cancelled: [],
};

/**
 * Every `ReviewStatus`, derived from the transition graph so the runtime list
 * and the type can never drift — the source of truth for CLI validation and
 * the MCP tool enums.
 */
export const REVIEW_STATUSES: readonly ReviewStatus[] = Object.keys(
  REVIEW_TRANSITIONS,
) as ReviewStatus[];

/** Statuses a request can still move out of — i.e. still open work. */
export const REVIEW_OPEN_STATUSES: readonly ReviewStatus[] = ["pending", "claimed"];

/**
 * A directed, acknowledgeable, time-bounded ask from one persona to another:
 * "you specifically need to look at this", with structure instead of prose.
 * The claim/resolve/cancel transitions are announced in chat like every other
 * structured mutation, so peers learn of them through their normal check loop.
 */
export interface ReviewRequest {
  id: number;
  /** The persona being asked. Only they may claim (and so resolve) it. */
  target: string;
  requested_by: string;
  /** What is being asked for. */
  body: string;
  /** Commit hashes, file paths, artifact ids — may be empty. */
  refs: string[];
  priority: ReviewPriority;
  status: ReviewStatus;
  created_ts: string;
  /** When the ask stops gating the target; null means it never expires. */
  expires_ts: string | null;
  /** The ack/lease: who took it and when. */
  claimed_by: string | null;
  claimed_ts: string | null;
  resolved_by: string | null;
  resolved_ts: string | null;
  resolution: string | null;
  cancelled_by: string | null;
  cancelled_ts: string | null;
  cancel_reason: string | null;
}

/**
 * A review request as listed: annotated with derived expiry. Like
 * `presenceState()`, expiry is computed at read time and never written back —
 * there is no scheduler in this codebase to drive time-based transitions, and
 * a lazily-derived flag cannot drift from the stored timestamp.
 */
export interface ReviewRequestView extends ReviewRequest {
  /** True when a still-open request is past its `expires_ts`. */
  expired: boolean;
}

/** Raw `review_requests` row shape (`refs` still JSON-encoded). */
export interface ReviewRow {
  id: number;
  target: string;
  requested_by: string;
  body: string;
  refs: string;
  priority: string;
  status: string;
  created_ts: string;
  expires_ts: string | null;
  claimed_by: string | null;
  claimed_ts: string | null;
  resolved_by: string | null;
  resolved_ts: string | null;
  resolution: string | null;
  cancelled_by: string | null;
  cancelled_ts: string | null;
  cancel_reason: string | null;
}

export function rowToReview(row: ReviewRow, nowMs: number = Date.now()): ReviewRequestView {
  const status = row.status as ReviewStatus;
  return {
    ...row,
    refs: JSON.parse(row.refs) as string[],
    priority: row.priority as ReviewPriority,
    status,
    expired: reviewExpired(row.expires_ts, status, nowMs),
  };
}

/**
 * Whether a request has aged out of gating anyone. Only open requests can be
 * expired — a resolved/cancelled request is already closed, and calling it
 * "expired" as well would be noise.
 */
function reviewExpired(
  expiresTs: string | null,
  status: ReviewStatus,
  nowMs: number = Date.now(),
): boolean {
  if (!expiresTs) return false;
  if (!REVIEW_OPEN_STATUSES.includes(status)) return false;
  const expires = Date.parse(expiresTs);
  return Number.isFinite(expires) && nowMs >= expires;
}


export function reviewRow(ctx: ReviewContext, id: number): ReviewRow {
  const row = ctx.db.prepare("SELECT * FROM review_requests WHERE id = ?").get(id) as
    | ReviewRow
    | undefined;
  if (!row) throw new Error(`no review request with id ${id}`);
  return row;
}

/**
 * Validate a status change against REVIEW_TRANSITIONS, rejecting an illegal
 * one with an error naming the request's *actual* current state (the same
 * validation style `cardTransition` uses for Science Card phases). Nothing
 * is written for a rejected transition.
 */
function assertReviewTransition(row: ReviewRow, to: ReviewStatus): ReviewStatus {
  const from = row.status as ReviewStatus;
  const allowed = REVIEW_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new Error(
      `illegal review request transition ${from} -> ${to} for request ${row.id} ` +
        `(current state: ${from}; allowed from ${from}: ` +
        `${allowed.length ? allowed.join(", ") : "none — terminal state"})`,
    );
  }
  return from;
}

/** One review request with its derived expiry. */
export function reviewGet(ctx: ReviewContext, id: number): ReviewRequestView {
    return rowToReview(reviewRow(ctx, id));
}

/**
 * Open a directed review request: ask one specific persona to look at
 * something, announced in chat as a system message like every other
 * structured mutation. `refs` may be empty; `priority` defaults to
 * `normal`; expiry is optional and may be given either as an explicit ISO
 * `expiresTs` or as an `expiresInMinutes` offset. An `expiresTs` already in
 * the past is accepted and simply never gates anyone — the record of the
 * ask is still worth keeping.
 */
export function reviewOpen(
  ctx: ReviewContext,
  target: string,
  body: string,
  opts: {
    refs?: string[];
    priority?: ReviewPriority;
    expiresTs?: string | null;
    expiresInMinutes?: number;
  } = {},
): ReviewRequestView {
    if (!target?.trim()) throw new Error("review request target is required");
  if (!body?.trim()) throw new Error("review request body is required");
  const priority: ReviewPriority = opts.priority ?? "normal";
  if (!REVIEW_PRIORITIES.includes(priority)) {
    throw new Error(
      `invalid priority "${priority}" (must be one of ${REVIEW_PRIORITIES.join(", ")})`,
    );
  }
  const refs = opts.refs ?? [];

  let expiresTs: string | null = null;
  if (opts.expiresTs !== undefined && opts.expiresTs !== null) {
    const parsed = Date.parse(opts.expiresTs);
    if (!Number.isFinite(parsed)) {
      throw new Error(`invalid expires_ts "${opts.expiresTs}" (must be an ISO timestamp)`);
    }
    expiresTs = new Date(parsed).toISOString();
  } else if (opts.expiresInMinutes !== undefined) {
    const minutes = opts.expiresInMinutes;
    if (!Number.isFinite(minutes) || minutes < 0) {
      throw new Error(`invalid expires_in_minutes "${minutes}" (must be a non-negative number)`);
    }
    expiresTs = new Date(Date.now() + minutes * 60_000).toISOString();
  }

  const ts = now();
  const { lastInsertRowid } = ctx.db
    .prepare(
      `INSERT INTO review_requests
         (target, requested_by, body, refs, priority, status, created_ts, expires_ts)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(target, ctx.persona, body, JSON.stringify(refs), priority, ts, expiresTs);
  const id = Number(lastInsertRowid);
  const refNote = refs.length ? ` (refs: ${refs.join(", ")})` : "";
  const expiryNote = expiresTs ? ` (expires ${expiresTs})` : "";
  ctx.send(
    `${ctx.persona} requested review #${id} from ${target} [${priority}]: ` +
      `${body}${refNote}${expiryNote}`,
    "system",
  );
  return rowToReview({
    id,
    target,
    requested_by: ctx.persona,
    body,
    refs: JSON.stringify(refs),
    priority,
    status: "pending",
    created_ts: ts,
    expires_ts: expiresTs,
    claimed_by: null,
    claimed_ts: null,
    resolved_by: null,
    resolved_ts: null,
    resolution: null,
    cancelled_by: null,
    cancelled_ts: null,
    cancel_reason: null,
  });
}

/**
 * Claim (ack) a request directed at you: records you as the claimant plus a
 * claim timestamp — the lease the request's requester is waiting on — and
 * announces it in chat. Only the `target` may claim, and only while the
 * request is `pending` and unexpired: once expired the gate is already
 * released, so the honest move is a fresh request rather than a late ack.
 */
export function reviewClaim(ctx: ReviewContext, id: number): ReviewRequestView {
    const row = reviewRow(ctx, id);
  assertReviewTransition(row, "claimed");
  if (row.target !== ctx.persona) {
    throw new Error(
      `review request #${id} is directed at ${row.target}, not ${ctx.persona} — ` +
        `only the target may claim it`,
    );
  }
  if (reviewExpired(row.expires_ts, row.status as ReviewStatus)) {
    throw new Error(
      `review request #${id} expired at ${row.expires_ts} — the gate has already been ` +
        `released; open a fresh request instead of claiming this one`,
    );
  }
  const ts = now();
  ctx.db
    .prepare(
      "UPDATE review_requests SET status = 'claimed', claimed_by = ?, claimed_ts = ? WHERE id = ?",
    )
    .run(ctx.persona, ts, id);
  ctx.send(`${ctx.persona} claimed review #${id}: ${row.body}`, "system");
  return rowToReview({ ...row, status: "claimed", claimed_by: ctx.persona, claimed_ts: ts });
}

/**
 * Resolve a request you claimed, announced in chat. Only the claimant may
 * resolve — which, since only the target can claim, means only the target
 * can resolve. Allowed even once expired, so an expired-but-answered ask
 * can still be closed out honestly.
 */
export function reviewResolve(ctx: ReviewContext, id: number, resolution?: string | null): ReviewRequestView {
    const row = reviewRow(ctx, id);
  assertReviewTransition(row, "resolved");
  if (row.claimed_by !== ctx.persona) {
    throw new Error(
      `review request #${id} is claimed by ${row.claimed_by} — only the claimant may resolve it`,
    );
  }
  const ts = now();
  ctx.db
    .prepare(
      `UPDATE review_requests SET status = 'resolved', resolved_by = ?, resolved_ts = ?,
              resolution = ? WHERE id = ?`,
    )
    .run(ctx.persona, ts, resolution ?? null, id);
  ctx.send(
    `${ctx.persona} resolved review #${id}${resolution ? `: ${resolution}` : ""}`,
    "system",
  );
  return rowToReview({
    ...row,
    status: "resolved",
    resolved_by: ctx.persona,
    resolved_ts: ts,
    resolution: resolution ?? null,
  });
}

/**
 * Cancel a request, announced in chat. Either side may cancel: the
 * requester withdraws an ask that no longer matters, the target declines
 * one it cannot take. Nobody else may — a third party cancelling someone
 * else's gate is exactly the coordination failure this primitive exists to
 * prevent. Allowed from both `pending` and `claimed`, and on an expired
 * request (closing the record out).
 */
export function reviewCancel(ctx: ReviewContext, id: number, reason?: string | null): ReviewRequestView {
    const row = reviewRow(ctx, id);
  assertReviewTransition(row, "cancelled");
  if (row.requested_by !== ctx.persona && row.target !== ctx.persona) {
    throw new Error(
      `only the requester (${row.requested_by}) or the target (${row.target}) may cancel ` +
        `review request #${id}`,
    );
  }
  const ts = now();
  ctx.db
    .prepare(
      `UPDATE review_requests SET status = 'cancelled', cancelled_by = ?, cancelled_ts = ?,
              cancel_reason = ? WHERE id = ?`,
    )
    .run(ctx.persona, ts, reason ?? null, id);
  ctx.send(`${ctx.persona} cancelled review #${id}${reason ? `: ${reason}` : ""}`, "system");
  return rowToReview({
    ...row,
    status: "cancelled",
    cancelled_by: ctx.persona,
    cancelled_ts: ts,
    cancel_reason: reason ?? null,
  });
}

/**
 * The directed review requests still gating a persona (its own, by
 * default): `pending` or `claimed`, not expired, most urgent first and
 * oldest first within a priority. This is what `join()` and `checkSummary()`
 * surface so a re-entering peer can work by priority instead of replaying
 * chat chronologically. Expiry is applied here, at read time — a request
 * past its `expires_ts` simply drops out, with no status change and no
 * background process needed to make that happen.
 */
export function pendingReviews(ctx: ReviewContext, persona: string = ctx.persona): ReviewRequestView[] {
    const rows = ctx.db
    .prepare(
      `SELECT * FROM review_requests
        WHERE target = ? AND status IN ('pending', 'claimed')
        ORDER BY id ASC`,
    )
    .all(persona) as unknown as ReviewRow[];
  const nowMs = Date.now();
  return sortReviews(rows.map((r) => rowToReview(r, nowMs)).filter((r) => !r.expired));
}

/**
 * List review requests across the room. Open (`pending`/`claimed`) and
 * unexpired by default; `status` narrows to one status, `includeTerminal`
 * also shows resolved/cancelled ones, and `includeExpired` keeps expired
 * ones in. Sorted like `pendingReviews`: most urgent first.
 */
export function reviewList(
  ctx: ReviewContext,
  opts: {
    target?: string;
    requestedBy?: string;
    status?: ReviewStatus;
    includeExpired?: boolean;
    includeTerminal?: boolean;
  } = {},
): ReviewRequestView[] {
    const statuses: readonly ReviewStatus[] = opts.status
    ? [opts.status]
    : opts.includeTerminal
      ? REVIEW_STATUSES
      : REVIEW_OPEN_STATUSES;
  const where: string[] = [`status IN (${statuses.map(() => "?").join(",")})`];
  const params: string[] = [...statuses];
  if (opts.target) {
    where.push("target = ?");
    params.push(opts.target);
  }
  if (opts.requestedBy) {
    where.push("requested_by = ?");
    params.push(opts.requestedBy);
  }
  const rows = ctx.db
    .prepare(`SELECT * FROM review_requests WHERE ${where.join(" AND ")} ORDER BY id ASC`)
    .all(...params) as unknown as ReviewRow[];
  const nowMs = Date.now();
  const views = rows.map((r) => rowToReview(r, nowMs));
  return sortReviews(opts.includeExpired ? views : views.filter((r) => !r.expired));
}

/** Most urgent first; oldest first within a priority. Stable on id. */
function sortReviews(views: ReviewRequestView[]): ReviewRequestView[] {
  return views.sort((a, b) => {
    const rank = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
    if (rank !== 0) return rank;
    if (a.created_ts !== b.created_ts) return a.created_ts < b.created_ts ? -1 : 1;
    return a.id - b.id;
  });
}
