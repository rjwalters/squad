import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { openDb } from "../dist/db.js";
import { Squad } from "../dist/core.js";
import { IntegrationLedger } from "../dist/integration-ledger.js";
const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
function fixture(t, command = "test -f artifact") {
  const root = mkdtempSync(join(tmpdir(), "squad-bank-test-")),
    repo = join(root, "repo"),
    remote = join(root, "remote.git");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--bare", "-q", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.name", "test");
  git(repo, "config", "user.email", "test@example.org");
  writeFileSync(join(repo, "base"), "base");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "origin", "main");
  writeFileSync(join(repo, "artifact"), "proved");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "artifact");
  const commit = git(repo, "rev-parse", "HEAD");
  process.env.SQUAD_DIR = join(root, "room");
  const db = openDb();
  t.after(() => db.close());
  const squad = new Squad(db, "alice");
  squad.integrationSet(
    {
      repository: repo,
      remote: "origin",
      branch: "main",
      build_command: command,
      steward: "alice",
    },
    0,
  );
  const submit = (extra = {}) =>
    squad.integrationSubmit({
      request_key: "work",
      config_revision: 1,
      commits: [commit],
      ...extra,
    });
  return { root, repo, remote, commit, db, squad, submit };
}
test("bank publishes exact built revision, preserves source dirt and converges retry", async (t) => {
  const f = fixture(t, "git rev-parse HEAD; test -f artifact");
  writeFileSync(join(f.repo, "base"), "dirty source");
  writeFileSync(join(f.repo, "scratch"), "untracked");
  const before = git(f.repo, "status", "--porcelain");
  const a = f.submit(),
    result = await f.squad.bank(a.id);
  assert.equal(result.status, "verified", JSON.stringify(result.evidence));
  const built = result.evidence.find((e) => e.event.kind === "build").event;
  assert.equal(built.output.trim(), built.commit);
  assert.equal(git(f.remote, "rev-parse", "main"), built.commit);
  assert.equal(git(f.repo, "status", "--porcelain"), before);
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.commit);
  assert.equal((await f.squad.bank(a.id)).revision, result.revision);
  assert.equal(
    f.squad.checkSummary().integration.local_work_visibility,
    "unobserved",
  );
  assert.deepEqual(f.squad.checkSummary().integration.known_submissions, {
    pending: 0,
    failed: 0,
    verified: 1,
  });
});
test("invalid committed selections and failed builds remain unbanked", async (t) => {
  const f = fixture(t, "echo bad; exit 7");
  const invalid = f.submit({
    request_key: "missing",
    commits: ["a".repeat(40)],
  });
  assert.equal((await f.squad.bank(invalid.id)).status, "failed");
  const result = await f.squad.bank(f.submit().id);
  assert.equal(result.status, "failed");
  assert.equal(
    result.evidence.find((e) => e.event.kind === "build").event.exit_code,
    7,
  );
  assert.notEqual(git(f.remote, "rev-parse", "main"), f.commit);
});
test("explicit artifact declaration rejects label-only, path traversal and conflicting retry selectors", (t) => {
  const f = fixture(t);
  assert.throws(
    () => f.submit({ selection: { paths: [], theorem: "unknown" } }),
    /explicit paths/,
  );
  assert.throws(
    () => f.submit({ selection: { paths: ["../artifact"] } }),
    /relative/,
  );
  f.submit({ selection: { paths: ["artifact"], theorem: "lemma" } });
  assert.throws(
    () => f.submit({ selection: { paths: ["base"], theorem: "lemma" } }),
    /different submission/,
  );
});
test("active runner exclusion and cancellation preserve durable failures", async (t) => {
  const f = fixture(t, "sleep 30");
  const a = f.submit();
  const abort = new AbortController();
  const running = f.squad.bank(a.id, { signal: abort.signal });
  await assert.rejects(() => f.squad.bank(a.id), /active runner/);
  setTimeout(() => abort.abort(), 150);
  const result = await running;
  assert.equal(result.status, "failed");
  assert.equal(result.evidence.at(-1).event.kind, "failure");
});
test("interrupted post-push receipt is recovered from remote with durable exact build", async (t) => {
  const f = fixture(t);
  const a = f.submit();
  const ledger = new IntegrationLedger(f.db, "alice");
  const original = ledger.verify.bind(ledger);
  let interrupt = true;
  ledger.verify = (...args) => {
    if (interrupt) throw new Error("receipt interrupted");
    return original(...args);
  };
  const { executeIntegration } = await import(
    "../dist/integration-executor.js"
  );
  const pending = await executeIntegration(
    ledger,
    a.id,
    () => f.squad.integrationGet(),
    () => {},
  );
  assert.equal(pending.status, "pending");
  const published = git(f.remote, "rev-parse", "main");
  f.squad.integrationUnset(1);
  interrupt = false;
  const result = await executeIntegration(
    ledger,
    a.id,
    () => f.squad.integrationGet(),
    () => {},
  );
  assert.equal(result.status, "verified", JSON.stringify(result.evidence));
  assert.equal(git(f.remote, "rev-parse", "main"), published);
  assert.equal(
    result.evidence.filter((e) => e.event.kind === "candidate").length,
    1,
  );
});
test("CLI bank executes real integration and rejects unknown selector flags", async (t) => {
  const f = fixture(t),
    attempt = f.submit();
  const invoke = async (args) =>
    await new Promise((resolve) => {
      const p = spawn(process.execPath, ["dist/index.js", ...args], {
        env: { ...process.env, SQUAD_DIR: join(f.root, "room") },
      });
      let stdout = "",
        stderr = "";
      p.stdout.on("data", (v) => (stdout += v));
      p.stderr.on("data", (v) => (stderr += v));
      p.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  const bad = await invoke(["bank", attempt.id, "--theorem", "unknown"]);
  assert.equal(bad.code, 1);
  const result = await invoke(["bank", attempt.id]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "verified");
});

test("missing selected artifacts and wrong configured source never bank", async (t) => {
  const f = fixture(t);
  const missing = f.submit({ selection: { paths: ["missing"] } });
  assert.equal((await f.squad.bank(missing.id)).status, "failed");
  const different = join(f.root, "different");
  execFileSync("git", ["init", "-q", different]);
  git(different, "remote", "add", "origin", f.remote);
  f.squad.integrationSet(
    { ...f.squad.integrationGet().config, repository: different },
    1,
  );
  const wrong = f.submit({
    request_key: "wrong-repository",
    config_revision: 2,
  });
  assert.equal((await f.squad.bank(wrong.id)).status, "failed");
});

test("remote rejection retains diagnostics and retry builds fresh evidence", async (t) => {
  const f = fixture(t);
  const hook = join(f.remote, "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\necho forbidden >&2\nexit 1\n", {
    mode: 0o755,
  });
  const initial = git(f.remote, "rev-parse", "main");
  const attempt = f.submit();
  const rejected = await f.squad.bank(attempt.id);
  assert.notEqual(rejected.status, "verified");
  assert.match(rejected.evidence.at(-1).event.message, /forbidden/);
  assert.equal(git(f.remote, "rev-parse", "main"), initial);
  rmSync(hook);
  const retried = await f.squad.bank(attempt.id);
  assert.equal(retried.status, "verified");
  assert.equal(
    retried.evidence.filter((e) => e.event.kind === "build").length,
    2,
  );
});

test("timed out build cannot verify and reports bounded failure", async (t) => {
  const f = fixture(t, "sleep 30");
  const result = await f.squad.bank(f.submit().id, { build_timeout_ms: 1000 });
  assert.equal(result.status, "failed");
  const built = result.evidence.find((e) => e.event.kind === "build").event;
  assert.equal(built.exit_code, null);
  assert.match(built.output, /timed out/);
});

test("renewal keeps presence and runner ownership alive during asynchronous builds", async (t) => {
  const f = fixture(t, "sleep 11; test -f artifact");
  const attempt = f.submit();
  const running = f.squad.bank(attempt.id);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const initial = f.db
    .prepare("SELECT expires_ms FROM integration_runners WHERE attempt_id = ?")
    .get(attempt.id).expires_ms;
  await new Promise((resolve) => setTimeout(resolve, 10000));
  const renewed = f.db
    .prepare("SELECT expires_ms FROM integration_runners WHERE attempt_id = ?")
    .get(attempt.id).expires_ms;
  assert.ok(renewed > initial + 9000);
  const result = await running;
  assert.equal(result.status, "verified");
});

test("a lost push response is reconciled against the remote without double integration", async (t) => {
  const f = fixture(t);
  const bin = join(f.root, "bin");
  mkdirSync(bin);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const script = `#!${process.execPath}
const {spawnSync} = require('node:child_process');
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(realGit)}, args, {stdio:'inherit'});
if (args.includes('push') && result.status === 0) { console.error('simulated lost transport response'); process.exit(1); }
process.exit(result.status ?? 1);
`;
  writeFileSync(join(bin, "git"), script, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  t.after(() => {
    process.env.PATH = previousPath;
  });
  const result = await f.squad.bank(f.submit().id);
  assert.equal(result.status, "verified", JSON.stringify(result));
  assert.equal(
    result.evidence.filter((e) => e.event.kind === "candidate").length,
    1,
  );
  assert.equal(
    result.evidence.at(-1).event.commit,
    git(f.remote, "rev-parse", "main"),
  );
});
