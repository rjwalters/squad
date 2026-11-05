import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { parseAgentArgs, envCount } from "../dist/agent-args.js";
import { parseOpencodeAgentArgs } from "../dist/opencode-agent.js";
import { parseClaudeArgs } from "../dist/claude-reentry-driver.js";
import { parseCodexReentryArgs } from "../dist/codex-reentry-driver.js";
import { DEFAULT_REENTRY_MAX_ATTEMPTS, DEFAULT_REENTRY_TTL_MINUTES } from "../dist/reentry.js";

const ENV_KEYS = [
  "SQUAD_PERSONA",
  "SQUAD_REENTRY_TTL_MINUTES",
  "SQUAD_REENTRY_MAX_ATTEMPTS",
  "SQUAD_TEST_BIN",
  "SQUAD_TEST_COUNT",
  "SQUAD_OPENCODE_BIN",
  "SQUAD_CLAUDE_BIN",
  "SQUAD_CODEX_BIN",
];
const INITIAL = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
let saved;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

after(() => {
  for (const k of ENV_KEYS) assert.equal(process.env[k], INITIAL[k], `${k} was not restored`);
});

const SPEC = {
  runtime: "fake",
  binEnv: "SQUAD_TEST_BIN",
  binFlag: "--fake",
  usage: "usage: squad agent fake",
};

const ADAPTERS = [
  { name: "opencode", parse: parseOpencodeAgentArgs, runtime: "opencode", binEnv: "SQUAD_OPENCODE_BIN", binFlag: "--opencode" },
  { name: "claude", parse: parseClaudeArgs, runtime: "claude", binEnv: "SQUAD_CLAUDE_BIN", binFlag: "--claude" },
  { name: "codex", parse: parseCodexReentryArgs, runtime: "codex", binEnv: "SQUAD_CODEX_BIN", binFlag: "--codex" },
];

test("defaults come from the spec and reentry constants", () => {
  assert.deepEqual(parseAgentArgs([], SPEC), {
    persona: "fake",
    bin: "fake",
    ttlMinutes: DEFAULT_REENTRY_TTL_MINUTES,
    maxAttempts: DEFAULT_REENTRY_MAX_ATTEMPTS,
    allowResume: true,
    extraArgs: [],
  });
});

test("env supplies persona, bin, ttl and attempts", () => {
  process.env.SQUAD_PERSONA = "envp";
  process.env.SQUAD_TEST_BIN = "/env/bin";
  process.env.SQUAD_REENTRY_TTL_MINUTES = "7";
  process.env.SQUAD_REENTRY_MAX_ATTEMPTS = "3";
  const o = parseAgentArgs([], SPEC);
  assert.equal(o.persona, "envp");
  assert.equal(o.bin, "/env/bin");
  assert.equal(o.ttlMinutes, 7);
  assert.equal(o.maxAttempts, 3);
});

test("empty-string env falls back to defaults", () => {
  process.env.SQUAD_PERSONA = "";
  process.env.SQUAD_TEST_BIN = "";
  process.env.SQUAD_REENTRY_TTL_MINUTES = "";
  process.env.SQUAD_REENTRY_MAX_ATTEMPTS = "";
  const o = parseAgentArgs([], SPEC);
  assert.equal(o.persona, "fake");
  assert.equal(o.bin, "fake");
  assert.equal(o.ttlMinutes, DEFAULT_REENTRY_TTL_MINUTES);
  assert.equal(o.maxAttempts, DEFAULT_REENTRY_MAX_ATTEMPTS);
});

test("invalid env counts fall back to defaults", () => {
  for (const bad of ["-1", "NaN", "abc", "Infinity"]) {
    process.env.SQUAD_REENTRY_TTL_MINUTES = bad;
    process.env.SQUAD_REENTRY_MAX_ATTEMPTS = bad;
    const o = parseAgentArgs([], SPEC);
    assert.equal(o.ttlMinutes, DEFAULT_REENTRY_TTL_MINUTES, bad);
    assert.equal(o.maxAttempts, DEFAULT_REENTRY_MAX_ATTEMPTS, bad);
  }
});

test("envCount: unset, valid, zero and invalid", () => {
  assert.equal(envCount("SQUAD_TEST_COUNT", 9), 9);
  process.env.SQUAD_TEST_COUNT = "4";
  assert.equal(envCount("SQUAD_TEST_COUNT", 9), 4);
  process.env.SQUAD_TEST_COUNT = "0";
  assert.equal(envCount("SQUAD_TEST_COUNT", 9), 0);
  for (const bad of ["-2", "NaN", "abc", "Infinity"]) {
    process.env.SQUAD_TEST_COUNT = bad;
    assert.equal(envCount("SQUAD_TEST_COUNT", 9), 9, bad);
  }
});

test("flags override env and set each option", () => {
  process.env.SQUAD_PERSONA = "envp";
  process.env.SQUAD_TEST_BIN = "/env/bin";
  const o = parseAgentArgs(
    ["--persona", "p", "--fake", "/flag/bin", "--prompt", "hi", "--ttl-minutes", "5", "--max-attempts", "2", "--no-resume"],
    SPEC,
  );
  assert.equal(o.persona, "p");
  assert.equal(o.bin, "/flag/bin");
  assert.equal(o.prompt, "hi");
  assert.equal(o.ttlMinutes, 5);
  assert.equal(o.maxAttempts, 2);
  assert.equal(o.allowResume, false);
});

test("zero is honoured for --ttl-minutes and --max-attempts", () => {
  const o = parseAgentArgs(["--ttl-minutes", "0", "--max-attempts", "0"], SPEC);
  assert.equal(o.ttlMinutes, 0);
  assert.equal(o.maxAttempts, 0);
});

test("-- passes everything after it through, flag-like or not", () => {
  const o = parseAgentArgs(["--no-resume", "--", "--persona", "x", "--bogus", "--"], SPEC);
  assert.equal(o.allowResume, false);
  assert.equal(o.persona, "fake");
  assert.deepEqual(o.extraArgs, ["--persona", "x", "--bogus", "--"]);
});

test("a bare trailing -- yields empty extraArgs", () => {
  assert.deepEqual(parseAgentArgs(["--"], SPEC).extraArgs, []);
});

test("a value-taking flag consumes the next token even if it looks like a flag", () => {
  const o = parseAgentArgs(["--prompt", "--no-resume"], SPEC);
  assert.equal(o.prompt, "--no-resume");
  assert.equal(o.allowResume, true);
});

test("a trailing value-taking flag throws 'needs a value'", () => {
  for (const flag of ["--persona", "--fake", "--prompt", "--ttl-minutes", "--max-attempts"]) {
    assert.throws(() => parseAgentArgs([flag], SPEC), (e) => {
      assert.ok(e.message.includes(SPEC.usage));
      assert.ok(e.message.includes(`${flag} needs a value`));
      return true;
    });
  }
});

test("bad counts throw 'needs a non-negative number'", () => {
  for (const flag of ["--ttl-minutes", "--max-attempts"]) {
    for (const bad of ["-1", "NaN", "abc", "Infinity"]) {
      assert.throws(
        () => parseAgentArgs([flag, bad], SPEC),
        (e) => e.message.includes(SPEC.usage) && e.message.includes(`${flag} needs a non-negative number`),
        `${flag} ${bad}`,
      );
    }
  }
});

test("unrecognized flags throw and name the flag", () => {
  assert.throws(
    () => parseAgentArgs(["--nope"], SPEC),
    (e) => e.message.includes(SPEC.usage) && e.message.includes("unrecognized flag '--nope'"),
  );
});

test("another adapter's bin flag is unrecognized", () => {
  assert.throws(() => parseAgentArgs(["--claude", "x"], SPEC), /unrecognized flag '--claude'/);
});

for (const a of ADAPTERS) {
  test(`${a.name} wrapper: default persona and bin are the runtime`, () => {
    const o = a.parse([]);
    assert.equal(o.persona, a.runtime);
    assert.equal(o.bin, a.runtime);
    assert.equal(o.allowResume, true);
    assert.deepEqual(o.extraArgs, []);
  });

  test(`${a.name} wrapper: ${a.binEnv} and ${a.binFlag} set the bin, flag wins`, () => {
    process.env[a.binEnv] = "/env/bin";
    assert.equal(a.parse([]).bin, "/env/bin");
    assert.equal(a.parse([a.binFlag, "/flag/bin"]).bin, "/flag/bin");
  });

  test(`${a.name} wrapper: SQUAD_PERSONA sets the persona, --persona wins`, () => {
    process.env.SQUAD_PERSONA = "envp";
    assert.equal(a.parse([]).persona, "envp");
    assert.equal(a.parse(["--persona", "p"]).persona, "p");
  });

  test(`${a.name} wrapper: shared flags and -- passthrough`, () => {
    const o = a.parse(["--persona", "p", "--max-attempts", "1", "--no-resume", "--", "--x"]);
    assert.equal(o.persona, "p");
    assert.equal(o.maxAttempts, 1);
    assert.equal(o.allowResume, false);
    assert.deepEqual(o.extraArgs, ["--x"]);
  });

  test(`${a.name} wrapper: errors are thrown`, () => {
    assert.throws(() => a.parse(["--nope"]), /unrecognized flag '--nope'/);
    assert.throws(() => a.parse([a.binFlag]), new RegExp(`${a.binFlag} needs a value`));
    assert.throws(() => a.parse(["--ttl-minutes", "-1"]), /needs a non-negative number/);
  });
}
