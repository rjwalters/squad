import { randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const PERSONA_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/i;
export interface AgentIdentity {
  /** Optional label prefix from trusted launcher metadata (`SQUAD_PROVIDER`). */
  provider?: string;
  /** Trusted launcher metadata (`SQUAD_MODEL`); the label when set. */
  model?: string;
  /** Self-reported model (the `squad_join` `model` argument); used only when `model` is absent. */
  label?: string;
  sessionId?: string;
}

/** Only explicit launcher/config metadata is trusted; a harness is not a provider. */
export function identityFromEnv(env: NodeJS.ProcessEnv = process.env): AgentIdentity {
  return {
    provider: env.SQUAD_PROVIDER,
    model: env.SQUAD_MODEL,
    sessionId: env.SQUAD_SESSION_ID,
  };
}

/**
 * Names no agent may hold, because the room already uses them to mean
 * something else. `repo` is the `@repo` broadcast target — "every agent
 * working in this repo", which the mid-turn inbox hook (`src/inbox.ts`)
 * delivers to every session regardless of its name. A persona called `repo`
 * would make `@repo` ambiguous between one agent and all of them, so the name
 * is refused at every entry point: automatic minting, a `squad_join` rename,
 * and a `SQUAD_PERSONA` pin.
 *
 * Compared case-insensitively, matching `PERSONA_PATTERN`'s own
 * case-insensitivity. Refinements are *not* reserved: `repo-doctor` is an
 * ordinary name, exactly as `@repo-doctor` is an ordinary mention.
 */
export const RESERVED_PERSONAS: readonly string[] = ["repo"];

export function isReservedPersona(name: string): boolean {
  const wanted = name.trim().toLowerCase();
  return RESERVED_PERSONAS.includes(wanted);
}

/** The refusal text shared by every entry point that rejects a reserved name. */
export function reservedPersonaReason(name: string): string {
  return (
    `'${name}' is a reserved name: @${name.trim().toLowerCase()} addresses every agent ` +
    `working in this repo, so no single agent may answer to it. Choose another persona.`
  );
}

/** Visible suffix length: 4 hex characters (65536 values) for rooms of a handful of agents. */
export const AUTOMATIC_SUFFIX_LENGTH = 4;
/** Collisions reroll a fresh suffix this many times before failing explicitly. */
export const AUTOMATIC_SUFFIX_ATTEMPTS = 32;
const DEFAULT_LABEL = "agent";

function component(value: string | undefined): string | undefined {
  return (
    value
      ?.toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40)
      .replace(/-$/, "") || undefined
  );
}

/**
 * The human-readable half of an automatic name: `SQUAD_MODEL`, else the
 * self-reported model, else `agent`, prefixed by `SQUAD_PROVIDER` when set.
 */
export function automaticLabel(metadata: AgentIdentity): string {
  const label = component(metadata.model) ?? component(metadata.label) ?? DEFAULT_LABEL;
  const provider = component(metadata.provider);
  return provider ? `${provider}-${label}` : label;
}

/** Fresh randomness, deliberately independent of the resume token (`SQUAD_SESSION_ID`). */
export function randomSuffix(): string {
  return randomBytes(AUTOMATIC_SUFFIX_LENGTH / 2).toString("hex");
}

export interface AutomaticReservation {
  persona: string;
  /** True when this call reserved a new name; false when it resumed an existing reservation. */
  minted: boolean;
}

export interface ReserveOptions {
  /**
   * Replace this identity's reservation, but only if it still holds exactly
   * this persona (used to apply a self-reported label before publication).
   */
  relabelFrom?: string;
  /**
   * Try this exact name first (restoring a reservation removed by a room
   * clear); a collision falls back to a freshly rolled suffix.
   */
  prefer?: string;
  /** Suffix source; injectable for tests. */
  suffix?: () => string;
}

/** Reserve before publication, under the room's SQLite write lock (also across processes). */
export function reserveAutomaticPersona(
  db: DatabaseSync,
  metadata: AgentIdentity,
  options: ReserveOptions = {},
): AutomaticReservation {
  const id = metadata.sessionId ?? randomUUID();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) {
    throw new Error("SQUAD_SESSION_ID must be a UUID, unique per logical agent session");
  }
  const key = id.toLowerCase();
  const next = options.suffix ?? randomSuffix;
  db.exec("BEGIN IMMEDIATE");
  try {
    const prior = db
      .prepare("SELECT persona FROM agent_identities WHERE identity_id = ?")
      .get(key) as { persona: string } | undefined;
    if (prior) {
      if (options.relabelFrom === undefined || prior.persona !== options.relabelFrom) {
        db.exec("COMMIT");
        return { persona: prior.persona, minted: false };
      }
      db.prepare("DELETE FROM agent_identities WHERE identity_id = ?").run(key);
    }
    const label = automaticLabel(metadata);
    const candidates = options.prefer === undefined ? [] : [options.prefer];
    for (let attempt = 0; attempt < AUTOMATIC_SUFFIX_ATTEMPTS; attempt++) {
      candidates.push(`${label}-${next()}`);
      const persona = candidates.shift()!;
      // A reserved name is treated exactly like an occupied one: `prefer` can
      // carry an arbitrary restored name, and a label could in principle
      // render one, so the guard belongs on the candidate rather than on the
      // caller.
      if (isReservedPersona(persona)) continue;
      const occupied = db
        .prepare(
          "SELECT persona FROM agent_identities WHERE persona = ? UNION SELECT persona FROM members WHERE persona = ?",
        )
        .get(persona, persona);
      if (occupied) continue;
      db.prepare("INSERT INTO agent_identities (identity_id, persona) VALUES (?, ?)").run(
        key,
        persona,
      );
      db.exec("COMMIT");
      return { persona, minted: true };
    }
    throw new Error(
      `Could not reserve a free automatic name for label '${label}' after ` +
        `${AUTOMATIC_SUFFIX_ATTEMPTS} attempts; set SQUAD_PERSONA or pass a persona explicitly`,
    );
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Resolve (resume or reserve) the automatic persona for a logical session. */
export function automaticPersona(
  db: DatabaseSync,
  metadata: AgentIdentity,
  options: ReserveOptions = {},
): string {
  return reserveAutomaticPersona(db, metadata, options).persona;
}
