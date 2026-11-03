import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// `squad join --as <label>` (#229): CLI identity minting for shell-only agents.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(repoRoot, "dist", "index.js");
const scratch = mkdtempSync(join(tmpdir(), "squad-test-join-"));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

let n = 0;
const newRoom = () => join(scratch, `room-${++n}`);

function squad(room, args, env = {}) {
  const e = { ...process.env, SQUAD_DIR: room, ...env };
  for (const k of ["SQUAD_PERSONA", "SQUAD_SESSION_ID", "SQUAD_MODEL", "SQUAD_PROVIDER", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"])
    if (!(k in env)) delete e[k];
  return spawnSync(process.execPath, [entry, ...args], { encoding: "utf8", env: e, timeout: 30_000 });
}

function exportLine(out) {
  const m = out.match(/^export SQUAD_PERSONA=(\S+) SQUAD_SESSION_ID=(\S+)$/m);
  assert.ok(m, `export line present in:\n${out}`);
  return { persona: m[1], id: m[2] };
}

test("mints <label>-<4 hex>, prints catch-up and a working export line", () => {
  const room = newRoom();
  const r = squad(room, ["join", "--as", "opencode-glm"]);
  assert.equal(r.status, 0, r.stderr);
  const { persona, id } = exportLine(r.stdout);
  assert.match(persona, /^opencode-glm-[0-9a-f]{4}$/);
  assert.match(r.stdout, /members: /);
  const env = { SQUAD_PERSONA: persona, SQUAD_SESSION_ID: id };
  assert.equal(squad(room, ["send", "hi"], env).status, 0);
  assert.equal(squad(room, ["read", "--unread"], env).status, 0);
  const w = squad(room, ["wait", "--max", "0", "--json"], env);
  assert.ok([0, 2, 3].includes(w.status), w.stderr);
  const who = squad(room, ["who"], env).stdout;
  assert.equal(who.split("\n").filter((l) => l.startsWith(persona)).length, 1, who);
  assert.ok(!/session/.test(who) || !/2 sessions/.test(who), who);
  const json = JSON.parse(squad(room, ["join", "--as", "x", "--json"]).stdout);
  assert.equal(json.persona.startsWith("x-"), true);
});

test("--json carries persona, identity_id, session_id, lease_expires_at", () => {
  const r = squad(newRoom(), ["join", "--as", "a", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  for (const k of ["persona", "identity_id", "session_id", "lease_expires_at", "join"]) assert.ok(j[k], k);
});

test("repeated joins never collide", () => {
  const room = newRoom();
  const names = new Set();
  for (let i = 0; i < 6; i++) names.add(exportLine(squad(room, ["join", "--as", "same"]).stdout).persona);
  assert.equal(names.size, 6);
});

test("refusals write nothing", () => {
  const room = newRoom();
  const seed = squad(room, ["join", "--as", "peer"]);
  const peer = exportLine(seed.stdout).persona;
  const before = squad(room, ["who"]).stdout;
  for (const args of [["join"], ["join", "--as", ""], ["join", "--as", "human"], ["join", "--as", "HUMAN"], ["join", "--as", "repo"], ["join", "--as", peer]]) {
    const r = squad(room, args);
    assert.notEqual(r.status, 0, args.join(" "));
    assert.equal(r.stdout.includes("export SQUAD_PERSONA"), false);
  }
  assert.notEqual(squad(room, ["join", "--as", "z"], { SQUAD_PERSONA: "pinned" }).status, 0);
  assert.equal(squad(room, ["who"]).stdout, before);
});

test("join --help answers without joining", () => {
  const room = newRoom();
  const r = squad(room, ["join", "--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /usage: squad join --as/);
});
