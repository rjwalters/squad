import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// This suite drives the CLI as a subprocess against dist/index.js, the same
// harness pattern tests/doctor.test.mjs uses — it exercises the `squad card`
// subcommand family the way a human terminal actually would.
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
  return mkdtempSync(join(tmpdir(), "squad-cli-card-"));
}

test("squad card create requires a question", () => {
  const dir = freshDir();
  try {
    const res = runCli(["card", "create"], { SQUAD_DIR: dir });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /usage: squad card create/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("squad card create defaults title to the question when --title is omitted", () => {
  const dir = freshDir();
  try {
    const res = runCli(["card", "create", "does X cause Y?"], { SQUAD_DIR: dir });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /^opened card #\d+ \[QUESTION\]: does X cause Y\?$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("squad card create honors --title and --claim-kind", () => {
  const dir = freshDir();
  try {
    const res = runCli(
      ["card", "create", "--title", "Speed of light", "--claim-kind", "formal", "is c constant?"],
      { SQUAD_DIR: dir },
    );
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /opened card #\d+ \[QUESTION\]: Speed of light/);

    const show = runCli(["card", "show", "1"], { SQUAD_DIR: dir });
    assert.equal(show.status, 0, show.stdout + show.stderr);
    assert.match(show.stdout, /\(formal\)/);
    assert.match(show.stdout, /question: is c constant\?/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("squad card create rejects an invalid --claim-kind", () => {
  const dir = freshDir();
  try {
    const res = runCli(["card", "create", "--claim-kind", "vibes", "q"], { SQUAD_DIR: dir });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /usage: squad card create --claim-kind/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("squad card list shows active cards by default and hides terminal ones until --all", () => {
  const dir = freshDir();
  try {
    runCli(["card", "create", "active one"], { SQUAD_DIR: dir });
    runCli(["card", "create", "to be abandoned"], { SQUAD_DIR: dir });
    runCli(["card", "transition", "2", "ABANDONED"], { SQUAD_DIR: dir });

    const active = runCli(["card", "list"], { SQUAD_DIR: dir });
    assert.equal(active.status, 0, active.stdout + active.stderr);
    assert.match(active.stdout, /#1 active one/);
    assert.doesNotMatch(active.stdout, /#2 to be abandoned/);

    const all = runCli(["card", "list", "--all"], { SQUAD_DIR: dir });
    assert.equal(all.status, 0, all.stdout + all.stderr);
    assert.match(all.stdout, /#1 active one/);
    assert.match(all.stdout, /\[ABANDONED\] #2 to be abandoned/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("squad card list reports an empty board", () => {
  const dir = freshDir();
  try {
    const res = runCli(["card", "list"], { SQUAD_DIR: dir });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /no active cards/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("squad card show reports missing id", () => {
  const dir = freshDir();
  try {
    const res = runCli(["card", "show", "999"], { SQUAD_DIR: dir });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /no science card/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("squad card transition moves the phase and is reflected in show", () => {
  const dir = freshDir();
  try {
    runCli(["card", "create", "moves through phases"], { SQUAD_DIR: dir });
    const res = runCli(["card", "transition", "1", "DIVERGE", "kicking", "off"], { SQUAD_DIR: dir });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /^card #1 -> DIVERGE$/m);

    const show = runCli(["card", "show", "1"], { SQUAD_DIR: dir });
    assert.match(show.stdout, /QUESTION -> DIVERGE: kicking off/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("squad card transition rejects an illegal move", () => {
  const dir = freshDir();
  try {
    runCli(["card", "create", "illegal jump"], { SQUAD_DIR: dir });
    const res = runCli(["card", "transition", "1", "SUPPORTED"], { SQUAD_DIR: dir });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /illegal science card transition/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("squad card evidence attaches an item and it shows up in card show", () => {
  const dir = freshDir();
  try {
    runCli(["card", "create", "needs evidence"], { SQUAD_DIR: dir });
    const res = runCli(
      ["card", "evidence", "1", "literature", "prior-survey.pdf", "background", "reading"],
      { SQUAD_DIR: dir },
    );
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /^added literature evidence #\d+ to card #1: prior-survey\.pdf$/m);

    const show = runCli(["card", "show", "1"], { SQUAD_DIR: dir });
    assert.match(show.stdout, /\[literature\] prior-survey\.pdf \(human\): background reading/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("squad card evidence rejects an invalid type", () => {
  const dir = freshDir();
  try {
    runCli(["card", "create", "bad evidence"], { SQUAD_DIR: dir });
    const res = runCli(["card", "evidence", "1", "vibes", "somewhere"], { SQUAD_DIR: dir });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /invalid evidence type/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("squad --help documents the card subcommand family", () => {
  const res = runCli(["--help"]);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /squad card create/);
  assert.match(res.stdout, /squad card list/);
  assert.match(res.stdout, /squad card show/);
  assert.match(res.stdout, /squad card transition/);
  assert.match(res.stdout, /squad card evidence/);
  assert.match(res.stdout, /squad card edit/);
});

// --- card edit --------------------------------------------------------

test("squad card edit changes a field and it's reflected in card show", () => {
  const dir = freshDir();
  try {
    runCli(["card", "create", "--title", "Original", "editable question"], { SQUAD_DIR: dir });
    const res = runCli(
      ["card", "edit", "1", "--title", "Renamed", "--confidence", "0.75"],
      { SQUAD_DIR: dir },
    );
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /^card #1 updated \[QUESTION\]: Renamed$/m);

    const show = runCli(["card", "show", "1"], { SQUAD_DIR: dir });
    assert.equal(show.status, 0, show.stdout + show.stderr);
    assert.match(show.stdout, /^#1 \[QUESTION\] Renamed/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("squad card edit accepts a comma-separated value for list fields", () => {
  const dir = freshDir();
  try {
    runCli(["card", "create", "list field card"], { SQUAD_DIR: dir });
    const res = runCli(
      ["card", "edit", "1", "--insights", "first insight,second insight"],
      { SQUAD_DIR: dir },
    );
    assert.equal(res.status, 0, res.stdout + res.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("squad card edit requires at least one --field value pair", () => {
  const dir = freshDir();
  try {
    runCli(["card", "create", "no fields"], { SQUAD_DIR: dir });
    const res = runCli(["card", "edit", "1"], { SQUAD_DIR: dir });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /usage: squad card edit/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("squad card edit rejects an unrecognized flag (phase cannot be edited this way)", () => {
  const dir = freshDir();
  try {
    runCli(["card", "create", "no phase edit"], { SQUAD_DIR: dir });
    const res = runCli(["card", "edit", "1", "--phase", "SUPPORTED"], { SQUAD_DIR: dir });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /unrecognized flag '--phase'/);

    const show = runCli(["card", "show", "1"], { SQUAD_DIR: dir });
    assert.match(show.stdout, /^#1 \[QUESTION\]/m, "phase unchanged after a rejected edit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("squad card edit reports missing id", () => {
  const dir = freshDir();
  try {
    const res = runCli(["card", "edit", "999", "--title", "x"], { SQUAD_DIR: dir });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /no science card/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mcp.ts registers squad_card_update", () => {
  const mcpSrc = readFileSync(join(repoRoot, "src", "mcp.ts"), "utf8");
  assert.match(mcpSrc, /registerTool\(\s*"squad_card_update"/);
});

// --- MCP tool registration (no live transport; see issue #23's test plan:
// verify the tools are registered when full MCP-transport testing isn't
// practical without spinning up a client) --------------------------------

test("mcp.ts registers the five card tools with registerTool", () => {
  const mcpSrc = readFileSync(join(repoRoot, "src", "mcp.ts"), "utf8");
  for (const tool of [
    "squad_card_create",
    "squad_card_list",
    "squad_card_get",
    "squad_card_transition",
    "squad_card_evidence_add",
  ]) {
    assert.match(mcpSrc, new RegExp(`registerTool\\(\\s*"${tool}"`), `${tool} must be registered`);
  }
});
