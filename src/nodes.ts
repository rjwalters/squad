import type { DatabaseSync } from "node:sqlite";
import type { IntegrationAttempt } from "./integration-ledger.js";

export interface NodeArtifact {
  path: string;
  commit: string;
  theorem?: string;
}
export interface NodeMetadata {
  dependencies: number[];
  artifacts: NodeArtifact[];
}
export interface NodeRevision {
  card_id: number;
  revision: number;
  content: Record<string, unknown>;
  actor: string | null;
  session_id: string | null;
  ts: string;
  origin: "adopted" | "created" | "edited";
}
export function nodeMetadata(db: DatabaseSync, id: number): NodeMetadata {
  const row = db
    .prepare("SELECT * FROM node_metadata WHERE card_id = ?")
    .get(id) as
    | { dependencies_json: string; artifacts_json: string }
    | undefined;
  return row
    ? {
        dependencies: JSON.parse(row.dependencies_json),
        artifacts: JSON.parse(row.artifacts_json),
      }
    : { dependencies: [], artifacts: [] };
}
function content(db: DatabaseSync, id: number): Record<string, unknown> {
  const row = db.prepare("SELECT * FROM science_cards WHERE id = ?").get(id);
  if (!row) throw new Error(`node: no science card with id ${id}`);
  const { updated_ts, ...card } = row;
  return {
    card,
    ...nodeMetadata(db, id),
    evidence: db
      .prepare(
        "SELECT * FROM science_card_evidence WHERE card_id = ? ORDER BY id",
      )
      .all(id),
    transitions: db
      .prepare(
        "SELECT * FROM science_card_transitions WHERE card_id = ? ORDER BY id",
      )
      .all(id),
  };
}
export function recordNodeRevision(
  db: DatabaseSync,
  id: number,
  actor: string | null,
  session: string | null,
  origin: NodeRevision["origin"],
): void {
  const serialized = JSON.stringify(content(db, id));
  const prior = db
    .prepare(
      "SELECT revision, content_json FROM node_revisions WHERE card_id = ? ORDER BY revision DESC LIMIT 1",
    )
    .get(id) as { revision: number; content_json: string } | undefined;
  if (prior?.content_json === serialized) return;
  db.prepare("INSERT INTO node_revisions VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    id,
    (prior?.revision ?? 0) + 1,
    serialized,
    actor,
    session,
    new Date().toISOString(),
    origin,
  );
}
/** Old mutable cards gain one honest baseline, never invented historical edits. */
export function adoptNodes(db: DatabaseSync): void {
  db.exec("SAVEPOINT adopt_nodes");
  try {
    for (const { id } of db
      .prepare(
        "SELECT id FROM science_cards WHERE id NOT IN (SELECT card_id FROM node_revisions)",
      )
      .all())
      recordNodeRevision(db, Number(id), null, null, "adopted");
    db.exec("RELEASE adopt_nodes");
  } catch (error) {
    db.exec("ROLLBACK TO adopt_nodes; RELEASE adopt_nodes");
    throw error;
  }
}
export function nodeRevisions(db: DatabaseSync, id: number): NodeRevision[] {
  return db
    .prepare("SELECT * FROM node_revisions WHERE card_id = ? ORDER BY revision")
    .all(id)
    .map((row) => {
      const { content_json, ...rest } = row;
      return {
        ...rest,
        content: JSON.parse(String(content_json)),
      } as unknown as NodeRevision;
    });
}
export function validateNodeMetadata(
  db: DatabaseSync,
  id: number | null,
  input: NodeMetadata,
): NodeMetadata {
  if (!Array.isArray(input.dependencies) || !Array.isArray(input.artifacts))
    throw new Error("node: dependencies and artifacts must be arrays");
  const dependencies = [...input.dependencies].sort((a, b) => a - b);
  if (new Set(dependencies).size !== dependencies.length)
    throw new Error("node: duplicate dependency");
  for (const dependency of dependencies) {
    if (
      !Number.isSafeInteger(dependency) ||
      dependency < 1 ||
      !db.prepare("SELECT id FROM science_cards WHERE id = ?").get(dependency)
    )
      throw new Error(`node: missing dependency ${dependency}`);
    const visited = new Set<number>();
    const visit = (next: number): void => {
      if (next === id) throw new Error("node: dependency cycle");
      if (visited.has(next)) return;
      visited.add(next);
      nodeMetadata(db, next).dependencies.forEach(visit);
    };
    visit(dependency);
  }
  const artifacts = input.artifacts
    .map((artifact) => {
      if (
        !artifact ||
        typeof artifact.path !== "string" ||
        !artifact.path ||
        /[\\\0\r\n]/.test(artifact.path) ||
        artifact.path.startsWith("/") ||
        artifact.path.split("/").some((p) => !p || p === "." || p === "..")
      )
        throw new Error(
          "node: artifact path must be an exact repository-relative file without traversal",
        );
      if (
        typeof artifact.commit !== "string" ||
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(artifact.commit)
      )
        throw new Error(
          "node: artifact commit must be a full lowercase Git object ID",
        );
      if (
        artifact.theorem !== undefined &&
        (typeof artifact.theorem !== "string" ||
          !artifact.theorem.trim() ||
          artifact.theorem.includes("\0"))
      )
        throw new Error("node: invalid theorem declaration");
      return {
        path: artifact.path,
        commit: artifact.commit,
        ...(artifact.theorem === undefined
          ? {}
          : { theorem: artifact.theorem }),
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (new Set(artifacts.map((a) => a.path)).size !== artifacts.length)
    throw new Error("node: duplicate artifact path");
  return { dependencies, artifacts };
}
export function writeNodeMetadata(
  db: DatabaseSync,
  id: number,
  metadata: NodeMetadata,
): void {
  db.prepare(
    "INSERT INTO node_metadata VALUES (?, ?, ?) ON CONFLICT(card_id) DO UPDATE SET dependencies_json=excluded.dependencies_json, artifacts_json=excluded.artifacts_json",
  ).run(
    id,
    JSON.stringify(metadata.dependencies),
    JSON.stringify(metadata.artifacts),
  );
}
/** Called inside the ledger's submission transaction: failures roll back the attempt. */
export function bindNodes(
  db: DatabaseSync,
  attempt: IntegrationAttempt,
  expected?: Record<string, number>,
): void {
  for (const ref of attempt.node_refs) {
    if (!/^[1-9][0-9]*$/.test(ref) || !Number.isSafeInteger(Number(ref)))
      throw new Error(
        `node: invalid node reference ${ref}; use a Science Card ID`,
      );
    const id = Number(ref),
      revisions = nodeRevisions(db, id),
      current = revisions.at(-1);
    if (!current) throw new Error(`node: no science card with id ${id}`);
    if (expected?.[ref] !== current.revision)
      throw new Error(
        "node: content revision changed or missing node_revisions binding",
      );
    const { artifacts } = nodeMetadata(db, id);
    if (
      !artifacts.length ||
      !attempt.selection ||
      attempt.commits.length !== 1 ||
      artifacts.some((a) => a.commit !== attempt.commits[0]) ||
      JSON.stringify(artifacts.map((a) => a.path).sort()) !==
        JSON.stringify([...attempt.selection.paths].sort()) ||
      (attempt.selection.theorem !== undefined &&
        artifacts.some((a) => a.theorem !== attempt.selection!.theorem))
    )
      throw new Error(
        `node: submission must match node ${id}'s declared artifact paths, source commit and theorem`,
      );
    db.prepare("INSERT INTO node_integrations VALUES (?, ?, ?)").run(
      id,
      current.revision,
      attempt.id,
    );
  }
}
