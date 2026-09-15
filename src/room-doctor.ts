import { execFileSync } from "node:child_process";
import type { Message, Squad } from "./core.js";
import type { IntegrationEvidence } from "./integration-ledger.js";

/**
 * `squad doctor --room`: a read-only, evidence-first drift report over the
 * exact same durable state `stewardStatus()` reads (unbanked declared work,
 * integration attempts, outline freshness, review requests, claims), plus a
 * bounded scan of chat for informal "banked" claims cross-checked against the
 * verified integration ledger. This module is pure and side-effect free --
 * `Squad.roomDoctor()` (core.ts) is the only caller that touches the
 * database, and it opens a read-only savepoint to do so. Nothing here writes
 * to the room, sends chat, or renews presence.
 *
 * Findings always cite evidence (a message id, an attempt id, a revision, a
 * timestamp) and a concrete next command, never a bare conclusion -- this is
 * the tool's answer to the Erdos-85 postmortem (#55): 548 informal "banked"
 * announcements in chat with no durable merge point behind them, and no way
 * for anyone standing outside a single agent's worktree to see the drift.
 */

const OVERDUE_MS = 86_400_000; // 24h, matching stewardStatus()'s existing stale-claim threshold
// Only completed-action wording is a candidate. Even this is a heuristic:
// quoted, conditional, and multi-node prose cannot prove a banking claim.
const BANK_CLAIM_RE = /\bbanked\b|\bbanking\s+(?:complete(?:d)?|succeeded|successful)\b/i;
const REF_RE = /#(\d+)/g;
/** A revision explicitly named in the message, e.g. "revision 3" / "rev #3" --
 * used to recognize a legitimate claim about a *historical* revision instead
 * of comparing it against the node's current one. */
const REVISION_REF_RE = /\brev(?:ision)?\.?\s*#?(\d+)/i;
/** Negation immediately around a "bank" mention -- "is NOT banked", "hasn't
 * been banked" -- states the true unbanked condition; it is not a false
 * claim to cross-check. */
const NEGATION_RE =
  /\b(?:not|isn['’]?t|wasn['’]?t|hasn['’]?t|haven['’]?t|doesn['’]?t|didn['’]?t|never|no\s+longer|not\s+yet)\b/i;
/** A request or intent to bank -- "please bank", "let's bank", "can you bank"
 * -- describes a future action, not an assertion that banking has already
 * happened. */
const REQUEST_RE =
  /\b(?:please|let'?s|let\s+us|can\s+(?:you|we)|could\s+(?:you|we)|should\s+(?:we|i|you)|need(?:s)?\s+to|want(?:s)?\s+to|going\s+to|gonna|must|would\s+you|will\s+(?:you|we))\b/i;
/** A leading interrogative auxiliary paired with a "?" after the bank mention
 * -- "is #3 banked?" -- is a genuine question, not an assertion; an uncertain
 * chat interpretation must never be reported as an asserted contradiction. */
const QUESTION_START_RE =
  /^\s*(?:is|are|was|were|has|have|had|does|do|did|can|could|should|would|will)\b/i;

export type FindingSeverity = "info" | "warning" | "critical";

export type FindingCategory =
  | "unbanked_work"
  | "integration_attempt"
  | "outline_divergence"
  | "overdue_review"
  | "missing_review"
  | "banking_claim_mismatch"
  | "claim_hygiene";

/** One evidence-backed observation. Never a bare conclusion: `evidence` names
 * the durable record behind `summary`, `age_ms` is null only when no
 * timestamp anchors the finding, and `next_step` is always an actual command. */
export interface DriftFinding {
  category: FindingCategory;
  severity: FindingSeverity;
  summary: string;
  evidence: string;
  age_ms: number | null;
  next_step: string;
}

/**
 * Whether a declared artifact commit is reachable from the doctor's read-only
 * perspective. `verified_clean` is the only "trust this" state -- it is
 * backed by a verified integration-ledger record, not a git heuristic.
 * `unreachable` and `unobserved` are both "not clean" but distinct: an
 * unreachable commit was looked for and not found in the configured
 * integration repository's object database (most likely still confined to an
 * unfetched per-agent branch, precisely the Erdos-85 failure mode);
 * `unobserved` means no reachability check could even be attempted (no
 * integration target configured, or the check itself failed) -- the room is
 * only partially observable, and this report says so instead of guessing.
 */
export type BranchClassification =
  | "verified_clean"
  | "observed_unbanked"
  | "unreachable"
  | "unobserved";

export interface BranchObservation {
  node_id: number;
  artifact_path: string;
  commit: string;
  classification: BranchClassification;
  evidence: string;
}

/** A `review_requests` row joined with the node it targets. Deliberately a
 * separate, narrower shape from `ReviewRequestView` (core.ts): the doctor
 * needs `card_id`/`revision` (from `node_review_requests`) alongside the full
 * request row, which the existing per-node snapshot does not carry. */
export interface RoomReviewRow {
  /** The review request's id (`review_requests.id`, aliased as `node_review_requests.request_id`). */
  id: number;
  card_id: number;
  revision: number;
  target: string;
  requested_by: string;
  body: string;
  refs: string;
  priority: string;
  status: string;
  created_ts: string;
  expires_ts: string | null;
}

export interface RoomDoctorInput {
  status: ReturnType<Squad["stewardStatus"]>;
  reviewRequests: RoomReviewRow[];
  /** Chat-kind messages only, oldest first, bounded by the caller. */
  messages: Message[];
  now?: number;
  /** Injected so tests can avoid shelling out to git; defaults to a real,
   * best-effort local object-existence check when omitted. */
  checkCommitExists?: (repository: string, commit: string) => boolean;
}

export interface RoomDoctorReport {
  generated_ts: string;
  configuration_revision: number;
  configured: boolean;
  outline: { path: string; fresh: boolean; version: string };
  findings: DriftFinding[];
  branch_observations: BranchObservation[];
  summary: {
    total_findings: number;
    by_category: Partial<Record<FindingCategory, number>>;
    by_severity: Record<FindingSeverity, number>;
    healthy: boolean;
  };
}

/** git's own message for "this object genuinely does not exist" from `cat-file
 * -e` -- distinct from every other failure mode of the same non-zero exit
 * code (bad repository path, not a git repository, permission error,
 * timeout). Matched against stderr with `LC_ALL=C` forced below so it is not
 * locale-dependent. */
const GIT_OBJECT_ABSENT_RE = /Not a valid object name/i;

/** Bounded, read-only existence check against the *local* integration
 * repository's object database -- no network fetch, so it never blocks and
 * never mutates anything the repository's own configured build/publish flow
 * hasn't already fetched. A commit that fails this check is not necessarily
 * bad science; it just means this room cannot currently observe it.
 *
 * Returns `false` only when git could actually run the check and confirmed
 * the object is absent -- the caller (`classifyArtifact`) reports that as
 * `unreachable`. Any other failure (missing/invalid repository path, a
 * partial clone that would otherwise lazily fetch the object, permission
 * error, timeout) is a failure to *observe*, not a confirmed absence, so it
 * is rethrown for the caller to report as `unobserved` instead -- this
 * function must never blur "checked and it's not there" with "couldn't
 * check". */
export function commitExistsLocally(repository: string, commit: string): boolean {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) return false;
  try {
    execFileSync("git", ["-C", repository, "cat-file", "-e", `${commit}^{commit}`], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 5_000,
      encoding: "utf8",
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))),
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        // Read-only inspection must never perform a network fetch: a partial
        // clone's promisor remote would otherwise lazily fetch a missing
        // object (and write it locally) on exactly this kind of access.
        GIT_NO_LAZY_FETCH: "1",
        LC_ALL: "C",
      },
    });
    return true;
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr ?? "")
        : "";
    if (GIT_OBJECT_ABSENT_RE.test(stderr)) return false;
    throw error;
  }
}

function truncate(text: string, max = 160): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/** Whether a message mentioning "bank(ed/ing)" is too uncertain an
 * interpretation to assert as a contradiction of the verified ledger:
 * negation ("is not banked"), a request/intent ("please bank"), or a genuine
 * question ("is #3 banked?"). All three describe something other than "this
 * is already banked", so treating any of them as a claim to cross-check would
 * manufacture a false mismatch out of an ordinary, often accurate, chat
 * message. */
function isUncertainBankMention(body: string): boolean {
  const trimmed = body.trim();
  const match = BANK_CLAIM_RE.exec(trimmed);
  if (!match) return false;
  const clauseStart = Math.max(
    trimmed.lastIndexOf(".", match.index),
    trimmed.lastIndexOf(",", match.index),
    trimmed.lastIndexOf(";", match.index),
    trimmed.lastIndexOf("!", match.index),
    trimmed.lastIndexOf("?", match.index),
  );
  const clause = trimmed.slice(clauseStart + 1, match.index);
  if (NEGATION_RE.test(clause)) return true;
  if (REQUEST_RE.test(trimmed)) return true;
  const questionMark = trimmed.indexOf("?", match.index);
  if (questionMark !== -1 && QUESTION_START_RE.test(trimmed)) return true;
  return false;
}

/** Describes the most recent evidence item, enriched with the exit code from
 * the last "build" event when the most recent item is the "failure" that
 * followed it -- a bare "failure during build" is not actionable without it. */
function describeEvidence(evidence: IntegrationEvidence[]): string {
  const last = evidence.at(-1);
  if (!last) return "no evidence recorded yet";
  const event = last.event;
  const base = ((): string => {
    switch (event.kind) {
      case "build":
        return `build at ${last.ts} exited ${event.exit_code ?? "null"} (${event.clean ? "clean" : "not clean"})`;
      case "failure":
        return `failure at ${last.ts} during ${event.stage}: ${truncate(event.message)}`;
      case "publication":
        return `publication at ${last.ts} to ${event.branch} (observed ${event.observed_commit})`;
      case "verified":
        return `verified at ${last.ts} (commit ${event.commit})`;
      default:
        return `${event.kind} at ${last.ts}`;
    }
  })();
  if (event.kind !== "failure") return base;
  const lastBuild = [...evidence].reverse().find((e) => e.event.kind === "build");
  return lastBuild && lastBuild.event.kind === "build"
    ? `${base} (build exit_code=${lastBuild.event.exit_code ?? "null"})`
    : base;
}

function classifyArtifact(
  node: RoomDoctorInput["status"]["nodes"][number],
  artifact: { path: string; commit: string },
  input: RoomDoctorInput,
): BranchObservation {
  const short = artifact.commit.slice(0, 12);
  if (node.banked)
    return {
      node_id: node.id,
      artifact_path: artifact.path,
      commit: artifact.commit,
      classification: "verified_clean",
      evidence: `node ${node.id} is banked at revision ${node.revision}; artifact ${artifact.path}@${short} is covered by a verified integration record.`,
    };
  const config = input.status.configuration.config;
  if (!config)
    return {
      node_id: node.id,
      artifact_path: artifact.path,
      commit: artifact.commit,
      classification: "unobserved",
      evidence: `no integration target is configured; reachability of ${artifact.path}@${short} cannot be determined.`,
    };
  const check = input.checkCommitExists ?? commitExistsLocally;
  let exists: boolean;
  try {
    exists = check(config.repository, artifact.commit);
  } catch {
    return {
      node_id: node.id,
      artifact_path: artifact.path,
      commit: artifact.commit,
      classification: "unobserved",
      evidence: `reachability check failed for ${artifact.path}@${short}; local repository state could not be inspected.`,
    };
  }
  if (!exists)
    return {
      node_id: node.id,
      artifact_path: artifact.path,
      commit: artifact.commit,
      classification: "unreachable",
      evidence: `commit ${short} for artifact ${artifact.path} is not present in the configured integration repository's object database. No conclusion about remote branches is possible from this local check.`,
    };
  return {
    node_id: node.id,
    artifact_path: artifact.path,
    commit: artifact.commit,
    classification: "observed_unbanked",
    evidence: `commit ${short} for artifact ${artifact.path} exists in the configured integration repository but node ${node.id} is not yet banked at revision ${node.revision}.`,
  };
}

/** Pure report builder: same inputs always produce the same findings, so two
 * doctor runs against one unchanged observed revision/state always agree. */
export function buildRoomDoctorReport(input: RoomDoctorInput): RoomDoctorReport {
  const now = input.now ?? Date.now();
  const findings: DriftFinding[] = [];
  const branch_observations: BranchObservation[] = [];
  const { status } = input;

  for (const node of status.nodes) {
    for (const artifact of node.artifacts)
      branch_observations.push(classifyArtifact(node, artifact, input));
    if (node.banked || !node.artifacts.length) continue;
    const latestTs = node.revisions.at(-1)?.ts ?? null;
    const age_ms = latestTs ? now - Date.parse(latestTs) : null;
    const currentLinks = node.integrations.filter(
      (link) => link.current && link.current_configuration,
    );
    const activeAttempt = currentLinks.find((link) => link.status !== "verified");
    const evidenceParts = [
      `node ${node.id} revision ${node.revision}`,
      `${node.artifacts.length} declared artifact(s)`,
    ];
    let next_step: string;
    if (activeAttempt) {
      evidenceParts.push(`attempt ${activeAttempt.attempt_id} status=${activeAttempt.status}`);
      next_step = `Inspect 'squad integration attempt ${activeAttempt.attempt_id}' evidence and resume with 'squad bank ${activeAttempt.attempt_id}'.`;
    } else if (!status.configuration.config) {
      evidenceParts.push("no integration target configured");
      next_step = "Inspect 'squad integration show', then configure the intended target with 'squad integration set --repository <path> --remote <remote> --branch <branch> --build-command <command> --steward <persona> --expected-revision <revision>' before submitting this node.";
    } else {
      evidenceParts.push("no submission recorded for the current integration configuration");
      next_step = `Use 'squad node submit ${node.id} ${node.revision} <request-key> ${status.configuration.revision}', then 'squad bank <attempt-id>'.`;
    }
    findings.push({
      category: "unbanked_work",
      severity: activeAttempt?.status === "failed" ? "critical" : "warning",
      summary: `Node ${node.id} revision ${node.revision} has declared artifacts that are not banked under the current configuration.`,
      evidence: `${evidenceParts.join("; ")}.`,
      age_ms,
      next_step,
    });
  }

  for (const attempt of status.attempts) {
    if (attempt.status === "verified") continue;
    const age_ms = now - Date.parse(attempt.created_ts);
    const retired = attempt.config_revision !== status.configuration.revision;
    findings.push({
      category: "integration_attempt",
      severity: attempt.status === "failed" ? "critical" : "info",
      summary: `Integration attempt ${attempt.id} (request ${attempt.request_key}) is ${attempt.status}${retired ? " under a retired configuration" : ""}.`,
      evidence: `submitted_by=${attempt.submitted_by}, config_revision=${attempt.config_revision}, created=${attempt.created_ts}, last evidence: ${describeEvidence(attempt.evidence)}.`,
      age_ms,
      next_step: retired
        ? `Preserve this attempt's evidence; it belongs to retired configuration ${attempt.config_revision} and cannot bank under current configuration ${status.configuration.revision}. Re-submit under the current configuration if still needed.`
        : `Inspect durable evidence with 'squad integration attempt ${attempt.id}' and resume with 'squad bank ${attempt.id}'.`,
    });
  }

  const outline = status.outline;
  const latestVerifiedPublication = [...outline.publications]
    .reverse()
    .find((p) => p.attempt.status === "verified");
  if (!outline.fresh)
    findings.push({
      category: "outline_divergence",
      severity: "warning",
      summary: `Shared outline at ${outline.path} differs from the latest recorded verified publication.`,
      evidence: latestVerifiedPublication
        ? `current computed snapshot version=${outline.version}; latest verified publication version=${latestVerifiedPublication.version} (request ${latestVerifiedPublication.request_key}, config revision ${latestVerifiedPublication.config_revision}, attempt ${latestVerifiedPublication.attempt_id}).`
        : `current computed snapshot version=${outline.version}; no verified publication has ever been recorded for this path.`,
      age_ms: latestVerifiedPublication
        ? now - Date.parse(latestVerifiedPublication.attempt.updated_ts)
        : null,
      next_step:
        "Inspect 'squad outline status', resume a pending publication with its existing request key, or explicitly publish a new snapshot via 'squad outline publish <request-key> [path]'.",
    });

  for (const row of input.reviewRequests) {
    if (row.status !== "pending" && row.status !== "claimed") continue;
    const createdMs = Date.parse(row.created_ts);
    const expiresMs = row.expires_ts ? Date.parse(row.expires_ts) : null;
    const expired = expiresMs !== null && now >= expiresMs;
    const age_ms = now - createdMs;
    if (!expired && age_ms < OVERDUE_MS) continue;
    findings.push({
      category: "overdue_review",
      severity: expired ? "critical" : "warning",
      summary: `Review request ${row.id} for node ${row.card_id} revision ${row.revision} is ${expired ? "expired" : "overdue"} (${row.status}).`,
      evidence: `target=${row.target}, requested_by=${row.requested_by}, priority=${row.priority}, created=${row.created_ts}${row.expires_ts ? `, expires=${row.expires_ts}` : ", no expiry"}.`,
      age_ms,
      next_step: `@${row.target} inspect 'squad review show ${row.id}' and node ${row.card_id} history; claim it with 'squad review claim ${row.id}', inspect the exact revision and integration evidence, then record independent review with 'squad node review ${row.id} <JSON>' using the persisted request key when resuming. Cancel the request if stale.`,
    });
  }

  for (const node of status.nodes) {
    const nodeReviewRequests = node.review_requests as unknown as {
      revision: number;
      status: string;
    }[];
    const openForRevision = nodeReviewRequests.filter(
      (r) => r.revision === node.revision && ["pending", "claimed"].includes(r.status),
    );
    if (node.review_status === "unreviewed" && !openForRevision.length && (node.banked || node.artifacts.length)) {
      const latestTs = node.revisions.at(-1)?.ts ?? null;
      findings.push({
        category: "missing_review",
        severity: "warning",
        summary: `Node ${node.id} revision ${node.revision} has no independent review.`,
        evidence: `banked=${node.banked}, declared artifacts=${node.artifacts.length}, review_status=unreviewed, no open review request for this revision.`,
        age_ms: latestTs ? now - Date.parse(latestTs) : null,
        next_step: `Use 'squad node claim ${node.id} ${node.revision} <independent-reviewer>' to open independent review; banking does not approve science.`,
      });
    }
  }

  for (const claim of status.claims) {
    if (!claim.stale_advisory && !claim.conflicting_claim_ids.length) continue;
    const reasons = [
      ...(claim.stale_advisory ? ["older than 24 hours"] : []),
      ...(claim.conflicting_claim_ids.length
        ? [`overlaps claim(s) ${claim.conflicting_claim_ids.join(", ")}`]
        : []),
    ];
    findings.push({
      category: "claim_hygiene",
      severity: claim.conflicting_claim_ids.length ? "warning" : "info",
      summary: `Claim ${claim.id} (${claim.path}) by ${claim.persona} needs an advisory check.`,
      evidence: `${reasons.join("; ")} (created ${claim.created_ts}).`,
      age_ms: now - Date.parse(claim.created_ts),
      next_step: `Confirm ownership with ${claim.persona}; release with 'squad release ${claim.path}' only if the claim should end. No claim is removed automatically.`,
    });
  }

  const nodesById = new Map(status.nodes.map((n) => [n.id, n]));
  for (const message of input.messages) {
    if (!BANK_CLAIM_RE.test(message.body)) continue;
    // A negation, a request/intent, or a genuine question is not an
    // assertion that banking already happened -- an uncertain chat
    // interpretation must never be reported as an asserted contradiction.
    if (isUncertainBankMention(message.body)) continue;
    const age_ms = now - Date.parse(message.ts);
    const refs = [...message.body.replace(REVISION_REF_RE, "").matchAll(REF_RE)].map((m) => Number(m[1]));
    const nodeRefs = refs.filter((id) => nodesById.has(id));
    if (!nodeRefs.length) {
      findings.push({
        category: "banking_claim_mismatch",
        severity: "info",
        summary: `Possible banking claim by ${message.sender} does not reference a resolvable node ID.`,
        evidence: `message #${message.id} at ${message.ts}: "${truncate(message.body)}".`,
        age_ms,
        next_step:
          "Cross-check manually against 'squad integration attempts' and 'squad node list'; an informal chat claim is never itself banking evidence.",
      });
      continue;
    }
    // An explicit revision named in the message ("revision 3", "rev #3") that
    // does not match the node's *current* revision is a claim about a past
    // revision, not the one this report evaluates -- comparing it against
    // the current, possibly-since-revised state would manufacture a false
    // mismatch out of a historically accurate claim.
    const revisionRef = REVISION_REF_RE.exec(message.body);
    const claimedRevision = revisionRef ? Number(revisionRef[1]) : null;
    for (const id of new Set(nodeRefs)) {
      const node = nodesById.get(id)!;
      if (node.banked) continue; // claim matches the verified record
      if (claimedRevision !== null && claimedRevision !== node.revision) continue;
      // A revisionless message predating the current revision cannot speak
      // for that revision. Preserve it in chat, but do not invent current drift.
      const currentRevisionTs = node.revisions.find((r) => r.revision === node.revision)?.ts;
      if (claimedRevision === null && currentRevisionTs &&
          Date.parse(message.ts) < Date.parse(currentRevisionTs)) continue;
      findings.push({
        category: "banking_claim_mismatch",
        severity: "warning",
        summary: `Possible banking claim for node ${id} needs verification against its currently unbanked revision.`,
        evidence: `message #${message.id} from ${message.sender} at ${message.ts}: "${truncate(message.body)}"; node ${id} revision ${node.revision} currently has banked=false. Chat interpretation is heuristic; this does not establish that the sender asserted banking for this revision.`,
        age_ms,
        next_step: `Verify with 'squad node show ${id}' and 'squad integration attempts'; if truly unbanked, submit and bank it explicitly instead of treating the chat claim as evidence.`,
      });
    }
  }

  const by_category: Partial<Record<FindingCategory, number>> = {};
  const by_severity: Record<FindingSeverity, number> = { info: 0, warning: 0, critical: 0 };
  for (const finding of findings) {
    by_category[finding.category] = (by_category[finding.category] ?? 0) + 1;
    by_severity[finding.severity] += 1;
  }

  return {
    generated_ts: new Date(now).toISOString(),
    configuration_revision: status.configuration.revision,
    configured: status.configuration.config !== null,
    outline: { path: outline.path, fresh: outline.fresh, version: outline.version },
    findings,
    branch_observations,
    summary: {
      total_findings: findings.length,
      by_category,
      by_severity,
      healthy: findings.length === 0,
    },
  };
}

function formatAge(ms: number | null): string {
  if (ms === null) return "unknown";
  if (ms < 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/** Render `RoomDoctorReport` as the plain, section-oriented text `squad
 * doctor` already uses -- readable directly in a terminal, no JSON parsing
 * required to act on a finding. */
export function formatRoomDoctorReport(report: RoomDoctorReport): string {
  const lines: string[] = [];
  lines.push(
    `squad doctor --room -- read-only room drift report (generated ${report.generated_ts})`,
    `configuration revision ${report.configuration_revision} (${report.configured ? "configured" : "NOT configured"}); outline ${report.outline.path} version ${report.outline.version} -- ${report.outline.fresh ? "fresh" : "STALE"}`,
    "",
  );
  const sections: { title: string; categories: FindingCategory[] }[] = [
    { title: "Unbanked work", categories: ["unbanked_work"] },
    { title: "Integration attempts", categories: ["integration_attempt"] },
    { title: "Outline divergence", categories: ["outline_divergence"] },
    { title: "Reviews", categories: ["overdue_review", "missing_review"] },
    { title: "Banking claim mismatches", categories: ["banking_claim_mismatch"] },
    { title: "Claim hygiene", categories: ["claim_hygiene"] },
  ];
  for (const section of sections) {
    const items = report.findings.filter((f) => section.categories.includes(f.category));
    lines.push(`== ${section.title} (${items.length}) ==`);
    if (!items.length) lines.push("  none observed.");
    for (const item of items) {
      lines.push(
        `  [${item.severity}] ${item.summary}`,
        `    evidence: ${item.evidence}`,
        `    age: ${formatAge(item.age_ms)}`,
        `    next step: ${item.next_step}`,
      );
    }
    lines.push("");
  }
  lines.push(`== Branch observations (${report.branch_observations.length}) ==`);
  if (!report.branch_observations.length) lines.push("  none observed.");
  for (const observation of report.branch_observations)
    lines.push(
      `  [${observation.classification}] node ${observation.node_id} ${observation.artifact_path}@${observation.commit.slice(0, 12)}: ${observation.evidence}`,
    );
  lines.push("");
  lines.push(
    `Summary: ${report.summary.total_findings} finding(s) -- ${report.summary.by_severity.critical} critical, ${report.summary.by_severity.warning} warning, ${report.summary.by_severity.info} info. ${
      report.summary.healthy
        ? "No drift observed at this revision/state."
        : "Drift observed; see findings above for evidence and next steps."
    }`,
  );
  return lines.join("\n") + "\n";
}
