import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Service unit for `squad waker --follow` (#175, phase 3 of #172): a launchd
 * agent (macOS) or systemd user unit (Linux) that keeps the waker running
 * unattended, plus the heartbeat `squad doctor` reads to report its health.
 *
 * Rendering is pure (`renderLaunchdPlist` / `renderSystemdUnit`); the only
 * code that touches launchctl/systemctl is `runServiceCommand`, which every
 * entry point takes as an injectable `ServiceRunner` so tests stub it.
 */

export const WAKER_UNIT_LABEL = "com.rjwalters.squad-waker";
export const WAKER_SYSTEMD_UNIT = "squad-waker.service";
export const WAKER_HEARTBEAT_FILE = "heartbeat.json";
/** A heartbeat older than this many poll intervals means the process is not polling. */
export const HEARTBEAT_STALE_FACTOR = 4;

export const DEFAULT_UNIT_INTERVAL_SECONDS = 15;

export type WakerPlatform = "darwin" | "linux";

export interface WakerUnitSpec {
  /** Absolute path of the node binary. */
  node: string;
  /** Absolute path of the installed build's dist/index.js. */
  entry: string;
  /** Room directory the waker follows (SQUAD_DIR). */
  squadDir: string;
  /** Poll interval in seconds. */
  intervalSeconds: number;
  /** Where the service's stdout/stderr go. */
  logPath: string;
}

const xml = (s: string): string =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** The argv the unit runs: the installed build's waker in follow mode. */
export function wakerArgv(spec: WakerUnitSpec): string[] {
  return [spec.node, spec.entry, "waker", "--follow", "--interval", String(spec.intervalSeconds)];
}

export function renderLaunchdPlist(spec: WakerUnitSpec): string {
  const args = wakerArgv(spec)
    .map((a) => `    <string>${xml(a)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${WAKER_UNIT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SQUAD_DIR</key>
    <string>${xml(spec.squadDir)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(spec.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(spec.logPath)}</string>
</dict>
</plist>
`;
}

/** systemd ExecStart quoting: every word double-quoted, with \ " and % escaped. */
const sd = (s: string): string => `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;

export function renderSystemdUnit(spec: WakerUnitSpec): string {
  return `[Unit]
Description=squad waker (wakes personas with no live session)

[Service]
Type=simple
ExecStart=${wakerArgv(spec).map(sd).join(" ")}
Environment=${sd(`SQUAD_DIR=${spec.squadDir}`)}
Restart=always
RestartSec=10
StandardOutput=append:${spec.logPath}
StandardError=append:${spec.logPath}

[Install]
WantedBy=default.target
`;
}

export function wakerUnitPath(platform: WakerPlatform, home: string = homedir()): string {
  return platform === "darwin"
    ? join(home, "Library", "LaunchAgents", `${WAKER_UNIT_LABEL}.plist`)
    : join(home, ".config", "systemd", "user", WAKER_SYSTEMD_UNIT);
}

export function renderWakerUnit(platform: WakerPlatform, spec: WakerUnitSpec): string {
  return platform === "darwin" ? renderLaunchdPlist(spec) : renderSystemdUnit(spec);
}

export interface ServiceResult {
  status: number | null;
  stdout: string;
}
/** Runs `launchctl` / `systemctl` with args. Injected so tests never touch a real service manager. */
export type ServiceRunner = (cmd: string, args: string[]) => ServiceResult;

export const runServiceCommand: ServiceRunner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { status: r.error ? null : r.status, stdout: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

export function supportedPlatform(p: string = process.platform): WakerPlatform | null {
  return p === "darwin" || p === "linux" ? p : null;
}

export interface WakerServiceDeps {
  platform: WakerPlatform;
  home?: string;
  run?: ServiceRunner;
  /** Numeric uid for the launchd `gui/<uid>` domain. */
  uid?: number;
}

function launchdDomain(deps: WakerServiceDeps): string {
  return `gui/${deps.uid ?? process.getuid?.() ?? 0}`;
}

/** Load (or reload) the unit with the service manager. Returns an error message, or null. */
function load(deps: WakerServiceDeps, path: string): string | null {
  const run = deps.run ?? runServiceCommand;
  if (deps.platform === "darwin") {
    const domain = launchdDomain(deps);
    run("launchctl", ["bootout", `${domain}/${WAKER_UNIT_LABEL}`]);
    const r = run("launchctl", ["bootstrap", domain, path]);
    return r.status === 0 ? null : `launchctl bootstrap failed: ${r.stdout.trim()}`;
  }
  const reload = run("systemctl", ["--user", "daemon-reload"]);
  if (reload.status !== 0) return `systemctl --user daemon-reload failed: ${reload.stdout.trim()}`;
  const en = run("systemctl", ["--user", "enable", "--now", WAKER_SYSTEMD_UNIT]);
  if (en.status !== 0) return `systemctl --user enable failed: ${en.stdout.trim()}`;
  // Pick up a rewritten unit on an already-running service.
  run("systemctl", ["--user", "restart", WAKER_SYSTEMD_UNIT]);
  return null;
}

export interface InstallResult {
  path: string;
  /** "installed" first time, "updated" when the file changed, "unchanged" when already current. */
  action: "installed" | "updated" | "unchanged";
  error: string | null;
}

/** Write the unit file and load it. Idempotent: an identical, already-written unit is not reloaded. */
export function installWakerUnit(spec: WakerUnitSpec, deps: WakerServiceDeps): InstallResult {
  const path = wakerUnitPath(deps.platform, deps.home);
  const text = renderWakerUnit(deps.platform, spec);
  const before = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (before === text) return { path, action: "unchanged", error: null };
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(dirname(spec.logPath), { recursive: true });
  writeFileSync(path, text);
  return { path, action: before === null ? "installed" : "updated", error: load(deps, path) };
}

export interface UninstallResult {
  path: string;
  removed: boolean;
}

/** Unload and delete the unit. Safe when nothing is installed. */
export function uninstallWakerUnit(deps: WakerServiceDeps): UninstallResult {
  const path = wakerUnitPath(deps.platform, deps.home);
  if (!existsSync(path)) return { path, removed: false };
  const run = deps.run ?? runServiceCommand;
  if (deps.platform === "darwin") {
    run("launchctl", ["bootout", `${launchdDomain(deps)}/${WAKER_UNIT_LABEL}`]);
  } else {
    run("systemctl", ["--user", "disable", "--now", WAKER_SYSTEMD_UNIT]);
  }
  rmSync(path, { force: true });
  if (deps.platform === "linux") run("systemctl", ["--user", "daemon-reload"]);
  return { path, removed: true };
}

/** Whether the service manager reports the unit's process running. */
export function wakerUnitRunning(deps: WakerServiceDeps): boolean {
  const run = deps.run ?? runServiceCommand;
  if (deps.platform === "darwin") {
    const r = run("launchctl", ["print", `${launchdDomain(deps)}/${WAKER_UNIT_LABEL}`]);
    return r.status === 0 && /state = running/.test(r.stdout);
  }
  return run("systemctl", ["--user", "is-active", WAKER_SYSTEMD_UNIT]).stdout.trim() === "active";
}

export interface Heartbeat {
  /** ISO time of the last poll. */
  at: string;
  intervalMs: number;
  pid: number;
}

export function heartbeatPath(squadDir: string): string {
  return join(squadDir, "waker", WAKER_HEARTBEAT_FILE);
}

/** Record one poll. Called by the follow loop after every pass. */
export function writeWakerHeartbeat(squadDir: string, nowMs: number, intervalMs: number, pid: number = process.pid): void {
  const path = heartbeatPath(squadDir);
  mkdirSync(dirname(path), { recursive: true });
  const beat: Heartbeat = { at: new Date(nowMs).toISOString(), intervalMs, pid };
  writeFileSync(path, JSON.stringify(beat) + "\n");
}

export function readWakerHeartbeat(squadDir: string): Heartbeat | null {
  try {
    const p = JSON.parse(readFileSync(heartbeatPath(squadDir), "utf8")) as Partial<Heartbeat>;
    if (typeof p.at === "string" && Number.isFinite(Date.parse(p.at)) && typeof p.intervalMs === "number")
      return { at: p.at, intervalMs: p.intervalMs, pid: Number(p.pid) || 0 };
  } catch {
    // Missing or corrupt: no heartbeat.
  }
  return null;
}

export interface WakerHealth {
  installed: boolean;
  running: boolean;
  lastPoll: string | null;
  /** True when a heartbeat exists but is older than HEARTBEAT_STALE_FACTOR intervals. */
  stale: boolean;
}

/** Pure: fold unit presence, service state and heartbeat into one health record. */
export function wakerHealth(
  installed: boolean,
  running: boolean,
  heartbeat: Heartbeat | null,
  nowMs: number,
): WakerHealth {
  const stale = heartbeat
    ? nowMs - Date.parse(heartbeat.at) > heartbeat.intervalMs * HEARTBEAT_STALE_FACTOR
    : false;
  return { installed, running, lastPoll: heartbeat?.at ?? null, stale };
}

/** `squad doctor` line for the waker unit. */
export function formatWakerHealth(h: WakerHealth): string {
  if (!h.installed) return "waker unit: not installed (opt in with 'install.sh --waker')";
  const state = h.running ? "running" : "NOT running (unit exists but process is dead)";
  const poll = h.lastPoll ? `last poll ${h.lastPoll}${h.stale ? " (STALE)" : ""}` : "no poll recorded yet";
  return `waker unit: installed, ${state}, ${poll}`;
}

/** Inspect this host's waker unit for `squad doctor`. */
export function inspectWaker(
  squadDir: string,
  nowMs: number,
  deps: WakerServiceDeps | null = null,
): WakerHealth {
  const d = deps ?? (supportedPlatform() ? { platform: supportedPlatform()! } : null);
  if (!d) return wakerHealth(false, false, readWakerHeartbeat(squadDir), nowMs);
  const installed = existsSync(wakerUnitPath(d.platform, d.home));
  return wakerHealth(installed, installed && wakerUnitRunning(d), readWakerHeartbeat(squadDir), nowMs);
}
