import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { IntegrationConfig } from "./integration.js";

export type IntegrationStatus = "pending" | "failed" | "verified";
export interface IntegrationSubmission {
  request_key: string;
  config_revision: number;
  commits: string[];
  /** Reserved stable references; submission does not create cards or reviews. */
  node_refs?: string[];
  /** Exact committed artifact paths; theorem is an explicit declaration, not symbol lookup. */
  selection?: { paths: string[]; theorem?: string };
}
export type IntegrationEvent =
  | { kind: "candidate"; commit: string; tree: string; base: string | null }
  | {
      kind: "build";
      commit: string;
      tree: string;
      command: string;
      exit_code: number | null;
      output: string;
      output_truncated?: boolean;
      clean: boolean;
      started_ts: string;
      finished_ts: string;
    }
  | {
      kind: "publication_intent";
      commit: string;
      tree: string;
      remote_url: string;
      branch: string;
    }
  | {
      kind: "publication";
      commit: string;
      tree: string;
      remote_url: string;
      branch: string;
      observed_commit: string;
      candidate_reachable?: boolean;
    }
  | { kind: "failure"; stage: string; message: string }
  | { kind: "retry"; reason: string }
  | { kind: "diagnostic"; stage: string; message: string };
export interface IntegrationEvidence {
  sequence: number;
  run_id: string;
  actor: string;
  ts: string;
  event: IntegrationEvent | { kind: "verified"; commit: string; tree: string };
}
export interface IntegrationAttempt {
  id: string;
  request_key: string;
  config_revision: number;
  config: IntegrationConfig;
  commits: string[];
  node_refs: string[];
  selection?: IntegrationSubmission["selection"];
  submitted_by: string;
  created_ts: string;
  updated_ts: string;
  revision: number;
  status: IntegrationStatus;
  evidence: IntegrationEvidence[];
}
export interface IntegrationFilter {
  status?: IntegrationStatus;
  limit?: number;
}

function required(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0"))
    throw new Error(`integration: invalid ${name}`);
}
function oid(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)
  )
    throw new Error("integration: expected a full lowercase Git object ID");
}
function revision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("integration: invalid revision");
}
function validateEvent(event: IntegrationEvent): void {
  switch (event.kind) {
    case "candidate":
      if (event.base !== null) oid(event.base);
      oid(event.commit);
      oid(event.tree);
      break;
    case "build":
      oid(event.commit);
      oid(event.tree);
      required(event.command, "build command");
      if (event.exit_code !== null && !Number.isSafeInteger(event.exit_code))
        throw new Error("integration: invalid build exit code");
      if (typeof event.clean !== "boolean")
        throw new Error("integration: build cleanliness must be observed");
      if (typeof event.output !== "string")
        throw new Error("integration: build output must be durable text");
      if (
        !Number.isFinite(Date.parse(event.started_ts)) ||
        !Number.isFinite(Date.parse(event.finished_ts)) ||
        Date.parse(event.finished_ts) < Date.parse(event.started_ts)
      )
        throw new Error("integration: invalid build timestamps");
      break;
    case "publication":
      oid(event.observed_commit); // fall through
    case "publication_intent":
      oid(event.commit);
      oid(event.tree);
      required(event.remote_url, "remote URL");
      required(event.branch, "branch");
      break;
    case "failure":
    case "diagnostic":
      required(event.stage, "stage");
      required(event.message, "message");
      break;
    case "retry":
      required(event.reason, "retry reason");
      break;
    default:
      throw new Error("integration: unsupported evidence kind");
  }
}

function lastIndex(
  events: IntegrationEvidence["event"][],
  kind: IntegrationEvidence["event"]["kind"],
): number {
  for (let i = events.length - 1; i >= 0; i--)
    if (events[i].kind === kind) return i;
  return -1;
}

/** Durable storage for a trusted executor, not a public success-assertion API.
 * No Git/build/network operations occur here. The executor must observe evidence;
 * this ledger enforces its consistency and ordering, not its external truth.
 */
export class IntegrationLedger {
  constructor(
    private db: DatabaseSync,
    private actor: string,
  ) {
    required(actor, "actor");
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  submit(input: IntegrationSubmission): IntegrationAttempt {
    required(input.request_key, "request key");
    revision(input.config_revision);
    if (!Array.isArray(input.commits) || !input.commits.length)
      throw new Error("integration: at least one submitted commit is required");
    input.commits.forEach(oid);
    if (new Set(input.commits).size !== input.commits.length)
      throw new Error("integration: duplicate submitted commits");
    const nodes = input.node_refs ?? [];
    if (!Array.isArray(nodes))
      throw new Error("integration: node_refs must be an array");
    nodes.forEach((node) => required(node, "node reference"));
    if (input.selection !== undefined) {
      const selection = input.selection;
      if (
        input.commits.length !== 1 ||
        !Array.isArray(selection.paths) ||
        !selection.paths.length
      )
        throw new Error(
          "integration: artifact selection requires one commit and explicit paths",
        );
      for (const path of selection.paths) {
        if (
          typeof path !== "string" ||
          !path ||
          /[\\\0\r\n]/.test(path) ||
          path.startsWith("/") ||
          path.split("/").some((part) => !part || part === "." || part === "..")
        )
          throw new Error(
            "integration: artifact paths must be exact repository-relative files without traversal",
          );
      }
      if (new Set(selection.paths).size !== selection.paths.length)
        throw new Error("integration: duplicate artifact paths");
      if (selection.theorem !== undefined)
        required(selection.theorem, "theorem declaration");
    }
    const normalized = {
      config_revision: input.config_revision,
      commits: input.commits,
      node_refs: [...new Set(nodes)].sort(),
      ...(input.selection
        ? {
            selection: {
              paths: [...input.selection.paths].sort(),
              ...(input.selection.theorem === undefined
                ? {}
                : { theorem: input.selection.theorem }),
            },
          }
        : {}),
    };
    const payload = JSON.stringify(normalized);
    return this.transaction(() => {
      const prior = this.db
        .prepare(
          "SELECT id, submission_json FROM integration_attempts WHERE request_key = ?",
        )
        .get(input.request_key) as
        | { id: string; submission_json: string }
        | undefined;
      if (prior) {
        if (prior.submission_json !== payload)
          throw new Error(
            "integration: request key already belongs to a different submission or configuration",
          );
        return this.get(prior.id);
      }
      const config = this.db
        .prepare(
          "SELECT revision, config_json FROM integration_configs ORDER BY revision DESC LIMIT 1",
        )
        .get() as { revision: number; config_json: string | null } | undefined;
      if (!config?.config_json)
        throw new Error("integration: room is not configured");
      if (config.revision !== input.config_revision)
        throw new Error(
          "integration: configuration revision changed; read configuration again",
        );
      const id = randomUUID(),
        ts = new Date().toISOString();
      this.db
        .prepare(
          "INSERT INTO integration_attempts (id, request_key, submission_json, config_revision, config_json, submitted_by, created_ts, updated_ts, revision, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending')",
        )
        .run(
          id,
          input.request_key,
          payload,
          config.revision,
          config.config_json,
          this.actor,
          ts,
          ts,
        );
      return this.get(id);
    });
  }

  get(id: string): IntegrationAttempt {
    required(id, "attempt ID");
    const row = this.db
      .prepare("SELECT * FROM integration_attempts WHERE id = ?")
      .get(id) as unknown as
      | (Omit<
          IntegrationAttempt,
          "config" | "commits" | "node_refs" | "evidence"
        > & { config_json: string; submission_json: string })
      | undefined;
    if (!row) throw new Error(`integration: attempt ${id} not found`);
    const { config_json, submission_json, ...fields } = row;
    const submission = JSON.parse(submission_json) as IntegrationSubmission;
    const evidence = this.db
      .prepare(
        "SELECT sequence, run_id, actor, ts, event_json FROM integration_events WHERE attempt_id = ? ORDER BY sequence",
      )
      .all(id) as {
      sequence: number;
      run_id: string;
      actor: string;
      ts: string;
      event_json: string;
    }[];
    return {
      ...fields,
      config: JSON.parse(config_json),
      commits: submission.commits,
      node_refs: submission.node_refs ?? [],
      ...(submission.selection ? { selection: submission.selection } : {}),
      evidence: evidence.map(({ event_json, ...record }) => ({
        ...record,
        event: JSON.parse(event_json),
      })),
    };
  }

  list(filter: IntegrationFilter = {}): IntegrationAttempt[] {
    if (
      filter.status !== undefined &&
      !["pending", "failed", "verified"].includes(filter.status)
    )
      throw new Error("integration: invalid status");
    const limit = filter.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new Error("integration: limit must be an integer from 1 to 1000");
    const rows = this.db
      .prepare(
        "SELECT id FROM integration_attempts WHERE (? IS NULL OR status = ?) ORDER BY created_ts DESC, id DESC LIMIT ?",
      )
      .all(filter.status ?? null, filter.status ?? null, limit) as {
      id: string;
    }[];
    return rows.map((row) => this.get(row.id));
  }

  /** Claim execution without allowing concurrent runners to interleave evidence.
   * Expired takeover keeps the run identity for recovery; retry starts a fresh run.
   */
  claim(
    id: string,
    ttlMs = 60_000,
  ): { token: string; attempt: IntegrationAttempt } {
    this.ttl(ttlMs);
    return this.transaction(() => {
      const attempt = this.get(id);
      if (attempt.status === "verified")
        throw new Error("integration: attempt already verified");
      const previous = this.db
        .prepare("SELECT * FROM integration_runners WHERE attempt_id = ?")
        .get(id) as { run_id: string; expires_ms: number } | undefined;
      if (previous && previous.expires_ms > Date.now())
        throw new Error("integration: attempt is owned by an active runner");
      const token = randomUUID();
      this.db
        .prepare(
          "INSERT INTO integration_runners (attempt_id, token, run_id, expires_ms) VALUES (?, ?, ?, ?) ON CONFLICT(attempt_id) DO UPDATE SET token = excluded.token, expires_ms = excluded.expires_ms",
        )
        .run(id, token, previous?.run_id ?? randomUUID(), Date.now() + ttlMs);
      return { token, attempt };
    });
  }
  renew(id: string, token: string, ttlMs = 60_000): void {
    this.ttl(ttlMs);
    this.transaction(() => {
      this.runner(id, token);
      this.db
        .prepare(
          "UPDATE integration_runners SET expires_ms = ? WHERE attempt_id = ?",
        )
        .run(Date.now() + ttlMs, id);
    });
  }
  release(id: string, token: string): void {
    this.transaction(() => {
      this.runner(id, token);
      this.db
        .prepare(
          "UPDATE integration_runners SET expires_ms = 0 WHERE attempt_id = ?",
        )
        .run(id);
    });
  }
  private ttl(ms: number): void {
    if (!Number.isSafeInteger(ms) || ms < 1000 || ms > 3_600_000)
      throw new Error(
        "integration: runner TTL must be 1000..3600000 milliseconds",
      );
  }
  private runner(id: string, token: string): string {
    required(token, "runner token");
    const row = this.db
      .prepare(
        "SELECT token, run_id, expires_ms FROM integration_runners WHERE attempt_id = ?",
      )
      .get(id) as
      | { token: string; run_id: string; expires_ms: number }
      | undefined;
    if (!row || row.token !== token || row.expires_ms <= Date.now())
      throw new Error("integration: runner claim expired or superseded");
    return row.run_id;
  }

  /** Internal executor-only operation. CAS also prevents concurrent evidence mixing. */
  append(
    id: string,
    expectedRevision: number,
    event: IntegrationEvent,
    token: string,
  ): IntegrationAttempt {
    revision(expectedRevision);
    validateEvent(event);
    if (event.kind === "build")
      event = {
        ...event,
        output: event.output.slice(0, 65_536),
        output_truncated:
          event.output_truncated === true || event.output.length > 65_536,
      };
    return this.transaction(() => {
      const attempt = this.get(id);
      this.runner(id, token);
      this.checkRevision(attempt, expectedRevision);
      if (attempt.status === "verified")
        throw new Error("integration: verified attempts are immutable");
      if (
        attempt.status === "failed" &&
        event.kind !== "retry" &&
        event.kind !== "diagnostic"
      )
        throw new Error(
          "integration: retry failed attempt before adding execution evidence",
        );
      if (event.kind === "retry")
        this.db
          .prepare(
            "UPDATE integration_runners SET run_id = ? WHERE attempt_id = ?",
          )
          .run(randomUUID(), id);
      return this.write(
        attempt,
        event,
        event.kind === "failure"
          ? "failed"
          : event.kind === "retry"
            ? "pending"
            : attempt.status,
        token,
      );
    });
  }

  /** Internal executor-only finalization, guarded by exact matching evidence. */
  verify(
    id: string,
    expectedRevision: number,
    token: string,
  ): IntegrationAttempt {
    revision(expectedRevision);
    return this.transaction(() => {
      const attempt = this.get(id);
      // A caller recovering a lost successful response gets the existing receipt.
      if (attempt.status === "verified") return attempt;
      this.runner(id, token);
      this.checkRevision(attempt, expectedRevision);
      if (attempt.status !== "pending")
        throw new Error("integration: failed attempt cannot be verified");
      const events = attempt.evidence
        .filter((e) => e.run_id === this.runner(id, token))
        .map((e) => e.event);
      const start = lastIndex(events, "candidate");
      const candidate = events[start];
      if (!candidate || candidate.kind !== "candidate")
        throw new Error("integration: missing candidate evidence");
      const tail = events.slice(start + 1);
      const buildIndex = lastIndex(tail, "build");
      const build = tail[buildIndex];
      const intentIndex = lastIndex(tail, "publication_intent");
      const intent = tail[intentIndex];
      const publicationIndex = lastIndex(tail, "publication");
      const publication = tail[publicationIndex];
      const exact = (e: { commit: string; tree: string }) =>
        e.commit === candidate.commit && e.tree === candidate.tree;
      const target = (e: { remote_url: string; branch: string }) =>
        e.remote_url === attempt.config.remote_url &&
        e.branch === attempt.config.branch;
      if (
        !build ||
        build.kind !== "build" ||
        !exact(build) ||
        build.command !== attempt.config.build_command ||
        build.exit_code !== 0 ||
        build.clean !== true ||
        !intent ||
        intent.kind !== "publication_intent" ||
        !exact(intent) ||
        !target(intent) ||
        intentIndex <= buildIndex ||
        !publication ||
        publication.kind !== "publication" ||
        !exact(publication) ||
        !target(publication) ||
        (publication.observed_commit !== candidate.commit &&
          publication.candidate_reachable !== true) ||
        publicationIndex <= intentIndex ||
        tail.some((e) => e.kind === "failure" || e.kind === "retry")
      ) {
        throw new Error(
          "integration: verification requires matching successful build and subsequent publication evidence for the exact candidate and configured target",
        );
      }
      return this.write(
        attempt,
        { kind: "verified", commit: candidate.commit, tree: candidate.tree },
        "verified",
        token,
      );
    });
  }

  private checkRevision(attempt: IntegrationAttempt, expected: number): void {
    if (attempt.revision !== expected)
      throw new Error(
        `integration: attempt revision changed (expected ${expected}, current ${attempt.revision})`,
      );
  }
  private write(
    attempt: IntegrationAttempt,
    event: IntegrationEvidence["event"],
    status: IntegrationStatus,
    token: string,
  ): IntegrationAttempt {
    const ts = new Date().toISOString(),
      sequence = attempt.revision + 1;
    this.db
      .prepare(
        "INSERT INTO integration_events (attempt_id, sequence, run_id, actor, ts, event_json) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        attempt.id,
        sequence,
        this.runner(attempt.id, token),
        this.actor,
        ts,
        JSON.stringify(event),
      );
    this.db
      .prepare(
        "UPDATE integration_attempts SET revision = ?, status = ?, updated_ts = ? WHERE id = ?",
      )
      .run(sequence, status, ts, attempt.id);
    return this.get(attempt.id);
  }
}
