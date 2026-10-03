import { lstatSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureRoomIgnoredStrict, roomIgnoreState } from "./db.js";

/**
 * `squad heal [--root <dir>]` (#132): keep dormant rooms out of `git status`.
 *
 * openDb() already calls ensureRoomIgnored() (#111), but that only heals a
 * checkout the next time squad runs *there*. A room created before that fix,
 * in a repo squad never runs in again, stayed untracked dirt forever. This
 * reaches those rooms without opening them: it never calls openDb(), never
 * constructs a Squad, never registers presence, and never creates a `.squad/`.
 * The only file it can write is a repo's local `.git/info/exclude`, through
 * the same additive, idempotent helper the runtime uses.
 *
 * Scan scope is deliberately bounded: `<root>/.squad` plus `<child>/.squad`
 * for each *immediate* child directory of root. No recursion, and neither a
 * symlinked child nor a symlinked `.squad` is followed. A nested layout
 * (`~/src/org/repo`) needs an explicit `--root ~/src/org`.
 */
export const HEAL_USAGE = "usage: squad heal [--root <dir>]";

/**
 * Parent of the squad source checkout this module was loaded from (dist/ ->
 * checkout -> parent): the directory sibling checkouts usually live in. It
 * comes from the module location, never the caller's working directory, so
 * the same command heals the same rooms wherever it is run from.
 */
export function defaultHealRoot(): string {
  const checkout = dirname(dirname(fileURLToPath(import.meta.url)));
  return dirname(checkout);
}

export function parseHealArgs(args: string[]): { root: string } {
  if (args.length === 0) return { root: defaultHealRoot() };
  if (args.length === 2 && args[0] === "--root" && args[1] && !args[1].startsWith("-"))
    return { root: args[1] };
  throw new Error(HEAL_USAGE);
}

export interface HealReport {
  root: string;
  /** Rooms whose repo exclude file was written by this run. */
  written: { room: string; exclude: string }[];
  /** Rooms git already ignored: nothing written. */
  covered: string[];
  /** Rooms deliberately left alone (not in a git repo, symlinked, …). */
  skipped: { room: string; reason: string }[];
  /** Rooms still visible to git after the attempt. */
  failed: { room: string; reason: string }[];
}

/** Candidate room paths in scan order: the root's own, then each child's. */
function candidates(root: string): string[] {
  const out = [join(root, ".squad")];
  const children = readdirSync(root, { withFileTypes: true })
    // isDirectory() on a Dirent is false for a symlink: never followed.
    .filter((d) => d.isDirectory() && d.name !== ".squad")
    .map((d) => d.name)
    .sort();
  for (const name of children) out.push(join(root, name, ".squad"));
  return out;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function healOne(room: string, report: HealReport): void {
  let st;
  try {
    st = lstatSync(room);
  } catch {
    return; // no room here: not a candidate at all, and never created
  }
  if (st.isSymbolicLink()) {
    report.skipped.push({ room, reason: "symlink, not followed" });
    return;
  }
  if (!st.isDirectory()) {
    report.skipped.push({ room, reason: "not a directory" });
    return;
  }
  const before = roomIgnoreState(room);
  if (before.state === "outside-repo") {
    report.skipped.push({ room, reason: "not inside a git working tree" });
    return;
  }
  if (before.state === "ignored") {
    report.covered.push(room);
    return;
  }
  let exclude: string | null = null;
  let error: string | null = null;
  try {
    exclude = ensureRoomIgnoredStrict(room);
  } catch (err) {
    error = message(err);
  }
  // Verify rather than trust the return value: the helper reports a no-op and
  // (in its non-strict form) a failure the same way.
  const after = roomIgnoreState(room);
  if (after.state !== "ignored") {
    report.failed.push({
      room,
      reason: error ?? `still not ignored after writing ${exclude ?? before.exclude ?? "(no exclude file)"}`,
    });
    return;
  }
  if (exclude) report.written.push({ room, exclude });
  else report.covered.push(room);
}

/**
 * Heal every room in scope under `root`. Throws only when `root` itself is
 * unusable; a problem with one candidate is recorded and the scan continues.
 */
export function healRooms(rootArg: string): HealReport {
  const root = resolve(rootArg);
  let isDir = false;
  try {
    isDir = statSync(root).isDirectory();
  } catch {
    // fall through
  }
  if (!isDir) throw new Error(`heal root is not a directory: ${root}\n${HEAL_USAGE}`);
  const report: HealReport = { root, written: [], covered: [], skipped: [], failed: [] };
  let list: string[];
  try {
    list = candidates(root);
  } catch (err) {
    throw new Error(`cannot list heal root ${root}: ${message(err)}`);
  }
  for (const room of list) {
    try {
      healOne(room, report);
    } catch (err) {
      report.failed.push({ room, reason: message(err) });
    }
  }
  return report;
}

export function formatHealReport(r: HealReport): string {
  const lines = [`heal: scanning ${r.root} (its own .squad and each immediate subdirectory's; no recursion)`];
  for (const w of r.written) lines.push(`wrote: ${w.exclude} (room ${w.room})`);
  for (const room of r.covered) lines.push(`ignored: ${room}`);
  for (const s of r.skipped) lines.push(`skip: ${s.room} (${s.reason})`);
  for (const f of r.failed) lines.push(`FAILED: ${f.room} (${f.reason})`);
  lines.push(
    `heal: ${r.written.length} exclude file(s) written, ${r.covered.length} already ignored, ` +
      `${r.skipped.length} skipped, ${r.failed.length} failed`,
  );
  return lines.join("\n") + "\n";
}
