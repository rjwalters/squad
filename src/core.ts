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

const now = () => new Date().toISOString();

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
   * Wipe the room: all messages, goals, claims, cursors, members, and
   * divergence rounds/submissions.
   */
  clear(): void {
    this.db.exec(
      "DELETE FROM messages; DELETE FROM goals; DELETE FROM claims; DELETE FROM cursors; DELETE FROM members; " +
        "DELETE FROM divergence_submissions; DELETE FROM divergence_rounds;",
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
