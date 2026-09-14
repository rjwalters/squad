import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openDb } from "../dist/db.js";
import { Squad } from "../dist/core.js";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "squad-outline-adversarial-"));
  const repo = join(root, "source"),
    remote = join(root, "remote.git");
  const git = (cwd, ...args) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  execFileSync("git", ["init", "--bare", "-q", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.name", "Fixture");
  git(repo, "config", "user.email", "fixture@example.org");
  git(repo, "remote", "add", "origin", remote);
  writeFileSync(join(repo, "artifact.txt"), "baseline\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "baseline");
  git(repo, "push", "-q", "origin", "main");
  git(repo, "checkout", "-qb", "research");
  writeFileSync(join(repo, "artifact.txt"), "new research\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "research artifact");
  const commit = git(repo, "rev-parse", "HEAD");
  const previousRoom = process.env.SQUAD_DIR;
  process.env.SQUAD_DIR = join(root, "room");
  const db = openDb(),
    squad = new Squad(db, "author"),
    peer = new Squad(db, "peer");
  t.after(() => {
    db.close();
    if (previousRoom === undefined) delete process.env.SQUAD_DIR;
    else process.env.SQUAD_DIR = previousRoom;
    rmSync(root, { recursive: true, force: true });
  });
  squad.integrationSet(
    {
      repository: repo,
      remote: "origin",
      branch: "main",
      build_command: "test -s artifact.txt",
      steward: "peer",
    },
    0,
  );
  const create = (title = "Research node") =>
    squad.nodeCreate({
      title,
      question: "What does this artifact establish?",
      artifacts: [{ path: "artifact.txt", commit }],
    });
  return { root, repo, remote, commit, db, squad, peer, create, git };
}

test("outline rendering is deterministic across personas and does not mutate the room", (t) => {
  const { db, squad, peer, create } = fixture(t);
  const node = create();
  squad.cardUpdate(node.id, {
    question: "Unbanked exploratory question with | pipes and [brackets]?",
  });
  const before = db.prepare("SELECT total_changes() AS n").get().n;
  db.exec("PRAGMA query_only=ON");
  let author, reviewer;
  try {
    author = squad.outlineRender();
    reviewer = peer.outlineRender();
  } finally {
    db.exec("PRAGMA query_only=OFF");
  }
  assert.equal(author.version, reviewer.version);
  assert.equal(author.content, reviewer.content);
  assert.equal(db.prepare("SELECT total_changes() AS n").get().n, before);
  assert.match(author.version, /^[a-f0-9]{64}$/);
  assert.match(author.content, /unbanked|pending|not banked/i);
  squad.send(
    "Presence and unrelated chat should not alter the authoritative research map",
  );
  assert.equal(peer.outlineRender().version, author.version);
  squad.cardUpdate(node.id, { question: "A changed scientific question?" });
  assert.notEqual(peer.outlineRender().version, author.version);
});

test("outline citations identify verified revisions while edited content is visibly unbanked", async (t) => {
  const { squad, peer, create } = fixture(t);
  const node = create();
  const pending = squad.nodeSubmit(
    node.id,
    node.revision,
    "outline-node-bank",
    1,
  );
  const bank = await squad.bank(pending.id);
  assert.equal(bank.status, "verified");
  const verified = bank.evidence
    .map((e) => e.event)
    .findLast((e) => e.kind === "verified");
  const first = peer.outlineRender();
  assert.ok(
    first.content.includes(verified.commit),
    "exact integrated commit cited",
  );
  squad.cardUpdate(node.id, {
    question: "Changed claim beyond its archived verified artifact?",
  });
  const next = peer.outlineRender();
  assert.notEqual(next.version, first.version);
  assert.match(next.content, /unbanked|pending|not banked/i);
});

test("publishing the outline banks exact output without making its own snapshot stale", async (t) => {
  const { repo, remote, git, squad, peer, create } = fixture(t);
  const node = create();
  const before = peer.outlineRender(),
    sourceHead = git(repo, "rev-parse", "HEAD");
  const publication = await squad.outlinePublish({ request_key: "first-map" });
  assert.equal(publication.attempt.status, "verified");
  assert.equal(publication.version, before.version);
  assert.equal(publication.fresh, true);
  assert.equal(
    peer.outlineRender().version,
    before.version,
    "own publication must not invalidate source hash",
  );
  assert.equal(peer.outlineStatus().fresh, true);
  assert.equal(
    git(remote, "show", "main:SQUAD_OUTLINE.md"),
    before.content.trim(),
  );
  assert.equal(git(repo, "rev-parse", "HEAD"), sourceHead);
  assert.equal(git(repo, "status", "--porcelain"), "");
  squad.cardUpdate(node.id, { question: "Updated research state?" });
  assert.equal(peer.outlineStatus().fresh, false);
  const retry = await peer.outlinePublish({ request_key: "first-map" });
  assert.equal(retry.attempt_id, publication.attempt_id);
  assert.equal(retry.fresh, false);
  const next = await peer.outlinePublish({ request_key: "second-map" });
  assert.equal(next.attempt.status, "verified");
  assert.equal(next.fresh, true);
  assert.equal(peer.outlineStatus().fresh, true);
});

test("publication refuses an existing separately edited prose outline", async (t) => {
  const { repo, remote, git, squad, create } = fixture(t);
  create();
  git(repo, "fetch", "-q", "origin", "main");
  git(repo, "checkout", "-q", "-B", "prose", "FETCH_HEAD");
  writeFileSync(
    join(repo, "SQUAD_OUTLINE.md"),
    "# Human-authored outline\nKeep this work.\n",
  );
  git(repo, "add", "SQUAD_OUTLINE.md");
  git(repo, "commit", "-qm", "separate prose");
  git(repo, "push", "-q", "origin", "HEAD:main");
  const before = git(remote, "rev-parse", "main");
  await assert.rejects(
    () => squad.outlinePublish({ request_key: "refuse-prose" }),
    /owned|prose|previously|refus/i,
  );
  assert.equal(git(remote, "rev-parse", "main"), before);
  assert.match(git(remote, "show", "main:SQUAD_OUTLINE.md"), /Human-authored/);
});

test("a concurrent prose edit is preserved when the target advances during outline build", async (t) => {
  const { root, repo, remote, git, squad, create } = fixture(t);
  create();
  const script = join(root, "wait.mjs");
  writeFileSync(
    script,
    `import {writeFileSync,existsSync} from "node:fs"; import {setTimeout as delay} from "node:timers/promises"; const root=${JSON.stringify(root)}; writeFileSync(root+"/started","ready"); while(!existsSync(root+"/release")) await delay(10);`,
  );
  const state = squad.integrationGet();
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  squad.integrationSet(
    { ...state.config, build_command: `node ${quote(script)}` },
    state.revision,
  );
  const pending = squad
    .outlinePublish({ request_key: "concurrent-map" })
    .catch((error) => ({ error }));
  try {
    const until = Date.now() + 10000;
    while (!existsSync(join(root, "started"))) {
      if (Date.now() > until) throw new Error("outline build did not start");
      await delay(10);
    }
    git(repo, "fetch", "-q", "origin", "main");
    git(repo, "checkout", "-q", "-B", "concurrent-prose", "FETCH_HEAD");
    writeFileSync(
      join(repo, "SQUAD_OUTLINE.md"),
      "# Concurrent human outline\nDo not overwrite.\n",
    );
    git(repo, "add", "SQUAD_OUTLINE.md");
    git(repo, "commit", "-qm", "concurrent prose");
    git(repo, "push", "-q", "origin", "HEAD:main");
  } finally {
    writeFileSync(join(root, "release"), "ready");
  }
  const result = await pending;
  assert.notEqual(result.attempt?.status, "verified");
  assert.match(
    git(remote, "show", "main:SQUAD_OUTLINE.md"),
    /Concurrent human outline/,
  );
});
