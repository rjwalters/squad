import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface Message {
  id: number;
  sender: string;
  kind: "chat" | "system";
  body: string;
  ts: string;
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

/** What `join()` returns: the caller's lease plus a full room snapshot. */
export interface JoinResult {
  session_id: string;
  joined_at: string;
  lease_expires_at: string;
  /** Everyone present, including the caller, with derived presence. */
  members: Member[];
  goals: Goal[];
  claims: ClaimView[];
  recent: Message[];
}

/**
 * A bounded window where each participant submits independently. Nobody's
 * submission is visible to anyone else (including the submitter checking
 * others') until the round closes — either explicitly via divergeClose or
 * automatically once every persona in expected_participants has submitted.
 */
export interface DivergenceRound {
  id: number;
  /** Optional Science Card this round belongs to. Nullable, no enforced FK. */
  card_id: number | null;
  topic: string;
  opened_by: string;
  opened_ts: string;
  /** Personas expected to submit; null means only an explicit close ends the round. */
  expected_participants: string[] | null;
  status: "open" | "closed";
  closed_by: string | null;
  closed_ts: string | null;
}

/** One persona's independent entry in a divergence round. */
export interface DivergenceSubmission {
  id: number;
  round_id: number;
  persona: string;
  body: string;
  submitted_ts: string;
}

/**
 * The caller's view of a round: metadata that is always safe to reveal (who
 * has submitted, never what) plus the caller's own submission. `submissions`
 * is null while the round is open — no one, not even the submitter, can read
 * a full list of bodies before close — and becomes the full list once closed.
 */
export interface DivergenceStatus {
  round: DivergenceRound;
  submitted_personas: string[];
  mine: DivergenceSubmission | null;
  submissions: DivergenceSubmission[] | null;
}

/**
 * Science Card phases. QUESTION..REPLICATE is the main investigative chain;
 * LEARN/PIVOT is a reflection loop reachable from most active phases and
 * feeding back into the chain; SUPPORTED/FALSIFIED/INCONCLUSIVE are the
 * chain's terminal outcomes; ABANDONED is an escape hatch reachable from any
 * non-terminal phase. See TRANSITIONS below for the exact allowed graph.
 */
export type CardPhase =
  | "QUESTION"
  | "DIVERGE"
  | "ORIENT"
  | "HYPOTHESIZE"
  | "DERIVE"
  | "ATTACK"
  | "SIMULATE"
  | "EXPERIMENT"
  | "REPLICATE"
  | "LEARN"
  | "PIVOT"
  | "SUPPORTED"
  | "FALSIFIED"
  | "INCONCLUSIVE"
  | "ABANDONED";

/**
 * Whether a card's claim requires empirical evidence to be SUPPORTED.
 * `empirical` (the default) means a `formal-check`/`derivation`/`simulation`/
 * `literature` item alone can never satisfy SUPPORTED — an `experiment` or
 * `observation` item is required. `formal` cards (pure math/logic claims) can
 * be SUPPORTED on formal evidence alone. This keeps "evidence item verified"
 * distinct from "card scientifically SUPPORTED".
 */
export type ClaimKind = "empirical" | "formal";

export type EvidenceType =
  | "derivation"
  | "formal-check"
  | "simulation"
  | "experiment"
  | "literature"
  | "observation";

export const EVIDENCE_TYPES: readonly EvidenceType[] = [
  "derivation",
  "formal-check",
  "simulation",
  "experiment",
  "literature",
  "observation",
];

/**
 * Explicit allowed-transition graph for Science Cards. A transition not
 * listed for the card's current phase is rejected. Terminal phases
 * (SUPPORTED/FALSIFIED/INCONCLUSIVE/ABANDONED) only permit looping back
 * through LEARN, except ABANDONED which has no way out.
 */
const TRANSITIONS: Record<CardPhase, readonly CardPhase[]> = {
  QUESTION: ["DIVERGE", "ABANDONED"],
  DIVERGE: ["ORIENT", "LEARN", "ABANDONED"],
  ORIENT: ["HYPOTHESIZE", "LEARN", "ABANDONED"],
  HYPOTHESIZE: ["DERIVE", "LEARN", "ABANDONED"],
  DERIVE: ["ATTACK", "LEARN", "ABANDONED"],
  ATTACK: ["SIMULATE", "LEARN", "ABANDONED"],
  SIMULATE: ["EXPERIMENT", "LEARN", "ABANDONED"],
  EXPERIMENT: ["REPLICATE", "LEARN", "ABANDONED"],
  REPLICATE: ["SUPPORTED", "FALSIFIED", "INCONCLUSIVE", "LEARN", "ABANDONED"],
  LEARN: ["PIVOT", "ABANDONED"],
  PIVOT: ["DIVERGE", "ORIENT", "HYPOTHESIZE", "DERIVE", "ABANDONED"],
  SUPPORTED: ["LEARN"],
  FALSIFIED: ["LEARN"],
  INCONCLUSIVE: ["LEARN"],
  ABANDONED: [],
};

/**
 * Every `CardPhase` value, in the same order as the TRANSITIONS graph above.
 * The single runtime source of truth for the phase enum, so callers building
 * an input validator (e.g. an MCP tool's zod schema) or a CLI usage message
 * reuse this instead of re-declaring the 15-name list themselves.
 */
export const CARD_PHASES: readonly CardPhase[] = Object.keys(TRANSITIONS) as CardPhase[];

/**
 * The chain's terminal/outcome phases: a card here is "done" investigating
 * (barring a LEARN/PIVOT reopen). Used to give `cardList` callers a
 * `squad_goals`-style "active by default, opt in to also see done" view even
 * though `cardList` itself always returns every phase unless narrowed.
 */
export const CARD_TERMINAL_PHASES: readonly CardPhase[] = [
  "SUPPORTED",
  "FALSIFIED",
  "INCONCLUSIVE",
  "ABANDONED",
];

/** Evidence types that count as "empirical" for the SUPPORTED gate. */
const EMPIRICAL_EVIDENCE_TYPES: readonly EvidenceType[] = ["experiment", "observation"];

export interface Card {
  id: number;
  title: string;
  question: string;
  phase: CardPhase;
  claim_kind: ClaimKind;
  origin_method: string | null;
  origin_contributors: string[];
  changed_assumptions: string[];
  proposed_mechanism: string | null;
  math_model: string | null;
  standard_prediction: string | null;
  discriminating_prediction: string | null;
  decisive_falsifier: string | null;
  cheapest_test: string | null;
  prior_art_status: string | null;
  confidence: number | null;
  novelty: number | null;
  attempts: string[];
  attacks: string[];
  insights: string[];
  post_mortems: string[];
  created_by: string;
  created_ts: string;
  updated_ts: string;
}

/** Fields accepted by `cardCreate`. Everything but `title`/`question` is optional. */
export interface CardCreateFields {
  title: string;
  question: string;
  claim_kind?: ClaimKind;
  origin_method?: string | null;
  origin_contributors?: string[];
  changed_assumptions?: string[];
  proposed_mechanism?: string | null;
  math_model?: string | null;
  standard_prediction?: string | null;
  discriminating_prediction?: string | null;
  decisive_falsifier?: string | null;
  cheapest_test?: string | null;
  prior_art_status?: string | null;
  confidence?: number | null;
  novelty?: number | null;
  attempts?: string[];
  attacks?: string[];
  insights?: string[];
  post_mortems?: string[];
}

/**
 * Fields `cardUpdate` may change: every field `cardCreate` accepts (the
 * fields set at creation time), all optional since an update only touches
 * what's supplied. Deliberately excludes `phase` (whose only legal path is
 * `cardTransition`, which also validates the transition graph and writes
 * `science_card_transitions` history) and evidence (only `cardEvidenceAdd`,
 * which writes `science_card_evidence`) — this is a plain field edit, never
 * a phase change or a history mutation.
 */
export type CardUpdateFields = Partial<CardCreateFields>;

/**
 * Runtime list of fields `cardUpdate` accepts, in the same order declared on
 * `CardCreateFields` — the single source of truth callers (CLI flag parsing,
 * an MCP zod schema) can iterate instead of re-declaring the field list.
 */
export const CARD_UPDATE_FIELDS: readonly (keyof CardUpdateFields)[] = [
  "title",
  "question",
  "claim_kind",
  "origin_method",
  "origin_contributors",
  "changed_assumptions",
  "proposed_mechanism",
  "math_model",
  "standard_prediction",
  "discriminating_prediction",
  "decisive_falsifier",
  "cheapest_test",
  "prior_art_status",
  "confidence",
  "novelty",
  "attempts",
  "attacks",
  "insights",
  "post_mortems",
];

export interface CardEvidence {
  id: number;
  card_id: number;
  type: EvidenceType;
  provenance: string;
  body: string | null;
  persona: string;
  ts: string;
}

export interface CardTransition {
  id: number;
  card_id: number;
  from_phase: CardPhase;
  to_phase: CardPhase;
  persona: string;
  ts: string;
  note: string | null;
}

/** `cardGet` result: the card plus its full evidence and transition history. */
export interface CardDetail extends Card {
  evidence: CardEvidence[];
  transitions: CardTransition[];
}

/** Raw `science_cards` row shape (JSON-array columns still string-encoded). */
interface CardRow {
  id: number;
  title: string;
  question: string;
  phase: string;
  claim_kind: string;
  origin_method: string | null;
  origin_contributors: string;
  changed_assumptions: string;
  proposed_mechanism: string | null;
  math_model: string | null;
  standard_prediction: string | null;
  discriminating_prediction: string | null;
  decisive_falsifier: string | null;
  cheapest_test: string | null;
  prior_art_status: string | null;
  confidence: number | null;
  novelty: number | null;
  attempts: string;
  attacks: string;
  insights: string;
  post_mortems: string;
  created_by: string;
  created_ts: string;
  updated_ts: string;
}

function rowToCard(row: CardRow): Card {
  return {
    ...row,
    phase: row.phase as CardPhase,
    claim_kind: row.claim_kind as ClaimKind,
    origin_contributors: JSON.parse(row.origin_contributors) as string[],
    changed_assumptions: JSON.parse(row.changed_assumptions) as string[],
    attempts: JSON.parse(row.attempts) as string[],
    attacks: JSON.parse(row.attacks) as string[],
    insights: JSON.parse(row.insights) as string[],
    post_mortems: JSON.parse(row.post_mortems) as string[],
  };
}

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

function envMinutes(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

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

export class Squad {
  /** This connection's session, created lazily on first touch. */
  private _sessionId: string | null = null;

  constructor(
    private db: DatabaseSync,
    private _persona: string,
  ) {}

  get persona(): string {
    return this._persona;
  }

  /** This connection's session id, or null before its first operation. */
  get sessionId(): string | null {
    return this._sessionId;
  }

  /** Rename this connection's identity (used by persona autofill on join). */
  setPersona(persona: string): void {
    this._persona = persona;
  }

  /**
   * Update presence and renew this connection's lease. Called by every
   * operation, so "the lease renews on any tool call" needs no separate
   * heartbeat. Creates the session on first call; a session ended by leave()
   * is never resurrected — the next operation opens a fresh one.
   */
  touch(): void {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO members (persona, first_seen, last_seen) VALUES (?, ?, ?)
         ON CONFLICT(persona) DO UPDATE SET last_seen = excluded.last_seen`,
      )
      .run(this.persona, ts, ts);
    if (!this._sessionId) this._sessionId = randomUUID();
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

  send(body: string, kind: "chat" | "system" = "chat"): Message {
    this.touch();
    const ts = now();
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO messages (sender, kind, body, ts) VALUES (?, ?, ?, ?)")
      .run(this.persona, kind, body, ts);
    return { id: Number(lastInsertRowid), sender: this.persona, kind, body, ts };
  }

  /** Stateless recent-history replay. Never touches any cursor. */
  read(limit = 30): Message[] {
    this.touch();
    const rows = this.db
      .prepare("SELECT * FROM messages ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as Message[];
    return rows.reverse();
  }

  private cursor(): number {
    const row = this.db
      .prepare("SELECT last_seen_id FROM cursors WHERE persona = ?")
      .get(this.persona) as { last_seen_id: number } | undefined;
    return row?.last_seen_id ?? 0;
  }

  private setCursor(id: number): void {
    this.db
      .prepare(
        `INSERT INTO cursors (persona, last_seen_id) VALUES (?, ?)
         ON CONFLICT(persona) DO UPDATE SET last_seen_id = excluded.last_seen_id`,
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
    return rows;
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
    return rows.map((r) => ({
      persona: r.persona,
      first_seen: r.member_first_seen ?? r.session_first_seen,
      last_seen: r.last_seen,
      lease_expires_at: r.lease_expires_at,
      state: presenceState(r.last_seen, r.lease_expires_at, nowMs),
      sessions: r.sessions,
    }));
  }

  /** members() minus yourself: the peers whose presence you actually need. */
  peers(): Member[] {
    return this.members().filter((m) => m.persona !== this.persona);
  }

  /** Sweep session rows nobody has touched in SESSION_RETENTION_HOURS. */
  private pruneSessions(): void {
    const cutoff = new Date(Date.now() - SESSION_RETENTION_HOURS * 3_600_000).toISOString();
    this.db
      .prepare("DELETE FROM sessions WHERE last_seen < ? AND session_id IS NOT ?")
      .run(cutoff, this._sessionId);
  }

  /**
   * Register presence and catch up: opens (or renews) this connection's lease
   * and returns your session id and lease expiry, who's here with their
   * presence state, the open goals, the current advisory claims, and recent
   * history. Advances the cursor past everything returned, so a subsequent
   * check() yields only genuinely new messages.
   */
  join(recentLimit = 30): JoinResult {
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
      claims: this.claims(),
      recent,
    };
  }

  /**
   * Create a Science Card in the QUESTION phase and announce it in chat as a
   * system message.
   */
  cardCreate(fields: CardCreateFields): Card {
    this.touch();
    if (!fields.title?.trim()) throw new Error("card title is required");
    if (!fields.question?.trim()) throw new Error("card question is required");
    const claimKind: ClaimKind = fields.claim_kind ?? "empirical";
    if (claimKind !== "empirical" && claimKind !== "formal") {
      throw new Error(`invalid claim_kind "${claimKind}" (must be "empirical" or "formal")`);
    }
    const ts = now();
    const row: CardRow = {
      id: 0,
      title: fields.title,
      question: fields.question,
      phase: "QUESTION",
      claim_kind: claimKind,
      origin_method: fields.origin_method ?? null,
      origin_contributors: JSON.stringify(fields.origin_contributors ?? []),
      changed_assumptions: JSON.stringify(fields.changed_assumptions ?? []),
      proposed_mechanism: fields.proposed_mechanism ?? null,
      math_model: fields.math_model ?? null,
      standard_prediction: fields.standard_prediction ?? null,
      discriminating_prediction: fields.discriminating_prediction ?? null,
      decisive_falsifier: fields.decisive_falsifier ?? null,
      cheapest_test: fields.cheapest_test ?? null,
      prior_art_status: fields.prior_art_status ?? null,
      confidence: fields.confidence ?? null,
      novelty: fields.novelty ?? null,
      attempts: JSON.stringify(fields.attempts ?? []),
      attacks: JSON.stringify(fields.attacks ?? []),
      insights: JSON.stringify(fields.insights ?? []),
      post_mortems: JSON.stringify(fields.post_mortems ?? []),
      created_by: this.persona,
      created_ts: ts,
      updated_ts: ts,
    };
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO science_cards (
           title, question, phase, claim_kind, origin_method, origin_contributors,
           changed_assumptions, proposed_mechanism, math_model, standard_prediction,
           discriminating_prediction, decisive_falsifier, cheapest_test, prior_art_status,
           confidence, novelty, attempts, attacks, insights, post_mortems,
           created_by, created_ts, updated_ts
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.title,
        row.question,
        row.phase,
        row.claim_kind,
        row.origin_method,
        row.origin_contributors,
        row.changed_assumptions,
        row.proposed_mechanism,
        row.math_model,
        row.standard_prediction,
        row.discriminating_prediction,
        row.decisive_falsifier,
        row.cheapest_test,
        row.prior_art_status,
        row.confidence,
        row.novelty,
        row.attempts,
        row.attacks,
        row.insights,
        row.post_mortems,
        row.created_by,
        row.created_ts,
        row.updated_ts,
      );
    row.id = Number(lastInsertRowid);
    this.send(`${this.persona} opened science card #${row.id}: ${row.title}`, "system");
    return rowToCard(row);
  }

  /**
   * Edit a card's fields set at creation time (title, confidence, novelty,
   * prior-art status, etc.) and announce the change in chat as a system
   * message. Never touches `phase` or history — moving phase is exclusively
   * `cardTransition`'s job (it validates the transition graph and records
   * `science_card_transitions`), and evidence is exclusively
   * `cardEvidenceAdd`'s job — so neither `phase` nor evidence/transition
   * history are among `CARD_UPDATE_FIELDS` and passing them here has no
   * effect. Only fields actually present in `fields` change; omitted fields
   * keep their current value. Requires at least one recognized field.
   */
  cardUpdate(id: number, fields: CardUpdateFields): Card {
    this.touch();
    const row = this.db.prepare("SELECT * FROM science_cards WHERE id = ?").get(id) as
      | CardRow
      | undefined;
    if (!row) throw new Error(`no science card with id ${id}`);

    const changedKeys = (Object.keys(fields) as (keyof CardUpdateFields)[]).filter(
      (k) => fields[k] !== undefined && (CARD_UPDATE_FIELDS as readonly string[]).includes(k),
    );
    if (changedKeys.length === 0) {
      throw new Error(
        `card update requires at least one field to change (allowed: ${CARD_UPDATE_FIELDS.join(", ")})`,
      );
    }
    if (fields.title !== undefined && !fields.title.trim()) {
      throw new Error("card title cannot be empty");
    }
    if (fields.question !== undefined && !fields.question.trim()) {
      throw new Error("card question cannot be empty");
    }
    if (
      fields.claim_kind !== undefined &&
      fields.claim_kind !== "empirical" &&
      fields.claim_kind !== "formal"
    ) {
      throw new Error(`invalid claim_kind "${fields.claim_kind}" (must be "empirical" or "formal")`);
    }

    const ts = now();
    const merged: CardRow = {
      ...row,
      title: fields.title ?? row.title,
      question: fields.question ?? row.question,
      claim_kind: fields.claim_kind ?? row.claim_kind,
      origin_method: fields.origin_method !== undefined ? fields.origin_method : row.origin_method,
      origin_contributors:
        fields.origin_contributors !== undefined
          ? JSON.stringify(fields.origin_contributors)
          : row.origin_contributors,
      changed_assumptions:
        fields.changed_assumptions !== undefined
          ? JSON.stringify(fields.changed_assumptions)
          : row.changed_assumptions,
      proposed_mechanism:
        fields.proposed_mechanism !== undefined ? fields.proposed_mechanism : row.proposed_mechanism,
      math_model: fields.math_model !== undefined ? fields.math_model : row.math_model,
      standard_prediction:
        fields.standard_prediction !== undefined ? fields.standard_prediction : row.standard_prediction,
      discriminating_prediction:
        fields.discriminating_prediction !== undefined
          ? fields.discriminating_prediction
          : row.discriminating_prediction,
      decisive_falsifier:
        fields.decisive_falsifier !== undefined ? fields.decisive_falsifier : row.decisive_falsifier,
      cheapest_test: fields.cheapest_test !== undefined ? fields.cheapest_test : row.cheapest_test,
      prior_art_status:
        fields.prior_art_status !== undefined ? fields.prior_art_status : row.prior_art_status,
      confidence: fields.confidence !== undefined ? fields.confidence : row.confidence,
      novelty: fields.novelty !== undefined ? fields.novelty : row.novelty,
      attempts: fields.attempts !== undefined ? JSON.stringify(fields.attempts) : row.attempts,
      attacks: fields.attacks !== undefined ? JSON.stringify(fields.attacks) : row.attacks,
      insights: fields.insights !== undefined ? JSON.stringify(fields.insights) : row.insights,
      post_mortems:
        fields.post_mortems !== undefined ? JSON.stringify(fields.post_mortems) : row.post_mortems,
      updated_ts: ts,
    };

    this.db
      .prepare(
        `UPDATE science_cards SET
           title = ?, question = ?, claim_kind = ?, origin_method = ?, origin_contributors = ?,
           changed_assumptions = ?, proposed_mechanism = ?, math_model = ?, standard_prediction = ?,
           discriminating_prediction = ?, decisive_falsifier = ?, cheapest_test = ?, prior_art_status = ?,
           confidence = ?, novelty = ?, attempts = ?, attacks = ?, insights = ?, post_mortems = ?,
           updated_ts = ?
         WHERE id = ?`,
      )
      .run(
        merged.title,
        merged.question,
        merged.claim_kind,
        merged.origin_method,
        merged.origin_contributors,
        merged.changed_assumptions,
        merged.proposed_mechanism,
        merged.math_model,
        merged.standard_prediction,
        merged.discriminating_prediction,
        merged.decisive_falsifier,
        merged.cheapest_test,
        merged.prior_art_status,
        merged.confidence,
        merged.novelty,
        merged.attempts,
        merged.attacks,
        merged.insights,
        merged.post_mortems,
        merged.updated_ts,
        id,
      );

    this.send(`${this.persona} updated card #${id}: ${changedKeys.join(", ")}`, "system");
    return rowToCard(merged);
  }

  /**
   * Lists Science Cards. Unlike `goals()` (which hides done goals by
   * default), `cardList` returns cards in **every** phase by default —
   * FALSIFIED/ABANDONED/INCONCLUSIVE cards are never silently hidden, since
   * negative outcomes must stay queryable. Pass `phase`/`phases` to narrow
   * the listing to specific phase(s).
   */
  cardList(opts: { phase?: CardPhase; phases?: CardPhase[] } = {}): Card[] {
    this.touch();
    const phases = opts.phase ? [opts.phase] : opts.phases;
    const rows =
      phases && phases.length > 0
        ? (this.db
            .prepare(
              `SELECT * FROM science_cards WHERE phase IN (${phases.map(() => "?").join(",")}) ORDER BY id ASC`,
            )
            .all(...phases) as unknown as CardRow[])
        : (this.db.prepare("SELECT * FROM science_cards ORDER BY id ASC").all() as unknown as CardRow[]);
    return rows.map(rowToCard);
  }

  /** Full card detail: the card plus its complete evidence and transition history. */
  cardGet(id: number): CardDetail {
    this.touch();
    const row = this.db.prepare("SELECT * FROM science_cards WHERE id = ?").get(id) as
      | CardRow
      | undefined;
    if (!row) throw new Error(`no science card with id ${id}`);
    const evidence = this.db
      .prepare("SELECT * FROM science_card_evidence WHERE card_id = ? ORDER BY id ASC")
      .all(id) as unknown as CardEvidence[];
    const transitions = this.db
      .prepare("SELECT * FROM science_card_transitions WHERE card_id = ? ORDER BY id ASC")
      .all(id) as unknown as CardTransition[];
    return { ...rowToCard(row), evidence, transitions };
  }

  /**
   * Moves a card to `toPhase`, validating against the explicit allowed-
   * transition graph (TRANSITIONS) and rejecting illegal transitions (e.g.
   * QUESTION -> SUPPORTED) with a clear error — nothing is written to
   * `science_card_transitions` for a rejected attempt. An `empirical`-claim
   * card additionally requires at least one `experiment`/`observation`
   * evidence item before it can reach SUPPORTED — a `derivation`/
   * `formal-check`/`simulation`/`literature` item alone is never enough,
   * keeping "evidence verified" distinct from "card SUPPORTED". Legal
   * transitions are announced in chat as a system message.
   */
  cardTransition(id: number, toPhase: CardPhase, note?: string): Card {
    this.touch();
    const row = this.db.prepare("SELECT * FROM science_cards WHERE id = ?").get(id) as
      | CardRow
      | undefined;
    if (!row) throw new Error(`no science card with id ${id}`);
    const fromPhase = row.phase as CardPhase;
    const allowed = TRANSITIONS[fromPhase] ?? [];
    if (!allowed.includes(toPhase)) {
      throw new Error(
        `illegal science card transition ${fromPhase} -> ${toPhase} for card ${id} ` +
          `(allowed from ${fromPhase}: ${allowed.length ? allowed.join(", ") : "none — terminal phase"})`,
      );
    }
    if (toPhase === "SUPPORTED" && row.claim_kind === "empirical") {
      const evidenceRows = this.db
        .prepare("SELECT type FROM science_card_evidence WHERE card_id = ?")
        .all(id) as unknown as { type: string }[];
      const hasEmpiricalEvidence = evidenceRows.some((e) =>
        (EMPIRICAL_EVIDENCE_TYPES as readonly string[]).includes(e.type),
      );
      if (!hasEmpiricalEvidence) {
        throw new Error(
          `card ${id} declares an empirical claim and needs at least one experiment or ` +
            `observation evidence item before it can be marked SUPPORTED ` +
            `(derivation/formal-check/simulation/literature evidence alone is not sufficient)`,
        );
      }
    }
    const ts = now();
    this.db
      .prepare("UPDATE science_cards SET phase = ?, updated_ts = ? WHERE id = ?")
      .run(toPhase, ts, id);
    this.db
      .prepare(
        "INSERT INTO science_card_transitions (card_id, from_phase, to_phase, persona, ts, note) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, fromPhase, toPhase, this.persona, ts, note ?? null);
    this.send(
      `${this.persona} moved card #${id} ${fromPhase} -> ${toPhase}${note ? `: ${note}` : ""}`,
      "system",
    );
    row.phase = toPhase;
    row.updated_ts = ts;
    return rowToCard(row);
  }

  /**
   * Adds an evidence item to a card and announces it in chat as a system
   * message. Requires a `type` from the fixed enum and non-empty
   * `provenance`; rejects otherwise.
   */
  cardEvidenceAdd(
    cardId: number,
    type: EvidenceType,
    provenance: string,
    body?: string | null,
  ): CardEvidence {
    this.touch();
    if (!EVIDENCE_TYPES.includes(type)) {
      throw new Error(`invalid evidence type "${type}" (must be one of ${EVIDENCE_TYPES.join(", ")})`);
    }
    if (!provenance?.trim()) {
      throw new Error("evidence provenance is required");
    }
    const card = this.db.prepare("SELECT id FROM science_cards WHERE id = ?").get(cardId);
    if (!card) throw new Error(`no science card with id ${cardId}`);
    const ts = now();
    const { lastInsertRowid } = this.db
      .prepare(
        "INSERT INTO science_card_evidence (card_id, type, provenance, body, persona, ts) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(cardId, type, provenance, body ?? null, this.persona, ts);
    this.send(`${this.persona} added ${type} evidence to card #${cardId}: ${provenance}`, "system");
    return {
      id: Number(lastInsertRowid),
      card_id: cardId,
      type,
      provenance,
      body: body ?? null,
      persona: this.persona,
      ts,
    };
  }

  /**
   * Wipe the room: all messages, goals, claims, cursors, members, presence
   * sessions, divergence rounds/submissions, and science cards (with their
   * evidence and transition history). A live connection keeps its session id
   * and re-registers presence on its next operation.
   */
  clear(): void {
    this.db.exec(
      "DELETE FROM messages; DELETE FROM goals; DELETE FROM claims; DELETE FROM cursors; DELETE FROM members; " +
        "DELETE FROM sessions; " +
        "DELETE FROM divergence_submissions; DELETE FROM divergence_rounds; " +
        "DELETE FROM science_card_evidence; DELETE FROM science_card_transitions; DELETE FROM science_cards;",
    );
  }

  private rowToDivergenceRound(row: {
    id: number;
    card_id: number | null;
    topic: string;
    opened_by: string;
    opened_ts: string;
    expected_participants: string | null;
    status: string;
    closed_by: string | null;
    closed_ts: string | null;
  }): DivergenceRound {
    return {
      id: row.id,
      card_id: row.card_id,
      topic: row.topic,
      opened_by: row.opened_by,
      opened_ts: row.opened_ts,
      expected_participants: row.expected_participants ? JSON.parse(row.expected_participants) : null,
      status: row.status === "closed" ? "closed" : "open",
      closed_by: row.closed_by,
      closed_ts: row.closed_ts,
    };
  }

  private getDivergenceRound(roundId: number): DivergenceRound {
    const row = this.db.prepare("SELECT * FROM divergence_rounds WHERE id = ?").get(roundId) as
      | unknown
      | undefined;
    if (!row) throw new Error(`no divergence round with id ${roundId}`);
    return this.rowToDivergenceRound(row as Parameters<typeof this.rowToDivergenceRound>[0]);
  }

  /**
   * Open a divergence round and announce it to chat — the announcement
   * carries only the topic, never a future submission body.
   */
  divergeOpen(
    topic: string,
    opts: { cardId?: number; expectedParticipants?: string[] } = {},
  ): DivergenceRound {
    this.touch();
    const ts = now();
    const expected = opts.expectedParticipants ?? null;
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO divergence_rounds (card_id, topic, opened_by, opened_ts, expected_participants, status)
         VALUES (?, ?, ?, ?, ?, 'open')`,
      )
      .run(opts.cardId ?? null, topic, this.persona, ts, expected ? JSON.stringify(expected) : null);
    const id = Number(lastInsertRowid);
    this.send(`${this.persona} opened divergence round #${id}: ${topic}`, "system");
    return {
      id,
      card_id: opts.cardId ?? null,
      topic,
      opened_by: this.persona,
      opened_ts: ts,
      expected_participants: expected,
      status: "open",
      closed_by: null,
      closed_ts: null,
    };
  }

  /**
   * Record this persona's independent submission to an open round.
   * Resubmission overwrites (idempotent per persona, no duplicate rows). The
   * return value never includes another persona's submission.
   */
  divergeSubmit(roundId: number, body: string): DivergenceSubmission {
    this.touch();
    const round = this.getDivergenceRound(roundId);
    if (round.status === "closed") {
      throw new Error(`divergence round #${roundId} is already closed`);
    }
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO divergence_submissions (round_id, persona, body, submitted_ts) VALUES (?, ?, ?, ?)
         ON CONFLICT(round_id, persona) DO UPDATE SET body = excluded.body, submitted_ts = excluded.submitted_ts`,
      )
      .run(roundId, this.persona, body, ts);
    const mine = this.db
      .prepare("SELECT * FROM divergence_submissions WHERE round_id = ? AND persona = ?")
      .get(roundId, this.persona) as unknown as DivergenceSubmission;

    // Auto-close once every expected participant has submitted. Only reads
    // *who* has submitted (personas), never a submission body.
    if (round.expected_participants && round.expected_participants.length > 0) {
      const rows = this.db
        .prepare("SELECT DISTINCT persona FROM divergence_submissions WHERE round_id = ?")
        .all(roundId) as unknown as Array<{ persona: string }>;
      const submitted = new Set(rows.map((r) => r.persona));
      const allIn = round.expected_participants.every((p) => submitted.has(p));
      if (allIn) this.closeDivergenceRound(round, this.persona, true);
    }

    return mine;
  }

  /**
   * The caller's view of a round: while open, who has submitted (not what)
   * plus the caller's own submission if made; while closed, every
   * submission.
   */
  divergeStatus(roundId: number): DivergenceStatus {
    this.touch();
    const round = this.getDivergenceRound(roundId);
    const rows = this.db
      .prepare("SELECT DISTINCT persona FROM divergence_submissions WHERE round_id = ?")
      .all(roundId) as unknown as Array<{ persona: string }>;
    const submitted_personas = rows.map((r) => r.persona);
    const mineRow = this.db
      .prepare("SELECT * FROM divergence_submissions WHERE round_id = ? AND persona = ?")
      .get(roundId, this.persona) as unknown as DivergenceSubmission | undefined;
    const mine = mineRow ?? null;

    if (round.status !== "closed") {
      return { round, submitted_personas, mine, submissions: null };
    }
    const submissions = this.db
      .prepare("SELECT * FROM divergence_submissions WHERE round_id = ? ORDER BY id ASC")
      .all(roundId) as unknown as DivergenceSubmission[];
    return { round, submitted_personas, mine, submissions };
  }

  private closeDivergenceRound(round: DivergenceRound, closedBy: string, auto: boolean): DivergenceRound {
    const ts = now();
    this.db
      .prepare("UPDATE divergence_rounds SET status = 'closed', closed_by = ?, closed_ts = ? WHERE id = ?")
      .run(closedBy, ts, round.id);
    const { n: count } = this.db
      .prepare("SELECT COUNT(*) AS n FROM divergence_submissions WHERE round_id = ?")
      .get(round.id) as { n: number };
    const how = auto ? "auto-closed (all expected participants submitted)" : "closed";
    this.send(
      `${closedBy} ${how} divergence round #${round.id}: ${round.topic} ` +
        `(${count} submission${count === 1 ? "" : "s"} revealed)`,
      "system",
    );
    return { ...round, status: "closed", closed_by: closedBy, closed_ts: ts };
  }

  /**
   * Explicitly close a round: reveals every submission and announces the
   * reveal to chat. Idempotent — a no-op returning the current state if the
   * round is already closed.
   */
  divergeClose(roundId: number): DivergenceRound {
    this.touch();
    const round = this.getDivergenceRound(roundId);
    if (round.status === "closed") return round;
    return this.closeDivergenceRound(round, this.persona, false);
  }
}
