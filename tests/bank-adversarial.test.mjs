import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDb } from "../dist/db.js";
import { Squad } from "../dist/core.js";

const quote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
const nodeCommand = (code) => `${quote(process.execPath)} -e ${quote(code)}`;
const gitEnv = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  ),
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
};
function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: gitEnv,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "squad-bank-adversarial-"));
  const source = join(dir, "source"),
    remote = join(dir, "remote.git");
  execFileSync("git", ["init", "--bare", "-q", remote], { env: gitEnv });
  git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  execFileSync("git", ["init", "-b", "main", "-q", source], { env: gitEnv });
  git(source, "config", "user.name", "Fixture");
  git(source, "config", "user.email", "fixture@example.org");
  git(source, "remote", "add", "origin", remote);
  writeFileSync(join(source, "proof.txt"), "base\n");
  writeFileSync(join(source, "other.txt"), "base other\n");
  git(source, "add", ".");
  git(source, "commit", "-qm", "base");
  const base = git(source, "rev-parse", "HEAD");
  git(source, "push", "-q", "origin", "main");
  git(source, "checkout", "-qb", "contribution");
  writeFileSync(join(source, "proof.txt"), "contribution\n");
  writeFileSync(join(source, "other.txt"), "unrelated contribution\n");
  git(source, "add", ".");
  git(source, "commit", "-qm", "two changed artifacts");
  const commit = git(source, "rev-parse", "HEAD");
  const previousRoom = process.env.SQUAD_DIR;
  const room = join(dir, "room");
  process.env.SQUAD_DIR = room;
  const db = openDb(),
    squad = new Squad(db, "author");
  t.after(() => {
    db.close();
    if (previousRoom === undefined) delete process.env.SQUAD_DIR;
    else process.env.SQUAD_DIR = previousRoom;
    rmSync(dir, { recursive: true, force: true });
  });
  const configure = (command) =>
    squad.integrationSet(
      {
        repository: source,
        remote: "origin",
        branch: "main",
        build_command: command,
        steward: "steward",
      },
      squad.integrationGet().revision,
    );
  const submit = (selection) =>
    squad.integrationSubmit({
      request_key: "request",
      config_revision: squad.integrationGet().revision,
      commits: [commit],
      ...(selection ? { selection } : {}),
    });
  const sourceState = () => ({
    head: git(source, "rev-parse", "HEAD"),
    refs: git(source, "show-ref"),
    status: git(source, "status", "--porcelain=v1", "--untracked-files=all"),
    proof: readFileSync(join(source, "proof.txt"), "utf8"),
    other: readFileSync(join(source, "other.txt"), "utf8"),
    index: readFileSync(join(source, ".git", "index")).toString("base64"),
  });
  return {
    dir,
    source,
    remote,
    base,
    commit,
    room,
    db,
    squad,
    configure,
    submit,
    sourceState,
  };
}

const artifactBuild = nodeCommand(
  "require('node:assert/strict').equal(require('node:fs').readFileSync('proof.txt','utf8'),'contribution\\n')",
);

test("path banking excludes unrelated committed changes and preserves unrelated source dirt", async (t) => {
  const f = fixture(t);
  f.configure(artifactBuild);
  git(f.source, "checkout", "main");
  writeFileSync(join(f.source, "other.txt"), "unrelated dirty work\n");
  writeFileSync(join(f.source, "scratch.txt"), "untracked notes\n");
  const before = f.sourceState();
  const attempt = f.submit({ paths: ["proof.txt"], theorem: "declared-proof" });
  const result = await f.squad.bank(attempt.id);
  assert.equal(result.status, "verified", JSON.stringify(result.evidence));
  assert.equal(git(f.remote, "show", "main:proof.txt"), "contribution");
  assert.equal(git(f.remote, "show", "main:other.txt"), "base other");
  assert.deepEqual(f.sourceState(), before);
  assert.equal(
    readFileSync(join(f.source, "scratch.txt"), "utf8"),
    "untracked notes\n",
  );
});

test("a staged selected-path change cannot be banked as its older committed version", async (t) => {
  const f = fixture(t);
  f.configure(artifactBuild);
  const attempt = f.submit({ paths: ["proof.txt"] });
  writeFileSync(join(f.source, "proof.txt"), "uncommitted staged research\n");
  git(f.source, "add", "proof.txt");
  const before = f.sourceState();
  const result = await f.squad.bank(attempt.id);
  assert.equal(result.status, "failed");
  assert.equal(git(f.remote, "rev-parse", "main"), f.base);
  assert.deepEqual(f.sourceState(), before);
});

test("a successful build that stages changed tracked inputs is not verification", async (t) => {
  const f = fixture(t);
  f.configure(
    nodeCommand(
      "require('node:fs').writeFileSync('proof.txt','changed by build\\n');require('node:child_process').execFileSync('git',['add','proof.txt'])",
    ),
  );
  const attempt = f.submit();
  const before = f.sourceState();
  const result = await f.squad.bank(attempt.id);
  assert.equal(result.status, "failed");
  assert.equal(git(f.remote, "rev-parse", "main"), f.base);
  assert.deepEqual(f.sourceState(), before);
  assert.ok(
    result.evidence.some(
      (e) => e.event.kind === "build" && e.event.clean === false,
    ),
  );
});

test("disabling integration during the build prevents publication", async (t) => {
  const f = fixture(t);
  const cli = resolve("dist/index.js");
  f.configure(
    nodeCommand(
      `require('node:child_process').execFileSync(${JSON.stringify(process.execPath)},[${JSON.stringify(cli)},'integration','unset','--expected-revision','1'],{env:{...process.env,SQUAD_DIR:${JSON.stringify(f.room)},SQUAD_PERSONA:'operator'}})`,
    ),
  );
  const attempt = f.submit();
  const before = f.sourceState();
  const result = await f.squad.bank(attempt.id);
  assert.equal(result.status, "failed");
  assert.equal(f.squad.integrationGet().config, null);
  assert.equal(git(f.remote, "rev-parse", "main"), f.base);
  assert.deepEqual(f.sourceState(), before);
});

test("a target advance during the build requires a new candidate and fresh build", async (t) => {
  const f = fixture(t),
    racer = join(f.dir, "racer"),
    marker = join(f.dir, "race-once");
  execFileSync("git", ["clone", "-q", f.remote, racer], { env: gitEnv });
  git(racer, "config", "user.name", "Concurrent integrator");
  git(racer, "config", "user.email", "other@example.org");
  const code = `const fs=require('node:fs'),cp=require('node:child_process');if(!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},'once');fs.writeFileSync(${JSON.stringify(join(racer, "peer.txt"))},'peer contribution');for(const args of [['add','peer.txt'],['commit','-qm','peer'],['push','-q','origin','main']])cp.execFileSync('git',['-C',${JSON.stringify(racer)},...args]);}require('node:assert/strict').equal(fs.readFileSync('proof.txt','utf8'),'contribution\\n');`;
  f.configure(nodeCommand(code));
  const attempt = f.submit(),
    before = f.sourceState();
  const result = await f.squad.bank(attempt.id);
  assert.equal(result.status, "verified", JSON.stringify(result.evidence));
  assert.equal(git(f.remote, "show", "main:peer.txt"), "peer contribution");
  assert.equal(git(f.remote, "show", "main:proof.txt"), "contribution");
  const builds = result.evidence.filter(
    (e) => e.event.kind === "build" && e.event.exit_code === 0,
  );
  assert.ok(builds.length >= 2, "the reconciled candidate must be built again");
  assert.ok(new Set(builds.map((e) => e.event.commit)).size >= 2);
  assert.deepEqual(f.sourceState(), before);
});

test("a build cannot redirect publication by changing isolated Git URL rewrites", async (t) => {
  const f = fixture(t),
    alternate = join(f.dir, "alternate.git");
  execFileSync("git", ["clone", "--bare", "-q", f.remote, alternate], {
    env: gitEnv,
  });
  f.configure(
    nodeCommand(
      `require('node:child_process').execFileSync('git',${JSON.stringify(["config", `url.${alternate}.insteadOf`, f.remote])})`,
    ),
  );
  const attempt = f.submit(),
    before = f.sourceState();
  const result = await f.squad.bank(attempt.id);
  assert.notEqual(result.status, "verified");
  assert.equal(git(f.remote, "rev-parse", "main"), f.base);
  assert.equal(git(alternate, "rev-parse", "main"), f.base);
  assert.deepEqual(f.sourceState(), before);
});

test("divergent selected-path edits fail with source and remote state preserved", async (t) => {
  const f = fixture(t),
    racer = join(f.dir, "racer");
  execFileSync("git", ["clone", "-q", f.remote, racer], { env: gitEnv });
  git(racer, "config", "user.name", "Concurrent integrator");
  git(racer, "config", "user.email", "other@example.org");
  writeFileSync(join(racer, "proof.txt"), "different proof\n");
  git(racer, "add", "proof.txt");
  git(racer, "commit", "-qm", "conflicting proof");
  git(racer, "push", "-q", "origin", "main");
  const remoteBefore = git(f.remote, "rev-parse", "main");
  f.configure(artifactBuild);
  const attempt = f.submit({ paths: ["proof.txt"] }),
    before = f.sourceState();
  const result = await f.squad.bank(attempt.id);
  assert.equal(result.status, "failed");
  assert.equal(git(f.remote, "rev-parse", "main"), remoteBefore);
  assert.deepEqual(f.sourceState(), before);
});

for (const dirt of ["unstaged", "staged", "assume-unchanged", "skip-worktree"]) {
  test(`different configured HEAD rejects selected ${dirt} work and permits a clean retry`, async (t) => {
    const f = fixture(t);
    git(f.source, "checkout", "main");
    f.configure(artifactBuild);
    if (["assume-unchanged", "skip-worktree"].includes(dirt))
      git(f.source, "update-index", `--${dirt}`, "proof.txt");
    writeFileSync(join(f.source, "proof.txt"), "contribution\n");
    if (dirt === "staged") git(f.source, "add", "proof.txt");
    const before = f.sourceState();
    const attempt = f.submit({ paths: ["proof.txt"] });
    const failed = await f.squad.bank(attempt.id);
    assert.equal(failed.status, "failed");
    assert.deepEqual(f.sourceState(), before);
    assert.equal(git(f.remote, "rev-parse", "main"), f.base);
    if (["assume-unchanged", "skip-worktree"].includes(dirt))
      git(f.source, "update-index", `--no-${dirt}`, "proof.txt");
    git(f.source, "restore", "--source=HEAD", "--staged", "--worktree", "proof.txt");
    const result = await f.squad.bank(attempt.id);
    assert.equal(result.status, "verified", JSON.stringify(result.evidence));
    assert.ok(result.evidence.some((e) => e.event.kind === "failure"));
    assert.ok(result.evidence.some((e) => e.event.kind === "retry"));
    assert.equal(git(f.source, "rev-parse", "HEAD"), f.base);
  });
}
for (const dirt of ["untracked", "ignored", "staged", "directory"]) {
  test(`selected path absent at configured HEAD rejects ${dirt} local work`, async (t) => {
    const f = fixture(t);
    git(f.source, "checkout", "main");
    git(f.source, "rm", "proof.txt");
    git(f.source, "commit", "-qm", "configured checkout without proof");
    f.configure(artifactBuild);
    if (dirt === "directory") mkdirSync(join(f.source, "proof.txt"));
    else writeFileSync(join(f.source, "proof.txt"), "contribution\n");
    if (dirt === "ignored") writeFileSync(join(f.source, ".git", "info", "exclude"), "proof.txt\n");
    if (dirt === "staged") git(f.source, "add", "proof.txt");
    const index = readFileSync(join(f.source, ".git", "index"));
    const result = await f.squad.bank(f.submit({ paths: ["proof.txt"] }).id);
    assert.equal(result.status, "failed");
    assert.match(result.evidence.at(-1).event.message, /uncommitted work/);
    assert.deepEqual(readFileSync(join(f.source, ".git", "index")), index);
    assert.equal(git(f.remote, "rev-parse", "main"), f.base);
  });
}

test("selected Unicode and tab paths use raw index records", async (t) => {
  const f = fixture(t);
  const path = "preuve-é\t.txt";
  git(f.source, "mv", "proof.txt", path);
  git(f.source, "commit", "-qm", "rename selected artifact");
  const commit = git(f.source, "rev-parse", "HEAD");
  f.configure(nodeCommand(`require('node:assert/strict').equal(require('node:fs').readFileSync(${JSON.stringify(path)},'utf8'),'contribution\\n')`));
  const attempt = f.squad.integrationSubmit({
    request_key: "unicode-artifact",
    config_revision: 1,
    commits: [commit],
    selection: { paths: [path] },
  });
  const result = await f.squad.bank(attempt.id);
  assert.equal(result.status, "verified", JSON.stringify(result.evidence));
  assert.equal(git(f.remote, "show", `main:${path}`), "contribution");
});
