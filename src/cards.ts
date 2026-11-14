import type { DatabaseSync } from "node:sqlite";

/**
 * Science Card domain: card types, the phase-transition graph, the SUPPORTED
 * evidence gate, and the card operations. Extracted from `core.ts`;
 * `Squad.card*` delegate here (`core.ts` re-exports every type and constant).
 * Shared room state is passed in as an explicit {@link CardContext} rather
 * than reached through `Squad` internals.
 */

const now = () => new Date().toISOString();

/**
 * What the card operations need from the room: the db handle, the acting
 * persona, and a way to announce a system message in chat. `Squad` calls
 * `touch()` and wraps mutations in its node transaction itself before
 * delegating, so neither is part of the context.
 */
export interface CardContext {
  db: DatabaseSync;
  persona: string;
  send(body: string, kind: "system"): unknown;
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
export interface CardRow {
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

export function rowToCard(row: CardRow): Card {
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

/**
 * Create a Science Card in the QUESTION phase and announce it in chat as a
 * system message.
 */
export function cardCreate(ctx: CardContext, fields: CardCreateFields): Card {
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
    created_by: ctx.persona,
    created_ts: ts,
    updated_ts: ts,
  };
  const { lastInsertRowid } = ctx.db
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
  ctx.send(`${ctx.persona} opened science card #${row.id}: ${row.title}`, "system");
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
export function cardUpdate(ctx: CardContext, id: number, fields: CardUpdateFields): Card {
  const row = ctx.db.prepare("SELECT * FROM science_cards WHERE id = ?").get(id) as
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

  ctx.db
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

  ctx.send(`${ctx.persona} updated card #${id}: ${changedKeys.join(", ")}`, "system");
  return rowToCard(merged);
}

/**
 * Lists Science Cards. Unlike `goals()` (which hides done goals by
 * default), `cardList` returns cards in **every** phase by default —
 * FALSIFIED/ABANDONED/INCONCLUSIVE cards are never silently hidden, since
 * negative outcomes must stay queryable. Pass `phase`/`phases` to narrow
 * the listing to specific phase(s).
 */
export function cardList(ctx: CardContext, opts: { phase?: CardPhase; phases?: CardPhase[] } = {}): Card[] {
  const phases = opts.phase ? [opts.phase] : opts.phases;
  const rows =
    phases && phases.length > 0
      ? (ctx.db
          .prepare(
            `SELECT * FROM science_cards WHERE phase IN (${phases.map(() => "?").join(",")}) ORDER BY id ASC`,
          )
          .all(...phases) as unknown as CardRow[])
      : (ctx.db.prepare("SELECT * FROM science_cards ORDER BY id ASC").all() as unknown as CardRow[]);
  return rows.map(rowToCard);
}

/** Full card detail: the card plus its complete evidence and transition history. */
export function cardGet(ctx: CardContext, id: number): CardDetail {
  const row = ctx.db.prepare("SELECT * FROM science_cards WHERE id = ?").get(id) as
    | CardRow
    | undefined;
  if (!row) throw new Error(`no science card with id ${id}`);
  const evidence = ctx.db
    .prepare("SELECT * FROM science_card_evidence WHERE card_id = ? ORDER BY id ASC")
    .all(id) as unknown as CardEvidence[];
  const transitions = ctx.db
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
export function cardTransition(ctx: CardContext, id: number, toPhase: CardPhase, note?: string): Card {
  const row = ctx.db.prepare("SELECT * FROM science_cards WHERE id = ?").get(id) as
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
    const evidenceRows = ctx.db
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
  ctx.db
    .prepare("UPDATE science_cards SET phase = ?, updated_ts = ? WHERE id = ?")
    .run(toPhase, ts, id);
  ctx.db
    .prepare(
      "INSERT INTO science_card_transitions (card_id, from_phase, to_phase, persona, ts, note) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(id, fromPhase, toPhase, ctx.persona, ts, note ?? null);
  ctx.send(
    `${ctx.persona} moved card #${id} ${fromPhase} -> ${toPhase}${note ? `: ${note}` : ""}`,
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
export function cardEvidenceAdd(
  ctx: CardContext,
  cardId: number,
  type: EvidenceType,
  provenance: string,
  body?: string | null,
): CardEvidence {
  if (!EVIDENCE_TYPES.includes(type)) {
    throw new Error(`invalid evidence type "${type}" (must be one of ${EVIDENCE_TYPES.join(", ")})`);
  }
  if (!provenance?.trim()) {
    throw new Error("evidence provenance is required");
  }
  const card = ctx.db.prepare("SELECT id FROM science_cards WHERE id = ?").get(cardId);
  if (!card) throw new Error(`no science card with id ${cardId}`);
  const ts = now();
  const { lastInsertRowid } = ctx.db
    .prepare(
      "INSERT INTO science_card_evidence (card_id, type, provenance, body, persona, ts) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(cardId, type, provenance, body ?? null, ctx.persona, ts);
  ctx.send(`${ctx.persona} added ${type} evidence to card #${cardId}: ${provenance}`, "system");
  return {
    id: Number(lastInsertRowid),
    card_id: cardId,
    type,
    provenance,
    body: body ?? null,
    persona: ctx.persona,
    ts,
  };
}
