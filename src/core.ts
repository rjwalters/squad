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

const now = () => new Date().toISOString();

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

  members(): Member[] {
    return this.db
      .prepare("SELECT * FROM members ORDER BY last_seen DESC")
      .all() as unknown as Member[];
  }

  /**
   * Register presence and catch up: returns who's here, the open goals, and
   * recent history. Advances the cursor past everything returned, so a
   * subsequent check() yields only genuinely new messages.
   */
  join(recentLimit = 30): { members: Member[]; goals: Goal[]; recent: Message[] } {
    this.touch();
    const recent = this.read(recentLimit);
    this.setCursor(this.maxMessageId());
    return { members: this.members(), goals: this.goals(), recent };
  }

  /** Wipe the room: all messages, goals, cursors, and members. */
  clear(): void {
    this.db.exec("DELETE FROM messages; DELETE FROM goals; DELETE FROM cursors; DELETE FROM members;");
  }
}
