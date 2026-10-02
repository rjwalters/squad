import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMAND_USAGE, HELP, knownCommand } from "../dist/cli.js";

// Drives the CLI as a subprocess against dist/index.js (same harness pattern
// as tests/cli-presence.test.mjs) to cover issue #119: `squad <cmd> --help`
// used to be swallowed as content, so asking for help *did the command*.
// `squad send --help` posted a chat message whose body was "--help" as
// `human`, `squad claim --help` claimed a path named "--help",
// `squad export --help` wrote a file named "--help" into the cwd, and
// `squad clear --help` wiped the entire room.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(repoRoot, "dist", "index.js");

/**
 * Every top-level command documented in HELP that squad itself must answer
 * `--help` for. `relay` and `codex-reentry` own their own `--help` handling
 * (their parser/supervisor prints its own usage); `nuke` is deliberately
 * undocumented and out of scope for #119.
 */
const SELF_DOCUMENTING = new Set(["help", "relay", "codex-reentry"]);
const DOCUMENTED = [
  "send",
  "read",
  "tail",
  "goals",
  "claims",
  "claim",
  "release",
  "diverge",
  "review",
  "card",
  "who",
  "leave",
  "clear",
  "export",
  "import",
  "steward",
  "outline",
  "node",
  "bank",
  "integration",
  "doctor",
  "path",
];

function runCli(args, { cwd, env = {} } = {}) {
  const merged = { ...process.env, ...env };
  // The ambient environment must not decide whether a persona is pinned: the
  // implicit-`human` warning below is only about the *absence* of both.
  for (const key of ["SQUAD_PERSONA", "SQUAD_SESSION_ID"]) {
    if (!(key in env)) delete merged[key];
  }
  return spawnSync(process.execPath, [entry, ...args], {
    cwd: cwd ?? repoRoot,
    encoding: "utf8",
    env: merged,
    // `squad tail --help` must not start following the room: without a cap a
    // regression there would hang this suite instead of failing it.
    timeout: 30_000,
  });
}

function freshDir() {
  return mkdtempSync(join(tmpdir(), "squad-cli-help-"));
}

test("every documented command answers --help/-h with usage and no side effect", () => {
  for (const cmd of DOCUMENTED) {
    const dir = freshDir();
    try {
      for (const flag of ["--help", "-h"]) {
        const res = runCli([cmd, flag], { cwd: dir, env: { SQUAD_DIR: dir } });
        assert.equal(res.signal, null, `squad ${cmd} ${flag} did not exit on its own`);
        assert.equal(res.status, 0, `squad ${cmd} ${flag}: ${res.stdout}${res.stderr}`);
        assert.match(
          res.stdout,
          new RegExp(`^usage: squad ${cmd}\\b`),
          `squad ${cmd} ${flag} must print its usage line`,
        );
        assert.equal(res.stderr, "", `squad ${cmd} ${flag} must not report an error`);
        // Asking for help is answered before the database is opened, the
        // persona is resolved, or any path is written: a room that never
        // existed must still not exist, and no file named after the flag may
        // appear in the cwd (the `squad export --help` failure).
        assert.deepEqual(
          readdirSync(dir),
          [],
          `squad ${cmd} ${flag} touched the data dir / cwd`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("squad clear --help explains itself instead of wiping the room", () => {
  const dir = freshDir();
  const env = { SQUAD_DIR: dir, SQUAD_PERSONA: "codex" };
  try {
    runCli(["send", "work in progress"], { env });
    runCli(["goals", "add", "land the help fix"], { env });
    runCli(["claim", "src/cli.ts"], { env });
    const populated = {
      messages: runCli(["read"], { env }).stdout,
      goals: runCli(["goals"], { env }).stdout,
      claims: runCli(["claims"], { env }).stdout,
    };
    assert.match(populated.messages, /work in progress/);
    assert.match(populated.goals, /land the help fix/);
    assert.match(populated.claims, /src\/cli\.ts/);

    for (const flag of ["--help", "-h"]) {
      const res = runCli(["clear", flag], { env });
      assert.equal(res.status, 0, res.stdout + res.stderr);
      assert.match(res.stdout, /^usage: squad clear\b/);
      assert.equal(runCli(["read"], { env }).stdout, populated.messages);
      assert.equal(runCli(["goals"], { env }).stdout, populated.goals);
      assert.equal(runCli(["claims"], { env }).stdout, populated.claims);
    }

    // Control: the comparisons above can actually see a wipe, so the
    // assertions are not vacuously true.
    assert.equal(runCli(["clear"], { env }).status, 0);
    assert.notEqual(runCli(["goals"], { env }).stdout, populated.goals);
    assert.match(runCli(["claims"], { env }).stdout, /no claims/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("squad export --help never writes a file named after the flag", () => {
  const dir = freshDir();
  const cwd = freshDir();
  try {
    for (const flag of ["--help", "-h"]) {
      const res = runCli(["export", flag], { cwd, env: { SQUAD_DIR: dir, SQUAD_PERSONA: "codex" } });
      assert.equal(res.status, 0, res.stdout + res.stderr);
      assert.match(res.stdout, /^usage: squad export <path>/);
      assert.ok(!existsSync(join(cwd, flag)), `squad export ${flag} wrote ${flag} to disk`);
    }
    // A trailing argument does not turn it back into a real export.
    const withPath = runCli(["export", "--help", "room.db"], {
      cwd,
      env: { SQUAD_DIR: dir, SQUAD_PERSONA: "codex" },
    });
    assert.equal(withPath.status, 0, withPath.stdout + withPath.stderr);
    assert.match(withPath.stdout, /^usage: squad export <path>/);
    assert.ok(!existsSync(join(cwd, "room.db")), "no export was written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("squad tail --help exits immediately instead of following the room", () => {
  const dir = freshDir();
  try {
    const started = Date.now();
    const res = runCli(["tail", "--help"], { cwd: dir, env: { SQUAD_DIR: dir } });
    assert.equal(res.signal, null, "tail --help had to be killed — it started following");
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /^usage: squad tail\b/);
    assert.ok(Date.now() - started < 15_000, "tail --help must return promptly");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("squad send names the sender when the persona implicitly defaults to human", () => {
  const dir = freshDir();
  try {
    const res = runCli(["send", "who am i"], { env: { SQUAD_DIR: dir } });
    // The acceptance criterion: refuse, or say out loud whose name goes on it.
    assert.ok(
      res.status !== 0 || /human/.test(res.stderr + res.stdout),
      "sending with no persona must not be silent about posting as 'human'",
    );
    assert.match(res.stderr, /posting as 'human'/);
    assert.match(res.stderr, /SQUAD_PERSONA/);
    // ...and it is a warning, not a failure: the message is still posted, and
    // stdout stays the clean one-line record a pipeline can read.
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /^\d\d:\d\d:\d\d <human> who am i$/m);

    // Scoped to the implicit default: a pinned persona warns about nothing.
    const pinned = runCli(["send", "pinned"], { env: { SQUAD_DIR: dir, SQUAD_PERSONA: "codex" } });
    assert.equal(pinned.status, 0, pinned.stdout + pinned.stderr);
    assert.equal(pinned.stderr, "", "a pinned persona needs no warning");

    // A session token resolves an identity of its own, so it is not implicit
    // either — the warning is about nobody having said who is speaking.
    const session = runCli(["send", "session"], {
      env: { SQUAD_DIR: dir, SQUAD_SESSION_ID: "bbbbbbbb-2222-4222-8222-222222222222" },
    });
    assert.equal(session.status, 0, session.stdout + session.stderr);
    assert.equal(session.stderr, "", "a session identity needs no warning");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("COMMAND_USAGE covers every documented command exactly once", () => {
  for (const cmd of DOCUMENTED) {
    assert.ok(knownCommand(cmd), `${cmd} is a known command`);
    assert.ok(COMMAND_USAGE[cmd], `${cmd} has a usage line`);
    assert.ok(
      COMMAND_USAGE[cmd].startsWith(`usage: squad ${cmd}`),
      `${cmd}'s usage line names the command first: ${COMMAND_USAGE[cmd]}`,
    );
  }
  assert.deepEqual(
    Object.keys(COMMAND_USAGE).sort(),
    [...DOCUMENTED].sort(),
    "COMMAND_USAGE and the documented command list must not drift",
  );

  // The drift guard that matters: a command added to HELP later must come
  // with a usage line, or `squad <new-cmd> --help` silently runs it again.
  const documentedInHelp = new Set(
    [...HELP.matchAll(/^ {2}squad ([a-z][a-z-]*)/gm)].map((m) => m[1]),
  );
  for (const cmd of documentedInHelp) {
    if (SELF_DOCUMENTING.has(cmd)) continue;
    assert.ok(COMMAND_USAGE[cmd], `'squad ${cmd}' is in squad help but has no usage line`);
  }
  assert.ok(documentedInHelp.size > 10, "HELP was parsed for command names");
});
