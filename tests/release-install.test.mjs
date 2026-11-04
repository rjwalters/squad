import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const script = resolve("scripts/release-install.sh");
const scratch = mkdtempSync(join(tmpdir(), "squad-release-install-"));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

// Run the script's swap_link helper against a stub `mv` that records its argv.
function swap(name, versionOutput) {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  const log = join(dir, "mv.log");
  const stub = join(dir, "mv");
  writeFileSync(
    stub,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then ${
      versionOutput ? `echo '${versionOutput}'; exit 0` : "exit 64"
    }; fi\necho "$@" >> "${log}"\n`,
  );
  chmodSync(stub, 0o755);
  const fn = readFileSync(script, "utf8").match(/^swap_link\(\) \{[\s\S]*?^\}/m);
  assert.ok(fn, "swap_link helper present");
  const result = spawnSync("bash", ["-c", `${fn[0]}\nswap_link a b`], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return readFileSync(log, "utf8").trim();
}

test("GNU mv uses -Tf", () => {
  assert.equal(swap("gnu", "mv (GNU coreutils) 9.4"), "-Tf a b");
});

test("non-GNU (BSD/macOS) mv uses -fh", () => {
  assert.equal(swap("bsd", ""), "-fh a b");
});

test("script no longer calls mv -T directly", () => {
  assert.doesNotMatch(readFileSync(script, "utf8"), /^\s*mv -Tf/m);
});

test("chmods install.sh and uninstall.sh so the printed command runs as-is", () => {
  const text = readFileSync(script, "utf8");
  assert.match(
    text,
    /^chmod \+x .*"\$ROOT\/\$VERSION\/install\.sh".*"\$ROOT\/\$VERSION\/uninstall\.sh"/m,
  );
});
