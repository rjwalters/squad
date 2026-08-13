import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Science Cards: the runtime-neutral vocabulary.
 *
 * This module owns everything about a Science Card that is *not* storage: the
 * phase vocabulary, the legal-transition graph, the evidence taxonomy, the
 * canonical JSON Schema, and a dependency-free validator for it. `core.ts`
 * imports these to implement the `Squad` card methods, and re-exports the
 * types so callers keep importing card types the same place they import
 * `Goal` and `Claim`.
 *
 * The schema at `schema/science-card.schema.json` is the canonical definition
 * for the whole cross-repo effort (squad#20, loom#6109, lean-genius#43705) —
 * see its `$comment` header. Nothing here may reference Claude, Codex, or any
 * other particular runtime.
 */

/** Version of the canonical schema this build validates against. */
export const SCIENCE_CARD_SCHEMA_VERSION = "1.0.0";

/** Stable `$id` of the canonical schema. Vendored copies must keep it. */
export const SCIENCE_CARD_SCHEMA_ID =
  "https://raw.githubusercontent.com/rjwalters/squad/main/schema/science-card.schema.json";

export const CARD_PHASES = [
  "QUESTION",
  "DIVERGE",
  "ORIENT",
  "HYPOTHESIZE",
  "DERIVE",
  "ATTACK",
  "SIMULATE",
  "EXPERIMENT",
  "REPLICATE",
  "LEARN",
  "PIVOT",
  "SUPPORTED",
  "FALSIFIED",
  "INCONCLUSIVE",
  "ABANDONED",
] as const;
export type CardPhase = (typeof CARD_PHASES)[number];

export const CARD_STATUSES = [
  "OPEN",
  "SUPPORTED",
  "FALSIFIED",
  "INCONCLUSIVE",
  "ABANDONED",
] as const;
/**
 * Claim-level status — what the room currently believes about the card's
 * claim. Deliberately NOT the same axis as an evidence item's own status: see
 * `CARD_EVIDENCE_STATUSES`.
 */
export type CardStatus = (typeof CARD_STATUSES)[number];

/**
 * Phases that end the card. Reaching one sets the card's claim-level status;
 * leaving one (e.g. SUPPORTED -> LEARN on new evidence) returns it to OPEN.
 */
export const TERMINAL_PHASE_STATUS: Readonly<Partial<Record<CardPhase, CardStatus>>> = {
  SUPPORTED: "SUPPORTED",
  FALSIFIED: "FALSIFIED",
  INCONCLUSIVE: "INCONCLUSIVE",
  ABANDONED: "ABANDONED",
};

export const CARD_CLAIM_KINDS = ["empirical", "formal", "mixed"] as const;
/**
 * What kind of claim the card makes. This is what keeps "verified" honest: an
 * `empirical` (or `mixed`) claim is about the world, so no amount of
 * derivation or formal-check evidence can make it SUPPORTED. A `formal` claim
 * is about a mathematical object, so a checked proof is the appropriate
 * evidence. Defaults to `empirical` — the stricter case — so a card only gets
 * the weaker bar by saying so explicitly.
 */
export type CardClaimKind = (typeof CARD_CLAIM_KINDS)[number];

export const CARD_PRIOR_ART_STATUSES = [
  "unknown",
  "novel",
  "partially-known",
  "known",
  "contested",
] as const;
export type CardPriorArtStatus = (typeof CARD_PRIOR_ART_STATUSES)[number];

export const CARD_EVIDENCE_TYPES = [
  "derivation",
  "formal-check",
  "simulation",
  "experiment",
  "literature",
  "observation",
] as const;
export type CardEvidenceType = (typeof CARD_EVIDENCE_TYPES)[number];

export const CARD_EVIDENCE_STATUSES = ["pending", "verified", "refuted", "inconclusive"] as const;
/**
 * Status of one evidence item, and nothing more. `verified` says the item
 * itself checks out — the proof compiles, the run reproduces — never that the
 * card's claim is scientifically true. Promoting a card to SUPPORTED is a
 * separate judgement made against `CardStatus`.
 */
export type CardEvidenceStatus = (typeof CARD_EVIDENCE_STATUSES)[number];

/**
 * Evidence types that say something about the world rather than about a model
 * or a proof. Only these can carry an empirical claim to SUPPORTED. A
 * `simulation` is a claim about a model, `literature` is second-hand, and
 * `derivation`/`formal-check` are claims about mathematics — all useful, none
 * sufficient on their own.
 */
export const EMPIRICAL_EVIDENCE_TYPES: readonly CardEvidenceType[] = ["experiment", "observation"];

/**
 * The legal-transition graph. Plain adjacency, deliberately in code rather
 * than in the database — it is a property of the method, not of a room.
 *
 * The spine is QUESTION -> DIVERGE -> ORIENT -> HYPOTHESIZE -> DERIVE ->
 * ATTACK -> SIMULATE -> EXPERIMENT -> REPLICATE -> terminal, with LEARN ->
 * PIVOT loops back into the cycle. Every non-terminal phase can also reach
 * ABANDONED: giving up is always legal, and an abandoned card stays queryable.
 * A terminal phase can only be left through LEARN, so re-opening a settled
 * claim is always recorded as learning rather than as a silent edit.
 */
export const PHASE_TRANSITIONS: Readonly<Record<CardPhase, readonly CardPhase[]>> = {
  QUESTION: ["DIVERGE", "ORIENT", "ABANDONED"],
  DIVERGE: ["ORIENT", "LEARN", "ABANDONED"],
  ORIENT: ["HYPOTHESIZE", "DIVERGE", "LEARN", "ABANDONED"],
  HYPOTHESIZE: ["DERIVE", "ATTACK", "LEARN", "ABANDONED"],
  DERIVE: ["ATTACK", "SIMULATE", "LEARN", "ABANDONED"],
  ATTACK: ["SIMULATE", "DERIVE", "FALSIFIED", "LEARN", "ABANDONED"],
  SIMULATE: ["EXPERIMENT", "ATTACK", "FALSIFIED", "INCONCLUSIVE", "LEARN", "ABANDONED"],
  EXPERIMENT: ["REPLICATE", "FALSIFIED", "INCONCLUSIVE", "LEARN", "ABANDONED"],
  REPLICATE: ["SUPPORTED", "FALSIFIED", "INCONCLUSIVE", "LEARN", "ABANDONED"],
  LEARN: ["PIVOT", "INCONCLUSIVE", "ABANDONED"],
  PIVOT: ["QUESTION", "ORIENT", "HYPOTHESIZE", "ABANDONED"],
  SUPPORTED: ["LEARN"],
  FALSIFIED: ["LEARN"],
  INCONCLUSIVE: ["LEARN"],
  ABANDONED: ["LEARN"],
};

/** A dated note attached to a card (an attempt, attack, insight, post-mortem). */
export interface CardNote {
  body: string;
  persona?: string;
  ts?: string;
}

export interface CardEvidence {
  id: number;
  card_id: number;
  type: CardEvidenceType;
  provenance: string;
  body: string;
  /** Evidence-level status only — never a statement about the card's claim. */
  status: CardEvidenceStatus;
  persona: string;
  ts: string;
}

export interface CardTransition {
  id: number;
  card_id: number;
  /** null on the genesis entry written when the card is created. */
  from_phase: CardPhase | null;
  to_phase: CardPhase;
  persona: string;
  ts: string;
  note: string | null;
}

/** A Science Card row, without its evidence and transition children. */
export interface Card {
  id: number;
  title: string;
  question: string;
  phase: CardPhase;
  status: CardStatus;
  claim_kind: CardClaimKind;
  origin_method: string | null;
  contributors: string[];
  changed_assumptions: string[];
  proposed_mechanism: string | null;
  model_statement: string | null;
  null_prediction: string | null;
  discriminating_prediction: string | null;
  decisive_falsifier: string | null;
  cheapest_test: string | null;
  prior_art_status: CardPriorArtStatus;
  confidence: number | null;
  novelty: number | null;
  attempts: CardNote[];
  attacks: CardNote[];
  insights: CardNote[];
  post_mortems: CardNote[];
  created_by: string;
  created_ts: string;
  updated_ts: string;
}

/** A card with its full evidence list and transition history. */
export interface CardDetail extends Card {
  evidence: CardEvidence[];
  transitions: CardTransition[];
}

let cachedSchema: Record<string, unknown> | null = null;

/**
 * The canonical schema document, read from `schema/science-card.schema.json`.
 *
 * Read from disk rather than inlined so there is exactly one copy of the
 * definition in this repo too — an inlined duplicate is the same divergence
 * problem this schema exists to prevent, just at a smaller scale. The file
 * ships in the published package (`files: ["schema"]`), and both the source
 * tree (`src/`) and the build output (`dist/`) sit one level under the package
 * root, so a single `..` hop resolves in both.
 */
export function scienceCardSchema(): Record<string, unknown> {
  if (cachedSchema) return cachedSchema;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "schema", "science-card.schema.json"),
    join(here, "..", "..", "schema", "science-card.schema.json"),
  ];
  let lastErr: unknown;
  for (const path of candidates) {
    try {
      cachedSchema = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      return cachedSchema;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `science-card.schema.json not found (looked in ${candidates.join(", ")}): ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

type JsonSchema = Record<string, any>;

/**
 * Validate a value against a JSON Schema subset — enough for the canonical
 * Science Card schema and nothing more: `type` (including union types),
 * `enum`, `const`, `required`, `properties`, `additionalProperties: false`,
 * `items`, `oneOf`, `minLength`, `minItems`, `minimum`, `maximum`, and local
 * `$ref` into `$defs`.
 *
 * Hand-rolled on purpose. Every other module here runs on Node built-ins only
 * (see the comment in `index.ts`); pulling a validator into the dependency
 * graph to check a fifteen-keyword schema would make a broken `node_modules`
 * able to take card storage down with it.
 */
export function validateAgainstSchema(value: unknown, schema: JsonSchema): ValidationResult {
  const errors: string[] = [];
  const root = schema;

  const resolve = (node: JsonSchema): JsonSchema => {
    let cur = node;
    // Local pointers only: "#/$defs/<name>". Anything else is a schema bug.
    for (let hops = 0; typeof cur.$ref === "string"; hops++) {
      if (hops > 16) throw new Error(`$ref cycle at ${cur.$ref}`);
      const ref: string = cur.$ref;
      if (!ref.startsWith("#/")) throw new Error(`unsupported $ref: ${ref}`);
      let target: any = root;
      for (const segment of ref.slice(2).split("/")) {
        target = target?.[segment];
      }
      if (!target || typeof target !== "object") throw new Error(`unresolvable $ref: ${ref}`);
      cur = { ...target, ...cur, $ref: undefined };
      delete cur.$ref;
    }
    return cur;
  };

  const typeOf = (v: unknown): string => {
    if (v === null) return "null";
    if (Array.isArray(v)) return "array";
    if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
    return typeof v;
  };

  const typeMatches = (v: unknown, want: string): boolean => {
    const actual = typeOf(v);
    if (want === "number") return actual === "number" || actual === "integer";
    return actual === want;
  };

  const walk = (v: unknown, node: JsonSchema, path: string): void => {
    const s = resolve(node);

    if (s.type !== undefined) {
      const wanted: string[] = Array.isArray(s.type) ? s.type : [s.type];
      if (!wanted.some((t) => typeMatches(v, t))) {
        errors.push(`${path}: expected ${wanted.join(" or ")}, got ${typeOf(v)}`);
        return; // further keywords assume the type held
      }
    }

    if (Array.isArray(s.enum) && !s.enum.some((e: unknown) => e === v)) {
      errors.push(`${path}: ${JSON.stringify(v)} is not one of ${s.enum.join(", ")}`);
    }
    if (s.const !== undefined && v !== s.const) {
      errors.push(`${path}: expected ${JSON.stringify(s.const)}`);
    }

    if (Array.isArray(s.oneOf)) {
      const matches = s.oneOf.filter((branch: JsonSchema) => {
        // Only the branch's own keywords, plus $defs so its $refs still resolve.
        return validateAgainstSchema(v, { ...branch, $defs: root.$defs }).valid;
      });
      if (matches.length !== 1) {
        errors.push(`${path}: matched ${matches.length} of ${s.oneOf.length} oneOf branches`);
      }
    }

    if (typeof v === "string") {
      if (typeof s.minLength === "number" && v.length < s.minLength) {
        errors.push(`${path}: shorter than minLength ${s.minLength}`);
      }
    }

    if (typeof v === "number") {
      if (typeof s.minimum === "number" && v < s.minimum) {
        errors.push(`${path}: ${v} is below minimum ${s.minimum}`);
      }
      if (typeof s.maximum === "number" && v > s.maximum) {
        errors.push(`${path}: ${v} is above maximum ${s.maximum}`);
      }
    }

    if (Array.isArray(v)) {
      if (typeof s.minItems === "number" && v.length < s.minItems) {
        errors.push(`${path}: fewer than minItems ${s.minItems}`);
      }
      if (s.items) v.forEach((item, i) => walk(item, s.items, `${path}[${i}]`));
    }

    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>;
      for (const key of (s.required ?? []) as string[]) {
        if (!(key in obj)) errors.push(`${path}: missing required property '${key}'`);
      }
      const props: Record<string, JsonSchema> = s.properties ?? {};
      for (const [key, val] of Object.entries(obj)) {
        const child = props[key];
        if (child) {
          walk(val, child, path === "" ? key : `${path}.${key}`);
        } else if (s.additionalProperties === false) {
          errors.push(`${path === "" ? "" : path + "."}${key}: unexpected property`);
        }
      }
    }
  };

  try {
    walk(value, root, "");
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  return { valid: errors.length === 0, errors };
}

/** Validate a candidate Science Card document against the canonical schema. */
export function validateScienceCard(doc: unknown): ValidationResult {
  return validateAgainstSchema(doc, scienceCardSchema());
}

/**
 * Render a stored card as a canonical Science Card document — the shape the
 * JSON Schema describes, and the shape another runtime should receive. Row
 * ids on children are dropped: they are storage detail, not part of the
 * portable record.
 */
export function toScienceCardDocument(card: CardDetail): Record<string, unknown> {
  return {
    schema_version: SCIENCE_CARD_SCHEMA_VERSION,
    id: card.id,
    title: card.title,
    question: card.question,
    phase: card.phase,
    status: card.status,
    claim_kind: card.claim_kind,
    origin_method: card.origin_method,
    contributors: card.contributors,
    changed_assumptions: card.changed_assumptions,
    proposed_mechanism: card.proposed_mechanism,
    model_statement: card.model_statement,
    null_prediction: card.null_prediction,
    discriminating_prediction: card.discriminating_prediction,
    decisive_falsifier: card.decisive_falsifier,
    cheapest_test: card.cheapest_test,
    prior_art_status: card.prior_art_status,
    confidence: card.confidence,
    novelty: card.novelty,
    evidence: card.evidence.map((e) => ({
      type: e.type,
      provenance: e.provenance,
      body: e.body,
      status: e.status,
      persona: e.persona,
      ts: e.ts,
    })),
    attempts: card.attempts,
    attacks: card.attacks,
    insights: card.insights,
    post_mortems: card.post_mortems,
    transitions: card.transitions.map((t) => ({
      from_phase: t.from_phase,
      to_phase: t.to_phase,
      persona: t.persona,
      ts: t.ts,
      note: t.note,
    })),
    created_by: card.created_by,
    created_ts: card.created_ts,
    updated_ts: card.updated_ts,
  };
}
