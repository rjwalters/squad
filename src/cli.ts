import { identityFromEnv } from "./identity.js";
import { openDb, openDbReadOnly, dbPath, squadDir } from "./db.js";
import {
  Squad,
  CARD_TERMINAL_PHASES,
  REVIEW_PRIORITIES,
  REVIEW_STATUSES,
  type CardPhase,
  type CardUpdateFields,
  type EvidenceType,
  type Message,
  type ReviewPriority,
  type ReviewStatus,
} from "./core.js";
import { rmSync } from "node:fs";
import { formatRoomDoctorReport } from "./room-doctor.js";
import {
  relayConfigFromEnv,
  relayKnownTargets,
  relayOnce,
  relayStatus,
  type RelayResult,
  type RelayTargetStatus,
} from "./relay.js";

const REVIEW_OPEN_USAGE =
  "usage: squad review open --to <persona> [--priority low|normal|high|urgent] " +
  "[--refs <r1,r2,...>] [--expires-in <minutes>] <body...>";

const REVIEW_LIST_USAGE =
  "usage: squad review list [--to <persona>] [--from <persona>] [--status <s>] [--all]";

/**
 * `squad card edit` flag -> `CardUpdateFields` key. Deliberately has no
 * `--phase`/`--status`/`--history` entry: an unrecognized flag is rejected
 * (see the `card edit` branch below), so phase/status/history can never be
 * changed through this path — only `squad card transition` moves phase.
 */
const CARD_EDIT_FLAGS: Record<string, keyof CardUpdateFields> = {
  "--title": "title",
  "--question": "question",
  "--claim-kind": "claim_kind",
  "--origin-method": "origin_method",
  "--origin-contributors": "origin_contributors",
  "--changed-assumptions": "changed_assumptions",
  "--proposed-mechanism": "proposed_mechanism",
  "--math-model": "math_model",
  "--standard-prediction": "standard_prediction",
  "--discriminating-prediction": "discriminating_prediction",
  "--decisive-falsifier": "decisive_falsifier",
  "--cheapest-test": "cheapest_test",
  "--prior-art-status": "prior_art_status",
  "--confidence": "confidence",
  "--novelty": "novelty",
  "--attempts": "attempts",
  "--attacks": "attacks",
  "--insights": "insights",
  "--post-mortems": "post_mortems",
};

/** `card edit` fields that take a comma-separated list rather than free text. */
const CARD_EDIT_LIST_FIELDS = new Set<keyof CardUpdateFields>([
  "origin_contributors",
  "changed_assumptions",
  "attempts",
  "attacks",
  "insights",
  "post_mortems",
]);

/** `card edit` fields that take a number rather than free text. */
const CARD_EDIT_NUMBER_FIELDS = new Set<keyof CardUpdateFields>(["confidence", "novelty"]);

const CARD_EDIT_USAGE =
  "usage: squad card edit <id> --field value [--field value ...] " +
  `(fields: ${Object.keys(CARD_EDIT_FLAGS).join(", ")})`;

/**
 * One-line usage for every documented top-level command, keyed by command
 * name. Two jobs, deliberately shared so they cannot drift apart:
 *
 *  1. `squad <cmd> --help` / `squad <cmd> -h` prints the matching line and
 *     exits 0 *before* the database, the persona, or any side effect is
 *     touched (#119). Every free-form command used to swallow `--help` as
 *     content instead -- `squad send --help` posted a chat message whose body
 *     was "--help" (attributed to `human`), `squad claim --help` claimed a
 *     path named "--help", `squad export --help` wrote a file called
 *     "--help", and `squad clear --help` wiped the whole room.
 *  2. The same string is what the command's own argument validation throws on
 *     bad input, so the usage a human reads from `--help` is exactly the usage
 *     they get told off with.
 *
 * `relay` and `codex-reentry` are absent on purpose: both parse `--help`
 * themselves (their own supervisors/parsers own the text). So is the
 * deliberately undocumented `nuke`.
 */
const COMMAND_USAGE: Record<string, string> = {
  bank: "usage: squad bank <attempt-id> [--build-timeout-ms N]",
  card: "usage: squad card [create|list|show|transition|evidence|edit] ...",
  claim: "usage: squad claim <path>",
  claims: "usage: squad claims (show advisory file claims -- who is working on what)",
  clear:
    "usage: squad clear (wipe messages, goals, claims, cursors, members, presence " +
    "sessions, divergence rounds/submissions, and review requests)",
  diverge: "usage: squad diverge [open|submit|status|close] ...",
  doctor: "usage: squad doctor [--room]",
  export: "usage: squad export <path>",
  goals: "usage: squad goals [add <text...> | done <id> | reopen <id>]",
  import: "usage: squad import <path>",
  integration:
    "usage: squad integration show|check|set|unset|submit|attempt|attempts (see docs/integration.md)",
  leave: "usage: squad leave (end this persona's presence lease(s) and announce the departure)",
  node: "usage: squad node create|list|show|update|submit|claim|review (see squad help)",
  outline:
    "usage: squad outline render|status [path]|publish <request-key> [path] [--build-timeout-ms N]",
  path: "usage: squad path (print the database path)",
  read: "usage: squad read [-n N] (show the last N messages, default 30; stateless)",
  release: "usage: squad release <path>",
  review: "usage: squad review [open|list|show|claim|resolve|cancel] ...",
  send: "usage: squad send <text...>",
  steward: "usage: squad steward <status|tick>",
  tail: "usage: squad tail (follow the room live; Ctrl-C to stop)",
  who: "usage: squad who (presence state and last-seen times for everyone in the room)",
};

const HELP = `squad — local cross-agent chat room with shared goals

With no subcommand (and stdin not a TTY) squad runs as a stdio MCP server.

Human CLI usage:
  squad bank <attempt-id> [--build-timeout-ms N]  Integrate exact committed work; selected paths must be clean against configured HEAD
  squad integration show|check|set|unset|submit|attempt|attempts (see docs/integration.md)
  squad send <text...>        Post a message to the room
  squad read [-n N]           Show the last N messages (default 30; stateless)
  squad tail                  Follow the room live (Ctrl-C to stop)
  squad goals                 Show the goal board (open + done)
  squad goals add <text...>   Add a shared goal
  squad goals done <id>       Mark a goal done
  squad goals reopen <id>     Reopen a goal mistakenly marked done
  squad claims                Show advisory file claims (who is working on what)
  squad claim <path>          Claim a file or area you are working on
  squad release <path>        Drop your claim on a file or area
  squad diverge open [--card <id>] [--expect <p1,p2,...>] <topic...>
                               Open a divergence round (hidden until reveal)
  squad diverge submit <round_id> <text...>
                               Submit your independent entry to an open round
  squad diverge status <round_id>
                               Show round metadata (+ your own submission if made);
                               full submissions only once the round is closed
  squad diverge close <round_id>
                               Explicitly close a round and reveal all submissions
  squad review open --to <persona> [--priority low|normal|high|urgent]
                    [--refs <r1,r2,...>] [--expires-in <minutes>] <body...>
                               Ask one teammate to look at something (a durable
                               directed request, not a prose message)
  squad review list [--to <persona>] [--from <persona>] [--status <s>]
                    [--all]     Show review requests (open + unexpired by
                               default; --all also shows resolved/cancelled
                               and expired ones)
  squad review show <id>      Full detail for one review request
  squad review claim <id>     Acknowledge a request directed at you
  squad review resolve <id> [note...]
                               Close out a request you claimed
  squad review cancel <id> [reason...]
                               Withdraw (requester) or decline (target)
  squad steward status|tick       Inspect durable steward state or send bounded reminders
  squad outline render | status [path]  Deterministic shared outline / freshness
  squad outline publish <request-key> [path] [--build-timeout-ms N]
  squad node create <question...> | --json '<card fields, dependencies, artifacts>'
  squad node list | show <id>  Discover the shared research graph and provenance
  squad node update <id> <expected-revision> '<metadata JSON>'
  squad node claim <id> <expected-revision> [target]
  squad node review <request-id> '<request_key, attempt_id, verdict, rationale JSON>'
  squad node submit <id> <expected-revision> <request-key> <config-revision>
                               Bind declared artifacts to a pending bank attempt
  squad card create [--title <text>] [--claim-kind empirical|formal] <question...>
                               Open a Science Card in the QUESTION phase
  squad card list [--all]     Show cards (active only; --all also shows
                               SUPPORTED/FALSIFIED/INCONCLUSIVE/ABANDONED)
  squad card show <id>        Full detail: card fields + evidence + transitions
  squad card transition <id> <phase> [note...]
                               Move a card to a new phase (validated)
  squad card evidence <id> <type> <provenance> [body...]
                               Attach an evidence item (type: derivation,
                               formal-check, simulation, experiment, literature,
                               observation; provenance is one token — quote it
                               if it contains spaces)
  squad card edit <id> --field value [--field value ...]
                               Edit fields set at creation (title, confidence,
                               novelty, prior-art status, etc.) — never phase;
                               use 'squad card transition' for that. Each flag
                               takes one token (quote multi-word values). List
                               fields (e.g. --insights) take a comma-separated
                               value.
  squad who                   Show who is in the room: presence (active/idle/
                               stale) and last-seen times
  squad leave                 End this persona's presence lease(s) and announce
                               the departure in chat
  squad clear                 Wipe messages, goals, claims, cursors, members,
                               presence sessions, divergence rounds/submissions,
                               and review requests
  squad export <path>         Export this room (every table) to a portable
                               SQLite file at <path> -- WAL-safe (reads
                               through pending WAL writes); refuses to
                               overwrite an existing file
  squad import <path>         Import a room previously written by
                               'squad export' into this room; refuses on a
                               schema-version mismatch or a non-empty
                               destination room (run 'squad clear' first)
  squad codex-reentry [--persona <name>] [--codex <bin>] [--ttl-minutes <n>]
                      [--max-attempts <n>] [--no-resume] [--prompt <text>]
                      [-- <extra codex exec args>]
                               Run a Codex persona under the re-entry
                               supervisor: launch 'codex exec' with the
                               /squad-join prompt and relaunch it (bounded
                               backoff, resets on an @mention) each time its
                               turn ends, instead of leaving it parked and
                               mute. One supervisor per persona, in that
                               persona's own terminal -- start it where you
                               would otherwise have run 'codex'. Bounded by
                               SQUAD_REENTRY_TTL_MINUTES and
                               SQUAD_REENTRY_MAX_ATTEMPTS, and stopped by
                               SQUAD_REENTRY_STOP=1 or a .squad/reentry-stop
                               marker; it announces in the room when it stops
  squad relay [--once]        Ship room messages past the relay cursor to
                               SQUAD_RELAY_ENDPOINT (OTLP logs) and exit; on a
                               newly-enabled room this backfills full history
  squad relay --follow [--interval <seconds>]
                               Keep shipping new messages (poll every 5s by
                               default) until Ctrl-C / SIGTERM
  squad relay status          Configured target, cursor lag, and last error
                               (or "not configured")
  squad path                  Print the database path
  squad doctor                Preflight: runtime deps resolve, DB reachable, persona resolves
  squad doctor --room         Read-only room drift report: known unbanked work,
                               integration/outline divergence, overdue/missing
                               reviews, and chat "banked" claims that disagree
                               with the verified integration ledger. Every
                               finding cites its evidence, age and a concrete
                               next command; never writes to the room.
  squad help                  Show this help
  squad <command> --help      One-line usage for that command, printed without
                               running it (no message sent, nothing cleared)

The room is per-repo: data lives in <repo-root>/.squad/, found by walking up
from the current directory (falling back to ~/.squad outside any repo). Inside
a git worktree the room is the primary clone's, so every worktree shares one.

Environment:
  SQUAD_PERSONA   Explicit identity override (default: human without a session token)
  SQUAD_SESSION_ID Logical agent UUID; reuse across CLI calls and MCP reconnects
  SQUAD_MODEL    Label for automatic agent identity, '<label>-<4 random hex>'
                  (default: the squad_join model argument, else 'agent')
  SQUAD_PROVIDER Optional prefix for that label (default: none)
  SQUAD_DIR       Override the data directory (skips repo-root resolution)
  SQUAD_STALE_MINUTES  Presence lease length: minutes of absence after which a
                  member (and its claims) list as stale (default 30)
  SQUAD_IDLE_MINUTES   Minutes of quiet after which a member drops from active
                  to idle — still leased, just paused (default 5)
  SQUAD_REENTRY_TTL_MINUTES   Re-entry TTL for both re-entry adapters
                  (default 240); 0 disables re-entry outright
  SQUAD_REENTRY_MAX_ATTEMPTS  Hard cap on re-entries per arm cycle, used by
                  'squad codex-reentry' (default 48)
  SQUAD_REENTRY_STOP   Set to 1 to stop re-entry immediately (or touch
                  .squad/reentry-stop / .squad/reentry/<persona>.stop)
  SQUAD_INBOX_INTERVAL_SECONDS  Minimum seconds between room peeks by the
                  opt-in mid-turn inbox hook (default 60); 0 peeks every call
  SQUAD_INBOX_STOP     Set to 1 to silence the inbox hook (or touch
                  .squad/inbox-stop / .squad/inbox/<persona>.stop)
  SQUAD_CODEX_BIN      The codex binary 'squad codex-reentry' supervises
                  (default 'codex')
  SQUAD_RELAY_ENDPOINT   OTLP/HTTP logs endpoint to relay room messages to,
                  e.g. https://collector.example/v1/logs. Unset = relay off.
                  Enabling it sends message bodies off this machine
  SQUAD_RELAY_HEADERS    Auth headers for it, 'name=value,name=value' (e.g.
                  signoz-ingestion-key=...); never written to the room db
  SQUAD_RELAY_ROOM_NAME  squad.room attribute (default: the repo directory name)
  SQUAD_RELAY_KINDS      Comma-separated message kinds to relay, e.g. 'chat'
                  (default: every kind)
`;

function fmt(m: Message): string {
  const time = m.ts.slice(11, 19);
  // Collapsed system messages (#59) carry occurrences > 1: surface the
  // repeat count and last-seen time instead of silently showing only the
  // latest occurrence with no indication earlier ones ever happened.
  const suffix = m.occurrences > 1 ? ` (seen ${m.occurrences} times, last at ${time})` : "";
  return m.kind === "system"
    ? `${time} -- ${m.body}${suffix}`
    : `${time} <${m.sender}> ${m.body}${suffix}`;
}

interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Dynamic import, not a static one at the top of this file: a static import
 * would make `squad doctor` itself unrunnable exactly when it's needed most
 * (node_modules missing/broken), same as index.ts's server startup. This is
 * the one check in `doctor` that can actually fail — it's the same package
 * resolution the MCP server depends on (mcp.ts imports the SDK and zod;
 * nothing else in this codebase does).
 */
async function checkDeps(): Promise<DoctorCheck> {
  try {
    await import("@modelcontextprotocol/sdk/server/mcp.js");
    await import("zod");
    return { name: "dependencies", ok: true, detail: "@modelcontextprotocol/sdk and zod resolve" };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      name: "dependencies",
      ok: false,
      detail: `${detail} -- run 'pnpm install' (or 'npm install') in the squad source clone, then 'pnpm build'`,
    };
  }
}

function checkDatabase(): DoctorCheck {
  try {
    const db = openDb();
    db.prepare("SELECT 1").get();
    db.close();
    return { name: "database", ok: true, detail: `reachable at ${dbPath()}` };
  } catch (err) {
    return {
      name: "database",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function checkPersona(): DoctorCheck {
  const pinned = process.env.SQUAD_PERSONA;
  if (pinned) {
    return { name: "persona", ok: true, detail: `pinned via SQUAD_PERSONA='${pinned}'` };
  }
  return {
    name: "persona",
    ok: true,
    detail:
      "not pinned -- MCP uses '<label>-<random hex>' identities (label: SQUAD_MODEL, else the " +
      "squad_join model argument, else 'agent'); " +
      "this CLI defaults to 'human', or resumes SQUAD_SESSION_ID when supplied",
  };
}

/**
 * Preflight for the MCP server's dependencies: run this to find out *why*
 * a host came up with no squad_* tools instead of guessing. Exits non-zero
 * (and prints a summary) when any check fails.
 */
async function runDoctor(): Promise<void> {
  const checks = [await checkDeps(), checkDatabase(), checkPersona()];
  for (const c of checks) {
    console.log(`[${c.ok ? "ok" : "FAIL"}] ${c.name}: ${c.detail}`);
  }
  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    process.exitCode = 1;
    console.log(`\n${failed.length} check(s) failed -- squad_* tools will not work until fixed.`);
  } else {
    console.log("\nall checks passed.");
  }
}

export const RELAY_USAGE =
  "usage: squad relay [--once] | squad relay --follow [--interval <seconds>] | squad relay status";

export type RelayCommand =
  | { mode: "once" }
  | { mode: "follow"; intervalMs: number }
  | { mode: "status" }
  | { mode: "help" };

/** Parse `squad relay ...` arguments. Throws the usage string on anything else. */
export function parseRelayArgs(args: string[]): RelayCommand {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return { mode: "help" };
  if (args.length === 1 && args[0] === "status") return { mode: "status" };
  if (args.length === 0 || (args.length === 1 && args[0] === "--once")) return { mode: "once" };
  if (args[0] === "--follow") {
    if (args.length === 1) return { mode: "follow", intervalMs: 5000 };
    if (args.length === 3 && args[1] === "--interval") {
      const seconds = Number(args[2]);
      if (Number.isFinite(seconds) && seconds > 0 && args[2]!.trim() !== "")
        return { mode: "follow", intervalMs: Math.round(seconds * 1000) };
    }
  }
  throw new Error(RELAY_USAGE);
}

function formatRelayResult(r: RelayResult): string {
  switch (r.status) {
    case "empty":
      return `relay: nothing new for ${r.target} (cursor at #${r.cursor})`;
    case "lease-held":
      return `relay: another relay pass holds the lease for ${r.target}; nothing sent (cursor at #${r.cursor})`;
    case "failed":
      return `relay: ${r.error ?? "pass failed"} (shipped ${r.shipped} before stopping; cursor at #${r.cursor})`;
    default:
      return (
        `relay: shipped ${r.shipped} message(s) to ${r.target}` +
        (r.rejected ? `, ${r.rejected} rejected by the collector` : "") +
        ` (scanned ${r.scanned}; cursor at #${r.cursor})`
      );
  }
}

function formatRelayStatus(st: RelayTargetStatus): string[] {
  return [
    `  target:     ${st.target}`,
    `  cursor:     message #${st.cursor}${st.updatedAt ? ` (last advanced ${st.updatedAt})` : " (never advanced)"}`,
    `  lag:        ${st.lag} unshipped message(s)`,
    `  last error: ${st.lastError ? `${st.lastError}${st.lastErrorAt ? ` (at ${st.lastErrorAt})` : ""}` : "none"}`,
    `  lease:      ${st.leaseHeld ? "held (a relay pass is in flight)" : "free"}`,
  ];
}

/** `squad relay [--once|--follow|status]` (#113). */
async function runRelay(command: RelayCommand): Promise<void> {
  if (command.mode === "help") {
    console.log(RELAY_USAGE);
    return;
  }
  const config = relayConfigFromEnv();
  const db = openDb();
  try {
    if (command.mode === "status") {
      if (!config) {
        console.log("relay: not configured (set SQUAD_RELAY_ENDPOINT to enable; see 'squad help')");
        const known = relayKnownTargets(db);
        if (known.length) {
          console.log("previously relayed targets in this room:");
          for (const target of known) for (const line of formatRelayStatus(relayStatus(db, target))) console.log(line);
        }
        return;
      }
      console.log("relay: configured");
      console.log(`  room:       ${config.room}`);
      console.log(`  kinds:      ${config.kinds ? config.kinds.join(", ") : "all"}`);
      for (const line of formatRelayStatus(relayStatus(db, config.target, config.kinds))) console.log(line);
      return;
    }
    if (!config) throw new Error("relay: not configured -- set SQUAD_RELAY_ENDPOINT (see 'squad help')");
    if (command.mode === "once") {
      const result = await relayOnce(db, config);
      console.log(formatRelayResult(result));
      if (result.status === "failed") process.exitCode = 1;
      return;
    }
    // --follow: pass, sleep, repeat until SIGINT/SIGTERM. The signal aborts
    // both the sleep and any in-flight POST; the cursor only ever advances
    // past batches the collector accepted, so stopping mid-backfill is safe
    // to resume with another `squad relay`.
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    console.log(`relay: following ${config.target} every ${command.intervalMs / 1000}s (Ctrl-C to stop)`);
    let lastError: string | undefined;
    let cursor = 0;
    try {
      while (!controller.signal.aborted) {
        const result = await relayOnce(db, config, { signal: controller.signal });
        cursor = result.cursor;
        if (controller.signal.aborted) break;
        if (result.status === "failed") {
          if (result.error !== lastError) console.log(formatRelayResult(result));
          lastError = result.error;
        } else {
          if (lastError !== undefined) console.log(`relay: ${config.target} reachable again`);
          lastError = undefined;
          if (result.shipped || result.rejected) console.log(formatRelayResult(result));
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, command.intervalMs);
          function done() {
            clearTimeout(timer);
            controller.signal.removeEventListener("abort", done);
            resolve();
          }
          controller.signal.addEventListener("abort", done, { once: true });
        });
      }
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
    console.log(`relay: stopped (cursor at #${cursor})`);
  } finally {
    db.close();
  }
}

export async function runCli(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  if (cmd === "help" || cmd === "--help" || cmd === "-h" || cmd === undefined) {
    process.stdout.write(HELP);
    return;
  }
  // `squad <cmd> --help` is a request for usage, never content or a path, and
  // it must be answered before openDb()/`new Squad` so that asking cannot
  // join the room, post, claim, write a file or clear anything (#119).
  //
  // Deliberately only the *first* argument, not `rest.includes("--help")`: the
  // free-form commands take prose ("squad send try squad relay --help"), and a
  // flag check that scanned the whole tail would swallow that message and
  // print usage instead of sending it. Trailing arguments are ignored, so
  // `squad export --help ./room.db` still explains itself instead of writing.
  if (rest[0] === "--help" || rest[0] === "-h") {
    const usage = COMMAND_USAGE[cmd];
    if (usage) {
      console.log(usage);
      console.log("(run 'squad help' for the full command reference)");
      return;
    }
  }
  if (cmd === "path") {
    console.log(dbPath());
    return;
  }
  if (cmd === "doctor" && !rest.includes("--room")) {
    if (rest.length) throw new Error(COMMAND_USAGE.doctor);
    await runDoctor();
    return;
  }
  if (cmd === "doctor") {
    if (rest.length !== 1 || rest[0] !== "--room")
      throw new Error(COMMAND_USAGE.doctor);
    const db = openDbReadOnly();
    try {
      // This observer does not join or reserve an identity, even when a
      // runtime exports a session ID. Reports are independent of persona.
      const observer = new Squad(db, "room-doctor-observer");
      process.stdout.write(formatRoomDoctorReport(observer.roomDoctor()));
    } finally {
      db.close();
    }
    return;
  }
  if (cmd === "codex-reentry") {
    // Handled before the shared `Squad` below: the supervisor is not a
    // human-persona command (it acts as the Codex persona it supervises) and
    // it holds the process for hours, so it opens its own connections.
    const { runCodexReentry, CODEX_REENTRY_USAGE } = await import("./codex-reentry-driver.js");
    if (rest.includes("--help") || rest.includes("-h")) {
      console.log(CODEX_REENTRY_USAGE);
      return;
    }
    const summary = await runCodexReentry(rest);
    console.log(
      `codex re-entry supervisor stopped after ${summary.runs} run(s) / ` +
        `${summary.attempts} re-entry(ies): ${summary.stopReason}`,
    );
    return;
  }

  if (cmd === "relay") {
    // Handled before the shared `Squad` below: relaying is delivery plumbing,
    // not a persona acting in the room, so it must not open a presence lease.
    await runRelay(parseRelayArgs(rest));
    return;
  }

  const persona = process.env.SQUAD_PERSONA || (process.env.SQUAD_SESSION_ID ? undefined : "human");
  const db = openDb();
  // Import must inspect an untouched destination before any identity reservation.
  const squad = new Squad(db, cmd === "import" ? (persona ?? "human") : persona, identityFromEnv());

  switch (cmd) {
    case "steward": {
      if (rest.length !== 1 || !["status", "tick"].includes(rest[0]!))
        throw new Error(COMMAND_USAGE.steward);
      console.log(
        JSON.stringify(
          rest[0] === "status" ? squad.stewardStatus() : squad.stewardTick(),
          null,
          2,
        ),
      );
      break;
    }
    case "outline": {
      const [action, ...args] = rest;
      if (action === "render" && !args.length)
        console.log(JSON.stringify(squad.outlineRender(), null, 2));
      else if (
        action === "status" &&
        args.length <= 1 &&
        !args[0]?.startsWith("--")
      )
        console.log(JSON.stringify(squad.outlineStatus(args[0]), null, 2));
      else if (action === "publish" && args.length) {
        const request_key = args.shift()!;
        const path =
          args[0] && !args[0].startsWith("--") ? args.shift() : undefined;
        if (
          request_key.startsWith("--") ||
          (args.length &&
            (args.length !== 2 ||
              args[0] !== "--build-timeout-ms" ||
              !/^[0-9]+$/.test(args[1]!)))
        )
          throw new Error(
            "usage: squad outline publish <request-key> [path] [--build-timeout-ms N]",
          );
        const controller = new AbortController();
        const abort = () => controller.abort();
        process.once("SIGINT", abort);
        process.once("SIGTERM", abort);
        try {
          const result = await squad.outlinePublish({
            request_key,
            path,
            build_timeout_ms:
              args[1] === undefined ? undefined : Number(args[1]),
            signal: controller.signal,
          });
          console.log(JSON.stringify(result, null, 2));
          if (result.attempt.status !== "verified") process.exitCode = 1;
        } finally {
          process.removeListener("SIGINT", abort);
          process.removeListener("SIGTERM", abort);
        }
      } else
        throw new Error(COMMAND_USAGE.outline);
      break;
    }
    case "node": {
      const [action = "list", ...args] = rest;
      const integer = (raw: string | undefined) => {
        if (
          !raw ||
          !/^[1-9][0-9]*$/.test(raw) ||
          !Number.isSafeInteger(Number(raw))
        )
          throw new Error("node: expected a positive integer ID/revision");
        return Number(raw);
      };
      let result;
      if (action === "list" && !args.length) result = squad.nodeList();
      else if (action === "show" && args.length === 1)
        result = squad.nodeGet(integer(args[0]));
      else if (action === "create" && args.length) {
        if (args[0] === "--json") {
          if (args.length !== 2)
            throw new Error("usage: squad node create --json '<fields>'");
          result = squad.nodeCreate(JSON.parse(args[1]!));
        } else {
          if (args.some((arg) => arg.startsWith("--")))
            throw new Error("node: use --json for named fields");
          const question = args.join(" ");
          result = squad.nodeCreate({ title: question, question });
        }
      } else if (action === "update" && args.length === 3)
        result = squad.nodeUpdate(
          integer(args[0]),
          integer(args[1]),
          JSON.parse(args[2]!),
        );
      else if (action === "claim" && (args.length === 2 || args.length === 3))
        result = squad.nodeClaim(integer(args[0]), integer(args[1]), args[2]);
      else if (
        action === "review" &&
        (args.length === 2 ||
          (args.length === 4 &&
            args[2] === "--build-timeout-ms" &&
            /^[1-9][0-9]*$/.test(args[3]!)))
      ) {
        const controller = new AbortController();
        const abort = () => controller.abort();
        process.once("SIGINT", abort);
        process.once("SIGTERM", abort);
        try {
          result = await squad.nodeReview(
            integer(args[0]),
            JSON.parse(args[1]!),
            {
              build_timeout_ms:
                args[3] === undefined ? undefined : Number(args[3]),
              signal: controller.signal,
            },
          );
        } finally {
          process.removeListener("SIGINT", abort);
          process.removeListener("SIGTERM", abort);
        }
      } else if (action === "submit" && args.length === 4) {
        if (!/^(0|[1-9][0-9]*)$/.test(args[3]!))
          throw new Error("node: invalid configuration revision");
        result = squad.nodeSubmit(
          integer(args[0]),
          integer(args[1]),
          args[2]!,
          Number(args[3]),
        );
      } else
        throw new Error(COMMAND_USAGE.node);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case "bank": {
      if (!rest[0] || rest[0].startsWith("--") || (rest.length !== 1 && (rest.length !== 3 || rest[1] !== "--build-timeout-ms" || !/^[1-9][0-9]*$/.test(rest[2]!))))
        throw new Error(COMMAND_USAGE.bank);
      const controller = new AbortController();
      const abort = () => controller.abort();
      process.once("SIGINT", abort); process.once("SIGTERM", abort);
      try {
        const result = await squad.bank(rest[0], { build_timeout_ms: rest[2] === undefined ? undefined : Number(rest[2]), signal: controller.signal });
        console.log(JSON.stringify(result, null, 2));
        if (result.status !== "verified") process.exitCode = 1;
      } finally { process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort); }
      break;
    }
    case "integration": {
      const [action = "show", ...args] = rest;
      if (action === "attempt") {
        if (args.length !== 1) throw new Error("usage: squad integration attempt <id>");
        console.log(JSON.stringify(squad.integrationAttempt(args[0]!), null, 2));
        break;
      }
      if (action === "submit" || action === "attempts") {
        const options: Record<string, string> = {};
        const commits: string[] = [], nodes: string[] = [], paths: string[] = [];
        const allowed = action === "submit" ? ["request-key", "config-revision", "commit", "node", "node-revisions", "path", "theorem"] : ["status", "limit"];
        for (let i = 0; i < args.length; i += 2) {
          const key = args[i]!.replace(/^--/, "");
          const value = args[i + 1];
          if (!args[i]!.startsWith("--") || !allowed.includes(key) || value === undefined || key in options) throw new Error(`integration: invalid or duplicate flag ${args[i]}`);
          if (key === "commit") commits.push(value);
          else if (key === "node") nodes.push(value);
          else if (key === "path") paths.push(value);
          else options[key] = value;
        }
        const numeric = action === "submit" ? "config-revision" : "limit";
        if ((action === "submit" || options[numeric] !== undefined) && !/^(0|[1-9][0-9]*)$/.test(options[numeric] ?? "")) throw new Error(`integration: ${numeric} must be a non-negative integer`);
        const result = action === "submit" ? squad.integrationSubmit({ request_key: options["request-key"]!, config_revision: Number(options["config-revision"]), commits, node_refs: nodes, ...(options["node-revisions"] ? { node_revisions: JSON.parse(options["node-revisions"]) } : {}), ...(paths.length || options.theorem !== undefined ? { selection: { paths, ...(options.theorem === undefined ? {} : { theorem: options.theorem }) } } : {}) })
          : squad.integrationAttempts({ status: options.status as import("./integration-ledger.js").IntegrationStatus | undefined, limit: options.limit === undefined ? undefined : Number(options.limit) });
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      if (action === "show" || action === "check") {
        if (args.length) throw new Error("usage: squad integration show|check");
        console.log(JSON.stringify(action === "show" ? squad.integrationGet() : squad.integrationValidate(), null, 2));
        break;
      }
      const flags: Record<string, string> = {};
      const allowed = action === "set" ? ["repository", "remote", "branch", "build-command", "steward", "expected-revision"] : ["expected-revision"];
      if (!["set", "unset"].includes(action)) throw new Error("usage: squad integration show|check|set|unset");
      for (let i = 0; i < args.length; i += 2) {
        const key = args[i]!.replace(/^--/, "");
        if (!args[i]!.startsWith("--") || !allowed.includes(key) || key in flags || args[i + 1] === undefined) {
          throw new Error(`integration: invalid or duplicate flag ${args[i]}`);
        }
        flags[key] = args[i + 1]!;
      }
      if (allowed.some(key => !(key in flags)) || !/^(0|[1-9][0-9]*)$/.test(flags["expected-revision"]!)) {
        throw new Error(`integration: required flags: ${allowed.map(key => "--" + key).join(" ")}; expected-revision must be a non-negative integer`);
      }
      const revision = Number(flags["expected-revision"]);
      const state = action === "unset" ? squad.integrationUnset(revision) : squad.integrationSet({
        repository: flags.repository!, remote: flags.remote!, branch: flags.branch!,
        build_command: flags["build-command"]!, steward: flags.steward!,
      }, revision);
      console.log(JSON.stringify(state, null, 2));
      break;
    }
    case "send": {
      const body = rest.join(" ").trim();
      if (!body) throw new Error(COMMAND_USAGE.send);
      // Posting is the one command that puts words in somebody's mouth: with
      // neither SQUAD_PERSONA nor SQUAD_SESSION_ID set, the shared default
      // above stamps the message `human`, i.e. attributes it to the operator
      // (#119). Defaulting to `human` is intentional and documented for every
      // other command, so the warning is scoped to `send` -- but it says so
      // out loud, on stderr, so the body still pipes cleanly from stdout.
      if (!process.env.SQUAD_PERSONA && !process.env.SQUAD_SESSION_ID) {
        process.stderr.write(
          "squad: no SQUAD_PERSONA or SQUAD_SESSION_ID set -- posting as 'human' " +
            "(the operator). Set SQUAD_PERSONA=<name> to post under your own identity.\n",
        );
      }
      const m = squad.send(body);
      console.log(fmt(m));
      break;
    }
    case "read": {
      let limit = 30;
      const nIdx = rest.indexOf("-n");
      if (nIdx !== -1) limit = parseInt(rest[nIdx + 1] ?? "30", 10);
      for (const m of squad.read(limit)) console.log(fmt(m));
      break;
    }
    case "tail": {
      for (const m of squad.read(15)) console.log(fmt(m));
      let last = squad.read(1).at(-1)?.id ?? 0;
      // Poll loop; stateless (never touches a cursor), safe to leave running.
      for (;;) {
        await new Promise((r) => setTimeout(r, 1000));
        const fresh = db
          .prepare("SELECT * FROM messages WHERE id > ? ORDER BY id ASC")
          .all(last) as unknown as Message[];
        for (const m of fresh) {
          console.log(fmt(m));
          last = m.id;
        }
      }
    }
    case "goals": {
      const [sub, ...args] = rest;
      if (sub === "add") {
        const body = args.join(" ").trim();
        if (!body) throw new Error("usage: squad goals add <text...>");
        const g = squad.goalAdd(body);
        console.log(`added goal #${g.id}: ${g.body}`);
      } else if (sub === "done") {
        const id = parseInt(args[0] ?? "", 10);
        if (Number.isNaN(id)) throw new Error("usage: squad goals done <id>");
        const g = squad.goalDone(id);
        console.log(`goal #${g.id} done: ${g.body}`);
      } else if (sub === "reopen") {
        const id = parseInt(args[0] ?? "", 10);
        if (Number.isNaN(id)) throw new Error("usage: squad goals reopen <id>");
        const wasOpen = squad.goals().some((g) => g.id === id);
        const g = squad.goalReopen(id);
        if (wasOpen) console.log(`goal #${g.id} is already open: ${g.body}`);
        else console.log(`goal #${g.id} reopened: ${g.body}`);
      } else if (sub === undefined) {
        const goals = squad.goals(true);
        if (goals.length === 0) console.log("no goals yet — squad goals add <text...>");
        for (const g of goals) {
          const mark = g.status === "done" ? "x" : " ";
          console.log(`[${mark}] #${g.id} ${g.body} (${g.created_by})`);
        }
      } else {
        throw new Error(COMMAND_USAGE.goals);
      }
      break;
    }
    case "claims": {
      const claims = squad.claims();
      if (claims.length === 0) console.log("no claims — squad claim <path>");
      for (const c of claims) {
        const mark = c.stale ? " (stale)" : "";
        console.log(`${c.path}\t${c.persona}${mark}\tsince ${c.created_ts}`);
      }
      break;
    }
    case "claim": {
      const path = rest.join(" ").trim();
      if (!path) throw new Error(COMMAND_USAGE.claim);
      const c = squad.claim(path);
      console.log(`claimed ${c.path} (${c.persona})`);
      break;
    }
    case "release": {
      const path = rest.join(" ").trim();
      if (!path) throw new Error(COMMAND_USAGE.release);
      const released = squad.release(path);
      if (released.length === 0) console.log(`no claim on ${path}`);
      else console.log(`released ${path} (was ${released.map((c) => c.persona).join(", ")})`);
      break;
    }
    case "diverge": {
      const [sub, ...args] = rest;
      if (sub === "open") {
        const tokens = [...args];
        let cardId: number | undefined;
        let expectedParticipants: string[] | undefined;
        while (tokens[0] === "--card" || tokens[0] === "--expect") {
          const flag = tokens.shift();
          const val = tokens.shift();
          if (flag === "--card") {
            cardId = parseInt(val ?? "", 10);
            if (Number.isNaN(cardId)) throw new Error("usage: squad diverge open --card <id> ...");
          } else {
            expectedParticipants = (val ?? "")
              .split(",")
              .map((p) => p.trim())
              .filter(Boolean);
          }
        }
        const topic = tokens.join(" ").trim();
        if (!topic) {
          throw new Error(
            "usage: squad diverge open [--card <id>] [--expect <p1,p2,...>] <topic...>",
          );
        }
        const round = squad.divergeOpen(topic, { cardId, expectedParticipants });
        console.log(`opened divergence round #${round.id}: ${round.topic}`);
      } else if (sub === "submit") {
        const id = parseInt(args[0] ?? "", 10);
        const body = args.slice(1).join(" ").trim();
        if (Number.isNaN(id) || !body) {
          throw new Error("usage: squad diverge submit <round_id> <text...>");
        }
        const s = squad.divergeSubmit(id, body);
        console.log(`submitted to round #${id} (${s.persona})`);
      } else if (sub === "status") {
        const id = parseInt(args[0] ?? "", 10);
        if (Number.isNaN(id)) throw new Error("usage: squad diverge status <round_id>");
        const status = squad.divergeStatus(id);
        console.log(`round #${status.round.id}: ${status.round.topic} [${status.round.status}]`);
        console.log(`submitted: ${status.submitted_personas.join(", ") || "none yet"}`);
        if (status.submissions) {
          for (const s of status.submissions) console.log(`  <${s.persona}> ${s.body}`);
        } else if (status.mine) {
          console.log(`  <${status.mine.persona}> ${status.mine.body} (yours; others hidden until close)`);
        }
      } else if (sub === "close") {
        const id = parseInt(args[0] ?? "", 10);
        if (Number.isNaN(id)) throw new Error("usage: squad diverge close <round_id>");
        const round = squad.divergeClose(id);
        console.log(`round #${round.id} closed`);
      } else {
        throw new Error(COMMAND_USAGE.diverge);
      }
      break;
    }
    case "review": {
      const [sub, ...args] = rest;
      if (sub === "open") {
        const tokens = [...args];
        let target: string | undefined;
        let priority: ReviewPriority | undefined;
        let refs: string[] | undefined;
        let expiresInMinutes: number | undefined;
        while (
          tokens[0] === "--to" ||
          tokens[0] === "--priority" ||
          tokens[0] === "--refs" ||
          tokens[0] === "--expires-in"
        ) {
          const flag = tokens.shift();
          const val = tokens.shift();
          if (flag === "--to") {
            target = (val ?? "").trim();
          } else if (flag === "--priority") {
            if (!REVIEW_PRIORITIES.includes(val as ReviewPriority)) {
              throw new Error(`usage: squad review open --priority ${REVIEW_PRIORITIES.join("|")} ...`);
            }
            priority = val as ReviewPriority;
          } else if (flag === "--refs") {
            refs = (val ?? "")
              .split(",")
              .map((r) => r.trim())
              .filter(Boolean);
          } else {
            expiresInMinutes = Number(val);
            if (!Number.isFinite(expiresInMinutes)) {
              throw new Error("usage: squad review open --expires-in <minutes> ...");
            }
          }
        }
        const body = tokens.join(" ").trim();
        if (!target || !body) throw new Error(REVIEW_OPEN_USAGE);
        const req = squad.reviewOpen(target, body, { refs, priority, expiresInMinutes });
        console.log(`opened review #${req.id} for ${req.target} [${req.priority}]: ${req.body}`);
      } else if (sub === "list" || sub === undefined) {
        const tokens = [...args];
        const all = tokens.includes("--all");
        let target: string | undefined;
        let requestedBy: string | undefined;
        let status: ReviewStatus | undefined;
        while (tokens.length > 0) {
          const flag = tokens.shift();
          if (flag === "--all") continue;
          const val = tokens.shift();
          if (flag === "--to" || flag === "--from" || flag === "--status") {
            // A missing value would otherwise silently read as "" (or, for
            // --status, as a typo'd status that matches nothing) — a filter
            // that quietly says "nothing to do" is the worst failure mode for
            // a gating primitive, so reject it loudly instead.
            const value = (val ?? "").trim();
            if (!value) throw new Error(`${REVIEW_LIST_USAGE} (${flag} needs a value)`);
            if (flag === "--to") target = value;
            else if (flag === "--from") requestedBy = value;
            else {
              if (!REVIEW_STATUSES.includes(value as ReviewStatus)) {
                throw new Error(
                  `${REVIEW_LIST_USAGE} (invalid status "${value}" — must be one of ${REVIEW_STATUSES.join(", ")})`,
                );
              }
              status = value as ReviewStatus;
            }
          } else throw new Error(`${REVIEW_LIST_USAGE} (unrecognized flag '${flag ?? ""}')`);
        }
        const requests = squad.reviewList({
          target,
          requestedBy,
          status,
          includeTerminal: all,
          includeExpired: all,
        });
        if (requests.length === 0) {
          console.log(
            all
              ? "no review requests yet — squad review open --to <persona> <body...>"
              : "no open review requests",
          );
        }
        for (const r of requests) {
          const mark = r.expired ? " (expired)" : "";
          console.log(
            `[${r.status}] #${r.id} ${r.requested_by} -> ${r.target} [${r.priority}]${mark} ${r.body}`,
          );
        }
      } else if (sub === "show") {
        const id = parseInt(args[0] ?? "", 10);
        if (Number.isNaN(id)) throw new Error("usage: squad review show <id>");
        const r = squad.reviewGet(id);
        console.log(
          `#${r.id} [${r.status}${r.expired ? ", expired" : ""}] ` +
            `${r.requested_by} -> ${r.target} [${r.priority}]`,
        );
        console.log(`  ${r.body}`);
        if (r.refs.length > 0) console.log(`  refs: ${r.refs.join(", ")}`);
        console.log(`  opened ${r.created_ts}${r.expires_ts ? `, expires ${r.expires_ts}` : ""}`);
        if (r.claimed_by) console.log(`  claimed by ${r.claimed_by} at ${r.claimed_ts}`);
        if (r.resolved_by) {
          console.log(
            `  resolved by ${r.resolved_by} at ${r.resolved_ts}` +
              `${r.resolution ? `: ${r.resolution}` : ""}`,
          );
        }
        if (r.cancelled_by) {
          console.log(
            `  cancelled by ${r.cancelled_by} at ${r.cancelled_ts}` +
              `${r.cancel_reason ? `: ${r.cancel_reason}` : ""}`,
          );
        }
      } else if (sub === "claim") {
        const id = parseInt(args[0] ?? "", 10);
        if (Number.isNaN(id)) throw new Error("usage: squad review claim <id>");
        const r = squad.reviewClaim(id);
        console.log(`claimed review #${r.id} (${r.claimed_by})`);
      } else if (sub === "resolve") {
        const id = parseInt(args[0] ?? "", 10);
        if (Number.isNaN(id)) throw new Error("usage: squad review resolve <id> [note...]");
        const resolution = args.slice(1).join(" ").trim() || undefined;
        const r = squad.reviewResolve(id, resolution);
        console.log(`resolved review #${r.id}${r.resolution ? `: ${r.resolution}` : ""}`);
      } else if (sub === "cancel") {
        const id = parseInt(args[0] ?? "", 10);
        if (Number.isNaN(id)) throw new Error("usage: squad review cancel <id> [reason...]");
        const reason = args.slice(1).join(" ").trim() || undefined;
        const r = squad.reviewCancel(id, reason);
        console.log(`cancelled review #${r.id}${r.cancel_reason ? `: ${r.cancel_reason}` : ""}`);
      } else {
        throw new Error(COMMAND_USAGE.review);
      }
      break;
    }
    case "card": {
      const [sub, ...args] = rest;
      if (sub === "create") {
        const tokens = [...args];
        let title: string | undefined;
        let claimKind: "empirical" | "formal" | undefined;
        while (tokens[0] === "--title" || tokens[0] === "--claim-kind") {
          const flag = tokens.shift();
          const val = tokens.shift();
          if (flag === "--title") {
            title = (val ?? "").trim();
          } else {
            if (val !== "empirical" && val !== "formal") {
              throw new Error("usage: squad card create --claim-kind empirical|formal ...");
            }
            claimKind = val;
          }
        }
        const question = tokens.join(" ").trim();
        if (!question) {
          throw new Error(
            "usage: squad card create [--title <text>] [--claim-kind empirical|formal] <question...>",
          );
        }
        const card = squad.cardCreate({
          title: title || question,
          question,
          claim_kind: claimKind,
        });
        console.log(`opened card #${card.id} [${card.phase}]: ${card.title}`);
      } else if (sub === "list") {
        const showAll = args.includes("--all");
        const cards = squad.cardList();
        const filtered = showAll
          ? cards
          : cards.filter((c) => !CARD_TERMINAL_PHASES.includes(c.phase));
        if (filtered.length === 0) {
          console.log(
            showAll
              ? "no cards yet — squad card create <question...>"
              : "no active cards — squad card create <question...> (or pass --all to include done cards)",
          );
        }
        for (const c of filtered) {
          console.log(`[${c.phase}] #${c.id} ${c.title} (${c.claim_kind})`);
        }
      } else if (sub === "show") {
        const id = parseInt(args[0] ?? "", 10);
        if (Number.isNaN(id)) throw new Error("usage: squad card show <id>");
        const card = squad.cardGet(id);
        console.log(`#${card.id} [${card.phase}] ${card.title} (${card.claim_kind})`);
        console.log(`  question: ${card.question}`);
        console.log(`  created by ${card.created_by} at ${card.created_ts}`);
        if (card.transitions.length === 0) {
          console.log("  transitions: none");
        } else {
          console.log("  transitions:");
          for (const t of card.transitions) {
            console.log(`    ${t.ts} ${t.persona} ${t.from_phase} -> ${t.to_phase}${t.note ? `: ${t.note}` : ""}`);
          }
        }
        if (card.evidence.length === 0) {
          console.log("  evidence: none");
        } else {
          console.log("  evidence:");
          for (const e of card.evidence) {
            console.log(`    #${e.id} [${e.type}] ${e.provenance} (${e.persona})${e.body ? `: ${e.body}` : ""}`);
          }
        }
      } else if (sub === "transition") {
        const id = parseInt(args[0] ?? "", 10);
        const toPhase = args[1] as CardPhase | undefined;
        const note = args.slice(2).join(" ").trim() || undefined;
        if (Number.isNaN(id) || !toPhase) {
          throw new Error("usage: squad card transition <id> <phase> [note...]");
        }
        const card = squad.cardTransition(id, toPhase, note);
        console.log(`card #${card.id} -> ${card.phase}`);
      } else if (sub === "evidence") {
        const id = parseInt(args[0] ?? "", 10);
        const type = args[1] as EvidenceType | undefined;
        const provenance = args[2];
        const body = args.slice(3).join(" ").trim() || undefined;
        if (Number.isNaN(id) || !type || !provenance) {
          throw new Error("usage: squad card evidence <id> <type> <provenance> [body...]");
        }
        const ev = squad.cardEvidenceAdd(id, type, provenance, body);
        console.log(`added ${ev.type} evidence #${ev.id} to card #${id}: ${ev.provenance}`);
      } else if (sub === "edit") {
        const id = parseInt(args[0] ?? "", 10);
        if (Number.isNaN(id)) throw new Error(CARD_EDIT_USAGE);
        const tokens = args.slice(1);
        if (tokens.length === 0) throw new Error(CARD_EDIT_USAGE);
        const fields: Partial<Record<keyof CardUpdateFields, unknown>> = {};
        while (tokens.length > 0) {
          const flag = tokens.shift();
          const fieldKey = flag !== undefined ? CARD_EDIT_FLAGS[flag] : undefined;
          if (!fieldKey) {
            throw new Error(`${CARD_EDIT_USAGE} (unrecognized flag '${flag ?? ""}')`);
          }
          const raw = tokens.shift();
          if (raw === undefined) {
            throw new Error(`${CARD_EDIT_USAGE} (${flag} needs a value)`);
          }
          if (CARD_EDIT_LIST_FIELDS.has(fieldKey)) {
            fields[fieldKey] = raw
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
          } else if (CARD_EDIT_NUMBER_FIELDS.has(fieldKey)) {
            const n = Number(raw);
            if (Number.isNaN(n)) throw new Error(`${CARD_EDIT_USAGE} (${flag} needs a number)`);
            fields[fieldKey] = n;
          } else {
            fields[fieldKey] = raw;
          }
        }
        const card = squad.cardUpdate(id, fields as CardUpdateFields);
        console.log(`card #${card.id} updated [${card.phase}]: ${card.title}`);
      } else {
        throw new Error(COMMAND_USAGE.card);
      }
      break;
    }
    case "who": {
      const members = squad.members();
      if (members.length === 0) console.log("nobody in the room");
      for (const m of members) {
        const extra = m.sessions > 1 ? ` (${m.sessions} sessions)` : "";
        console.log(`${m.persona}\t${m.state}\tlast seen ${m.last_seen}${extra}`);
      }
      break;
    }
    case "leave": {
      const left = squad.leave();
      if (left.sessions_ended.length === 0) console.log(`${squad.persona} is not in the room`);
      else
        console.log(
          `${squad.persona} left the room (${left.sessions_ended.length} session(s) ended)`,
        );
      break;
    }
    case "clear": {
      squad.clear();
      console.log(`cleared room at ${dbPath()}`);
      break;
    }
    case "export": {
      const destPath = rest[0];
      if (!destPath) throw new Error(COMMAND_USAGE.export);
      const counts = await squad.exportRoom(destPath);
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      console.log(`exported ${total} row(s) across ${Object.keys(counts).length} tables to ${destPath}`);
      break;
    }
    case "import": {
      const srcPath = rest[0];
      if (!srcPath) throw new Error(COMMAND_USAGE.import);
      const counts = squad.importRoom(srcPath);
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      console.log(`imported ${total} row(s) across ${Object.keys(counts).length} tables from ${srcPath} into ${dbPath()}`);
      break;
    }
    case "nuke": {
      // Undocumented big hammer: remove the whole data dir.
      rmSync(squadDir(), { recursive: true, force: true });
      console.log(`removed ${squadDir()}`);
      break;
    }
    default:
      process.stderr.write(`squad: unknown command '${cmd}'\n\n${HELP}`);
      process.exitCode = 1;
  }
}

export function knownCommand(cmd: string | undefined): boolean {
  return (
    cmd !== undefined &&
    [
      "steward",
      "outline",
      "node",
      "bank",
      "integration",
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
      "nuke",
      "path",
      "doctor",
      "codex-reentry",
      "relay",
      "help",
      "--help",
      "-h",
    ].includes(cmd)
  );
}

export { HELP, COMMAND_USAGE };
