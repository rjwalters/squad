import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const PERSONA_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/i;
export interface AgentIdentity {
  provider?: string;
  model?: string;
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

function component(value: string | undefined): string {
  return (
    value
      ?.toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40)
      .replace(/-$/, "") || "unknown"
  );
}

/** Reserve before publication, under the room's SQLite write lock (also across processes). */
export function automaticPersona(db: DatabaseSync, metadata: AgentIdentity): string {
  const id = metadata.sessionId ?? randomUUID();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) {
    throw new Error("SQUAD_SESSION_ID must be a UUID, unique per logical agent session");
  }
  const key = id.toLowerCase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const prior = db
      .prepare("SELECT persona FROM agent_identities WHERE identity_id = ?")
      .get(key) as { persona: string } | undefined;
    if (prior) {
      db.exec("COMMIT");
      return prior.persona;
    }
    const prefix = `${component(metadata.provider)}-${component(metadata.model)}`;
    const suffix = key.replaceAll("-", "");
    for (let length = 8; length <= 32; length += 4) {
      const persona = `${prefix}-${suffix.slice(0, length)}`;
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
      return persona;
    }
    throw new Error(
      "Session identity collides with an existing persona; use a fresh SQUAD_SESSION_ID",
    );
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
