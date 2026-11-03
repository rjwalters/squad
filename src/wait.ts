/**
 * `squad wait` (#222): the room loop body, moved out of the prompt.
 *
 * An agent used to poll with `squad_check` from its own turn, paying a model
 * turn per 25s check and parking after ~10 empty ones. `squad wait` blocks in
 * code instead: it polls the local database cheaply, renews the caller's
 * presence lease, returns early on activity that concerns the caller, and
 * otherwise waits out an exponentially growing quiet window. Either way it
 * ends with exactly one `next:` action chosen by `chooseNext()`, so a quiet
 * agent is told to pick up work rather than left to drift.
 *
 * The decision logic (`backoffSeconds`, `nextStep`, `wakeReasons`,
 * `chooseNext`) is pure; `runWait` wires it to a `Squad` with an injectable
 * clock so tests never sleep for real.
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { envMinutes } from "./db.js";
import {
  type ClaimView,
  type CrossRoomRequestView,
  type Goal,
  type Member,
  type Message,
  type PresenceState,
  type ReviewRequestView,
  type Squad,
} from "./core.js";
import { mentionsPersona } from "./reentry.js";
import { REPO_BROADCAST } from "./inbox.js";

/** Quiet-call wait lengths, in seconds; the last step repeats. */
export const BACKOFF_SECONDS: readonly number[] = [60, 120, 240, 480];

/** Default `--max`: under Claude Code's 600s Bash tool cap. */
export const DEFAULT_WAIT_MAX_SECONDS = 540;

/** How often the local database is polled while waiting. */
export const DEFAULT_WAIT_POLL_MS = 2_000;

/** How often the presence lease is renewed while waiting. */
export const DEFAULT_WAIT_LEASE_MS = 60_000;

/** Quiet minutes, with nothing open, after which parking is recommended. */
export const DEFAULT_WAIT_PARK_MINUTES = 45;

/** Messages printed per wake; older ones are still consumed, and counted. */
export const WAIT_MESSAGE_LIMIT = 20;

/** Goals listed on the board line before the rest collapse into a count. */
export const WAIT_GOAL_LIMIT = 8;

/** Per-goal body budget on the board line. */
export const WAIT_GOAL_BODY_LENGTH = 60;

export const WAIT_EXIT = { woke: 0, quiet: 2, park: 3 } as const;

export const WAIT_USAGE = `usage: squad wait [--max <seconds>] [--json]
  Block until something in the room concerns you, then print the new messages
  (consumed, like 'squad read --unread'), a short board summary, and exactly
  one 'next:' line. Needs an agent identity (SQUAD_PERSONA or
  SQUAD_SESSION_ID); refuses to run as 'human'.
  Wait length: successive quiet calls wait 60s, 120s, 240s, then 480s, never
  more than --max (default ${DEFAULT_WAIT_MAX_SECONDS}; pass less if your shell
  times out sooner). The step is kept per session and resets after a call that
  wakes on activity. Presence stays live while waiting.
  Wakes early on: unread peer chat, an @mention of you or @repo, a new review
  request for you, a goal added/done/reopened, an inbound cross-room request.
  next: (first that applies) 1 reply/act on directed work (mention, review,
  cross-room request); 2 continue a goal you hold; 3 claim an open goal nobody
  holds (squad_claim goal#<id>); 4 take over a goal held by a stale peer;
  (every open goal held by a live peer: offer help); 5 empty board: propose
  goals; 6 quiet past SQUAD_WAIT_PARK_MINUTES (default ${DEFAULT_WAIT_PARK_MINUTES}) with no open
  goals: post status and park.
  Exit: 0 woke on activity, 2 quiet with a suggestion, 3 park recommended.
  --json prints the same as one JSON object.`;

/** Wait length for a backoff step, capped by `--max`. */
export function backoffSeconds(step: number, maxSeconds: number): number {
  const i = Math.min(Math.max(0, Math.floor(step)), BACKOFF_SECONDS.length - 1);
  return Math.max(0, Math.min(BACKOFF_SECONDS[i]!, maxSeconds));
}

/**
 * The step the following call uses: reset on activity, else one longer. A
 * call that did not wait at all (`--max 0`, a snapshot) keeps its step.
 */
export function nextStep(step: number, woke: boolean, waitedSeconds = 1): number {
  if (woke) return 0;
  const s = Math.max(0, step);
  return waitedSeconds > 0 ? Math.min(s + 1, BACKOFF_SECONDS.length - 1) : s;
}

/** The advisory claim label that marks a goal as someone's. */
export function goalClaimLabel(id: number): string {
  return `goal#${id}`;
}

export type WakeReason = "mention" | "chat" | "review" | "goals" | "cross-room";

/** What one poll saw, against what the previous call already knew. */
export interface WakeObservation {
  persona: string;
  /** Peeked (unconsumed) messages from others since the read cursor. */
  unread: Message[];
  /** Goal board now, and its fingerprint as stored by the previous call (null: none yet). */
  board: BoardRow[];
  storedBoard: string | null;
  /** Newest open review request for the caller, and the newest one already seen. */
  reviewMax: number;
  reviewSeen: number;
}

/** One goal as the wake check sees it. */
export interface BoardRow {
  id: number;
  status: string;
  created_by: string;
  done_by: string | null;
}

/** `id:status` per goal, in id order: what `wait_state.board` stores. */
export function fingerprintOf(rows: BoardRow[]): string {
  return rows.map((r) => `${r.id}:${r.status}`).join(",");
}

/**
 * Whether the board changed in a way the caller didn't cause itself. Its own
 * goal add (absent -> open, created by it) and its own done (open -> done, done
 * by it) are not news; anything else is, including any reopen (the schema
 * does not record who reopened) and a goal that disappeared.
 */
export function boardNews(stored: string, rows: BoardRow[], persona: string): boolean {
  const before = new Map<number, string>();
  for (const part of stored ? stored.split(",") : []) {
    const at = part.lastIndexOf(":");
    before.set(Number(part.slice(0, at)), part.slice(at + 1));
  }
  for (const r of rows) {
    const was = before.get(r.id);
    before.delete(r.id);
    if (was === r.status) continue;
    if (was === undefined && r.status === "open" && r.created_by === persona) continue;
    if (was === "open" && r.status === "done" && r.done_by === persona) continue;
    return true;
  }
  return before.size > 0;
}

/** Why this poll should end the wait; empty means keep waiting. */
export function wakeReasons(o: WakeObservation): WakeReason[] {
  const reasons = new Set<WakeReason>();
  for (const m of o.unread) {
    if (m.route?.direction === "inbound") reasons.add("cross-room");
    if (isMention(m, o.persona)) reasons.add("mention");
    if (m.kind === "chat") reasons.add("chat");
  }
  if (o.reviewMax > o.reviewSeen) reasons.add("review");
  if (o.storedBoard !== null && boardNews(o.storedBoard, o.board, o.persona)) reasons.add("goals");
  const order: WakeReason[] = ["mention", "review", "cross-room", "goals", "chat"];
  return order.filter((r) => reasons.has(r));
}

function isMention(m: Message, persona: string): boolean {
  return (
    m.kind === "chat" &&
    (mentionsPersona(m.body, persona) || mentionsPersona(m.body, REPO_BROADCAST, { exact: true }))
  );
}

export interface GoalHolder {
  persona: string;
  state: PresenceState;
}

/** An open goal with who holds its `goal#<id>` claim. */
export interface GoalView {
  id: number;
  body: string;
  holders: GoalHolder[];
  mine: boolean;
}

/** Open goals annotated with their `goal#<id>` claim holders. */
export function goalViews(goals: Goal[], claims: ClaimView[], persona: string): GoalView[] {
  return goals
    .filter((g) => g.status === "open")
    .map((g) => {
      const label = goalClaimLabel(g.id);
      const holders = claims
        .filter((c) => c.path === label)
        .map((c) => ({ persona: c.persona, state: c.holder_state }));
      return { id: g.id, body: g.body, holders, mine: holders.some((h) => h.persona === persona) };
    });
}

export type NextKind =
  | "reply"
  | "review"
  | "cross-room"
  | "continue"
  | "claim"
  | "takeover"
  | "assist"
  | "propose"
  | "park";

export interface NextAction {
  kind: NextKind;
  /** The goal, message, review or request id the action is about. */
  ref?: number;
  text: string;
}

export interface NextInput {
  persona: string;
  /** Messages delivered by this call. */
  messages: Message[];
  /** Open directed review requests for the caller. */
  reviews: ReviewRequestView[];
  /** Inbound cross-room requests not answered yet. */
  crossRoom: CrossRoomRequestView[];
  goals: GoalView[];
  /** Time since the last room activity, and the park threshold. */
  quietMs: number;
  parkMs: number;
}

const clip = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

/**
 * The one ordered decision behind `next:`. Earlier branches always win, so
 * directed work is never buried under goal housekeeping, and parking is only
 * ever suggested when there is nothing open to do.
 */
export function chooseNext(i: NextInput): NextAction {
  // 1. Directed work: an @mention, a review request, a cross-room request.
  const mention = [...i.messages].reverse().find((m) => isMention(m, i.persona));
  if (mention)
    return {
      kind: "reply",
      ref: mention.id,
      text:
        `reply to ${mention.sender} (message #${mention.id}): squad_send, ` +
        `or squad send --reply ${mention.id} "<text>"`,
    };
  const review = i.reviews[0];
  if (review)
    return {
      kind: "review",
      ref: review.id,
      text:
        `act on review #${review.id} from ${review.requested_by} [${review.priority}]: ` +
        (review.status === "pending" ? "squad_review_claim it, then " : "") +
        "do it and squad_review_resolve",
    };
  const request = i.crossRoom[0];
  if (request)
    return {
      kind: "cross-room",
      ref: request.message_id,
      text:
        `answer cross-room request #${request.message_id} from ${request.origin_persona}: ` +
        `squad send --reply ${request.message_id} "<text>"`,
    };
  // 2. A goal the caller already holds.
  const held = i.goals.find((g) => g.mine);
  if (held)
    return {
      kind: "continue",
      ref: held.id,
      text:
        `continue goal #${held.id} (${clip(held.body, WAIT_GOAL_BODY_LENGTH)}); post progress, ` +
        `squad_goal_done when verified, squad_release ${goalClaimLabel(held.id)} if you stop`,
    };
  // 3. An open goal nobody holds.
  const free = i.goals.find((g) => g.holders.length === 0);
  if (free)
    return {
      kind: "claim",
      ref: free.id,
      text:
        `claim goal #${free.id} (${clip(free.body, WAIT_GOAL_BODY_LENGTH)}): ` +
        `squad_claim ${goalClaimLabel(free.id)} and say so in the room, or post why you can't take it`,
    };
  // 4. A goal whose every holder is stale.
  const orphan = i.goals.find((g) => g.holders.length > 0 && g.holders.every((h) => h.state === "stale"));
  if (orphan) {
    const who = orphan.holders.map((h) => h.persona).join(", ");
    return {
      kind: "takeover",
      ref: orphan.id,
      text:
        `take over goal #${orphan.id} from stale ${who}: say so in the room, ` +
        `squad_release ${goalClaimLabel(orphan.id)}, then squad_claim it`,
    };
  }
  // Open goals exist, all held by live peers: not parkable, nothing to claim.
  if (i.goals.length > 0) {
    const g = i.goals[0]!;
    return {
      kind: "assist",
      ref: g.id,
      text:
        `every open goal is held by a live peer: if you haven't already, offer ${g.holders[0]!.persona} ` +
        `help on #${g.id} or propose a new goal with squad_goal_add; otherwise keep waiting`,
    };
  }
  // 6. Nothing open and the room has been quiet long enough: park.
  if (i.quietMs >= i.parkMs)
    return {
      kind: "park",
      text:
        `room quiet ${Math.floor(i.quietMs / 60_000)}m with no open goals: ` +
        "post a short status and park (see the wait workflow)",
    };
  // 5. Empty board.
  return {
    kind: "propose",
    text: "the board is empty: propose goals with squad_goal_add, or ask the room once what's next " +
      "(if you already asked, just keep waiting)",
  };
}

export interface WaitClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: WaitClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export interface WaitOptions {
  maxSeconds?: number;
  pollMs?: number;
  leaseMs?: number;
  parkMinutes?: number;
  clock?: WaitClock;
  /** Logical session the backoff belongs to (default: SQUAD_SESSION_ID). */
  sessionKey?: string;
}

export interface WaitBoard {
  goals: GoalView[];
  peers: Array<{ persona: string; state: PresenceState }>;
  pending_reviews: Array<{ id: number; requested_by: string; priority: string; status: string; body: string }>;
  cross_room_requests: Array<{ message_id: number; origin_persona: string; body: string }>;
}

export interface WaitResult {
  persona: string;
  exit: 0 | 2 | 3;
  woke: boolean;
  reasons: WakeReason[];
  waited_seconds: number;
  /** This call's wait window and the next call's. */
  wait_seconds: number;
  next_wait_seconds: number;
  messages: Message[];
  /** Consumed messages not printed (beyond WAIT_MESSAGE_LIMIT). */
  omitted_messages: number;
  board: WaitBoard;
  next: NextAction;
}

/** Persisted state row key: never stores the raw resume token. */
export function waitStateKey(persona: string, sessionKey: string | undefined): string {
  return createHash("sha256").update(`${persona}\0${sessionKey ?? ""}`).digest("hex").slice(0, 32);
}

interface StateRow {
  step: number;
  board: string | null;
  review_seen: number;
  started_at: string;
}

function boardRows(db: DatabaseSync): BoardRow[] {
  return db
    .prepare("SELECT id, status, created_by, done_by FROM goals ORDER BY id ASC")
    .all() as unknown as BoardRow[];
}

function boardFingerprint(db: DatabaseSync): string {
  return fingerprintOf(boardRows(db));
}

function reviewMax(db: DatabaseSync, persona: string, nowMs: number): number {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(id), 0) AS m FROM review_requests
        WHERE target = ? AND status = 'pending' AND (expires_ts IS NULL OR expires_ts > ?)`,
    )
    .get(persona, new Date(nowMs).toISOString()) as { m: number };
  return row.m;
}

/**
 * Newest room activity: any message from someone other than the caller, and
 * any goal change. The caller's own posts are excluded, or an agent that
 * posts on every wake would keep resetting its own quiet clock and never
 * park; a fresh intro is covered by the session's `started_at` floor instead.
 * Null for a room with no such history.
 */
function lastActivityMs(db: DatabaseSync, persona: string): number | null {
  const row = db
    .prepare(
      `SELECT MAX(t) AS t FROM (
         SELECT MAX(ts) AS t FROM messages WHERE sender <> ?
         UNION ALL SELECT MAX(created_ts) FROM goals
         UNION ALL SELECT MAX(done_ts) FROM goals)`,
    )
    .get(persona) as { t: string | null };
  return row.t ? Date.parse(row.t) : null;
}

/**
 * One `squad wait` call. Reads and writes the room through `squad` (consuming
 * the caller's unread messages at the end, exactly like `check()`), and keeps
 * the backoff step in `wait_state`.
 */
export async function runWait(squad: Squad, db: DatabaseSync, opts: WaitOptions = {}): Promise<WaitResult> {
  const clock = opts.clock ?? realClock;
  const maxSeconds = opts.maxSeconds ?? DEFAULT_WAIT_MAX_SECONDS;
  const pollMs = Math.max(1, opts.pollMs ?? DEFAULT_WAIT_POLL_MS);
  const leaseMs = opts.leaseMs ?? DEFAULT_WAIT_LEASE_MS;
  const parkMs =
    (opts.parkMinutes ?? envMinutes("SQUAD_WAIT_PARK_MINUTES", DEFAULT_WAIT_PARK_MINUTES)) * 60_000;
  const persona = squad.persona;
  const key = waitStateKey(persona, opts.sessionKey ?? process.env.SQUAD_SESSION_ID);

  squad.touch();
  const stored = db
    .prepare("SELECT step, board, review_seen, started_at FROM wait_state WHERE state_key = ?")
    .get(key) as unknown as StateRow | undefined;
  const step = stored?.step ?? 0;
  const storedBoard = stored?.board ?? null;
  const reviewSeen = stored?.review_seen ?? 0;

  const waitSeconds = backoffSeconds(step, maxSeconds);
  const start = clock.now();
  const startedAt = stored ? Date.parse(stored.started_at) : start;
  const deadline = start + waitSeconds * 1000;
  let lastLease = start;
  let reasons: WakeReason[] = [];
  for (;;) {
    reasons = wakeReasons({
      persona,
      unread: squad.peekUnread(),
      board: boardRows(db),
      storedBoard,
      reviewMax: reviewMax(db, persona, clock.now()),
      reviewSeen,
    });
    const t = clock.now();
    if (reasons.length > 0 || t >= deadline) break;
    await clock.sleep(Math.min(pollMs, deadline - t));
    if (clock.now() - lastLease >= leaseMs) {
      squad.touch();
      lastLease = clock.now();
    }
  }
  const end = clock.now();
  const woke = reasons.length > 0;

  const consumed = squad.check();
  const messages = consumed.slice(-WAIT_MESSAGE_LIMIT);
  const goals = goalViews(squad.goals(), squad.claims(), persona);
  const reviews = squad.pendingReviews();
  const crossRoom = squad.crossRoomRequests();
  const peers = squad.peers();
  // Quiet is measured from the newest room activity, but never from before
  // this session first waited: an agent arriving in a long-silent room (or
  // one with no history) gets a full park threshold of its own. Clamped at 0
  // so a clock skewed behind the room never reads as negative.
  const last = Math.max(lastActivityMs(db, persona) ?? startedAt, startedAt);
  const quietMs = Math.max(0, end - last);
  const next = chooseNext({ persona, messages: consumed, reviews, crossRoom, goals, quietMs, parkMs });

  const following = nextStep(step, woke, waitSeconds);
  db.prepare(
    `INSERT INTO wait_state (state_key, step, board, review_seen, started_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(state_key) DO UPDATE SET
       step = excluded.step, board = excluded.board,
       review_seen = MAX(review_seen, excluded.review_seen), updated_at = excluded.updated_at`,
  ).run(
    key,
    following,
    boardFingerprint(db),
    reviewMax(db, persona, end),
    new Date(startedAt).toISOString(),
    new Date(end).toISOString(),
  );

  return {
    persona,
    exit: woke ? WAIT_EXIT.woke : next.kind === "park" ? WAIT_EXIT.park : WAIT_EXIT.quiet,
    woke,
    reasons,
    waited_seconds: Math.round((end - start) / 1000),
    wait_seconds: waitSeconds,
    next_wait_seconds: backoffSeconds(following, maxSeconds),
    messages,
    omitted_messages: consumed.length - messages.length,
    board: {
      goals,
      peers: peers.map((p: Member) => ({ persona: p.persona, state: p.state })),
      pending_reviews: reviews.map((r) => ({
        id: r.id,
        requested_by: r.requested_by,
        priority: r.priority,
        status: r.status,
        body: r.body,
      })),
      cross_room_requests: crossRoom.map((r) => ({
        message_id: r.message_id,
        origin_persona: r.origin_persona,
        body: r.body,
      })),
    },
    next,
  };
}

function goalTag(g: GoalView, persona: string): string {
  if (g.mine) return "you";
  if (g.holders.length === 0) return "unclaimed";
  return g.holders
    .filter((h) => h.persona !== persona)
    .map((h) => (h.state === "stale" ? `${h.persona}, stale` : h.persona))
    .join("; ");
}

/**
 * The compact text form. It lands in a model's context on every wake, so it
 * is bounded: at most WAIT_MESSAGE_LIMIT messages, WAIT_GOAL_LIMIT goals with
 * clipped bodies, and counts instead of listings for everything else.
 */
export function formatWait(r: WaitResult, fmtMessage: (m: Message) => string): string {
  const lines: string[] = [];
  lines.push(
    r.woke
      ? `woke: ${r.reasons.join(", ")} after ${r.waited_seconds}s (next quiet wait ${r.next_wait_seconds}s)`
      : `quiet: nothing for you in ${r.waited_seconds}s (next wait ${r.next_wait_seconds}s)`,
  );
  if (r.omitted_messages > 0)
    lines.push(`(${r.omitted_messages} earlier message(s) consumed, not shown: squad read -n ${r.omitted_messages + r.messages.length})`);
  for (const m of r.messages) lines.push(fmtMessage(m));
  const b = r.board;
  const shown = b.goals.slice(0, WAIT_GOAL_LIMIT).map(
    (g) => `#${g.id} ${clip(g.body, WAIT_GOAL_BODY_LENGTH)} [${goalTag(g, r.persona)}]`,
  );
  const more = b.goals.length > WAIT_GOAL_LIMIT ? ` · +${b.goals.length - WAIT_GOAL_LIMIT} more` : "";
  lines.push(`goals: ${shown.length ? shown.join(" · ") + more : "none open"}`);
  const peers = b.peers.length ? b.peers.map((p) => `${p.persona} ${p.state}`).join(", ") : "none";
  const extra = [
    b.pending_reviews.length ? `reviews for you: ${b.pending_reviews.length}` : "",
    b.cross_room_requests.length ? `cross-room requests: ${b.cross_room_requests.length}` : "",
  ].filter(Boolean);
  lines.push(`peers: ${peers}${extra.length ? ` | ${extra.join(" | ")}` : ""}`);
  lines.push(`next: ${r.next.text}`);
  return lines.join("\n") + "\n";
}
