import {
  renderOutline,
  publishOutline,
  outlinePublications,
  validateOutlinePath,
  type OutlinePublishOptions,
} from "./outline.js";
import { rebuildNode } from "./node-review-executor.js";
import { buildRoomDoctorReport, commitExistsLocally, type RoomReviewRow } from "./room-doctor.js";
import { nodeMetadata, nodeRevisions, recordNodeRevision, validateNodeMetadata, writeNodeMetadata, bindNodes, type NodeMetadata } from "./nodes.js";
import { executeIntegration, type BankOptions } from "./integration-executor.js";
import { IntegrationLedger, type IntegrationSubmission, type IntegrationFilter } from "./integration-ledger.js";
import { resolveIntegration, validateIntegration, type IntegrationInput, type IntegrationState } from "./integration.js";
import {
  automaticLabel,
  automaticPersona,
  isReservedPersona,
  reserveAutomaticPersona,
  reservedPersonaReason,
  type AgentIdentity,
} from "./identity.js";
import { randomUUID } from "node:crypto";
import { DatabaseSync, backup } from "node:sqlite";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { hostname } from "node:os";
import { canonicalRoomDir, envMinutes, openExistingRoom, ROOM_TABLES, SCHEMA_VERSION } from "./db.js";
import * as cards from "./cards.js";
import { rowToCard } from "./cards.js";
import type {
  Card,
  CardCreateFields,
  CardDetail,
  CardEvidence,
  CardPhase,
  CardRow,
  CardUpdateFields,
  EvidenceType,
} from "./cards.js";
import * as diverge from "./diverge.js";
import type { DivergenceRound, DivergenceStatus, DivergenceSubmission } from "./diverge.js";
import * as reviews from "./reviews.js";
import type { ReviewPriority, ReviewRequestView, ReviewRow, ReviewStatus } from "./reviews.js";
import { assertInboundAllowed, assertReplyAllowed, roomLabel } from "./routing.js";

export interface Message {
  id: number;
  sender: string;
  kind: "chat" | "system";
  body: string;
  /**
   * When `occurrences > 1`, `ts` is the *last* occurrence's timestamp, not the
   * first — see `occurrences` below.
   */
  ts: string;
  /**
   * How many consecutive identical `"system"` messages from `sender` this row
   * represents (#59). Always 1 for `"chat"` messages, and for a `"system"`
   * message whose immediately preceding message from the same sender differs
   * in body. `Squad.send()` collapses an exact repeat into this counter
   * in place — bumping it and refreshing `ts` — instead of inserting a new
   * row, so a persistently failing startup (or any other repeating system
   * notice) occupies one row/slot no matter how many times it recurs.
   */
  occurrences: number;
  /**
   * The posting connection's session id (#135, Option B of #120) -- what
   * distinguishes two sessions sharing one persona, since `sender` alone
   * cannot. For a pinned persona (`SQUAD_PERSONA`), a session resumed via
   * `SQUAD_SESSION_ID` keeps the same stored value. For an automatic
   * identity, `SQUAD_SESSION_ID` is the resume token and must never be
   * readable in the room, so each process stores its own per-process presence
   * id instead; the persona, which is unique per automatic identity, already
   * tells them apart. Each non-resuming session gets a fresh id. NULL for
   * rows written before the column existed. A collapsed `"system"` repeat keeps the session id
   * of the row it collapsed into.
   */
  session_id: string | null;
  /**
   * Cross-room routing metadata (#144) -- present only on a message that
   * arrived through `squad send --room`, a reply to one, a delivered copy of
   * such a reply, or an explicit local reply. Absent for every ordinary
   * message, so their payloads are unchanged.
   */
  route?: MessageRoute;
}

/** How a routed message relates to its thread (see `message_routes`, src/db.ts). */
export type RouteDirection = "inbound" | "reply" | "delivered" | "local-reply";

/**
 * A message's place in a cross-room request/reply thread (#144). Rooms are
 * identified by canonical `.squad` directory paths; `request_id` is the
 * thread's stable identifier across both rooms' databases.
 */
export interface MessageRoute {
  direction: RouteDirection;
  /** Thread id shared by the request and every reply/copy; null for a local reply. */
  request_id: string | null;
  /** inbound: the asking room. reply: the room the reply is delivered to. delivered: the answering room. */
  remote_room: string | null;
  /** inbound: the asker. reply: the asker (recipient). delivered: the replier. */
  remote_persona: string | null;
  /** delivered: the reply's message id in the answering room. */
  remote_message_id: number | null;
  /** reply / delivered: the persona the reply is addressed to (the original asker). */
  recipient: string | null;
  /** reply / local-reply: the local message id replied to. */
  reply_to: number | null;
  /** reply / delivered: the delivery identifier (deduplicates retried deliveries). */
  delivery_id: string | null;
  /** inbound: when the first explicit reply was delivered back, else null. */
  answered_ts: string | null;
  answered_by: string | null;
}

/** An inbound cross-room request still waiting for a delivered reply (#144). */
export interface CrossRoomRequestView {
  request_id: string;
  /** Local id of the request message in this room. */
  message_id: number;
  origin_room: string;
  origin_persona: string;
  sender: string;
  body: string;
  created_ts: string;
  age_ms: number;
  /** Replies already stored here whose delivery is still pending, if any. */
  pending_deliveries: PendingDeliveryView[];
}

/** A stored cross-room reply whose delivery to the asking room has not succeeded yet (#144). */
export interface PendingDeliveryView {
  delivery_id: string;
  request_id: string;
  /** Local id of the stored reply. */
  message_id: number;
  dest_room: string;
  recipient: string;
  attempts: number;
  last_error: string | null;
  created_ts: string;
  age_ms: number;
}

/** Outcome of one successful (or already-complete) cross-room delivery (#144). */
export interface DeliveryResult {
  delivery_id: string;
  request_id: string;
  dest_room: string;
  recipient: string;
  /** 'delivered' on this call, or 'already-delivered' when a retry found it done. */
  status: "delivered" | "already-delivered";
  /** The copy's message id in the destination room, when known. */
  remote_message_id: number | null;
  delivered_ts: string | null;
}

/** What `Squad.reply()` returns. */
export interface ReplyResult {
  /** The reply as stored in this room. */
  message: Message;
  /** True when the reply was routed to another room; false for a local reply. */
  routed: boolean;
  delivery?: DeliveryResult;
}

/**
 * Failure-injection seams for crash-safety tests of cross-room delivery
 * (#144). Never set in production: a hook that throws simulates a crash just
 * before or just after the origin room's copy is committed.
 */
export interface DeliveryFaults {
  beforeOriginCommit?: () => void;
  afterOriginCommit?: () => void;
}

interface RouteRow extends MessageRoute {
  message_id: number;
  created_ts: string;
}

interface DeliveryRow {
  delivery_id: string;
  request_id: string;
  message_id: number;
  dest_room: string;
  recipient: string;
  status: "pending" | "delivered";
  attempts: number;
  last_error: string | null;
  created_ts: string;
  delivered_ts: string | null;
}

function toRoute(row: RouteRow): MessageRoute {
  return {
    direction: row.direction,
    request_id: row.request_id,
    remote_room: row.remote_room,
    remote_persona: row.remote_persona,
    remote_message_id: row.remote_message_id,
    recipient: row.recipient,
    reply_to: row.reply_to,
    delivery_id: row.delivery_id,
    answered_ts: row.answered_ts,
    answered_by: row.answered_by,
  };
}

/** Run `fn` in an IMMEDIATE transaction on `db`, rolling back on any throw. */
function immediate<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // COMMIT itself failed and already ended the transaction.
    }
    throw err;
  }
}

/**
 * Deliver a `squad send --room` message into `destRoom` as a replyable
 * cross-room request (#144). `db` is the destination room's database and
 * `originRoom`/`originPersona` were resolved in the *sending* room before the
 * target override, so no persona is minted here. Checks the destination's
 * inbound policy first; writes the message and its routing row atomically.
 * The message carries no session id: the sender's session belongs to its own
 * room, and an automatic identity's resume token must never appear here.
 */
export function receiveCrossRoomRequest(
  db: DatabaseSync,
  destRoom: string,
  input: { body: string; originRoom: string; originPersona: string },
): Message {
  const body = input.body.trim();
  if (!body) throw new Error("cross-room message body is empty");
  assertInboundAllowed(destRoom, input.originRoom);
  const originRoom = canonicalRoomDir(input.originRoom);
  const sender = `${input.originPersona}@${roomLabel(originRoom)}`;
  const ts = now();
  const requestId = randomUUID();
  return immediate(db, () => {
    const { lastInsertRowid } = db
      .prepare("INSERT INTO messages (sender, kind, body, ts, occurrences, session_id) VALUES (?, 'chat', ?, ?, 1, NULL)")
      .run(sender, body, ts);
    const id = Number(lastInsertRowid);
    db.prepare(
      `INSERT INTO message_routes (message_id, direction, request_id, remote_room, remote_persona, created_ts)
       VALUES (?, 'inbound', ?, ?, ?, ?)`,
    ).run(id, requestId, originRoom, input.originPersona, ts);
    return {
      id,
      sender,
      kind: "chat" as const,
      body,
      ts,
      occurrences: 1,
      session_id: null,
      route: {
        direction: "inbound" as const,
        request_id: requestId,
        remote_room: originRoom,
        remote_persona: input.originPersona,
        remote_message_id: null,
        recipient: null,
        reply_to: null,
        delivery_id: null,
        answered_ts: null,
        answered_by: null,
      },
    };
  });
}

export interface Goal {
  id: number;
  body: string;
  status: "open" | "done";
  created_by: string;
  created_ts: string;
  done_by: string | null;
  done_ts: string | null;
}

/**
 * Derived presence, never stored: `active` = touched the room within the idle
 * window (taking a turn right now), `idle` = quiet but its lease is still
 * good (a deliberate pause), `stale` = the lease expired (treat as gone).
 */
export type PresenceState = "active" | "idle" | "stale";

/**
 * One connection's presence lease. A row per *session* (an MCP server process,
 * a CLI invocation), not per persona: the same persona can legitimately be in
 * the room twice. Renewed by `touch()` on every operation; ended explicitly by
 * `leave()`, which stamps `left_ts`.
 */
export interface Session {
  session_id: string;
  persona: string;
  joined_at: string;
  last_seen: string;
  lease_expires_at: string;
  /** Set when the session left explicitly; null while the session is live. */
  left_ts: string | null;
}

/**
 * A persona present in the room: the live sessions of one persona rolled up,
 * annotated with derived presence so a peer can tell a pause from a death
 * without asking.
 */
export interface Member {
  persona: string;
  /** First time this persona was ever seen (survives leaving and rejoining). */
  first_seen: string;
  /** Freshest last_seen across this persona's live sessions. */
  last_seen: string;
  /** When the freshest lease runs out; past this the persona reads as stale. */
  lease_expires_at: string;
  state: PresenceState;
  /** How many live sessions this persona holds (usually 1). */
  sessions: number;
  /**
   * One entry per live session, freshest first — present only when
   * `sessions > 1`, i.e. when unrelated agents share this persona and the
   * rolled-up presence cannot say which of them is active (#120, #136).
   * Omitted for a single-session persona, whose payload is unchanged.
   */
  sessions_detail?: MemberSession[];
}

/**
 * One live session of a shared persona, as listed in
 * `Member.sessions_detail`. `session_id` is the full presence-session id —
 * the same value `Message.session_id` records — so a message can be matched
 * to the seat that posted it; `shortSessionId()` gives its display form.
 */
export interface MemberSession {
  session_id: string;
  joined_at: string;
  last_seen: string;
  lease_expires_at: string;
  state: PresenceState;
}

/** Characters of a session id shown wherever a session is displayed. */
export const SHORT_SESSION_ID_LENGTH = 8;

/**
 * The display form of a presence-session id (its first
 * SHORT_SESSION_ID_LENGTH characters), used by `squad who` to tell apart
 * the sessions of a shared persona. Full ids are stored and returned in
 * payloads; this is only how they are rendered for a human.
 */
export function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, SHORT_SESSION_ID_LENGTH);
}

/** An advisory claim on a file path (or freeform label). Never a lock. */
export interface Claim {
  id: number;
  path: string;
  persona: string;
  created_ts: string;
}

/** A claim as listed: annotated with its holder's presence so peers can judge it. */
export interface ClaimView extends Claim {
  /** Holder's last_seen, or null when the holder has no live session. */
  last_seen: string | null;
  /** The holder's presence, from the same lease signal `members()` reports. */
  holder_state: PresenceState;
  /** True when the holder's lease has expired — i.e. holder_state is stale. */
  stale: boolean;
}

/** What `leave()` did: the sessions it ended, or an empty result for a no-op. */
export interface LeaveResult {
  persona: string;
  /** Session ids ended by this call (empty when the caller held none). */
  sessions_ended: string[];
  /** When they ended, or null for a no-op. */
  left_ts: string | null;
  /** Live sessions this persona still holds after the call. */
  sessions_remaining: number;
}

/**
 * The outcome of a requested rename (see `Squad.requestPersona`): whether it
 * took effect, the identity in force afterwards, and — when it did not — why.
 */
export interface PersonaRequestResult {
  /** The connection's identity after the request (unchanged when refused). */
  persona: string;
  /** True when the rename took effect. */
  applied: boolean;
  /** Present only when the rename was refused: the reason, for the caller. */
  note?: string;
}

/**
 * Another connection is already in the room under the identity you just
 * joined as. Co-named sessions are filtered out of each other's messages by
 * self-suppression (`check()` excludes your own sender), so this is reported
 * rather than left to be discovered as unexplained silence (#50).
 */
export interface IdentityCollision {
  /** The contested identity. */
  persona: string;
  /** Other sessions currently holding it with an unexpired lease. */
  session_ids: string[];
  /** Human-readable warning, including the way out. */
  note: string;
}

/** What `join()` returns: the caller's lease plus a full room snapshot. */
export interface JoinResult {
  session_id: string;
  joined_at: string;
  lease_expires_at: string;
  /** Everyone present, including the caller, with derived presence. */
  members: Member[];
  goals: Goal[];
  nodes: ReturnType<Squad["nodeList"]>;
  claims: ClaimView[];
  /**
   * Directed review requests still gating the caller (see `pendingReviews`):
   * most urgent first, so a re-entering peer can work by priority instead of
   * reading chat chronologically.
   */
  pending_reviews: ReviewRequestView[];
  /**
   * Cross-room requests (#144) that arrived here and have no delivered reply
   * yet, oldest first, read from durable routing state rather than `recent`,
   * so an old unanswered request stays visible however busy the room is.
   */
  cross_room_requests: CrossRoomRequestView[];
  /** Replies stored here whose delivery to the asking room is still pending. */
  pending_deliveries: PendingDeliveryView[];
  recent: Message[];
  /**
   * Set only when the identity you joined under is already held by another
   * live session — the silent-mute condition from #50.
   */
  identity_collision?: IdentityCollision;
}

/**
 * The room-state summary `squad_check` returns alongside your unread
 * messages. Extracted from the MCP handler so its contents — in particular
 * the pending-directed review counts — are directly testable.
 */
export interface CheckSummary {
  integration: ReturnType<Squad["integrationSummary"]>;
  peers: Member[];
  session_id: string | null;
  lease_expires_at: string | null;
  open_goals: number;
  active_claims: number;
  /** How many directed review requests are still gating you. */
  pending_review_count: number;
  /** Those same requests, most urgent first. */
  pending_reviews: ReviewRequestView[];
  /** How many inbound cross-room requests have no delivered reply yet (#144). */
  cross_room_request_count: number;
  /** Those requests, oldest first. */
  cross_room_requests: CrossRoomRequestView[];
}

export {
  REVIEW_OPEN_STATUSES,
  REVIEW_PRIORITIES,
  REVIEW_STATUSES,
  type ReviewPriority,
  type ReviewRequest,
  type ReviewRequestView,
  type ReviewStatus,
} from "./reviews.js";
export type { DivergenceRound, DivergenceStatus, DivergenceSubmission } from "./diverge.js";

export {
  CARD_PHASES,
  CARD_TERMINAL_PHASES,
  CARD_UPDATE_FIELDS,
  EVIDENCE_TYPES,
} from "./cards.js";
export type {
  Card,
  CardCreateFields,
  CardDetail,
  CardEvidence,
  CardPhase,
  CardTransition,
  CardUpdateFields,
  ClaimKind,
  EvidenceType,
} from "./cards.js";

const now = () => new Date().toISOString();

/**
 * The presence lease: every operation renews it for this many minutes. Once a
 * persona's lease has expired it reads as `stale` — and so do its advisory
 * claims, so a peer can take them over explicitly. Advisory only — nothing
 * expires or is enforced, the state is just visible.
 */
export const DEFAULT_STALE_MINUTES = 30;

/**
 * How long after its last touch a persona still counts as `active` (mid-turn)
 * rather than `idle`. Shorter than the lease: idle is the honest answer for a
 * deliberate pause, stale is the honest answer for a dead session.
 */
export const DEFAULT_IDLE_MINUTES = 5;

function staleMinutes(): number {
  return envMinutes("SQUAD_STALE_MINUTES", DEFAULT_STALE_MINUTES);
}

/** Never longer than the lease itself, so the three states stay ordered. */
function idleMinutes(): number {
  return Math.min(envMinutes("SQUAD_IDLE_MINUTES", DEFAULT_IDLE_MINUTES), staleMinutes());
}

/**
 * The single presence rule, shared by peer state and claim staleness so the two
 * can never disagree: the stored lease decides stale, the idle window decides
 * active. No live session at all (never joined, or left explicitly) is stale.
 */
export function presenceState(
  lastSeen: string | null,
  leaseExpiresAt: string | null,
  nowMs: number = Date.now(),
): PresenceState {
  if (!lastSeen) return "stale";
  const seen = Date.parse(lastSeen);
  const expires = leaseExpiresAt ? Date.parse(leaseExpiresAt) : seen + staleMinutes() * 60_000;
  if (nowMs >= expires) return "stale";
  return nowMs < seen + idleMinutes() * 60_000 ? "active" : "idle";
}

/**
 * Session rows older than this are swept on join: a session nobody has touched
 * for a day is long past stale, and without a sweep every process that ever
 * connected would accumulate a row forever.
 */
const SESSION_RETENTION_HOURS = 24;

/**
 * The one separator a refined persona may use. A pinned identity
 * (`SQUAD_PERSONA`) is a *namespace*, not an exact name: `codex` may join as
 * `codex-2`, never as `fable`.
 *
 * `-` only, deliberately. Issue #50 also floated `codex/sol3`, but `/` is
 * outside the charset the MCP `persona` argument validates against
 * (`^[a-z0-9][a-z0-9_-]{0,127}$`), so such a request is rejected by input
 * validation before any refinement logic sees it — and a persona string is
 * interpolated into chat announcements, claim listings, and CLI output, where
 * a path-like separator reads as a path. `_` is left out for the same reason
 * one separator is better than two: `<pinned>-<n>` is the single convention
 * documented in the fanout skill, so there is nothing to guess.
 */
export const PERSONA_REFINEMENT_SEPARATOR = "-";

/**
 * Does `requested` refine `pinned`? True for the pinned name itself and for
 * `<pinned>-<suffix>`; false for everything else. This is what keeps the pin's
 * anti-impersonation property while letting N sessions of one agent hold
 * distinct identities: `codex` -> `codex-2` is a refinement, `codex` -> `fable`
 * is not, and neither is `codex` -> `codex2` (a different name that merely
 * looks similar). Compared case-insensitively, matching the case-insensitive
 * regex the `persona` argument is validated with.
 */
export function isPersonaRefinement(pinned: string, requested: string): boolean {
  const base = pinned.toLowerCase();
  const want = requested.toLowerCase();
  if (want === base) return true;
  const prefix = base + PERSONA_REFINEMENT_SEPARATOR;
  return want.startsWith(prefix) && want.length > prefix.length;
}

export class Squad {
  /** This connection's session, created lazily on first touch. */
  private _sessionId: string | null = null;

  /**
   * The session id the caller supplied (`SQUAD_SESSION_ID`, or the `session_id`
   * a hook receives on stdin) — the stable name of one *logical* session across
   * the many short-lived processes an agent runs (#124). Null when the caller
   * gave nothing, in which case every connection mints its own on first touch,
   * exactly as before.
   *
   * Only meaningful for an explicit persona: an automatic identity's
   * `sessionId` is its *resume token* (it keys `agent_identities`, see
   * `identityId`), a different thing from a presence session row.
   */
  private readonly pinnedSessionId: string | null;

  constructor(
    private db: DatabaseSync,
    persona?: string,
    identity: AgentIdentity = {},
  ) {
    this.automaticIdentity = persona === undefined
      ? { ...identity, sessionId: identity.sessionId ?? randomUUID() }
      : null;
    const supplied = identity.sessionId?.trim();
    this.pinnedSessionId = persona !== undefined && supplied ? supplied : null;
    // Seed the session *before* the first touch(), so a pinned caller reuses
    // its one row instead of inserting a phantom live row per process — which
    // over-reported `squad who` session counts and made join() warn a pinned
    // persona about an `identity_collision` with its own earlier CLI calls.
    this._sessionId = this.pinnedSessionId;
    if (persona !== undefined) {
      // An explicit identity (a `SQUAD_PERSONA` pin, a CLI default, an
      // already-resolved rename) must not be a reserved room-wide target.
      // This is the loud entry point: a misconfigured pin fails at open time
      // rather than silently shadowing `@repo` for every other agent.
      if (isReservedPersona(persona)) throw new Error(reservedPersonaReason(persona));
      this._persona = persona;
    } else {
      const reserved = reserveAutomaticPersona(db, this.automaticIdentity!);
      this._persona = reserved.persona;
      // Only a name this connection just minted, with no trusted SQUAD_MODEL,
      // may still take a self-reported label — and only until first published.
      this.labelOpen = reserved.minted && !this.automaticIdentity!.model?.trim();
    }
  }

  private _persona: string;
  private automaticIdentity: AgentIdentity | null;

  /**
   * Called after a message row is inserted (#113) -- src/mcp.ts sets this to
   * `opportunisticRelay(db)` so a live server ships room chat as it happens.
   * Must be fire-and-forget: it runs inside the tool call's request path, so
   * it is invoked through `messageInserted()`, which swallows anything it
   * throws, and it must not return work the caller would wait on. Unset (the
   * default, and always for the CLI) means no relay side effect at all.
   */
  onMessageInserted: (() => void) | null = null;

  /** Test-only crash-injection hooks for cross-room delivery (#144). */
  deliveryFaults: DeliveryFaults | null = null;

  private _roomDir: string | null | undefined;

  /**
   * Canonical directory of this room (the dir holding squad.db), derived from
   * the open database file itself so every caller agrees on the room's
   * identity without plumbing a path through. Null for an in-memory db, which
   * therefore cannot take part in cross-room routing.
   */
  get roomDir(): string | null {
    if (this._roomDir === undefined) {
      const rows = this.db.prepare("PRAGMA database_list").all() as unknown as Array<{ name: string; file: string }>;
      const file = rows.find((r) => r.name === "main")?.file;
      this._roomDir = file ? canonicalRoomDir(dirname(file)) : null;
    }
    return this._roomDir;
  }

  private messageInserted(): void {
    try {
      this.onMessageInserted?.();
    } catch {
      // A relay hook can never fail the room operation that triggered it.
    }
  }
  /** Whether a self-reported model may still relabel this automatic identity. */
  private labelOpen = false;

  /** Automatic resume token; explicit personas must resume through SQUAD_PERSONA. */
  get identityId(): string | null {
    return this.automaticIdentity?.sessionId ?? null;
  }

  get persona(): string {
    return this._persona;
  }

  /** This connection's session id, or null before its first operation. */
  get sessionId(): string | null {
    return this._sessionId;
  }

  /** SAVEPOINTs preserve a read snapshot without writes and nest inside callers. */
  private nodeTransaction<T>(fn: () => T): T {
    const savepoint = `node_${randomUUID().replaceAll("-", "")}`;
    this.db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = fn();
      this.db.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      this.db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw error;
    }
  }

  nodeCreate(fields: CardCreateFields & Partial<NodeMetadata>) {
    return this.nodeTransaction(() => {
      const metadata = validateNodeMetadata(this.db, null, {
        dependencies: fields.dependencies ?? [],
        artifacts: fields.artifacts ?? [],
      });
      this.touch();
      const card = cards.cardCreate(this.cardContext(), fields);
      writeNodeMetadata(this.db, card.id, metadata);
      recordNodeRevision(
        this.db,
        card.id,
        this.persona,
        this.sessionId,
        "created",
      );
      return this.nodeGet(card.id);
    });
  }

  nodeUpdate(
    id: number,
    expectedRevision: number,
    fields: Partial<NodeMetadata>,
  ) {
    return this.nodeTransaction(() => {
      const node = this.nodeGet(id);
      if (node.revision !== expectedRevision)
        throw new Error("node: content revision changed; read node again");
      if (
        Object.keys(fields).some(
          (key) => key !== "dependencies" && key !== "artifacts",
        ) ||
        !Object.keys(fields).length
      )
        throw new Error(
          "node: update requires dependencies or artifacts; use card edit for research fields",
        );
      const metadata = validateNodeMetadata(this.db, id, {
        ...nodeMetadata(this.db, id),
        ...fields,
      });
      this.touch();
      writeNodeMetadata(this.db, id, metadata);
      recordNodeRevision(this.db, id, this.persona, this.sessionId, "edited");
      const updated = this.nodeGet(id);
      if (updated.revision !== node.revision)
        this.send(
          `${this.persona} updated research node #${id}: ${Object.keys(fields).join(", ")}`,
          "system",
        );
      return updated;
    });
  }

  /** Pure read: presence, leases, cursor and node history are never changed. */
  nodeGet(id: number) {
    return this.nodeTransaction(() => this.nodeGetSnapshot(id));
  }

  private nodeGetSnapshot(id: number) {
    if (!Number.isSafeInteger(id) || id < 1)
      throw new Error("node: invalid node ID");
    const row = this.db
      .prepare("SELECT * FROM science_cards WHERE id = ?")
      .get(id) as CardRow | undefined;
    if (!row) throw new Error(`node: no science card with id ${id}`);
    const revisions = nodeRevisions(this.db, id),
      revision = revisions.at(-1)?.revision ?? null;
    const configuration = this.integrationGet();
    const links = (
      this.db
        .prepare(
          "SELECT revision, attempt_id FROM node_integrations WHERE card_id = ? ORDER BY attempt_id",
        )
        .all(id) as { revision: number; attempt_id: string }[]
    ).map((link) => {
      const attempt = this.integrationAttempt(link.attempt_id);
      return {
        ...link,
        current: link.revision === revision,
        status: attempt.status,
        config_revision: attempt.config_revision,
        current_configuration:
          configuration.config !== null &&
          configuration.revision === attempt.config_revision,
        source_commits: attempt.commits,
        selection: attempt.selection,
        integrated:
          attempt.evidence.filter((e) => e.event.kind === "verified").at(-1)
            ?.event ?? null,
      };
    });
    const reviews = (
      this.db
        .prepare(
          "SELECT request_key, receipt_json FROM node_reviews WHERE card_id=? ORDER BY rowid",
        )
        .all(id) as { request_key: string; receipt_json: string }[]
    ).map((row) => {
      const receipt = JSON.parse(row.receipt_json);
      return {
        ...receipt,
        request_key: row.request_key,
        current:
          receipt.revision === revision &&
          receipt.config_revision === configuration.revision &&
          configuration.config !== null,
      };
    });
    return {
      ...rowToCard(row),
      ...nodeMetadata(this.db, id),
      revision,
      revisions,
      evidence: this.db
        .prepare(
          "SELECT * FROM science_card_evidence WHERE card_id = ? ORDER BY id",
        )
        .all(id),
      transitions: this.db
        .prepare(
          "SELECT * FROM science_card_transitions WHERE card_id = ? ORDER BY id",
        )
        .all(id),
      integrations: links,
      banked: links.some(
        (link) =>
          link.current &&
          link.current_configuration &&
          link.status === "verified",
      ),
      reviews,
      review_builds: this.db
        .prepare(
          "SELECT b.review_id, b.build_json FROM node_review_builds b JOIN node_reviews r ON r.id=b.review_id WHERE r.card_id=? ORDER BY b.rowid",
        )
        .all(id)
        .map((row) => ({
          review_id: row.review_id,
          build: JSON.parse(row.build_json as string),
        })),
      review_requests: this.db
        .prepare(
          "SELECT n.*, r.status, r.target, r.expires_ts FROM node_review_requests n JOIN review_requests r ON r.id=n.request_id WHERE n.card_id=? ORDER BY n.request_id",
        )
        .all(id),
      review_status:
        [...reviews]
          .sort((a, b) => String(b.completed_ts ?? b.created_ts).localeCompare(String(a.completed_ts ?? a.created_ts)))
          .find((r) => r.current && ["approved", "rejected"].includes(r.status))
          ?.status ?? "unreviewed",
    };
  }

  nodeList() {
    return this.nodeTransaction(() =>
      (
        this.db.prepare("SELECT id FROM science_cards ORDER BY id").all() as {
          id: number;
        }[]
      ).map(({ id }) => {
        const node = this.nodeGetSnapshot(id);
        return {
          id,
          title: node.title,
          question: node.question,
          phase: node.phase,
          revision: node.revision,
          dependencies: node.dependencies,
          artifacts: node.artifacts,
          banked: node.banked,
          review_status: node.review_status,
        };
      }),
    );
  }

  nodeClaim(id: number, expectedRevision: number, target?: string) {
    return this.nodeTransaction(() => {
      const node = this.nodeGet(id);
      if (node.revision !== expectedRevision)
        throw new Error(
          "node: content revision changed; open a fresh revision request",
        );
      const reviewer = target ?? this.integrationGet().config?.steward;
      if (typeof reviewer !== "string" || !reviewer.trim())
        throw new Error("node: named reviewer or configured steward required");
      const existing = this.db
        .prepare(
          `SELECT r.* FROM review_requests r JOIN node_review_requests n ON n.request_id=r.id WHERE n.card_id=? AND n.revision=? AND r.status IN ('pending','claimed') AND (r.expires_ts IS NULL OR r.expires_ts > ?) ORDER BY r.id LIMIT 1`,
        )
        .get(id, expectedRevision, now()) as ReviewRow | undefined;
      if (existing && existing.target !== reviewer)
        throw new Error(
          "node: active review targets another reviewer; its requester or target must cancel it explicitly",
        );
      const review = existing
        ? reviews.rowToReview(existing)
        : this.reviewOpen(
            reviewer,
            `Independently review node #${id} revision ${expectedRevision}`,
            { refs: [`node:${id}@${expectedRevision}`] },
          );
      if (!existing)
        this.db
          .prepare("INSERT INTO node_review_requests VALUES (?, ?, ?)")
          .run(review.id, id, expectedRevision);
      return {
        claim: this.claim(`node:${id}`),
        review,
        node_id: id,
        revision: expectedRevision,
      };
    });
  }

  async nodeReview(
    requestId: number,
    input: {
      request_key: string;
      attempt_id: string;
      verdict: "approve" | "reject";
      rationale: string;
    },
    options: BankOptions = {},
  ) {
    if (
      !Number.isSafeInteger(requestId) ||
      requestId < 1 ||
      !input ||
      Object.keys(input).some(
        (k) =>
          !["request_key", "attempt_id", "verdict", "rationale"].includes(k),
      ) ||
      !["approve", "reject"].includes(input.verdict) ||
      [input.request_key, input.attempt_id, input.rationale].some(
        (v) => typeof v !== "string" || !v.trim() || v.includes("\0"),
      )
    )
      throw new Error("node review: invalid input");
    const timeout = options.build_timeout_ms ?? 1_800_000;
    if (
      !Number.isSafeInteger(timeout) ||
      timeout < 1000 ||
      timeout > 86_400_000
    )
      throw new Error("node review: build_timeout_ms must be 1000..86400000");
    const reviewer = this.persona;
    const payload = JSON.stringify({
      requestId,
      reviewer,
      request_key: input.request_key,
      attempt_id: input.attempt_id,
      verdict: input.verdict,
      rationale: input.rationale,
    });
    const setup = this.nodeTransaction(() => {
      const prior = this.db
        .prepare("SELECT * FROM node_reviews WHERE request_key=?")
        .get(input.request_key) as
        | { payload_json: string; receipt_json: string; lease_expires: number }
        | undefined;
      if (prior) {
        if (prior.payload_json !== payload)
          throw new Error(
            "node review: request_key already used with different actor or payload",
          );
        const receipt = JSON.parse(prior.receipt_json);
        if (receipt.status !== "running") return { receipt };
        if (prior.lease_expires > Date.now())
          throw new Error("node review: verification already running");
        // An interrupted process has no completed build proof. Retain that fact.
        receipt.status = "failed";
        receipt.error =
          "verification interrupted before durable completion; use a fresh request key";
        this.db
          .prepare("UPDATE node_reviews SET receipt_json=? WHERE request_key=?")
          .run(JSON.stringify(receipt), input.request_key);
        return { receipt };
      }
      const request = this.reviewRow(requestId);
      if (
        request.status !== "claimed" ||
        request.claimed_by !== reviewer ||
        request.target !== reviewer
      )
        throw new Error(
          "node review: only the claimed request's reviewer may verify",
        );
      const binding = this.db
        .prepare(
          "SELECT card_id, revision FROM node_review_requests WHERE request_id=?",
        )
        .get(requestId) as { card_id: number; revision: number } | undefined;
      if (!binding)
        throw new Error("node review: request is not bound to a node");
      const node = this.nodeGet(binding.card_id);
      if (node.revision !== binding.revision)
        throw new Error(
          "node review: stale content revision; open a fresh request",
        );
      const attempt = this.integrationAttempt(input.attempt_id);
      const linked = node.integrations.find(
        (link) =>
          link.attempt_id === attempt.id && link.revision === binding.revision,
      );
      const verified = attempt.evidence
        .map((e) => e.event)
        .reverse()
        .find((e) => e.kind === "verified");
      if (
        !linked ||
        !linked.current_configuration ||
        attempt.status !== "verified" ||
        verified?.kind !== "verified"
      )
        throw new Error(
          "node review: exact node revision requires a verified bank under current configuration",
        );
      if (
        request.requested_by === reviewer ||
        attempt.submitted_by === reviewer ||
        node.created_by === reviewer ||
        node.revisions.some(
          (r) =>
            r.actor === reviewer ||
            (r.session_id !== null && r.session_id === this.sessionId),
        )
      )
        throw new Error(
          "node review: contributing author cannot independently review their own node",
        );
      this.touch();
      const receipt = {
        id: randomUUID(),
        request_id: requestId,
        request_created_ts: request.created_ts,
        node_id: binding.card_id,
        revision: binding.revision,
        attempt_id: attempt.id,
        config_revision: attempt.config_revision,
        reviewer,
        session_id: this.sessionId,
        identity_id: this.identityId,
        provider: this.automaticIdentity?.provider ?? null,
        model: this.automaticIdentity?.model ?? null,
        commit: verified.commit,
        tree: verified.tree,
        verdict: input.verdict,
        rationale: input.rationale,
        status: "running",
        created_ts: now(),
        completed_ts: null as string | null,
        build: null as Awaited<ReturnType<typeof rebuildNode>> | null,
      };
      this.db
        .prepare("INSERT INTO node_reviews VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(
          receipt.id,
          input.request_key,
          requestId,
          binding.card_id,
          binding.revision,
          payload,
          JSON.stringify(receipt),
          Date.now() + 120_000,
        );
      return { receipt, attempt };
    });
    if (!setup.attempt) return setup.receipt;
    const { receipt, attempt } = setup;
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const timer = setInterval(() => {
      try {
        const changed = this.db
          .prepare(
            "UPDATE node_reviews SET lease_expires=? WHERE id=? AND lease_expires>? AND json_extract(receipt_json, '$.status')='running'",
          )
          .run(Date.now() + 120_000, receipt.id, Date.now());
        if (!changed.changes) throw new Error("node review: runner lease lost");
        this.touch();
      } catch {
        controller.abort();
      }
    }, 10_000);
    try {
      receipt.build = await rebuildNode(attempt, receipt.commit, receipt.tree, {
        ...options,
        signal: controller.signal,
      });
      return this.nodeTransaction(() => {
        const stored = this.db
          .prepare(
            "SELECT receipt_json, lease_expires FROM node_reviews WHERE id=?",
          )
          .get(receipt.id) as
          | { receipt_json: string; lease_expires: number }
          | undefined;
        if (!stored) return { ...receipt, status: "cancelled" };
        this.db
          .prepare("INSERT OR IGNORE INTO node_review_builds VALUES (?, ?)")
          .run(receipt.id, JSON.stringify(receipt.build));
        const prior = JSON.parse(stored.receipt_json);
        if (prior.status !== "running") return prior;
        const request = this.reviewRow(requestId),
          node = this.nodeGet(receipt.node_id);
        receipt.status =
          stored.lease_expires <= Date.now() || controller.signal.aborted
            ? "failed"
            : request.status === "cancelled"
              ? "cancelled"
              : this.persona !== reviewer ||
                  request.status !== "claimed" ||
                  request.claimed_by !== reviewer ||
                  request.target !== reviewer ||
                  request.created_ts !== receipt.request_created_ts ||
                  !node.integrations.some(
                    (link) =>
                      link.attempt_id === receipt.attempt_id &&
                      link.revision === receipt.revision &&
                      link.status === "verified" &&
                      link.current_configuration,
                  ) ||
                  node.revision !== receipt.revision ||
                  this.integrationGet().revision !== receipt.config_revision
                ? "stale"
                : receipt.build!.exit_code !== 0 || !receipt.build!.clean
                  ? "failed"
                  : input.verdict === "approve"
                    ? "approved"
                    : "rejected";
        receipt.completed_ts = now();
        this.db
          .prepare(
            "UPDATE node_reviews SET receipt_json=?, lease_expires=0 WHERE id=?",
          )
          .run(JSON.stringify(receipt), receipt.id);
        if (receipt.status === "approved" || receipt.status === "rejected")
          this.reviewResolve(requestId, input.rationale);
        return receipt;
      });
    } finally {
      clearInterval(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }
  nodeSubmit(
    id: number,
    expectedRevision: number,
    requestKey: string,
    configRevision: number,
  ) {
    const node = this.nodeGet(id);
    if (node.revision !== expectedRevision)
      throw new Error("node: content revision changed; read node again");
    const commits = [...new Set(node.artifacts.map((a) => a.commit))];
    if (commits.length !== 1)
      throw new Error(
        "node: submission requires artifacts from one source commit",
      );
    const theorems = [...new Set(node.artifacts.map((a) => a.theorem))];
    return this.integrationSubmit({
      request_key: requestKey,
      config_revision: configRevision,
      commits,
      node_refs: [String(id)],
      node_revisions: { [id]: expectedRevision },
      selection: {
        paths: node.artifacts.map((a) => a.path),
        ...(theorems.length === 1 && theorems[0] !== undefined
          ? { theorem: theorems[0] }
          : {}),
      },
    });
  }

  /** Durable authoritative state, available to every identity without touching presence. */
  stewardStatus() {
    return this.nodeTransaction(() => {
      const configuration = this.integrationGet();
      const observedMs = Date.now();
      const nodes = this.nodeList().map((node) =>
        this.nodeGetSnapshot(node.id),
      );
      const attempts = (
        this.db
          .prepare(
            "SELECT id FROM integration_attempts ORDER BY created_ts, id",
          )
          .all() as { id: string }[]
      ).map(({ id }) => this.integrationAttempt(id));
      const claims = (
        this.db
          .prepare("SELECT * FROM claims ORDER BY id")
          .all() as unknown as {
          id: number;
          path: string;
          persona: string;
          created_ts: string;
        }[]
      ).map((claim, _, all) => ({
        ...claim,
        stale_advisory: observedMs - Date.parse(claim.created_ts) >= 86400000,
        conflicting_claim_ids: all
          .filter(
            (other) =>
              other.id !== claim.id &&
              other.persona !== claim.persona &&
              (other.path === claim.path ||
                other.path.startsWith(claim.path.replace(/\/$/, "") + "/") ||
                claim.path.startsWith(other.path.replace(/\/$/, "") + "/")),
          )
          .map((other) => other.id),
      }));
      return {
        configuration,
        steward: configuration.config?.steward ?? null,
        nodes,
        attempts,
        pending_attempt_ids: attempts
          .filter((a) => a.status === "pending")
          .map((a) => a.id),
        failed_attempt_ids: attempts
          .filter((a) => a.status === "failed")
          .map((a) => a.id),
        unbanked_declared_node_ids: nodes
          .filter((n) => !n.banked && n.artifacts.length > 0)
          .map((n) => n.id),
        outline: this.outlineStatus(),
        claims,
        claim_policy:
          "advisory only; claims older than 24 hours may still be intentional" as const,
        local_work_visibility: "unobserved" as const,
        reminders: this.db
          .prepare("SELECT * FROM steward_reminders ORDER BY condition_key")
          .all(),
        reminder_policy: {
          cadence_ms: 86400000,
          max_per_condition_revision: 3,
          max_per_tick: 5,
        },
      };
    });
  }

  /** One explicitly invoked pass. No scheduler, automatic banking or science approval. */
  stewardTick() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const status = this.stewardStatus();
      if (!status.steward || status.steward !== this.persona)
        throw new Error(
          "steward: tick requires the configured steward identity",
        );
      const now = Date.now();
      const conditions: {
        condition: string;
        object_id: string;
        revision: string;
        body: string;
      }[] = [];
      const add = (
        condition: string,
        object: string | number,
        revision: string | number,
        body: string,
      ) =>
        conditions.push({
          condition,
          object_id: String(object),
          revision: `${status.configuration.revision}:${revision}`,
          body,
        });
      for (const attempt of status.attempts) {
        if (attempt.status !== "verified")
          add(
            `integration_${attempt.status}`,
            attempt.id,
            attempt.revision,
            attempt.config_revision === status.configuration.revision
              ? `@${attempt.submitted_by} integration ${attempt.id} is ${attempt.status}; inspect its durable evidence and resume this attempt with squad bank ${attempt.id}. Chat acknowledgment does not change integration state.`
              : `@${attempt.submitted_by} integration ${attempt.id} belongs to retired configuration ${attempt.config_revision} and is ${attempt.status}. Preserve its evidence; inspect current configuration and explicitly submit still-needed work under the selected target. This old attempt cannot bank under the current configuration.`,
          );
      }
      for (const node of status.nodes) {
        if (
          !node.banked &&
          node.artifacts.length &&
          !node.integrations.some(
            (a) =>
              a.current && a.current_configuration && a.status !== "verified",
          )
        )
          add(
            "unbanked_declared_work",
            node.id,
            node.revision ?? 0,
            `Node ${node.id} revision ${node.revision} has declared unbanked artifacts. Use squad node submit ${node.id} ${node.revision} <request-key> ${status.configuration.revision}, then bank the returned attempt. Local work outside durable declarations is unobserved.`,
          );
        const open = node.review_requests.filter(
          (r) =>
            r.revision === node.revision &&
            ["pending", "claimed"].includes(String(r.status)) &&
            (r.expires_ts === null || Date.parse(String(r.expires_ts)) > now),
        );
        for (const request of open)
          add(
            "pending_review",
            request.request_id as number,
            node.revision ?? 0,
            `@${request.target} review request ${request.request_id} for node ${node.id} revision ${node.revision} is ${request.status}. Inspect node history and inspect any recorded review request_key before resuming the existing request; an acknowledgment is not an independent review.`,
          );
        if (
          node.review_status === "unreviewed" &&
          !open.length &&
          (node.banked || node.artifacts.length)
        )
          add(
            "missing_review",
            node.id,
            node.revision ?? 0,
            `Node ${node.id} revision ${node.revision} needs independent review. Use squad node claim ${node.id} ${node.revision} <independent-reviewer>; banking does not approve science.`,
          );
      }
      if (!status.outline.fresh)
        add(
          "stale_outline",
          status.outline.path,
          status.outline.version,
          "Shared outline differs from the latest recorded verified publication. Inspect squad outline status, resume a pending publication with its existing request key, or explicitly publish a new snapshot. Remote visibility is unobserved.",
        );
      for (const claim of status.claims)
        if (claim.stale_advisory || claim.conflicting_claim_ids.length)
          add(
            "claim_hygiene",
            claim.id,
            claim.created_ts,
            `@${claim.persona} claim ${claim.id} (${claim.path}) needs an advisory check: ${claim.stale_advisory ? "older than 24 hours" : "overlapping peer claim"}. Confirm ownership; only explicitly release claims that should end. No claim was removed.`,
          );
      const sent: { condition_key: string; message_id: number }[] = [];
      for (const condition of conditions) {
        if (sent.length >= status.reminder_policy.max_per_tick) break;
        const key = JSON.stringify([
          condition.condition,
          condition.object_id,
          condition.revision,
        ]);
        const prior = this.db
          .prepare(
            "SELECT sends, last_sent_ms FROM steward_reminders WHERE condition_key=?",
          )
          .get(key) as { sends: number; last_sent_ms: number } | undefined;
        if (
          prior &&
          (prior.sends >= status.reminder_policy.max_per_condition_revision ||
            now - prior.last_sent_ms < status.reminder_policy.cadence_ms)
        )
          continue;
        // Every message row carries its posting session (#135). A tick from a
        // fresh process has not opened one yet; open it here, inside the
        // transaction, only once a reminder is actually going out.
        if (!this._sessionId) this.touch();
        const message = this.db
          .prepare(
            "INSERT INTO messages(sender, kind, body, ts, session_id) VALUES (?, 'chat', ?, ?, ?)",
          )
          .run(this.persona, condition.body, new Date(now).toISOString(), this._sessionId);
        const message_id = Number(message.lastInsertRowid);
        this.db
          .prepare(
            `INSERT INTO steward_reminders(condition_key, condition, object_id, revision, sends, last_sent_ms, message_id, actor)
          VALUES (?, ?, ?, ?, 1, ?, ?, ?) ON CONFLICT(condition_key) DO UPDATE SET sends=sends+1, last_sent_ms=excluded.last_sent_ms, message_id=excluded.message_id, actor=excluded.actor`,
          )
          .run(
            key,
            condition.condition,
            condition.object_id,
            condition.revision,
            now,
            message_id,
            this.persona,
          );
        sent.push({ condition_key: key, message_id });
      }
      const result = { sent, status: this.stewardStatus() };
      this.db.exec("COMMIT");
      if (sent.length) this.messageInserted();
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * `squad doctor --room`: a read-only, evidence-first drift report over
   * exactly the same durable state `stewardStatus()` reads, plus a bounded
   * scan of chat for informal "banked" claims cross-checked against the
   * verified integration ledger. Unlike `stewardTick`, this never writes --
   * no reminders sent, no presence touched -- and unlike `send`/`read`, it
   * never renews a session. One SAVEPOINT gives every section of the report
   * a single consistent observed revision/state.
   */
  roomDoctor(options: { message_limit?: number } = {}) {
    return this.nodeTransaction(() => {
      const status = this.stewardStatus();
      const reviewRequests = this.db
        .prepare(
          `SELECT n.card_id, n.revision, r.* FROM node_review_requests n
           JOIN review_requests r ON r.id = n.request_id ORDER BY r.id`,
        )
        .all() as unknown as RoomReviewRow[];
      const messages = (
        this.db
          .prepare("SELECT * FROM messages WHERE kind='chat' ORDER BY id DESC LIMIT ?")
          .all(options.message_limit ?? 2000) as unknown as Message[]
      ).reverse();
      return buildRoomDoctorReport({
        status,
        reviewRequests,
        messages,
        checkCommitExists: status.configuration.config
          ? (repository, commit) => commitExistsLocally(repository, commit)
          : undefined,
        crossRoomRequests: this.crossRoomRequests(),
        pendingDeliveries: this.pendingDeliveries(),
      });
    });
  }

  outlineRender() {
    return this.nodeTransaction(() =>
      renderOutline(
        this.integrationGet(),
        this.nodeList().map((n) => this.nodeGetSnapshot(n.id)),
      ),
    );
  }
  outlineStatus(path = "SQUAD_OUTLINE.md") {
    validateOutlinePath(path);
    return this.nodeTransaction(() => {
      const snapshot = this.outlineRender();
      const publications = outlinePublications(this.db, this.persona, path);
      const latest = [...publications]
        .reverse()
        .find(
          (p) =>
            p.attempt.status === "verified" &&
            p.config_revision === this.integrationGet().revision,
        );
      return {
        path,
        version: snapshot.version,
        fresh: latest?.version === snapshot.version,
        remote_visibility: "unobserved" as const,
        publications,
      };
    });
  }
  async outlinePublish(options: OutlinePublishOptions) {
    return publishOutline(
      this.db,
      this.persona,
      () => this.outlineRender(),
      () => this.integrationGet(),
      () => this.touch(),
      options,
    );
  }

  integrationSubmit(input: IntegrationSubmission) {
    const result = new IntegrationLedger(this.db, this.persona).submit(input, attempt => bindNodes(this.db, attempt, input.node_revisions));
    this.touch();
    return result;
  }
  async bank(id: string, options: BankOptions = {}) {
    return executeIntegration(new IntegrationLedger(this.db, this.persona), id, () => this.integrationGet(), () => this.touch(), options);
  }
  integrationSummary() {
    const counts = { pending: 0, failed: 0, verified: 0 };
    for (const row of this.db.prepare("SELECT status, COUNT(*) AS count FROM integration_attempts GROUP BY status").all() as {status: keyof typeof counts; count: number}[]) counts[row.status] = row.count;
    return { configuration: this.integrationGet(), known_submissions: counts, counts_scope: "all_configuration_revisions" as const, local_work_visibility: "unobserved" as const };
  }
  integrationAttempt(id: string) { return new IntegrationLedger(this.db, this.persona).get(id); }
  integrationAttempts(filter: IntegrationFilter = {}) { return new IntegrationLedger(this.db, this.persona).list(filter); }

  integrationGet(): IntegrationState {
    const row = this.db.prepare("SELECT * FROM integration_configs ORDER BY revision DESC LIMIT 1").get() as
      { revision: number; config_json: string | null; updated_by: string; updated_ts: string } | undefined;
    return row ? { revision: row.revision, config: row.config_json === null ? null : JSON.parse(row.config_json),
      updated_by: row.updated_by, updated_ts: row.updated_ts }
      : { revision: 0, config: null, updated_by: null, updated_ts: null };
  }

  integrationSet(input: IntegrationInput, expectedRevision: number): IntegrationState {
    return this.writeIntegration(resolveIntegration(input), expectedRevision);
  }

  integrationUnset(expectedRevision: number): IntegrationState {
    return this.writeIntegration(null, expectedRevision);
  }

  integrationValidate(): IntegrationState {
    const state = this.integrationGet();
    if (!state.config) throw new Error("integration: room is not configured");
    validateIntegration(state.config);
    return state;
  }

  private writeIntegration(config: IntegrationState["config"], expectedRevision: number): IntegrationState {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error("integration: expected_revision must be a non-negative integer");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.integrationGet();
      if (current.revision !== expectedRevision) throw new Error(`integration: revision changed (expected ${expectedRevision}, current ${current.revision}); read configuration again`);
      this.db.prepare("INSERT INTO integration_configs (config_json, updated_by, updated_ts) VALUES (?, ?, ?)")
        .run(config === null ? null : JSON.stringify(config), this.persona, new Date().toISOString());
      const state = this.integrationGet();
      this.send(`${this.persona} changed integration configuration to revision ${state.revision}: ${config
        ? `repository=${config.repository}, remote=${config.remote}, branch=${config.branch}, steward=${config.steward}; full configuration available via integration show`
        : "disabled"}`, "system");
      this.db.exec("COMMIT");
      return state;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Apply a self-reported model (the `squad_join` `model` argument) as the
   * label of this connection's automatic name. Trusted `SQUAD_MODEL` always
   * wins; a resumed or already-published name never changes; the server
   * always draws a fresh suffix, so the model cannot pick or collide a name.
   */
  requestModelLabel(model: string): PersonaRequestResult {
    const identity = this.automaticIdentity;
    if (!identity) return { persona: this._persona, applied: false };
    const wanted = automaticLabel({ ...identity, model: undefined, label: model });
    const tail = this._persona.startsWith(`${wanted}-`) ? this._persona.slice(wanted.length + 1) : "";
    if (/^[a-f0-9]+$/.test(tail)) return { persona: this._persona, applied: false };
    if (!this.labelOpen) {
      const reason = identity.model?.trim()
        ? "SQUAD_MODEL launcher metadata takes precedence"
        : "an established automatic name is never renamed";
      return {
        persona: this._persona,
        applied: false,
        note: `model '${model}' not applied to '${this._persona}': ${reason}.`,
      };
    }
    const next = { ...identity, label: model };
    this._persona = reserveAutomaticPersona(this.db, next, { relabelFrom: this._persona }).persona;
    this.automaticIdentity = next;
    this.labelOpen = false;
    return { persona: this._persona, applied: true };
  }

  /** Rename this connection's identity (used by persona autofill on join). */
  setPersona(persona: string): void {
    this.automaticIdentity = null;
    this.labelOpen = false;
    this._persona = persona;
  }

  /**
   * Apply a requested identity, honouring a pinned one as a namespace rather
   * than an exact name (#50). With nothing pinned any valid name is accepted,
   * as before. With `pinned` set, only a *refinement* of it is accepted — the
   * pin itself, or `<pinned>-<suffix>` — so N sessions of one pinned agent can
   * differentiate (`codex-1`, `codex-2`, …) and stop being filtered out of
   * each other's messages as self-authored, while an unrelated name is still
   * refused exactly as it was.
   *
   * Renaming only ever affects this connection's in-memory identity; the next
   * `touch()` writes the session row under the new name.
   */
  requestPersona(requested: string, pinned?: string | null): PersonaRequestResult {
    if (requested === this._persona) return { persona: this._persona, applied: false };
    if (isReservedPersona(requested)) {
      return {
        persona: this._persona,
        applied: false,
        note: `${reservedPersonaReason(requested)} Rename ignored.`,
      };
    }
    if (pinned && !isPersonaRefinement(pinned, requested)) {
      return {
        persona: this._persona,
        applied: false,
        note:
          `persona is pinned to '${pinned}' by config and '${requested}' is not a refinement ` +
          `of your pinned identity; rename ignored. To run several sessions as this agent, ` +
          `join as '${pinned}${PERSONA_REFINEMENT_SEPARATOR}<suffix>' ` +
          `(e.g. '${pinned}${PERSONA_REFINEMENT_SEPARATOR}2').`,
      };
    }
    this.setPersona(requested);
    return { persona: this._persona, applied: true };
  }

  /**
   * Update presence and renew this connection's lease. Called by every
   * operation, so "the lease renews on any tool call" needs no separate
   * heartbeat. Creates the session on first call; a session ended by leave()
   * is never resurrected — the next operation opens a fresh one, unless the
   * caller named the session itself (see `pinnedSessionId`), in which case the
   * name *is* the session and re-entering under it reopens that one row.
   */
  touch(): void {
    // A room clear removes reservations. Restore this still-connected agent
    // before publishing again; any collision is resolved under the same lock.
    if (this.automaticIdentity && !this.db.prepare(
      "SELECT 1 FROM agent_identities WHERE identity_id = ?",
    ).get(this.identityId!.toLowerCase())) {
      this._persona = automaticPersona(this.db, this.automaticIdentity, { prefer: this._persona });
    }
    this.labelOpen = false;
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO members (persona, first_seen, last_seen) VALUES (?, ?, ?)
         ON CONFLICT(persona) DO UPDATE SET last_seen = excluded.last_seen`,
      )
      .run(this.persona, ts, ts);
    if (!this._sessionId) this._sessionId = this.pinnedSessionId ?? randomUUID();
    const expires = new Date(Date.parse(ts) + staleMinutes() * 60_000).toISOString();
    this.db
      .prepare(
        `INSERT INTO sessions (session_id, persona, joined_at, last_seen, lease_expires_at, left_ts)
         VALUES (?, ?, ?, ?, ?, NULL)
         ON CONFLICT(session_id) DO UPDATE SET
           persona = excluded.persona,
           last_seen = excluded.last_seen,
           lease_expires_at = excluded.lease_expires_at`,
      )
      .run(this._sessionId, this.persona, ts, ts, expires);
    // A caller-supplied session id outlives the process that first used it, so
    // a later operation under that id is the same logical session re-entering
    // after a `leave()` — reopen its row rather than leaving presence dead
    // until the retention sweep. The upsert above deliberately leaves `left_ts`
    // alone, so a *minted* id is still never resurrected: leave() nulls
    // `_sessionId` and the next touch() draws a new one.
    if (this.pinnedSessionId && this._sessionId === this.pinnedSessionId)
      this.db
        .prepare("UPDATE sessions SET left_ts = NULL WHERE session_id = ? AND left_ts IS NOT NULL")
        .run(this._sessionId);
  }

  /** Record this process as an MCP server holding the room open (#151). */
  registerHolder(pid: number = process.pid): void {
    this.db
      .prepare("INSERT OR REPLACE INTO mcp_holders (host, pid, started_at) VALUES (?, ?, ?)")
      .run(hostname(), pid, now());
  }

  /** Remove this process's holder row. */
  unregisterHolder(pid: number = process.pid): void {
    this.db.prepare("DELETE FROM mcp_holders WHERE host = ? AND pid = ?").run(hostname(), pid);
  }

  /**
   * Live local holders of the room: rows for this host whose pid still exists.
   * Dead pids are pruned. Rows from other hosts are skipped (unverifiable).
   */
  listHolders(): Array<{ host: string; pid: number; started_at: string | null }> {
    const host = hostname();
    const rows = this.db
      .prepare("SELECT host, pid, started_at FROM mcp_holders WHERE host = ? ORDER BY started_at, pid")
      .all(host) as unknown as Array<{ host: string; pid: number; started_at: string | null }>;
    const live: typeof rows = [];
    for (const r of rows) {
      let alive = true;
      try {
        process.kill(r.pid, 0);
      } catch (e) {
        alive = (e as NodeJS.ErrnoException).code === "EPERM";
      }
      if (alive) live.push(r);
      else this.db.prepare("DELETE FROM mcp_holders WHERE host = ? AND pid = ?").run(r.host, r.pid);
    }
    return live;
  }

  /** This connection's session row, or null before its first operation. */
  session(): Session | null {
    if (!this._sessionId) return null;
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE session_id = ?")
      .get(this._sessionId) as unknown as Session | undefined;
    return row ?? null;
  }

  /** Live (not explicitly left) session ids held by this persona. */
  private liveSessionIds(): string[] {
    const rows = this.db
      .prepare("SELECT session_id FROM sessions WHERE persona = ? AND left_ts IS NULL")
      .all(this.persona) as unknown as Array<{ session_id: string }>;
    return rows.map((r) => r.session_id);
  }

  /**
   * Sessions *other than this connection's* that currently hold this identity
   * with an unexpired lease — the co-naming that makes two agents invisible to
   * each other (#50).
   *
   * Two things this deliberately does not count: this connection's own session
   * (so an idempotent re-join never collides with itself — `join()` calls
   * `touch()`, which creates exactly that row), and sessions whose lease has
   * expired (a dead process that never called `leave()` is not a live twin).
   */
  collidingSessions(): string[] {
    const rows = this.db
      .prepare(
        `SELECT session_id, last_seen, lease_expires_at FROM sessions
          WHERE persona = ? AND left_ts IS NULL AND session_id IS NOT ?`,
      )
      .all(this.persona, this._sessionId) as unknown as Array<{
      session_id: string;
      last_seen: string;
      lease_expires_at: string | null;
    }>;
    return rows
      .filter((r) => presenceState(r.last_seen, r.lease_expires_at) !== "stale")
      .map((r) => r.session_id);
  }

  /**
   * End this connection's session: the explicit "I'm done, stop waiting on me"
   * signal, announced in chat so peers see it in their normal check loop. A
   * connection that never opened a session (e.g. a fresh CLI process) leaves
   * every live session this persona holds instead — the way a human closes out
   * a persona left behind by a dead process. No-op, and silent, when the
   * persona holds no live session. Claims are deliberately left alone: they go
   * stale on their own and releasing another's work is an explicit act.
   */
  leave(): LeaveResult {
    const live = this.liveSessionIds();
    if (live.length === 0) {
      return { persona: this.persona, sessions_ended: [], left_ts: null, sessions_remaining: 0 };
    }
    const mine = this._sessionId && live.includes(this._sessionId) ? [this._sessionId] : live;
    const leavingRoom = live.every((id) => mine.includes(id));

    // Announce *before* ending the session: send() touches, which would
    // otherwise re-open a lease for a persona that just left.
    if (leavingRoom) {
      const held = this.db
        .prepare("SELECT path FROM claims WHERE persona = ? ORDER BY id ASC")
        .all(this.persona) as unknown as Array<{ path: string }>;
      const note = held.length
        ? ` — still holding ${held.map((c) => c.path).join(", ")}; claims are advisory, take them over if you need them`
        : "";
      this.send(`${this.persona} left the room${note}`, "system");
    }

    // Re-resolve when leaving wholesale: the announcement's touch() may have
    // opened a session that must go too.
    const targets = leavingRoom ? this.liveSessionIds() : mine;
    const ts = now();
    const end = this.db.prepare(
      "UPDATE sessions SET left_ts = ?, lease_expires_at = ? WHERE session_id = ?",
    );
    for (const id of targets) end.run(ts, ts, id);
    this._sessionId = null;
    return {
      persona: this.persona,
      sessions_ended: targets,
      left_ts: ts,
      sessions_remaining: this.liveSessionIds().length,
    };
  }

  /**
   * Post a message. `"system"` messages are deduped against this sender's own
   * immediately preceding message (#59): if that message is also `"system"`
   * with an identical body, this call collapses into it in place — bumping
   * `occurrences` and refreshing `ts` to now — instead of inserting a new
   * row, so a persistently repeating system notice (e.g. an MCP startup
   * failure retried on every session start) occupies one row no matter how
   * many times it recurs. `"chat"` messages are never collapsed, even if
   * byte-identical to a prior one — only `"system"` is scoped in, per #59's
   * acceptance criteria. Scoped to *this sender's* last message, not the
   * table's last message overall, so two different personas posting the same
   * body never collapse into each other's row.
   */
  send(body: string, kind: "chat" | "system" = "chat"): Message {
    this.touch();
    const ts = now();
    if (kind === "system") {
      const last = this.db
        .prepare("SELECT * FROM messages WHERE sender = ? ORDER BY id DESC LIMIT 1")
        .get(this.persona) as unknown as Message | undefined;
      if (last && last.kind === "system" && last.body === body) {
        const occurrences = (last.occurrences ?? 1) + 1;
        this.db
          .prepare("UPDATE messages SET ts = ?, occurrences = ? WHERE id = ?")
          .run(ts, occurrences, last.id);
        return {
          id: last.id,
          sender: this.persona,
          kind,
          body,
          ts,
          occurrences,
          session_id: last.session_id ?? null,
        };
      }
    }
    const { lastInsertRowid } = this.db
      .prepare(
        "INSERT INTO messages (sender, kind, body, ts, occurrences, session_id) VALUES (?, ?, ?, ?, 1, ?)",
      )
      .run(this.persona, kind, body, ts, this._sessionId);
    this.messageInserted();
    return {
      id: Number(lastInsertRowid),
      sender: this.persona,
      kind,
      body,
      ts,
      occurrences: 1,
      session_id: this._sessionId,
    };
  }

  /** Stateless recent-history replay. Never touches any cursor. */
  read(limit = 30): Message[] {
    this.touch();
    const rows = this.db
      .prepare("SELECT * FROM messages ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as Message[];
    return this.withRoutes(rows.reverse());
  }

  /**
   * Attach cross-room routing metadata (#144) to the routed messages in
   * `rows`; every other message is returned unchanged (no `route` key).
   */
  withRoutes(rows: Message[]): Message[] {
    if (!rows.length) return rows;
    const lo = Math.min(...rows.map((m) => m.id));
    const hi = Math.max(...rows.map((m) => m.id));
    const routes = new Map(
      (
        this.db
          .prepare("SELECT * FROM message_routes WHERE message_id BETWEEN ? AND ?")
          .all(lo, hi) as unknown as RouteRow[]
      ).map((r) => [r.message_id, toRoute(r)]),
    );
    if (!routes.size) return rows;
    return rows.map((m) => (routes.has(m.id) ? { ...m, route: routes.get(m.id)! } : m));
  }

  /**
   * This connection's session-scoped read cursor (#41). Keyed by session_id,
   * not persona, so two live sessions of one persona (an MCP connection and a
   * CLI invocation, or two concurrent MCP clients) never consume each other's
   * unread state. A session with no cursor row yet is seeded once — from the
   * persona's most-advanced other session (live or recently-ended) or its
   * durable high-water mark in `cursors`, whichever is further along — falling
   * back to 0 only for the persona's very first session ever, so it matches
   * today's single-session steady-state UX instead of replaying the whole
   * backlog as unread every time a second session opens.
   *
   * The `cursors` half is what keeps that true across *time* as well as across
   * sessions: session rows (and their cursor rows) are swept after
   * SESSION_RETENTION_HOURS, so a persona quiet for longer than that would
   * otherwise have nothing left to seed from and would replay the entire room
   * history on its next join. It also carries a pre-#41 room forward: a DB
   * written by the old persona-keyed code already has these rows, so upgrading
   * seeds from the persona's real last read rather than 0.
   */
  private cursor(): number {
    // touch() always assigns _sessionId before cursor()/setCursor() run.
    const sessionId = this._sessionId;
    if (!sessionId) return 0;
    const row = this.db
      .prepare("SELECT last_seen_id FROM session_cursors WHERE session_id = ?")
      .get(sessionId) as { last_seen_id: number } | undefined;
    if (row) return row.last_seen_id;
    const seed = this.db
      .prepare(
        `SELECT MAX(
                  COALESCE((SELECT MAX(sc.last_seen_id)
                              FROM session_cursors sc
                              JOIN sessions s ON s.session_id = sc.session_id
                             WHERE s.persona = ? AND s.session_id != ?), 0),
                  COALESCE((SELECT last_seen_id FROM cursors WHERE persona = ?), 0)
                ) AS m`,
      )
      .get(this.persona, sessionId, this.persona) as { m: number };
    this.setCursor(seed.m);
    return seed.m;
  }

  /**
   * Advance this session's cursor, and with it the persona's durable
   * high-water mark. The per-session row is the one `check()` reads; the
   * persona row in `cursors` exists purely so cursor state outlives session
   * retention (see cursor()). It only ever moves forward — a lagging session
   * consuming its own older backlog must never drag the persona's mark
   * backwards and re-mark read messages as unread for a future session.
   */
  private setCursor(id: number): void {
    const sessionId = this._sessionId;
    if (!sessionId) return;
    this.db
      .prepare(
        `INSERT INTO session_cursors (session_id, last_seen_id) VALUES (?, ?)
         ON CONFLICT(session_id) DO UPDATE SET last_seen_id = excluded.last_seen_id`,
      )
      .run(sessionId, id);
    this.db
      .prepare(
        `INSERT INTO cursors (persona, last_seen_id) VALUES (?, ?)
         ON CONFLICT(persona) DO UPDATE SET last_seen_id = MAX(last_seen_id, excluded.last_seen_id)`,
      )
      .run(this.persona, id);
  }

  private maxMessageId(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM messages").get() as {
      m: number;
    };
    return row.m;
  }

  /**
   * Unread messages via this persona's durable cursor. Excludes the persona's
   * own messages. Consumes (advances the cursor) unless peek is set.
   */
  check(opts: { peek?: boolean } = {}): Message[] {
    this.touch();
    const since = this.cursor();
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE id > ? AND sender != ? ORDER BY id ASC")
      .all(since, this.persona) as unknown as Message[];
    if (!opts.peek) this.setCursor(this.maxMessageId());
    return this.withRoutes(rows);
  }

  /**
   * `check({ peek: true })` without the presence write: a cheap read for
   * callers that poll often and renew the lease on their own schedule
   * (`squad wait`, src/wait.ts). Before this connection's first touch there
   * is no session, and so no cursor, to read against: it returns [] then.
   */
  peekUnread(): Message[] {
    if (!this._sessionId) return [];
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE id > ? AND sender != ? ORDER BY id ASC")
      .all(this.cursor(), this.persona) as unknown as Message[];
    return this.withRoutes(rows);
  }

  /**
   * Long-poll variant of check: waits up to waitSeconds for something new
   * before returning. Still pull-only — the caller always initiates.
   */
  async checkWait(waitSeconds: number, opts: { peek?: boolean } = {}): Promise<Message[]> {
    const deadline = Date.now() + waitSeconds * 1000;
    for (;;) {
      const messages = this.check(opts);
      if (messages.length > 0 || Date.now() >= deadline) return messages;
      await new Promise((r) => setTimeout(r, 700));
    }
  }

  goals(includeDone = false): Goal[] {
    this.touch();
    const sql = includeDone
      ? "SELECT * FROM goals ORDER BY id ASC"
      : "SELECT * FROM goals WHERE status = 'open' ORDER BY id ASC";
    return this.db.prepare(sql).all() as unknown as Goal[];
  }

  /** Adds a goal and announces it in chat as a system message. */
  goalAdd(body: string): Goal {
    this.touch();
    const ts = now();
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO goals (body, created_by, created_ts) VALUES (?, ?, ?)")
      .run(body, this.persona, ts);
    const id = Number(lastInsertRowid);
    this.send(`${this.persona} added goal #${id}: ${body}`, "system");
    return {
      id,
      body,
      status: "open",
      created_by: this.persona,
      created_ts: ts,
      done_by: null,
      done_ts: null,
    };
  }

  /** Marks a goal done and announces it in chat as a system message. */
  goalDone(id: number): Goal {
    this.touch();
    const goal = this.db.prepare("SELECT * FROM goals WHERE id = ?").get(id) as
      | unknown
      | undefined;
    if (!goal) throw new Error(`no goal with id ${id}`);
    if ((goal as Goal).status === "done") return goal as Goal;
    const ts = now();
    this.db
      .prepare("UPDATE goals SET status = 'done', done_by = ?, done_ts = ? WHERE id = ?")
      .run(this.persona, ts, id);
    this.send(`${this.persona} marked goal #${id} done: ${(goal as Goal).body}`, "system");
    return { ...(goal as Goal), status: "done", done_by: this.persona, done_ts: ts };
  }

  /** Reopens a done goal (undoes goalDone) and announces it in chat as a system message. */
  goalReopen(id: number): Goal {
    this.touch();
    const goal = this.db.prepare("SELECT * FROM goals WHERE id = ?").get(id) as
      | unknown
      | undefined;
    if (!goal) throw new Error(`no goal with id ${id}`);
    if ((goal as Goal).status === "open") return goal as Goal;
    this.db
      .prepare("UPDATE goals SET status = 'open', done_by = NULL, done_ts = NULL WHERE id = ?")
      .run(id);
    this.send(`${this.persona} reopened goal #${id}: ${(goal as Goal).body}`, "system");
    return { ...(goal as Goal), status: "open", done_by: null, done_ts: null };
  }

  /**
   * Current advisory claims, oldest first, each annotated with its holder's
   * presence. Staleness comes from the holder's *lease* — the same signal
   * members() reports — so a claim and its holder can never disagree about
   * whether they are stale.
   */
  claims(): ClaimView[] {
    this.touch();
    const rows = this.db
      .prepare(
        `SELECT c.id, c.path, c.persona, c.created_ts,
                (SELECT MAX(s.last_seen) FROM sessions s
                  WHERE s.persona = c.persona AND s.left_ts IS NULL) AS last_seen,
                (SELECT MAX(s.lease_expires_at) FROM sessions s
                  WHERE s.persona = c.persona AND s.left_ts IS NULL) AS lease_expires_at
           FROM claims c
          ORDER BY c.id ASC`,
      )
      .all() as unknown as Array<
      Claim & { last_seen: string | null; lease_expires_at: string | null }
    >;
    const nowMs = Date.now();
    return rows.map(({ lease_expires_at, ...r }) => {
      // No live session means the holder left or never came back — stale.
      const holder_state = presenceState(r.last_seen, lease_expires_at, nowMs);
      return { ...r, holder_state, stale: holder_state === "stale" };
    });
  }

  /**
   * Stake an advisory claim on a path and announce it in chat as a system
   * message. Idempotent for your own claim. Claiming a path a teammate already
   * holds is allowed — this is visibility, not a lock — but the announcement
   * names the existing holders so the conflict is impossible to miss.
   */
  claim(path: string): Claim {
    this.touch();
    const existing = this.db
      .prepare("SELECT * FROM claims WHERE path = ? ORDER BY id ASC")
      .all(path) as unknown as Claim[];
    const mine = existing.find((c) => c.persona === this.persona);
    if (mine) return mine;
    const ts = now();
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO claims (path, persona, created_ts) VALUES (?, ?, ?)")
      .run(path, this.persona, ts);
    const others = existing.map((c) => c.persona);
    const note = others.length
      ? ` — already claimed by ${others.join(", ")}; claims are advisory, coordinate in chat`
      : "";
    this.send(`${this.persona} claimed ${path}${note}`, "system");
    return { id: Number(lastInsertRowid), path, persona: this.persona, created_ts: ts };
  }

  /**
   * Drop claims on a path and announce it. Releases your own claim; if you hold
   * none, releases the peers' claims on that path (the explicit takeover path
   * for a stale claim left by a departed teammate). A no-op returning [] when
   * nothing is claimed on that path.
   */
  release(path: string): Claim[] {
    this.touch();
    const rows = this.db
      .prepare("SELECT * FROM claims WHERE path = ? ORDER BY id ASC")
      .all(path) as unknown as Claim[];
    if (rows.length === 0) return [];
    const mine = rows.filter((c) => c.persona === this.persona);
    const released = mine.length > 0 ? mine : rows;
    const del = this.db.prepare("DELETE FROM claims WHERE id = ?");
    for (const c of released) del.run(c.id);
    const owners = [...new Set(released.map((c) => c.persona))].filter((p) => p !== this.persona);
    const note = owners.length ? ` (held by ${owners.join(", ")})` : "";
    this.send(`${this.persona} released ${path}${note}`, "system");
    return released;
  }

  /**
   * Everyone in the room — one entry per persona holding a live session,
   * freshest first, each with derived presence. A persona that left explicitly
   * is gone from this list (its departure is in the chat log); one that simply
   * stopped answering is still listed, as `stale`.
   */
  members(): Member[] {
    const rows = this.db
      .prepare(
        `SELECT s.persona AS persona,
                MIN(s.joined_at) AS session_first_seen,
                MAX(s.last_seen) AS last_seen,
                MAX(s.lease_expires_at) AS lease_expires_at,
                COUNT(*) AS sessions,
                m.first_seen AS member_first_seen
           FROM sessions s LEFT JOIN members m ON m.persona = s.persona
          WHERE s.left_ts IS NULL
          GROUP BY s.persona
          ORDER BY MAX(s.last_seen) DESC`,
      )
      .all() as unknown as Array<{
      persona: string;
      session_first_seen: string;
      last_seen: string;
      lease_expires_at: string;
      sessions: number;
      member_first_seen: string | null;
    }>;
    const nowMs = Date.now();
    // Per-session breakdown for shared personas only (#136). Same liveness
    // filter as the rollup above (left_ts IS NULL), so a left session is
    // gone from both and a lease-expired one is in both, as `stale`.
    const shared = rows.filter((r) => r.sessions > 1).map((r) => r.persona);
    const detail = new Map<string, MemberSession[]>();
    if (shared.length > 0) {
      const sessionRows = this.db
        .prepare(
          `SELECT session_id, persona, joined_at, last_seen, lease_expires_at
             FROM sessions
            WHERE left_ts IS NULL
              AND persona IN (${shared.map(() => "?").join(", ")})
            ORDER BY last_seen DESC, session_id ASC`,
        )
        .all(...shared) as unknown as Array<{
        session_id: string;
        persona: string;
        joined_at: string;
        last_seen: string;
        lease_expires_at: string;
      }>;
      for (const s of sessionRows) {
        const list = detail.get(s.persona) ?? [];
        list.push({
          session_id: s.session_id,
          joined_at: s.joined_at,
          last_seen: s.last_seen,
          lease_expires_at: s.lease_expires_at,
          state: presenceState(s.last_seen, s.lease_expires_at, nowMs),
        });
        detail.set(s.persona, list);
      }
    }
    return rows.map((r) => {
      const member: Member = {
        persona: r.persona,
        first_seen: r.member_first_seen ?? r.session_first_seen,
        last_seen: r.last_seen,
        lease_expires_at: r.lease_expires_at,
        state: presenceState(r.last_seen, r.lease_expires_at, nowMs),
        sessions: r.sessions,
      };
      const sessions = detail.get(r.persona);
      if (sessions) member.sessions_detail = sessions;
      return member;
    });
  }

  /** members() minus yourself: the peers whose presence you actually need. */
  peers(): Member[] {
    return this.members().filter((m) => m.persona !== this.persona);
  }

  /**
   * Sweep session rows nobody has touched in SESSION_RETENTION_HOURS, plus
   * any session_cursors rows left behind for a session that's gone — mirrors
   * the sessions table's own retention rationale so cursor rows don't
   * accumulate forever either. Safe to prune in lockstep because it is not
   * where cursor durability lives: setCursor() mirrors every advance into the
   * never-pruned persona-keyed `cursors` table, so a persona whose sessions
   * have all aged out still seeds its next session from where it actually
   * left off (see cursor()).
   */
  private pruneSessions(): void {
    const cutoff = new Date(Date.now() - SESSION_RETENTION_HOURS * 3_600_000).toISOString();
    this.db
      .prepare("DELETE FROM sessions WHERE last_seen < ? AND session_id IS NOT ?")
      .run(cutoff, this._sessionId);
    this.db
      .prepare(
        "DELETE FROM session_cursors WHERE session_id NOT IN (SELECT session_id FROM sessions)",
      )
      .run();
  }

  /**
   * Register presence and catch up: opens (or renews) this connection's lease
   * and returns your session id and lease expiry, who's here with their
   * presence state, the open goals, the current advisory claims, and recent
   * history. Advances the cursor past everything returned, so a subsequent
   * check() yields only genuinely new messages.
   */
  join(recentLimit = 30): JoinResult {
    // Resolved *before* touch(), which creates or renews this connection's own
    // session row under the same identity: after it, "is someone else already
    // here under this name?" would always find at least this session. (It is
    // excluded by session id as well, so a re-join is safe either way.)
    const colliding = this.collidingSessions();
    this.touch();
    this.pruneSessions();
    const recent = this.read(recentLimit);
    this.setCursor(this.maxMessageId());
    // touch() above always leaves this connection a live session row.
    const session = this.session();
    if (!session) throw new Error("squad: presence session missing after join");
    return {
      session_id: session.session_id,
      joined_at: session.joined_at,
      lease_expires_at: session.lease_expires_at,
      members: this.members(),
      goals: this.goals(),
      nodes: this.nodeList(),
      claims: this.claims(),
      pending_reviews: this.pendingReviews(),
      cross_room_requests: this.crossRoomRequests(),
      pending_deliveries: this.pendingDeliveries(),
      recent,
      ...(colliding.length
        ? {
            identity_collision: {
              persona: this.persona,
              session_ids: colliding,
              note:
                `identity collision: '${this.persona}' already has ` +
                `${colliding.length} other live session${colliding.length === 1 ? "" : "s"}. ` +
                `Same-named sessions are filtered out of each other's messages as ` +
                `self-authored, so you would be mutually invisible — re-join with a refined ` +
                `persona like '${this.persona}${PERSONA_REFINEMENT_SEPARATOR}2' to be heard.`,
            },
          }
        : {}),
    };
  }

  /**
   * The room-state summary that accompanies `check()`'s unread messages:
   * peers with their presence, this connection's renewed lease, and the
   * open-goal / active-claim / pending-directed-review counts a re-entering
   * peer needs to prioritize. Lives here rather than inline in the MCP
   * handler so it is testable.
   */
  checkSummary(): CheckSummary {
    const session = this.session();
    const pending = this.pendingReviews();
    const crossRoom = this.crossRoomRequests();
    return {
      peers: this.peers(),
      session_id: session?.session_id ?? null,
      lease_expires_at: session?.lease_expires_at ?? null,
      integration: this.integrationSummary(),
      open_goals: this.goals().length,
      active_claims: this.claims().length,
      pending_review_count: pending.length,
      pending_reviews: pending,
      cross_room_request_count: crossRoom.length,
      cross_room_requests: crossRoom,
    };
  }

  /**
   * Inbound cross-room requests (#144) with no delivered reply yet, oldest
   * first, each with any of its replies still awaiting delivery. Reads only
   * this room's durable routing tables -- never another room's database --
   * and writes nothing, so it is safe from the read-only doctor.
   */
  crossRoomRequests(nowMs: number = Date.now()): CrossRoomRequestView[] {
    const rows = this.db
      .prepare(
        `SELECT r.message_id, r.request_id, r.remote_room, r.remote_persona, r.created_ts, m.sender, m.body
           FROM message_routes r JOIN messages m ON m.id = r.message_id
          WHERE r.direction = 'inbound' AND r.answered_ts IS NULL
          ORDER BY r.message_id ASC`,
      )
      .all() as unknown as Array<{
      message_id: number;
      request_id: string;
      remote_room: string;
      remote_persona: string;
      created_ts: string;
      sender: string;
      body: string;
    }>;
    const pending = this.pendingDeliveries(nowMs);
    return rows.map((r) => ({
      request_id: r.request_id,
      message_id: r.message_id,
      origin_room: r.remote_room,
      origin_persona: r.remote_persona,
      sender: r.sender,
      body: r.body,
      created_ts: r.created_ts,
      age_ms: Math.max(0, nowMs - Date.parse(r.created_ts)),
      pending_deliveries: pending.filter((d) => d.request_id === r.request_id),
    }));
  }

  /** Stored cross-room replies whose delivery has not succeeded yet (#144), oldest first. */
  pendingDeliveries(nowMs: number = Date.now()): PendingDeliveryView[] {
    const rows = this.db
      .prepare("SELECT * FROM route_deliveries WHERE status = 'pending' ORDER BY created_ts ASC, delivery_id ASC")
      .all() as unknown as DeliveryRow[];
    return rows.map((d) => ({
      delivery_id: d.delivery_id,
      request_id: d.request_id,
      message_id: d.message_id,
      dest_room: d.dest_room,
      recipient: d.recipient,
      attempts: d.attempts,
      last_error: d.last_error,
      created_ts: d.created_ts,
      age_ms: Math.max(0, nowMs - Date.parse(d.created_ts)),
    }));
  }

  /**
   * Explicitly reply to local message `replyTo` (#144: `squad send --reply`,
   * `squad_send` with `reply_to`). Routing comes only from this room's own
   * metadata -- a caller can never supply a return path.
   *
   * - Replying to an inbound cross-room request stores the reply here and
   *   delivers exactly one copy into the asking room, addressed (@mention) to
   *   the original asker and carrying the same request id. Policies are
   *   checked first (this room's `reply_to`, the asking room's `accept_from`);
   *   a refusal stores nothing. A delivery failure after the reply is stored
   *   leaves it pending and the request outstanding, and throws an error
   *   naming the delivery id to retry with `retryDelivery()`.
   * - Replying to anything else (an ordinary message, or a delivered copy of a
   *   reply from another room) stays local, so a routed copy can never
   *   trigger another forward.
   */
  reply(replyTo: number, body: string): ReplyResult {
    const text = body.trim();
    if (!text) throw new Error("reply body is empty");
    if (!Number.isSafeInteger(replyTo) || replyTo < 1) throw new Error(`invalid message id to reply to: ${replyTo}`);
    this.touch();
    const target = this.db.prepare("SELECT id FROM messages WHERE id = ?").get(replyTo);
    if (!target) throw new Error(`no message #${replyTo} in this room to reply to`);
    const route = this.db
      .prepare("SELECT * FROM message_routes WHERE message_id = ?")
      .get(replyTo) as unknown as RouteRow | undefined;
    const ts = now();
    if (!route || route.direction !== "inbound") {
      const message = immediate(this.db, () => {
        const id = this.insertMessage(text, ts);
        this.db
          .prepare("INSERT INTO message_routes (message_id, direction, reply_to, created_ts) VALUES (?, 'local-reply', ?, ?)")
          .run(id, replyTo, ts);
        return id;
      });
      this.messageInserted();
      return { message: this.messageWithRoute(message), routed: false };
    }
    const self = this.roomDir;
    if (!self) throw new Error("this room has no on-disk location, so replies cannot be routed to another room");
    const dest = route.remote_room!;
    const recipient = route.remote_persona!;
    const requestId = route.request_id!;
    // Pre-flight policy checks: a refusal stores nothing and sends nothing.
    assertReplyAllowed(self, dest);
    if (existsSync(dest)) assertInboundAllowed(dest, self);
    const deliveryId = randomUUID();
    const id = immediate(this.db, () => {
      const id = this.insertMessage(text, ts);
      this.db
        .prepare(
          `INSERT INTO message_routes
             (message_id, direction, request_id, remote_room, remote_persona, recipient, reply_to, delivery_id, created_ts)
           VALUES (?, 'reply', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, requestId, dest, recipient, recipient, replyTo, deliveryId, ts);
      this.db
        .prepare(
          `INSERT INTO route_deliveries (delivery_id, request_id, message_id, dest_room, recipient, status, attempts, created_ts)
           VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)`,
        )
        .run(deliveryId, requestId, id, dest, recipient, ts);
      return id;
    });
    this.messageInserted();
    const delivery = this.retryDelivery(deliveryId);
    return { message: this.messageWithRoute(id), routed: true, delivery };
  }

  /**
   * Deliver (or re-deliver) a stored cross-room reply (#144). Idempotent: the
   * origin room's copy is keyed by the UNIQUE delivery id, so retrying after a
   * failure -- whether the copy never arrived or arrived but this room never
   * recorded it -- yields exactly one copy. The delivery is marked delivered,
   * and its request answered, only after the origin room's write commits. A
   * delivery already recorded as delivered returns 'already-delivered'.
   */
  retryDelivery(deliveryId: string): DeliveryResult {
    const d = this.db
      .prepare("SELECT * FROM route_deliveries WHERE delivery_id = ?")
      .get(deliveryId) as unknown as DeliveryRow | undefined;
    if (!d) throw new Error(`no cross-room delivery '${deliveryId}' in this room`);
    const result = (status: DeliveryResult["status"], remote: number | null, at: string | null): DeliveryResult => ({
      delivery_id: d.delivery_id,
      request_id: d.request_id,
      dest_room: d.dest_room,
      recipient: d.recipient,
      status,
      remote_message_id: remote,
      delivered_ts: at,
    });
    if (d.status === "delivered") return result("already-delivered", null, d.delivered_ts);
    const reply = this.db
      .prepare("SELECT sender, body FROM messages WHERE id = ?")
      .get(d.message_id) as { sender: string; body: string } | undefined;
    this.db.prepare("UPDATE route_deliveries SET attempts = attempts + 1 WHERE delivery_id = ?").run(deliveryId);
    try {
      if (!reply) throw new Error(`the stored reply #${d.message_id} no longer exists in this room`);
      const self = this.roomDir;
      if (!self) throw new Error("this room has no on-disk location");
      assertReplyAllowed(self, d.dest_room);
      const origin = openExistingRoom(d.dest_room);
      let remoteId: number;
      try {
        assertInboundAllowed(d.dest_room, self);
        remoteId = immediate(origin, () => {
          const existing = origin
            .prepare("SELECT message_id FROM message_routes WHERE delivery_id = ?")
            .get(deliveryId) as { message_id: number } | undefined;
          let id = existing?.message_id;
          if (id === undefined) {
            const ts = now();
            const mention = `@${d.recipient}`;
            const body = reply.body === mention || reply.body.startsWith(`${mention} `) ? reply.body : `${mention} ${reply.body}`;
            id = Number(
              origin
                .prepare("INSERT INTO messages (sender, kind, body, ts, occurrences, session_id) VALUES (?, 'chat', ?, ?, 1, NULL)")
                .run(`${reply.sender}@${roomLabel(self)}`, body, ts).lastInsertRowid,
            );
            origin
              .prepare(
                `INSERT INTO message_routes
                   (message_id, direction, request_id, remote_room, remote_persona, remote_message_id, recipient, delivery_id, created_ts)
                 VALUES (?, 'delivered', ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(id, d.request_id, self, reply.sender, d.message_id, d.recipient, deliveryId, ts);
          }
          this.deliveryFaults?.beforeOriginCommit?.();
          return id;
        });
        this.deliveryFaults?.afterOriginCommit?.();
      } finally {
        origin.close();
      }
      const at = now();
      immediate(this.db, () => {
        this.db
          .prepare("UPDATE route_deliveries SET status = 'delivered', delivered_ts = ?, last_error = NULL WHERE delivery_id = ?")
          .run(at, deliveryId);
        this.db
          .prepare(
            `UPDATE message_routes SET answered_ts = ?, answered_by = ?
              WHERE direction = 'inbound' AND request_id = ? AND answered_ts IS NULL`,
          )
          .run(at, reply.sender, d.request_id);
      });
      return result("delivered", remoteId, at);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.db.prepare("UPDATE route_deliveries SET last_error = ? WHERE delivery_id = ?").run(reason, deliveryId);
      throw new Error(
        `reply #${d.message_id} is stored in this room but was NOT delivered to ${d.dest_room}: ${reason}. ` +
          `The request stays outstanding. Retry with 'squad send --retry ${deliveryId}' ` +
          `(MCP: squad_retry_delivery); a retry never duplicates a copy that already arrived.`,
      );
    }
  }

  private insertMessage(body: string, ts: string): number {
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO messages (sender, kind, body, ts, occurrences, session_id) VALUES (?, 'chat', ?, ?, 1, ?)")
      .run(this.persona, body, ts, this._sessionId);
    return Number(lastInsertRowid);
  }

  private messageWithRoute(id: number): Message {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as unknown as Message;
    return this.withRoutes([row])[0]!;
  }

  /**
   * Create a Science Card in the QUESTION phase and announce it in chat as a
   * system message; see `cards.cardCreate`.
   */
  cardCreate(fields: CardCreateFields): Card {
    return this.nodeTransaction(() => {
      this.touch();
      const result = cards.cardCreate(this.cardContext(), fields);
      recordNodeRevision(this.db, result.id, this.persona, this.sessionId, "created");
      return result;
    });
  }

  /**
   * Edit a card's fields set at creation time; see `cards.cardUpdate`. Never
   * touches `phase` or history.
   */
  cardUpdate(id: number, fields: CardUpdateFields): Card {
    return this.nodeTransaction(() => {
      this.touch();
      const result = cards.cardUpdate(this.cardContext(), id, fields);
      recordNodeRevision(this.db, id, this.persona, this.sessionId, "edited");
      return result;
    });
  }

  /**
   * Lists Science Cards in every phase unless narrowed by `phase`/`phases`;
   * see `cards.cardList`.
   */
  cardList(opts: { phase?: CardPhase; phases?: CardPhase[] } = {}): Card[] {
    this.touch();
    return cards.cardList(this.cardContext(), opts);
  }

  /** Full card detail: the card plus its complete evidence and transition history. */
  cardGet(id: number): CardDetail {
    this.touch();
    return cards.cardGet(this.cardContext(), id);
  }

  /**
   * Moves a card to `toPhase`, validating the transition graph and the
   * SUPPORTED evidence gate; see `cards.cardTransition`.
   */
  cardTransition(id: number, toPhase: CardPhase, note?: string): Card {
    return this.nodeTransaction(() => {
      this.touch();
      const result = cards.cardTransition(this.cardContext(), id, toPhase, note);
      recordNodeRevision(this.db, id, this.persona, this.sessionId, "edited");
      return result;
    });
  }

  /** Adds an evidence item to a card; see `cards.cardEvidenceAdd`. */
  cardEvidenceAdd(cardId: number, type: EvidenceType, provenance: string, body?: string | null): CardEvidence {
    return this.nodeTransaction(() => {
      this.touch();
      const result = cards.cardEvidenceAdd(this.cardContext(), cardId, type, provenance, body);
      recordNodeRevision(this.db, cardId, this.persona, this.sessionId, "edited");
      return result;
    });
  }

  private cardContext(): cards.CardContext {
    return { db: this.db, persona: this.persona, send: (body, kind) => this.send(body, kind) };
  }

  /**
   * Wipe the room: all messages, goals, claims, cursors, members, presence
   * sessions, divergence rounds/submissions, directed review requests, and
   * science cards (with their evidence and transition history). A live
   * connection keeps its session id and re-registers presence on its next
   * operation.
   */
  clear(): void {
    this.db.exec(ROOM_TABLES.map((t) => `DELETE FROM ${t};`).join(" "));
  }

  /**
   * Export every room table (ROOM_TABLES, src/db.ts -- the same set clear()
   * empties) to a single portable SQLite file at destPath, via node:sqlite's
   * built-in backup() (SQLite's Online Backup API). WAL-safe: backup() reads
   * committed pages straight through any pending WAL frames, so a
   * concurrently-open MCP server or CLI process never produces a torn copy
   * the way a raw `cp` of squad.db can (which can race a WAL checkpoint), and
   * the destination is a self-contained file -- no `-wal`/`-shm` sidecars for
   * a caller (or a later `squad import`) to know about.
   *
   * Refuses to overwrite an existing file at destPath rather than silently
   * clobbering it.
   *
   * Returns the row count exported per table, for a human-readable summary.
   *
   * node:sqlite's module-level `backup()` (as opposed to `DatabaseSync`
   * instance methods, present since node:sqlite's v22.5.0 debut) landed
   * later, in Node v22.16.0/v23.8.0 -- package.json's `engines.node` floor
   * is pinned to v22.16.0 specifically because of this dependency.
   */
  async exportRoom(destPath: string): Promise<Record<string, number>> {
    if (existsSync(destPath)) {
      throw new Error(`squad export: refusing to overwrite existing file: ${destPath}`);
    }
    await backup(this.db, destPath);
    const copy = new DatabaseSync(destPath, { readOnly: true });
    try {
      const counts: Record<string, number> = {};
      for (const t of ROOM_TABLES) {
        counts[t] = (copy.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
      }
      return counts;
    } finally {
      copy.close();
    }
  }

  /**
   * Import a room previously produced by exportRoom() into this (already
   * open) room's database, via a temporary ATTACH DATABASE + table-by-table
   * INSERT ... SELECT (all within one transaction) rather than replacing the
   * destination file outright -- so the destination keeps its own on-disk
   * identity (WAL mode, pragmas) and the "must be empty" refusal below has
   * something to check.
   *
   * Refuses (throws) rather than partially writing or silently merging when:
   *  - srcPath does not exist (checked before ATTACH, which would otherwise
   *    silently create an empty file there)
   *  - srcPath is not a readable SQLite database
   *  - srcPath's `PRAGMA user_version` does not match this build's
   *    SCHEMA_VERSION (src/db.ts) -- the export was produced by an
   *    incompatible (older or newer) squad build
   *  - srcPath is missing one or more ROOM_TABLES -- not a squad export
   *  - this room is not empty (any ROOM_TABLES row already present) --
   *    import is not a merge; run `squad clear` first
   *
   * On success, every row in every ROOM_TABLES table is copied verbatim
   * (ids included); SQLite's own AUTOINCREMENT bookkeeping picks up from the
   * imported max id per table, so a post-import `squad send` etc. can never
   * collide with an imported row's id.
   *
   * Returns the row count imported per table, for a human-readable summary.
   */
  importRoom(srcPath: string): Record<string, number> {
    if (!existsSync(srcPath)) {
      throw new Error(`squad import: no such file: ${srcPath}`);
    }
    try {
      this.db.prepare("ATTACH DATABASE ? AS import_src").run(srcPath);
    } catch (err) {
      throw new Error(
        `squad import: could not open ${srcPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      let srcVersion: number;
      try {
        srcVersion = (this.db.prepare("PRAGMA import_src.user_version").get() as { user_version: number })
          .user_version;
      } catch (err) {
        throw new Error(`squad import: ${srcPath} is not a valid SQLite database`);
      }
      if (srcVersion !== SCHEMA_VERSION) {
        throw new Error(
          `squad import: schema version mismatch (export is v${srcVersion}, this squad build expects ` +
            `v${SCHEMA_VERSION}) -- install a matching squad version before importing`,
        );
      }
      const srcTables = new Set(
        (
          this.db.prepare("SELECT name FROM import_src.sqlite_master WHERE type = 'table'").all() as {
            name: string;
          }[]
        ).map((r) => r.name),
      );
      const missing = ROOM_TABLES.filter((t) => !srcTables.has(t));
      if (missing.length > 0) {
        throw new Error(`squad import: ${srcPath} is not a squad export (missing table(s): ${missing.join(", ")})`);
      }
      const existing = ROOM_TABLES.map((t) => ({
        table: t,
        n: (this.db.prepare(`SELECT COUNT(*) AS n FROM main.${t}`).get() as { n: number }).n,
      })).filter((c) => c.n > 0);
      if (existing.length > 0) {
        throw new Error(
          "squad import: refusing to import into a non-empty room " +
            `(${existing.map((c) => `${c.table}: ${c.n}`).join(", ")}) -- run 'squad clear' first`,
        );
      }
      const counts: Record<string, number> = {};
      this.db.exec("BEGIN");
      try {
        for (const t of ROOM_TABLES) {
          this.db.exec(`INSERT INTO main.${t} SELECT * FROM import_src.${t}`);
          counts[t] = (this.db.prepare(`SELECT COUNT(*) AS n FROM main.${t}`).get() as { n: number }).n;
        }
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
      return counts;
    } finally {
      this.db.exec("DETACH DATABASE import_src");
    }
  }

  /** Open a divergence round; see `diverge.divergeOpen`. */
  divergeOpen(
    topic: string,
    opts: { cardId?: number; expectedParticipants?: string[] } = {},
  ): DivergenceRound {
    this.touch();
    return diverge.divergeOpen(this.divergeContext(), topic, opts);
  }

  /** Record this persona's independent submission; see `diverge.divergeSubmit`. */
  divergeSubmit(roundId: number, body: string): DivergenceSubmission {
    this.touch();
    return diverge.divergeSubmit(this.divergeContext(), roundId, body);
  }

  /** The caller's view of a round; see `diverge.divergeStatus`. */
  divergeStatus(roundId: number): DivergenceStatus {
    this.touch();
    return diverge.divergeStatus(this.divergeContext(), roundId);
  }

  /** Explicitly close a round; see `diverge.divergeClose`. */
  divergeClose(roundId: number): DivergenceRound {
    this.touch();
    return diverge.divergeClose(this.divergeContext(), roundId);
  }

  private divergeContext(): diverge.DivergeContext {
    return { db: this.db, persona: this.persona, send: (body, kind) => this.send(body, kind) };
  }

  /** One review request with its derived expiry. */
  reviewGet(id: number): ReviewRequestView {
    this.touch();
    return reviews.reviewGet(this.reviewContext(), id);
  }

  /** Open a directed review request; see `reviews.reviewOpen`. */
  reviewOpen(
    target: string,
    body: string,
    opts: {
      refs?: string[];
      priority?: ReviewPriority;
      expiresTs?: string | null;
      expiresInMinutes?: number;
    } = {},
  ): ReviewRequestView {
    this.touch();
    return reviews.reviewOpen(this.reviewContext(), target, body, opts);
  }

  /** Claim (ack) a request directed at you; see `reviews.reviewClaim`. */
  reviewClaim(id: number): ReviewRequestView {
    this.touch();
    return reviews.reviewClaim(this.reviewContext(), id);
  }

  /** Resolve a request you claimed; see `reviews.reviewResolve`. */
  reviewResolve(id: number, resolution?: string | null): ReviewRequestView {
    this.touch();
    return reviews.reviewResolve(this.reviewContext(), id, resolution);
  }

  /** Cancel a request (requester or target only); see `reviews.reviewCancel`. */
  reviewCancel(id: number, reason?: string | null): ReviewRequestView {
    this.touch();
    return reviews.reviewCancel(this.reviewContext(), id, reason);
  }

  /** Directed review requests still gating a persona; see `reviews.pendingReviews`. */
  pendingReviews(persona: string = this.persona): ReviewRequestView[] {
    this.touch();
    return reviews.pendingReviews(this.reviewContext(), persona);
  }

  /** List review requests across the room; see `reviews.reviewList`. */
  reviewList(
    opts: {
      target?: string;
      requestedBy?: string;
      status?: ReviewStatus;
      includeExpired?: boolean;
      includeTerminal?: boolean;
    } = {},
  ): ReviewRequestView[] {
    this.touch();
    return reviews.reviewList(this.reviewContext(), opts);
  }

  private reviewContext(): reviews.ReviewContext {
    return { db: this.db, persona: this.persona, send: (body, kind) => this.send(body, kind) };
  }

  private reviewRow(id: number): ReviewRow {
    return reviews.reviewRow(this.reviewContext(), id);
  }
}
