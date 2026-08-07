import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// VERSION is the single source of truth the installer records into consumer
// repos; package.json must not drift from it.
test("VERSION matches package.json", () => {
  const version = readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim();
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.notEqual(version, "", "VERSION must not be empty");
  assert.equal(version, pkg.version);
});
