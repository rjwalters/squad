import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Squad } from "./core.js";
import type { IntegrationState } from "./integration.js";
import { IntegrationLedger } from "./integration-ledger.js";
import {
  executeIntegration,
  run,
  type BankOptions,
} from "./integration-executor.js";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function renderOutline(
  configuration: IntegrationState,
  nodes: ReturnType<Squad["nodeGet"]>[],
) {
  const source = {
    format_version: 1,
    configuration: {
      revision: configuration.revision,
      config: configuration.config,
    },
    nodes,
  };
  const version = createHash("sha256").update(canonical(source)).digest("hex");
  const lines = [
    "# Shared research outline",
    "",
    `Snapshot: sha256:${version}`,
    "",
    "Generated from shared research state. Banking and independent review are separate. Pending evidence is not integrated. Historical citations retain their exact revisions.",
    "",
  ];
  for (const node of nodes) {
    lines.push(
      `## Node ${node.id}: ${node.title}`,
      "",
      `Revision: ${node.revision}; scientific phase: ${node.phase}; ${node.banked ? "BANKED (current revision and configuration)" : "PENDING / UNBANKED current revision"}; independent review: ${node.review_status}.`,
      "",
      `Question: ${node.question}`,
      "",
      `Dependencies: ${node.dependencies.join(", ") || "none"}`,
      "",
    );
    for (const link of node.integrations) {
      if (link.status === "verified" && link.integrated?.kind === "verified")
        lines.push(
          `- VERIFIED BANK ${link.attempt_id}: node ${node.id} revision ${link.revision}; commit ${link.integrated.commit}; tree ${link.integrated.tree}; ${link.current && link.current_configuration ? "current" : "historical / stale"}.`,
        );
      else
        lines.push(
          `- PENDING / UNBANKED attempt ${link.attempt_id}: node revision ${link.revision}; status ${link.status}.`,
        );
    }
    for (const artifact of node.artifacts)
      lines.push(
        `- Declared source artifact (not itself a bank citation): ${artifact.path} at ${artifact.commit}${artifact.theorem ? `; theorem ${artifact.theorem}` : ""}.`,
      );
    for (const review of node.reviews)
      lines.push(
        `- Independent review ${review.id}: ${review.status}; revision ${review.revision}; ${review.current ? "current" : "historical / stale"}.`,
      );
    lines.push(
      "",
      "Complete shared node record (includes negative outcomes, evidence, transitions and review receipts):",
      "",
      "```json",
      canonical(node),
      "```",
      "",
    );
  }
  return {
    format_version: 1 as const,
    version,
    content: lines.join("\n") + "\n",
    source,
  };
}
export function validateOutlinePath(path: string) {
  if (
    typeof path !== "string" ||
    !path ||
    /[\\\0\r\n]/.test(path) ||
    path.startsWith("/") ||
    path
      .split("/")
      .some((p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git")
  )
    throw new Error(
      "outline: path must be an exact repository-relative file without traversal or .git components",
    );
}
interface Publication {
  request_key: string;
  path: string;
  version: string;
  content: string;
  config_revision: number;
  base_commit: string;
  expected_blob: string | null;
  source_commit: string;
  attempt_id: string;
}
export interface OutlinePublishOptions extends BankOptions {
  request_key: string;
  path?: string;
}
export function outlinePublications(
  db: DatabaseSync,
  persona: string,
  path: string,
) {
  const ledger = new IntegrationLedger(db, persona);
  return (
    db
      .prepare("SELECT * FROM outline_publications WHERE path=? ORDER BY rowid")
      .all(path) as unknown as Publication[]
  ).map((row) => ({ ...row, attempt: ledger.get(row.attempt_id) }));
}
export async function publishOutline(
  db: DatabaseSync,
  persona: string,
  render: () => ReturnType<typeof renderOutline>,
  config: () => IntegrationState,
  touch: () => void,
  options: OutlinePublishOptions,
) {
  if (
    !options ||
    Object.keys(options).some(
      (k) => !["request_key", "path", "build_timeout_ms", "signal"].includes(k),
    ) ||
    typeof options.request_key !== "string" ||
    !options.request_key.trim() ||
    options.request_key.includes("\0")
  )
    throw new Error(
      "outline: valid request_key and supported options required",
    );
  const path = options.path ?? "SQUAD_OUTLINE.md";
  validateOutlinePath(path);
  if (
    options.build_timeout_ms !== undefined &&
    (!Number.isSafeInteger(options.build_timeout_ms) ||
      options.build_timeout_ms < 1000 ||
      options.build_timeout_ms > 86400000)
  )
    throw new Error("outline: build_timeout_ms must be 1000..86400000");
  const ledger = new IntegrationLedger(db, persona);
  let row = db
    .prepare("SELECT * FROM outline_publications WHERE request_key=?")
    .get(options.request_key) as unknown as Publication | undefined;
  if (row && row.path !== path)
    throw new Error("outline: request_key already bound to a different path");
  if (row && ledger.get(row.attempt_id).status === "verified")
    return {
      ...row,
      attempt: ledger.get(row.attempt_id),
      fresh: render().version === row.version,
    };
  const observed = render();
  const state = row
    ? {
        revision: row.config_revision,
        config: ledger.get(row.attempt_id).config,
      }
    : observed.source.configuration;
  if (!state.config) throw new Error("outline: integration must be configured");
  const snapshot = row ?? observed;
  const workspace = mkdtempSync(join(tmpdir(), "squad-outline-"));
  const signal = options.signal ?? new AbortController().signal;
  const git = async (args: string[], raw = false) => {
    const result = await run(
      workspace,
      "git",
      [
        "--literal-pathspecs",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgSign=false",
        ...args,
      ],
      signal,
      60000,
      16777216,
    );
    if (result.code !== 0 || result.truncated)
      throw new Error(`outline: git ${args[0]} failed: ${result.output}`);
    return raw ? result.output : result.output.trim();
  };
  try {
    await git(["init", "-q", "."]);
    const pinTransport = async () => {
      await git(["remote", "add", "squad-target", state.config!.remote_url]);
      for (const flags of [["--all"], ["--push", "--all"]]) {
        if (
          (await git(["remote", "get-url", ...flags, "squad-target"])) !==
          state.config!.remote_url
        )
          throw new Error(
            "outline: effective isolated transport URL differs from pinned remote",
          );
      }
    };
    await pinTransport();
    const probe = await git([
      "ls-remote",
      "--heads",
      "--",
      state.config.remote_url,
      `refs/heads/${state.config.branch}`,
    ]);
    const targetOid = probe.split(/\s/)[0];
    if (!targetOid)
      throw new Error("outline: an existing integration branch is required");
    const objectFormat =
      (row?.base_commit.length ?? targetOid.length) === 64 ? "sha256" : "sha1";
    if ((await git(["rev-parse", "--show-object-format"])) !== objectFormat) {
      rmSync(join(workspace, ".git"), { recursive: true, force: true });
      await git(["init", "-q", `--object-format=${objectFormat}`, "."]);
      await pinTransport();
    }
    await git([
      "fetch",
      "--no-tags",
      "--",
      state.config.remote_url,
      row?.base_commit ?? `refs/heads/${state.config.branch}`,
    ]);
    const base = row?.base_commit ?? (await git(["rev-parse", "FETCH_HEAD"]));
    await git(["checkout", "--detach", "-f", base]);
    const entry = await git(["ls-tree", base, "--", path]);
    let blob: string | null = null;
    if (entry) {
      const match = /^100644 blob ([0-9a-f]+)\t/.exec(entry);
      if (!match)
        throw new Error(
          "outline: existing generated path is not an owned regular file",
        );
      blob = match[1]!;
      if (!row) {
        const content = await git(["cat-file", "blob", blob], true);
        const owned = outlinePublications(db, persona, path).some(
          (p) =>
            p.attempt.status === "verified" &&
            p.attempt.config.remote_url === state.config!.remote_url &&
            p.attempt.config.branch === state.config!.branch &&
            p.content === content,
        );
        if (!owned)
          throw new Error(
            "outline: existing file is not an exact previously verified generated publication; refusing prose replacement",
          );
      }
    }
    // Reject symlink ancestors before any filesystem write in the isolated checkout.
    for (let parent = dirname(path); parent !== "."; parent = dirname(parent)) {
      const entry = await git(["ls-tree", base, "--", parent]);
      if (entry && !entry.startsWith("040000 tree "))
        throw new Error("outline: path ancestor is not a directory");
    }
    mkdirSync(dirname(join(workspace, path)), { recursive: true });
    writeFileSync(join(workspace, path), snapshot.content);
    await git(["add", "--", path]);
    const tree = await git(["write-tree"]);
    if (
      (await git(["cat-file", "blob", `${tree}:${path}`], true)) !==
      snapshot.content
    )
      throw new Error(
        "outline: Git filters changed generated content; refusing publication",
      );
    const commitResult = await run(
      workspace,
      "env",
      [
        "GIT_AUTHOR_DATE=2000-01-01T00:00:00Z",
        "GIT_COMMITTER_DATE=2000-01-01T00:00:00Z",
        "git",
        "-c",
        "commit.gpgSign=false",
        "commit-tree",
        tree,
        "-p",
        base,
        "-m",
        `Generate outline ${snapshot.version}`,
      ],
      signal,
      60000,
    );
    if (commitResult.code !== 0)
      throw new Error("outline: could not prepare generated commit");
    const commit = commitResult.output.trim();
    if (row && commit !== row.source_commit)
      throw new Error("outline: reconstructed source provenance mismatch");
    if (!row) {
      ledger.submit(
        {
          request_key: `outline:${options.request_key}`,
          config_revision: state.revision,
          commits: [commit],
          selection: { paths: [path] },
        },
        (attempt) => {
          row = {
            request_key: options.request_key,
            path,
            version: snapshot.version,
            content: snapshot.content,
            config_revision: state.revision,
            base_commit: base,
            expected_blob: blob,
            source_commit: commit,
            attempt_id: attempt.id,
          };
          db.prepare(
            "INSERT INTO outline_publications VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ).run(
            row.request_key,
            path,
            row.version,
            row.content,
            row.config_revision,
            base,
            blob,
            commit,
            attempt.id,
          );
        },
      );
      if (!row)
        throw new Error(
          "outline: request key collides with an existing integration request",
        );
    }
    await git(["checkout", "--detach", "-f", commit]);
    const attempt = await executeIntegration(
      ledger,
      row.attempt_id,
      config,
      touch,
      options,
      {
        repository: workspace,
        config_revision: row.config_revision,
        commits: [row.source_commit],
        expected_target_blobs: { [path]: row.expected_blob },
      },
    );
    return {
      ...row,
      attempt,
      fresh: attempt.status === "verified" && render().version === row.version,
    };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}
