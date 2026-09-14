import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { PERSONA_PATTERN } from "./identity.js";

export interface IntegrationInput {
  repository: string;
  remote: string;
  branch: string;
  build_command: string;
  steward: string;
}
export interface IntegrationConfig extends IntegrationInput {
  git_common_dir: string;
  remote_url: string;
}
export interface IntegrationState {
  revision: number;
  config: IntegrationConfig | null;
  updated_by: string | null;
  updated_ts: string | null;
}

/** Read-only Git, independent of the caller's cwd and ambient repository overrides. */
function git(repository: string, ...args: string[]): string {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  try {
    return execFileSync("git", ["-C", repository, ...args], {
      env: { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error(
      `integration: cannot validate ${args[0]} in configured repository ${repository}`,
    );
  }
}

/** Snapshot the explicit local repository and remote identity; never execute its build. */
export function resolveIntegration(input: IntegrationInput): IntegrationConfig {
  for (const key of [
    "repository",
    "remote",
    "branch",
    "build_command",
    "steward",
  ] as const) {
    if (
      typeof input[key] !== "string" ||
      !input[key].trim() ||
      /[\0\r\n]/.test(input[key])
    ) {
      throw new Error(`integration: invalid ${key}`);
    }
  }
  if (!isAbsolute(input.repository))
    throw new Error(
      "integration: repository must be an explicit absolute path",
    );
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(input.remote))
    throw new Error("integration: invalid remote name");
  if (!PERSONA_PATTERN.test(input.steward))
    throw new Error("integration: invalid steward identity");
  const repository = realpathSync(input.repository);
  if (
    realpathSync(git(repository, "rev-parse", "--show-toplevel")) !== repository
  ) {
    throw new Error(
      "integration: repository must name the repository root, not a subdirectory",
    );
  }
  // Full ref validation avoids checkout shorthand such as @{-1} and option injection.
  git(repository, "check-ref-format", `refs/heads/${input.branch}`);
  if (input.branch.startsWith("-") || input.branch === "HEAD")
    throw new Error("integration: invalid branch");
  const git_common_dir = realpathSync(
    git(repository, "rev-parse", "--path-format=absolute", "--git-common-dir"),
  );
  const urls = git(
    repository,
    "remote",
    "get-url",
    "--all",
    input.remote,
  ).split("\n");
  const pushUrls = git(
    repository,
    "remote",
    "get-url",
    "--push",
    "--all",
    input.remote,
  ).split("\n");
  if (urls.length !== 1 || pushUrls.length !== 1 || urls[0] !== pushUrls[0]) {
    throw new Error(
      "integration: remote must have one identical fetch and push URL",
    );
  }
  const remote_url = urls[0]!;
  if (!remote_url || /[\0\r\n]/.test(remote_url))
    throw new Error("integration: invalid remote URL");
  // Config is shared and announced. Credentials belong in Git's credential helper,
  // never in a durable room record or chat transcript.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote_url)) {
    const url = new URL(remote_url);
    if (
      !["https:", "http:", "ssh:", "git:", "file:"].includes(url.protocol) ||
      url.password ||
      ((url.protocol === "http:" || url.protocol === "https:") &&
        url.username) ||
      url.search ||
      url.hash
    ) {
      throw new Error(
        "integration: use a credential-free remote URL with a supported Git transport",
      );
    }
  } else if (
    !isAbsolute(remote_url) &&
    !/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+:.+/.test(remote_url)
  ) {
    throw new Error(
      "integration: remote must be an absolute path, URL, or user@host:path, not a relative path or remote helper",
    );
  }
  return {
    repository,
    remote: input.remote,
    branch: input.branch,
    build_command: input.build_command,
    steward: input.steward,
    git_common_dir,
    remote_url,
  };
}

export function validateIntegration(config: IntegrationConfig): void {
  const current = resolveIntegration(config);
  if (
    current.repository !== config.repository ||
    current.git_common_dir !== config.git_common_dir
  ) {
    throw new Error(
      "integration: configured repository identity changed; explicitly configure the new target",
    );
  }
  if (current.remote_url !== config.remote_url) {
    throw new Error(
      "integration: configured remote URL changed; explicitly configure the new target",
    );
  }
}
