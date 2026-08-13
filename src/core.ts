import type { DatabaseSync } from "node:sqlite";
import {
  CARD_CLAIM_KINDS,
  CARD_EVIDENCE_STATUSES,
  CARD_EVIDENCE_TYPES,
  CARD_PHASES,
  CARD_PRIOR_ART_STATUSES,
  CARD_STATUSES,
  EMPIRICAL_EVIDENCE_TYPES,
  PHASE_TRANSITIONS,
  TERMINAL_PHASE_STATUS,
  toScienceCardDocument,
} from "./science-card.js";
import type {
  Card,
  CardClaimKind,
  CardDetail,
  CardEvidence,
  CardEvidenceStatus,
  CardEvidenceType,
  CardNote,
  CardPhase,
  CardPriorArtStatus,
  CardStatus,
  CardTransition,
} from "./science-card.js";

// Card vocabulary lives in science-card.ts (it is the runtime-neutral part),
// but callers import card types from the same place they import Goal and
// Claim, so re-export them here.
export type {
  Card,
  CardClaimKind,
  CardDetail,
  CardEvidence,
  CardEvidenceStatus,
  CardEvidenceType,
  CardNote,
  CardPhase,
  CardPriorArtStatus,
  CardStatus,
  CardTransition,
};
export {
  CARD_CLAIM_KINDS,
  CARD_EVIDENCE_STATUSES,
  CARD_EVIDENCE_TYPES,
  CARD_PHASES,
  CARD_PRIOR_ART_STATUSES,
  CARD_STATUSES,
  EMPIRICAL_EVIDENCE_TYPES,
  PHASE_TRANSITIONS,
  SCIENCE_CARD_SCHEMA_ID,
  SCIENCE_CARD_SCHEMA_VERSION,
  scienceCardSchema,
  toScienceCardDocument,
  validateScienceCard,
} from "./science-card.js";

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

export interface Member {
  persona: string;
  first_seen: string;
  last_seen: string;
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
  /** Holder's last_seen, or null when the holder has no member record. */
  last_seen: string | null;
  /** True when the holder has been absent longer than the staleness threshold. */
  stale: boolean;
}

const now = () => new Date().toISOString();

/** Fields accepted by `cardCreate`. Everything but title/question is optional. */
export interface CardCreateFields {
  title: string;
  question: string;
  /** Defaults to `empirical` — the stricter bar for reaching SUPPORTED. */
  claim_kind?: CardClaimKind;
  origin_method?: string | null;
  /** Defaults to `[the creating persona]`. */
  contributors?: string[];
  changed_assumptions?: string[];
  proposed_mechanism?: string | null;
  model_statement?: string | null;
  null_prediction?: string | null;
  discriminating_prediction?: string | null;
  decisive_falsifier?: string | null;
  cheapest_test?: string | null;
  prior_art_status?: CardPriorArtStatus;
  confidence?: number | null;
  novelty?: number | null;
  attempts?: Array<string | CardNote>;
  attacks?: Array<string | CardNote>;
  insights?: Array<string | CardNote>;
  post_mortems?: Array<string | CardNote>;
}

/** Filters for `cardList`. All of them narrow a default of "every card". */
export interface CardListOptions {
  status?: CardStatus | CardStatus[];
  phase?: CardPhase | CardPhase[];
  /** Shorthand for `status: "OPEN"` — cards still in play. */
  openOnly?: boolean;
}

/** The raw `science_cards` row shape: compound fields arrive as JSON text. */
interface CardRow {
  id: number;
  title: string;
  question: string;
  phase: CardPhase;
  status: CardStatus;
  claim_kind: CardClaimKind;
  origin_method: string | null;
  contributors: string;
  changed_assumptions: string;
  proposed_mechanism: string | null;
  model_statement: string | null;
  null_prediction: string | null;
  discriminating_prediction: string | null;
  decisive_falsifier: string | null;
  cheapest_test: string | null;
  prior_art_status: CardPriorArtStatus;
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

function parseJsonArray<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return []; // a corrupt blob must not make the whole card unreadable
  }
}

function rowToCard(row: CardRow): Card {
  return {
    ...row,
    contributors: parseJsonArray<string>(row.contributors),
    changed_assumptions: parseJsonArray<string>(row.changed_assumptions),
    attempts: parseJsonArray<CardNote>(row.attempts),
    attacks: parseJsonArray<CardNote>(row.attacks),
    insights: parseJsonArray<CardNote>(row.insights),
    post_mortems: parseJsonArray<CardNote>(row.post_mortems),
  };
}

/** Bare strings are the common case; both forms are stored as dated notes. */
function normalizeNotes(
  input: Array<string | CardNote> | undefined,
  persona: string,
  ts: string,
): CardNote[] {
  return (input ?? []).map((n) =>
    typeof n === "string"
      ? { body: n, persona, ts }
      : { body: n.body, persona: n.persona ?? persona, ts: n.ts ?? ts },
  );
}

function toArray<T>(v: T | T[]): T[] {
  return Array.isArray(v) ? v : [v];
}

function requireText(value: string | undefined | null, field: string): string {
  const text = (value ?? "").trim();
  if (!text) throw new Error(`${field} is required and cannot be empty`);
  return text;
}

function requireEnum<T extends string>(value: string, allowed: readonly T[], field: string): T {
  if (!allowed.includes(value as T)) {
    throw new Error(`invalid ${field} '${value}' (expected one of: ${allowed.join(", ")})`);
  }
  return value as T;
}

function requireUnitInterval(value: number | null | undefined, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${field} must be between 0 and 1 (got ${value})`);
  }
  return value;
}

/**
 * A claim goes stale with its holder: once the claiming persona has not touched
 * the room for this many minutes, the claim is listed as stale so a peer can
 * take it over explicitly. Advisory only — nothing expires or is enforced.
 */
export const DEFAULT_STALE_MINUTES = 30;

function staleMinutes(): number {
  const raw = process.env.SQUAD_STALE_MINUTES;
  if (!raw) return DEFAULT_STALE_MINUTES;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_STALE_MINUTES;
}

export class Squad {
  constructor(
    private db: DatabaseSync,
    private _persona: string,
  ) {}

  get persona(): string {
    return this._persona;
  }

  /** Rename this connection's identity (used by persona autofill on join). */
  setPersona(persona: string): void {
    this._persona = persona;
  }

  /** Update presence. Called by every operation. */
  touch(): void {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO members (persona, first_seen, last_seen) VALUES (?, ?, ?)
         ON CONFLICT(persona) DO UPDATE SET last_seen = excluded.last_seen`,
      )
      .run(this.persona, ts, ts);
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

  unreadCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE id > ? AND sender != ?")
      .get(this.cursor(), this.persona) as { n: number };
    return row.n;
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
   * last_seen and whether that presence has gone stale.
   */
  claims(): ClaimView[] {
    this.touch();
    const rows = this.db
      .prepare(
        `SELECT c.id, c.path, c.persona, c.created_ts, m.last_seen AS last_seen
           FROM claims c LEFT JOIN members m ON m.persona = c.persona
          ORDER BY c.id ASC`,
      )
      .all() as unknown as Array<Claim & { last_seen: string | null }>;
    const cutoff = Date.now() - staleMinutes() * 60_000;
    return rows.map((r) => ({
      ...r,
      // No member record means the holder is gone entirely — treat as stale.
      stale: r.last_seen === null || Date.parse(r.last_seen) < cutoff,
    }));
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

  // ---------------------------------------------------------------------
  // Science Cards
  // ---------------------------------------------------------------------

  /**
   * Create a Science Card in the QUESTION phase and announce it in chat, so
   * teammates learn about it through the same check() loop that carries goals
   * and claims.
   */
  cardCreate(fields: CardCreateFields): Card {
    this.touch();
    const title = requireText(fields.title, "title");
    const question = requireText(fields.question, "question");
    const claim_kind = requireEnum(
      fields.claim_kind ?? "empirical",
      CARD_CLAIM_KINDS,
      "claim_kind",
    );
    const prior_art_status = requireEnum(
      fields.prior_art_status ?? "unknown",
      CARD_PRIOR_ART_STATUSES,
      "prior_art_status",
    );
    const confidence = requireUnitInterval(fields.confidence, "confidence");
    const novelty = requireUnitInterval(fields.novelty, "novelty");
    const ts = now();
    const notes = (input?: Array<string | CardNote>) => normalizeNotes(input, this.persona, ts);

    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO science_cards (
           title, question, phase, status, claim_kind, origin_method, contributors,
           changed_assumptions, proposed_mechanism, model_statement, null_prediction,
           discriminating_prediction, decisive_falsifier, cheapest_test, prior_art_status,
           confidence, novelty, attempts, attacks, insights, post_mortems,
           created_by, created_ts, updated_ts
         ) VALUES (?, ?, 'QUESTION', 'OPEN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        title,
        question,
        claim_kind,
        fields.origin_method ?? null,
        JSON.stringify(fields.contributors ?? [this.persona]),
        JSON.stringify(fields.changed_assumptions ?? []),
        fields.proposed_mechanism ?? null,
        fields.model_statement ?? null,
        fields.null_prediction ?? null,
        fields.discriminating_prediction ?? null,
        fields.decisive_falsifier ?? null,
        fields.cheapest_test ?? null,
        prior_art_status,
        confidence,
        novelty,
        JSON.stringify(notes(fields.attempts)),
        JSON.stringify(notes(fields.attacks)),
        JSON.stringify(notes(fields.insights)),
        JSON.stringify(notes(fields.post_mortems)),
        this.persona,
        ts,
        ts,
      );
    const id = Number(lastInsertRowid);
    // Genesis entry: history is complete from the card's first breath, so
    // "how did this get here" never has to be inferred from created_ts.
    this.db
      .prepare(
        `INSERT INTO science_card_transitions (card_id, from_phase, to_phase, persona, ts, note)
         VALUES (?, NULL, 'QUESTION', ?, ?, ?)`,
      )
      .run(id, this.persona, ts, "card created");
    this.send(`${this.persona} created science card #${id} (QUESTION): ${title}`, "system");
    return this.cardRow(id);
  }

  /**
   * List cards, newest first.
   *
   * **The default is everything.** Unlike `goals()`, which hides done goals
   * unless asked, a settled card is a result: FALSIFIED, INCONCLUSIVE, and
   * ABANDONED cards are returned by default and stay queryable forever. Pass
   * `openOnly` (or an explicit `status`/`phase` filter) to narrow.
   */
  cardList(opts: CardListOptions = {}): Card[] {
    this.touch();
    const where: string[] = [];
    const params: string[] = [];
    const statuses = opts.openOnly
      ? (["OPEN"] as CardStatus[])
      : opts.status
        ? toArray(opts.status)
        : [];
    if (statuses.length) {
      for (const s of statuses) requireEnum(s, CARD_STATUSES, "status");
      where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
      params.push(...statuses);
    }
    const phases = opts.phase ? toArray(opts.phase) : [];
    if (phases.length) {
      for (const p of phases) requireEnum(p, CARD_PHASES, "phase");
      where.push(`phase IN (${phases.map(() => "?").join(", ")})`);
      params.push(...phases);
    }
    const sql =
      `SELECT * FROM science_cards${where.length ? ` WHERE ${where.join(" AND ")}` : ""}` +
      ` ORDER BY id DESC`;
    const rows = this.db.prepare(sql).all(...params) as unknown as CardRow[];
    return rows.map(rowToCard);
  }

  /** A card with its full evidence list and transition history. */
  cardGet(id: number): CardDetail {
    this.touch();
    const card = this.cardRow(id);
    return {
      ...card,
      evidence: this.db
        .prepare("SELECT * FROM science_card_evidence WHERE card_id = ? ORDER BY id ASC")
        .all(id) as unknown as CardEvidence[],
      transitions: this.db
        .prepare("SELECT * FROM science_card_transitions WHERE card_id = ? ORDER BY id ASC")
        .all(id) as unknown as CardTransition[],
    };
  }

  /** The card as a canonical Science Card document (see the JSON Schema). */
  cardDocument(id: number): Record<string, unknown> {
    return toScienceCardDocument(this.cardGet(id));
  }

  /**
   * Move a card to another phase, if the graph allows it, and record the move
   * in the card's append-only history.
   *
   * Two rules are enforced here, and both are refusals rather than warnings:
   *
   * 1. The move must be legal in `PHASE_TRANSITIONS` — no jumping from
   *    QUESTION straight to SUPPORTED.
   * 2. A card whose claim is `empirical` or `mixed` cannot reach SUPPORTED on
   *    derivation/formal-check/simulation/literature evidence alone. A
   *    `verified` proof is verified mathematics, not a supported claim about
   *    the world.
   *
   * Reaching a terminal phase sets the card's claim-level status; leaving one
   * through LEARN returns it to OPEN.
   */
  cardTransition(id: number, toPhase: CardPhase, note?: string): CardDetail {
    this.touch();
    const card = this.cardRow(id);
    const to = requireEnum(toPhase, CARD_PHASES, "phase");
    const allowed = PHASE_TRANSITIONS[card.phase];
    if (!allowed.includes(to)) {
      throw new Error(
        `illegal transition for science card #${id}: ${card.phase} -> ${to} ` +
          `(allowed from ${card.phase}: ${allowed.join(", ")})`,
      );
    }
    if (to === "SUPPORTED" && card.claim_kind !== "formal") {
      const empirical = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM science_card_evidence
            WHERE card_id = ? AND status != 'refuted'
              AND type IN (${EMPIRICAL_EVIDENCE_TYPES.map(() => "?").join(", ")})`,
        )
        .get(id, ...EMPIRICAL_EVIDENCE_TYPES) as { n: number };
      if (empirical.n === 0) {
        throw new Error(
          `science card #${id} makes an ${card.claim_kind} claim, so it cannot be SUPPORTED ` +
            `without unrefuted empirical evidence (${EMPIRICAL_EVIDENCE_TYPES.join(" or ")}): ` +
            `a verified derivation or formal-check is evidence about the mathematics, not ` +
            `about the world`,
        );
      }
    }
    const ts = now();
    const status: CardStatus = TERMINAL_PHASE_STATUS[to] ?? "OPEN";
    this.db
      .prepare("UPDATE science_cards SET phase = ?, status = ?, updated_ts = ? WHERE id = ?")
      .run(to, status, ts, id);
    this.db
      .prepare(
        `INSERT INTO science_card_transitions (card_id, from_phase, to_phase, persona, ts, note)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, card.phase, to, this.persona, ts, note ?? null);
    const statusNote = status === "OPEN" ? "" : ` [status ${status}]`;
    this.send(
      `${this.persona} moved science card #${id} ${card.phase} -> ${to}${statusNote}` +
        `${note ? `: ${note}` : ""}`,
      "system",
    );
    return this.cardGet(id);
  }

  /**
   * Attach a typed, sourced piece of evidence to a card.
   *
   * `type` must be one of the six recognised kinds and `provenance` must be
   * non-empty — evidence nobody can trace back to a file, run, or paper is an
   * assertion, and the point of the card is to keep the two apart. The
   * evidence item's own `status` (default `pending`) describes that item only;
   * it never promotes the card's claim.
   */
  cardEvidenceAdd(
    id: number,
    type: CardEvidenceType,
    provenance: string,
    body: string,
    opts: { status?: CardEvidenceStatus } = {},
  ): CardEvidence {
    this.touch();
    this.cardRow(id); // 404s before writing an orphan row
    const evidenceType = requireEnum(type, CARD_EVIDENCE_TYPES, "evidence type");
    const source = requireText(provenance, "provenance");
    const text = requireText(body, "evidence body");
    const status = requireEnum(opts.status ?? "pending", CARD_EVIDENCE_STATUSES, "evidence status");
    const ts = now();
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO science_card_evidence (card_id, type, provenance, body, status, persona, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, evidenceType, source, text, status, this.persona, ts);
    this.db.prepare("UPDATE science_cards SET updated_ts = ? WHERE id = ?").run(ts, id);
    this.send(
      `${this.persona} added ${evidenceType} evidence to science card #${id} (${status}, ` +
        `source: ${source})`,
      "system",
    );
    return {
      id: Number(lastInsertRowid),
      card_id: id,
      type: evidenceType,
      provenance: source,
      body: text,
      status,
      persona: this.persona,
      ts,
    };
  }

  /** The card row, or a clear error naming the id that does not exist. */
  private cardRow(id: number): Card {
    const row = this.db.prepare("SELECT * FROM science_cards WHERE id = ?").get(id) as
      | CardRow
      | undefined;
    if (!row) throw new Error(`no science card with id ${id}`);
    return rowToCard(row);
  }

  members(): Member[] {
    return this.db
      .prepare("SELECT * FROM members ORDER BY last_seen DESC")
      .all() as unknown as Member[];
  }

  /**
   * Register presence and catch up: returns who's here, the open goals, the
   * current advisory claims, and recent history. Advances the cursor past
   * everything returned, so a subsequent check() yields only genuinely new
   * messages.
   */
  join(recentLimit = 30): {
    members: Member[];
    goals: Goal[];
    claims: ClaimView[];
    recent: Message[];
  } {
    this.touch();
    const recent = this.read(recentLimit);
    this.setCursor(this.maxMessageId());
    return { members: this.members(), goals: this.goals(), claims: this.claims(), recent };
  }

  /**
   * Wipe the room: all messages, goals, claims, cursors, members, and science
   * cards (with their evidence and transition history).
   */
  clear(): void {
    this.db.exec(
      "DELETE FROM messages; DELETE FROM goals; DELETE FROM claims; DELETE FROM cursors; DELETE FROM members;" +
        " DELETE FROM science_card_evidence; DELETE FROM science_card_transitions; DELETE FROM science_cards;",
    );
  }
}
