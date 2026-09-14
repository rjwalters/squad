import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchesBlob, run, type BankOptions } from "./integration-executor.js";
import type { IntegrationAttempt } from "./integration-ledger.js";

/** Rebuild an archived, published commit; no source checkout or publication. */
export async function rebuildNode(
  attempt: IntegrationAttempt,
  commit: string,
  tree: string,
  options: BankOptions,
) {
  const workspace = mkdtempSync(join(tmpdir(), "squad-review-"));
  const signal = options.signal ?? new AbortController().signal;
  const started_ts = new Date().toISOString();
  let result = {
    exit_code: null as number | null,
    output: "",
    output_truncated: false,
    clean: false,
  };
  const git = async (args: string[]) => {
    const r = await run(
      workspace,
      "git",
      ["--literal-pathspecs", "-c", "core.hooksPath=/dev/null", ...args],
      signal,
      60_000,
      16_777_216,
    );
    if (r.code !== 0 || r.truncated)
      throw new Error(`review git ${args[0]}: ${r.output}`);
    return r.output.trimEnd();
  };
  try {
    const format = commit.length === 64 ? "sha256" : "sha1";
    await git(["init", `--object-format=${format}`, "-q", "."]);
    await git(["remote", "add", "squad-review", attempt.config.remote_url]);
    if (
      (await git(["remote", "get-url", "--all", "squad-review"])) !==
      attempt.config.remote_url
    )
      throw new Error("review: effective transport differs from pinned remote");
    await git([
      "fetch",
      "--no-tags",
      "--",
      attempt.config.remote_url,
      `refs/heads/${attempt.config.branch}`,
    ]);
    await git(["merge-base", "--is-ancestor", commit, "FETCH_HEAD"]);
    if ((await git(["rev-parse", `${commit}^{tree}`])) !== tree)
      throw new Error("review tree mismatch");
    await git(["checkout", "--detach", "-f", commit]);
    const entries = (await git(["ls-tree", "-rz", "--full-tree", commit]))
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const m = /^(\d+) blob ([0-9a-f]+)\t([\s\S]*)$/.exec(entry);
        if (!m) throw new Error("review: unsupported tracked entry");
        return { mode: m[1]!, oid: m[2]!, path: m[3]! };
      });
    const physical = async () => {
      for (const e of entries)
        if (
          !(await matchesBlob(workspace, e.path, e.mode, e.oid, format, signal))
        )
          return false;
      return true;
    };
    if (!(await physical()))
      throw new Error("review: checkout differs from committed bytes");
    const build = await run(
      workspace,
      "/bin/sh",
      ["-c", attempt.config.build_command],
      signal,
      options.build_timeout_ms ?? 1_800_000,
    );
    result = {
      exit_code: build.code,
      output: build.output,
      output_truncated: build.truncated,
      clean: false,
    };
    result.clean =
      (await physical()) &&
      (await git(["rev-parse", "HEAD"])) === commit &&
      (await git(["write-tree"])) === tree &&
      (await git(["status", "--porcelain", "--untracked-files=no"])) === "";
  } catch (error) {
    result.output += `\n${String(error)}`;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
  return {
    ...result,
    command: attempt.config.build_command,
    commit,
    tree,
    started_ts,
    finished_ts: new Date().toISOString(),
  };
}
