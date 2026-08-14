import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Drives the CLI as a subprocess against dist/index.js, the same harness
// pattern tests/cli-card.test.mjs uses — this suite exists to keep the
// `squad review` command family in parity with the squad_review_* MCP tools.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(repoRoot, "dist", "index.js");

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [entry, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function freshDir() {
  return mkdtempSync(join(tmpdir(), "squad-cli-review-"));
}

test("squad review open requires --to and a body", () => {
  const dir = freshDir();
  try {
    const noTarget = runCli(["review", "open", "have a look"], { SQUAD_DIR: dir });
    assert.notEqual(noTarget.status, 0);
    assert.match(noTarget.stderr, /usage: squad review open --to <persona>/);

    const noBody = runCli(["review", "open", "--to", "codex"], { SQUAD_DIR: dir });
    assert.notEqual(noBody.status, 0);
    assert.match(noBody.stderr, /usage: squad review open --to <persona>/);

    const badPriority = runCli(["review", "open", "--to", "codex", "--priority", "asap", "x"], {
      SQUAD_DIR: dir,
    });
    assert.notEqual(badPriority.status, 0);
    assert.match(badPriority.stderr, /--priority low\|normal\|high\|urgent/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("open -> list -> claim -> resolve round trip, with permissions enforced", () => {
  const dir = freshDir();
  try {
    const opened = runCli(
      [
        "review",
        "open",
        "--to",
        "codex",
        "--priority",
        "high",
        "--refs",
        "src/core.ts,abc1234",
        "does the lease renewal race?",
      ],
      { SQUAD_DIR: dir, SQUAD_PERSONA: "claude" },
    );
    assert.equal(opened.status, 0, opened.stdout + opened.stderr);
    assert.match(opened.stdout, /^opened review #1 for codex \[high\]: does the lease renewal race\?$/m);

    const listed = runCli(["review", "list"], { SQUAD_DIR: dir, SQUAD_PERSONA: "codex" });
    assert.equal(listed.status, 0, listed.stdout + listed.stderr);
    assert.match(listed.stdout, /\[pending\] #1 claude -> codex \[high\] does the lease renewal race\?/);

    // Only the target may claim.
    const wrongClaimant = runCli(["review", "claim", "1"], {
      SQUAD_DIR: dir,
      SQUAD_PERSONA: "human",
    });
    assert.notEqual(wrongClaimant.status, 0);
    assert.match(wrongClaimant.stderr, /only the target may claim it/);

    const claimed = runCli(["review", "claim", "1"], { SQUAD_DIR: dir, SQUAD_PERSONA: "codex" });
    assert.equal(claimed.status, 0, claimed.stdout + claimed.stderr);
    assert.match(claimed.stdout, /claimed review #1 \(codex\)/);

    const shown = runCli(["review", "show", "1"], { SQUAD_DIR: dir, SQUAD_PERSONA: "claude" });
    assert.equal(shown.status, 0, shown.stdout + shown.stderr);
    assert.match(shown.stdout, /#1 \[claimed\] claude -> codex \[high\]/);
    assert.match(shown.stdout, /refs: src\/core\.ts, abc1234/);
    assert.match(shown.stdout, /claimed by codex at /);

    // Only the claimant may resolve.
    const wrongResolver = runCli(["review", "resolve", "1"], {
      SQUAD_DIR: dir,
      SQUAD_PERSONA: "claude",
    });
    assert.notEqual(wrongResolver.status, 0);
    assert.match(wrongResolver.stderr, /only the claimant may resolve it/);

    const resolved = runCli(["review", "resolve", "1", "no race, the lease is renewed first"], {
      SQUAD_DIR: dir,
      SQUAD_PERSONA: "codex",
    });
    assert.equal(resolved.status, 0, resolved.stdout + resolved.stderr);
    assert.match(resolved.stdout, /resolved review #1: no race, the lease is renewed first/);

    // Resolved requests drop out of the default listing but stay queryable.
    const openOnly = runCli(["review", "list"], { SQUAD_DIR: dir, SQUAD_PERSONA: "codex" });
    assert.match(openOnly.stdout, /no open review requests/);
    const all = runCli(["review", "list", "--all"], { SQUAD_DIR: dir, SQUAD_PERSONA: "codex" });
    assert.match(all.stdout, /\[resolved\] #1 claude -> codex/);

    // Every transition was announced in chat.
    const chat = runCli(["read", "-n", "10"], { SQUAD_DIR: dir, SQUAD_PERSONA: "human" });
    assert.match(chat.stdout, /claude requested review #1 from codex \[high\]/);
    assert.match(chat.stdout, /codex claimed review #1/);
    assert.match(chat.stdout, /codex resolved review #1: no race/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("squad review cancel is open to the requester and the target", () => {
  const dir = freshDir();
  try {
    runCli(["review", "open", "--to", "codex", "withdraw me"], {
      SQUAD_DIR: dir,
      SQUAD_PERSONA: "claude",
    });
    const outsider = runCli(["review", "cancel", "1"], { SQUAD_DIR: dir, SQUAD_PERSONA: "human" });
    assert.notEqual(outsider.status, 0);
    assert.match(outsider.stderr, /only the requester \(claude\) or the target \(codex\)/);

    const cancelled = runCli(["review", "cancel", "1", "handled it myself"], {
      SQUAD_DIR: dir,
      SQUAD_PERSONA: "claude",
    });
    assert.equal(cancelled.status, 0, cancelled.stdout + cancelled.stderr);
    assert.match(cancelled.stdout, /cancelled review #1: handled it myself/);

    // Terminal: no further transition is accepted.
    const late = runCli(["review", "claim", "1"], { SQUAD_DIR: dir, SQUAD_PERSONA: "codex" });
    assert.notEqual(late.status, 0);
    assert.match(late.stderr, /illegal review request transition cancelled -> claimed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an expired request is hidden by default and cannot be claimed", () => {
  const dir = freshDir();
  try {
    const opened = runCli(["review", "open", "--to", "codex", "--expires-in", "0", "already stale"], {
      SQUAD_DIR: dir,
      SQUAD_PERSONA: "claude",
    });
    assert.equal(opened.status, 0, opened.stdout + opened.stderr);

    const listed = runCli(["review", "list"], { SQUAD_DIR: dir, SQUAD_PERSONA: "codex" });
    assert.match(listed.stdout, /no open review requests/);

    const all = runCli(["review", "list", "--all"], { SQUAD_DIR: dir, SQUAD_PERSONA: "codex" });
    assert.match(all.stdout, /\[pending\] #1 claude -> codex \[normal\] \(expired\) already stale/);

    const late = runCli(["review", "claim", "1"], { SQUAD_DIR: dir, SQUAD_PERSONA: "codex" });
    assert.notEqual(late.status, 0);
    assert.match(late.stderr, /expired at /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("squad review list rejects a bad --status instead of silently listing nothing", () => {
  const dir = freshDir();
  try {
    const opened = runCli(["review", "open", "--to", "codex", "look at this"], {
      SQUAD_DIR: dir,
      SQUAD_PERSONA: "claude",
    });
    assert.equal(opened.status, 0, opened.stdout + opened.stderr);

    // A typo must error, not read as "nothing to do".
    const typo = runCli(["review", "list", "--status", "pendign"], {
      SQUAD_DIR: dir,
      SQUAD_PERSONA: "codex",
    });
    assert.notEqual(typo.status, 0);
    assert.match(typo.stderr, /invalid status "pendign"/);
    assert.match(typo.stderr, /pending, claimed, resolved, cancelled/);

    // A missing flag value is an error too, not an empty-string filter.
    const missing = runCli(["review", "list", "--to"], { SQUAD_DIR: dir, SQUAD_PERSONA: "codex" });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /--to needs a value/);

    // The valid spelling still works.
    const ok = runCli(["review", "list", "--status", "pending"], {
      SQUAD_DIR: dir,
      SQUAD_PERSONA: "codex",
    });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /\[pending\] #1 claude -> codex/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("squad help documents the review command family", () => {
  const res = runCli(["help"]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /squad review open --to <persona>/);
  assert.match(res.stdout, /squad review claim <id>/);
});
