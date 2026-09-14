import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IntegrationLedger,
  type IntegrationEvent,
} from "./integration-ledger.js";
import { validateIntegration, type IntegrationState } from "./integration.js";

export interface BankOptions {
  /** Builds default to 30 minutes; Git operations have a separate 60 second bound. */
  build_timeout_ms?: number;
  signal?: AbortSignal;
}

/** Internal reusable source seam for generated artifacts. The producer must own
 * this isolated repository and establish provenance before submitting its commits.
 * This is intentionally absent from CLI/MCP inputs. */
export interface PreparedIntegrationSource {
  repository: string;
  config_revision: number;
  commits: string[];
}

function environment(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    ),
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_AUTHOR_NAME: "Squad integration",
    GIT_AUTHOR_EMAIL: "squad@localhost",
    GIT_COMMITTER_NAME: "Squad integration",
    GIT_COMMITTER_EMAIL: "squad@localhost",
  };
}

/** Async and bounded so runner/presence renewal continues during builds. */
async function run(
  cwd: string,
  command: string,
  args: string[],
  signal: AbortSignal,
  timeout: number,
) {
  signal.throwIfAborted();
  return await new Promise<{
    code: number | null;
    output: string;
    truncated: boolean;
  }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: environment(),
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "",
      truncated = false,
      stopped: string | undefined;
    const capture = (chunk: Buffer) => {
      const text = chunk.toString();
      truncated ||= output.length + text.length > 65_536;
      output = (output + text).slice(0, 65_536);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const stop = (reason: string) => {
      stopped = reason;
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* already exited */
      }
    };
    const abort = () => stop("cancelled");
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => stop(`timed out after ${timeout} ms`),
      timeout,
    );
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      cleanup();
      resolve({
        code: stopped ? null : code,
        output: output + (stopped ? `\n${stopped}` : ""),
        truncated,
      });
    });
  });
}

export async function executeIntegration(
  ledger: IntegrationLedger,
  id: string,
  currentConfig: () => IntegrationState,
  touch: () => void,
  options: BankOptions = {},
  prepared?: PreparedIntegrationSource,
) {
  const timeout = options.build_timeout_ms ?? 1_800_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 86_400_000)
    throw new Error("integration: build_timeout_ms must be 1000..86400000");
  let attempt = ledger.get(id);
  if (attempt.status === "verified") return attempt;
  const { token } = ledger.claim(id);
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  let leaseError: unknown;
  const timer = setInterval(() => {
    try {
      ledger.renew(id, token);
      touch();
    } catch (error) {
      leaseError = error;
      controller.abort();
    }
  }, 10_000);
  let workspace: string | undefined,
    stage = "validation";
  const append = (event: IntegrationEvent) => {
    attempt = ledger.append(id, attempt.revision, event, token);
  };
  const guard = () => {
    controller.signal.throwIfAborted();
    ledger.renew(id, token);
    const state = currentConfig();
    if (!state.config || state.revision !== attempt.config_revision)
      throw new Error(
        "integration: configuration revision changed or disabled; submit a new request",
      );
    validateIntegration(attempt.config);
  };
  const git = async (cwd: string, args: string[], allowFailure = false) => {
    const result = await run(
      cwd,
      "git",
      [
        "--literal-pathspecs",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgSign=false",
        ...args,
      ],
      controller.signal,
      60_000,
    );
    if (result.code !== 0 && !allowFailure)
      throw new Error(`integration: git ${args[0]} failed: ${result.output}`);
    return result;
  };
  const value = async (cwd: string, args: string[]) =>
    (await git(cwd, args)).output.trim();
  try {
    touch();
    // Recovery uses the archived target even if integration has since been disabled.
    // It only observes; no new publication occurs without guard().
    workspace = mkdtempSync(join(tmpdir(), "squad-bank-"));
    await git(workspace, ["init", "-q", "."]);
    const ref = `refs/heads/${attempt.config.branch}`;
    await git(workspace, [
      "remote",
      "add",
      "squad-target",
      attempt.config.remote_url,
    ]);
    const transport = async () => {
      for (const flags of [["--all"], ["--push", "--all"]]) {
        if (
          (await value(workspace!, [
            "remote",
            "get-url",
            ...flags,
            "squad-target",
          ])) !== attempt.config.remote_url
        )
          throw new Error(
            "integration: effective isolated transport URL differs from pinned remote",
          );
      }
    };
    const fetchTarget = async () => {
      await transport();
      const probe = await git(workspace!, [
        "ls-remote",
        "--heads",
        "--",
        attempt.config.remote_url,
        ref,
      ]);
      if (!probe.output.trim()) return null;
      await git(workspace!, [
        "fetch",
        "--no-tags",
        "--",
        attempt.config.remote_url,
        ref,
      ]);
      return value(workspace!, ["rev-parse", "FETCH_HEAD"]);
    };
    const observe = async (
      commit: string,
      tree: string,
      observed: string | null,
    ) => {
      if (!observed) return false;
      const reachable = await git(
        workspace!,
        ["merge-base", "--is-ancestor", commit, observed],
        true,
      );
      if (reachable.code !== 0) return false;
      if ((await value(workspace!, ["rev-parse", `${commit}^{tree}`])) !== tree)
        throw new Error("integration: recovery tree mismatch");
      append({
        kind: "publication",
        commit,
        tree,
        remote_url: attempt.config.remote_url,
        branch: attempt.config.branch,
        observed_commit: observed,
        candidate_reachable: true,
      });
      attempt = ledger.verify(id, attempt.revision, token);
      return true;
    };
    const last = attempt.evidence.at(-1);
    if (attempt.status === "pending" && last) {
      const events = attempt.evidence
        .filter((e) => e.run_id === last.run_id)
        .map((e) => e.event);
      const candidateIndex = events.map((e) => e.kind).lastIndexOf("candidate");
      const intent = [...events.slice(candidateIndex + 1)]
        .reverse()
        .find((e) => e.kind === "publication_intent");
      if (intent?.kind === "publication_intent") {
        stage = "recovery";
        const observed = await fetchTarget();
        if (await observe(intent.commit, intent.tree, observed)) return attempt;
      }
    }
    guard();
    if (attempt.status === "failed" || attempt.evidence.length)
      append({
        kind: "retry",
        reason: "Explicit bank execution; previous publication not observed",
      });
    const source = prepared?.repository ?? attempt.config.repository;
    if (
      prepared &&
      (prepared.config_revision !== attempt.config_revision ||
        JSON.stringify(prepared.commits) !== JSON.stringify(attempt.commits))
    )
      throw new Error(
        "integration: prepared source provenance does not match submission",
      );
    // Full commit selection includes ancestry. No refs or files in source are mutated.
    for (const commit of attempt.commits) {
      if ((await value(source, ["cat-file", "-t", commit])) !== "commit")
        throw new Error("integration: selection is not a commit");
      await git(workspace, ["fetch", "--no-tags", "--", source, commit]);
    }
    if (attempt.selection) {
      const selectedCommit = attempt.commits[0]!;
      for (const path of attempt.selection.paths) {
        const entry = await value(source, [
          "ls-tree",
          selectedCommit,
          "--",
          path,
        ]);
        if (!/^100(?:644|755) blob /.test(entry))
          throw new Error(
            `integration: artifact is not a committed regular file: ${path}`,
          );
      }
      if (
        (await value(source, [
          "status",
          "--porcelain",
          "--untracked-files=all",
          "--",
          ...attempt.selection.paths,
        ])) ||
        (await value(source, [
          "diff",
          selectedCommit,
          "--",
          ...attempt.selection.paths,
        ]))
      )
        throw new Error(
          "integration: selected artifacts contain uncommitted work or differ from submitted commit",
        );
    }
    for (let reconciliation = 0; reconciliation < 3; reconciliation++) {
      guard();
      stage = "integration";
      const base = await fetchTarget();
      if (base) await git(workspace, ["checkout", "--detach", "-f", base]);
      else
        await git(workspace, [
          "checkout",
          "--detach",
          "-f",
          attempt.commits[0]!,
        ]);
      await git(workspace, ["clean", "-fdx"]);
      if (attempt.selection) {
        if (!base)
          throw new Error(
            "integration: artifact selection requires an existing target branch",
          );
        const ancestor = await value(workspace, [
          "merge-base",
          base,
          attempt.commits[0]!,
        ]);
        const patch = join(workspace, ".git", "selection.patch");
        await git(workspace, [
          "diff",
          "--binary",
          "--full-index",
          `--output=${patch}`,
          ancestor,
          attempt.commits[0]!,
          "--",
          ...attempt.selection.paths,
        ]);
        await git(workspace, [
          "apply",
          "--3way",
          "--index",
          "--allow-empty",
          patch,
        ]);
        await git(workspace, [
          "commit",
          "--allow-empty",
          "-m",
          `Integrate declared artifacts for ${attempt.id}`,
        ]);
      } else {
        for (const commit of attempt.commits)
          await git(workspace, ["merge", "--no-edit", "--no-ff", commit]);
      }
      const commit = await value(workspace, ["rev-parse", "HEAD"]),
        tree = await value(workspace, ["rev-parse", "HEAD^{tree}"]);
      append({ kind: "candidate", commit, tree, base });
      stage = "build";
      const started_ts = new Date().toISOString();
      const build = await run(
        workspace,
        "/bin/sh",
        ["-c", attempt.config.build_command],
        controller.signal,
        timeout,
      );
      const clean =
        (await value(workspace, [
          "status",
          "--porcelain",
          "--untracked-files=no",
        ])) === "" &&
        (await value(workspace, ["rev-parse", "HEAD"])) === commit &&
        (await value(workspace, ["write-tree"])) === tree;
      append({
        kind: "build",
        commit,
        tree,
        command: attempt.config.build_command,
        exit_code: build.code,
        clean,
        output: build.output,
        output_truncated: build.truncated,
        started_ts,
        finished_ts: new Date().toISOString(),
      });
      if (build.code !== 0 || !clean)
        throw new Error(
          `integration: build ${build.code === 0 ? "modified tracked inputs or HEAD" : "failed"}: ${build.output}`,
        );
      guard();
      stage = "publication";
      append({
        kind: "publication_intent",
        commit,
        tree,
        remote_url: attempt.config.remote_url,
        branch: attempt.config.branch,
      });
      // No force/lease override: the remote rejects a candidate whose base lost a race.
      await transport();
      const pushed = await git(
        workspace,
        [
          "push",
          "--porcelain",
          "--",
          attempt.config.remote_url,
          `${commit}:${ref}`,
        ],
        true,
      );
      const observed = await fetchTarget();
      if (await observe(commit, tree, observed)) return attempt;
      if (observed === base)
        throw new Error(`integration: publication failed: ${pushed.output}`);
      append({
        kind: "diagnostic",
        stage: "publication",
        message: `Target moved; rebuilding a new candidate. ${pushed.output}`,
      });
    }
    throw new Error(
      "integration: target contention persisted after three candidates; retry explicitly",
    );
  } catch (error) {
    // Keep a pending intent on ambiguous publication/recovery so a later runner
    // can recover the matching clean build instead of creating a second merge.
    try {
      append({
        kind:
          stage === "publication" || stage === "recovery"
            ? "diagnostic"
            : "failure",
        stage,
        message: String(leaseError ?? error),
      });
    } catch {
      /* stale runners cannot write */
    }
    return ledger.get(id);
  } finally {
    clearInterval(timer);
    options.signal?.removeEventListener("abort", abort);
    try {
      ledger.release(id, token);
    } catch {
      /* expired or superseded */
    }
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  }
}
