import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const u = await import("../dist/waker-unit.js");
const { wakeHandleState, formatWakeHandleLines } = await import("../dist/room-doctor.js");

const spec = {
  node: "/usr/bin/node",
  entry: "/opt/squad/dist/index.js",
  squadDir: "/repo/.squad",
  intervalSeconds: 15,
  logPath: "/repo/.squad/waker/waker.log",
};

test("launchd plist renders the follow command, room and KeepAlive", () => {
  const text = u.renderLaunchdPlist(spec);
  assert.match(text, /<string>com\.rjwalters\.squad-waker<\/string>/);
  assert.match(text, /<string>\/opt\/squad\/dist\/index\.js<\/string>\s*<string>waker<\/string>\s*<string>--follow<\/string>/);
  assert.match(text, /<key>SQUAD_DIR<\/key>\s*<string>\/repo\/\.squad<\/string>/);
  assert.match(text, /<key>KeepAlive<\/key>\s*<true\/>/);
});

test("plist escapes XML metacharacters in paths", () => {
  assert.match(u.renderLaunchdPlist({ ...spec, squadDir: "/a&b/<c>" }), /\/a&amp;b\/&lt;c&gt;/);
});

test("systemd unit renders quoted ExecStart, restart policy and room", () => {
  const text = u.renderSystemdUnit(spec);
  assert.match(text, /^ExecStart="\/usr\/bin\/node" "\/opt\/squad\/dist\/index\.js" "waker" "--follow" "--interval" "15"$/m);
  assert.match(text, /^Environment="SQUAD_DIR=\/repo\/\.squad"$/m);
  assert.match(text, /^Restart=always$/m);
  assert.match(text, /WantedBy=default\.target/);
});

function fixture(platform) {
  const home = mkdtempSync(join(tmpdir(), "squad-unit-"));
  const calls = [];
  const deps = { platform, home, uid: 501, run: (cmd, args) => (calls.push([cmd, ...args].join(" ")), { status: 0, stdout: "" }) };
  return { home, calls, deps, done: () => rmSync(home, { recursive: true, force: true }) };
}

for (const platform of ["linux", "darwin"]) {
  test(`${platform}: install is idempotent and uninstall removes the unit`, () => {
    const f = fixture(platform);
    try {
      const logPath = join(f.home, "waker.log");
      const s = { ...spec, logPath };
      const first = u.installWakerUnit(s, f.deps);
      assert.equal(first.action, "installed");
      assert.ok(existsSync(first.path));
      assert.equal(readFileSync(first.path, "utf8"), u.renderWakerUnit(platform, s));
      const callsAfterFirst = f.calls.length;
      assert.ok(callsAfterFirst > 0);
      assert.equal(u.installWakerUnit(s, f.deps).action, "unchanged");
      assert.equal(f.calls.length, callsAfterFirst, "an unchanged unit is not reloaded");
      assert.equal(u.installWakerUnit({ ...s, intervalSeconds: 30 }, f.deps).action, "updated");
      assert.equal(u.uninstallWakerUnit(f.deps).removed, true);
      assert.equal(existsSync(first.path), false);
      assert.equal(u.uninstallWakerUnit(f.deps).removed, false);
    } finally {
      f.done();
    }
  });
}

test("a failing service manager surfaces an error", () => {
  const f = fixture("linux");
  try {
    const deps = { ...f.deps, run: () => ({ status: 1, stdout: "boom" }) };
    assert.match(u.installWakerUnit({ ...spec, logPath: join(f.home, "l") }, deps).error, /daemon-reload failed: boom/);
  } finally {
    f.done();
  }
});

test("wakerUnitRunning reads systemctl and launchctl output", () => {
  assert.equal(u.wakerUnitRunning({ platform: "linux", run: () => ({ status: 0, stdout: "active\n" }) }), true);
  assert.equal(u.wakerUnitRunning({ platform: "linux", run: () => ({ status: 3, stdout: "inactive\n" }) }), false);
  assert.equal(u.wakerUnitRunning({ platform: "darwin", run: () => ({ status: 0, stdout: "state = running" }) }), true);
  assert.equal(u.wakerUnitRunning({ platform: "darwin", run: () => ({ status: 113, stdout: "" }) }), false);
});

test("heartbeat round-trips and health flags stale and dead-process units", () => {
  const dir = mkdtempSync(join(tmpdir(), "squad-hb-"));
  try {
    assert.equal(u.readWakerHeartbeat(dir), null);
    const now = Date.parse("2026-10-27T12:00:00Z");
    u.writeWakerHeartbeat(dir, now, 15_000, 42);
    const hb = u.readWakerHeartbeat(dir);
    assert.deepEqual(hb, { at: "2026-10-27T12:00:00.000Z", intervalMs: 15_000, pid: 42 });
    assert.equal(u.wakerHealth(true, true, hb, now + 30_000).stale, false);
    assert.equal(u.wakerHealth(true, true, hb, now + 600_000).stale, true);
    assert.match(u.formatWakerHealth(u.wakerHealth(false, false, null, now)), /not installed/);
    assert.match(u.formatWakerHealth(u.wakerHealth(true, false, hb, now)), /NOT running/);
    assert.match(u.formatWakerHealth(u.wakerHealth(true, true, hb, now)), /running, last poll 2026-10-27T12:00:00\.000Z/);
    assert.match(u.formatWakerHealth(u.wakerHealth(true, true, null, now)), /no poll recorded/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wake handle states: usable / missing / other-host / opted-out", () => {
  assert.equal(wakeHandleState(null, "h"), "missing");
  assert.equal(wakeHandleState({ host: "h", no_wake: false }, "h"), "usable");
  assert.equal(wakeHandleState({ host: "x", no_wake: false }, "h"), "other-host");
  assert.equal(wakeHandleState({ host: "h", no_wake: true }, "h"), "opted-out");
  const lines = formatWakeHandleLines(["b", "a"], new Map([["a", { host: "x", no_wake: false }]]), "h");
  assert.deepEqual(lines, ["persona a: wake handle other-host", "persona b: wake handle missing"]);
});
