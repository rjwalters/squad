import type { DatabaseSync } from "node:sqlite";

/**
 * Divergence-round domain: bounded windows where each participant submits
 * independently. Extracted from `core.ts`; `Squad.diverge*` delegate here.
 * Shared room state is passed in as an explicit {@link DivergeContext} rather
 * than reached through `Squad` internals.
 */

const now = () => new Date().toISOString();

/**
 * What the divergence operations need from the room: the db handle, the
 * acting persona, and a way to announce a system message in chat. `Squad`
 * calls `touch()` itself before delegating, so it is not part of the context.
 */
export interface DivergeContext {
  db: DatabaseSync;
  persona: string;
  send(body: string, kind: "system"): unknown;
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

type DivergenceRoundRow = {
  id: number;
  card_id: number | null;
  topic: string;
  opened_by: string;
  opened_ts: string;
  expected_participants: string | null;
  status: string;
  closed_by: string | null;
  closed_ts: string | null;
};

function rowToDivergenceRound(row: DivergenceRoundRow): DivergenceRound {
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

function getDivergenceRound(ctx: DivergeContext, roundId: number): DivergenceRound {
  const row = ctx.db.prepare("SELECT * FROM divergence_rounds WHERE id = ?").get(roundId) as
    | unknown
    | undefined;
  if (!row) throw new Error(`no divergence round with id ${roundId}`);
  return rowToDivergenceRound(row as DivergenceRoundRow);
}

function closeDivergenceRound(
  ctx: DivergeContext,
  round: DivergenceRound,
  closedBy: string,
  auto: boolean,
): DivergenceRound {
  const ts = now();
  ctx.db
    .prepare("UPDATE divergence_rounds SET status = 'closed', closed_by = ?, closed_ts = ? WHERE id = ?")
    .run(closedBy, ts, round.id);
  const { n: count } = ctx.db
    .prepare("SELECT COUNT(*) AS n FROM divergence_submissions WHERE round_id = ?")
    .get(round.id) as { n: number };
  const how = auto ? "auto-closed (all expected participants submitted)" : "closed";
  ctx.send(
    `${closedBy} ${how} divergence round #${round.id}: ${round.topic} ` +
      `(${count} submission${count === 1 ? "" : "s"} revealed)`,
    "system",
  );
  return { ...round, status: "closed", closed_by: closedBy, closed_ts: ts };
}

/**
 * Open a divergence round and announce it to chat — the announcement
 * carries only the topic, never a future submission body.
 */
export function divergeOpen(
  ctx: DivergeContext,
  topic: string,
  opts: { cardId?: number; expectedParticipants?: string[] } = {},
): DivergenceRound {
  const ts = now();
  const expected = opts.expectedParticipants ?? null;
  const { lastInsertRowid } = ctx.db
    .prepare(
      `INSERT INTO divergence_rounds (card_id, topic, opened_by, opened_ts, expected_participants, status)
       VALUES (?, ?, ?, ?, ?, 'open')`,
    )
    .run(opts.cardId ?? null, topic, ctx.persona, ts, expected ? JSON.stringify(expected) : null);
  const id = Number(lastInsertRowid);
  ctx.send(`${ctx.persona} opened divergence round #${id}: ${topic}`, "system");
  return {
    id,
    card_id: opts.cardId ?? null,
    topic,
    opened_by: ctx.persona,
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
export function divergeSubmit(
  ctx: DivergeContext,
  roundId: number,
  body: string,
): DivergenceSubmission {
  const round = getDivergenceRound(ctx, roundId);
  if (round.status === "closed") {
    throw new Error(`divergence round #${roundId} is already closed`);
  }
  const ts = now();
  ctx.db
    .prepare(
      `INSERT INTO divergence_submissions (round_id, persona, body, submitted_ts) VALUES (?, ?, ?, ?)
       ON CONFLICT(round_id, persona) DO UPDATE SET body = excluded.body, submitted_ts = excluded.submitted_ts`,
    )
    .run(roundId, ctx.persona, body, ts);
  const mine = ctx.db
    .prepare("SELECT * FROM divergence_submissions WHERE round_id = ? AND persona = ?")
    .get(roundId, ctx.persona) as unknown as DivergenceSubmission;

  // Auto-close once every expected participant has submitted. Only reads
  // *who* has submitted (personas), never a submission body.
  if (round.expected_participants && round.expected_participants.length > 0) {
    const rows = ctx.db
      .prepare("SELECT DISTINCT persona FROM divergence_submissions WHERE round_id = ?")
      .all(roundId) as unknown as Array<{ persona: string }>;
    const submitted = new Set(rows.map((r) => r.persona));
    const allIn = round.expected_participants.every((p) => submitted.has(p));
    if (allIn) closeDivergenceRound(ctx, round, ctx.persona, true);
  }

  return mine;
}

/**
 * The caller's view of a round: while open, who has submitted (not what)
 * plus the caller's own submission if made; while closed, every
 * submission.
 */
export function divergeStatus(ctx: DivergeContext, roundId: number): DivergenceStatus {
  const round = getDivergenceRound(ctx, roundId);
  const rows = ctx.db
    .prepare("SELECT DISTINCT persona FROM divergence_submissions WHERE round_id = ?")
    .all(roundId) as unknown as Array<{ persona: string }>;
  const submitted_personas = rows.map((r) => r.persona);
  const mineRow = ctx.db
    .prepare("SELECT * FROM divergence_submissions WHERE round_id = ? AND persona = ?")
    .get(roundId, ctx.persona) as unknown as DivergenceSubmission | undefined;
  const mine = mineRow ?? null;

  if (round.status !== "closed") {
    return { round, submitted_personas, mine, submissions: null };
  }
  const submissions = ctx.db
    .prepare("SELECT * FROM divergence_submissions WHERE round_id = ? ORDER BY id ASC")
    .all(roundId) as unknown as DivergenceSubmission[];
  return { round, submitted_personas, mine, submissions };
}

/**
 * Explicitly close a round: reveals every submission and announces the
 * reveal to chat. Idempotent — a no-op returning the current state if the
 * round is already closed.
 */
export function divergeClose(ctx: DivergeContext, roundId: number): DivergenceRound {
  const round = getDivergenceRound(ctx, roundId);
  if (round.status === "closed") return round;
  return closeDivergenceRound(ctx, round, ctx.persona, false);
}
