import { openDb, dbPath, squadDir } from "./db.js";
import { Squad, type Message } from "./core.js";
import { rmSync } from "node:fs";

const HELP = `squad — local cross-agent chat room with shared goals

With no subcommand (and stdin not a TTY) squad runs as a stdio MCP server.

Human CLI usage:
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
  squad diverge open <topic...> [--card <id>] [--participants a,b,c]
                               Open a divergence round (submissions hidden until reveal)
  squad diverge submit <round_id> <text...>
                               Submit your independent contribution to an open round
  squad diverge status <round_id>
                               Check a round (metadata only while open, full reveal once closed)
  squad diverge close <round_id>
                               Explicitly close a round, revealing all submissions
  squad who                   Show members and last-seen times
  squad clear                 Wipe messages, goals, claims, cursors, members
  squad path                  Print the database path
  squad doctor                Preflight: runtime deps resolve, DB reachable, persona resolves
  squad help                  Show this help

The room is per-repo: data lives in <repo-root>/.squad/, found by walking up
from the current directory (falling back to ~/.squad outside any repo). Inside
a git worktree the room is the primary clone's, so every worktree shares one.

Environment:
  SQUAD_PERSONA   Identity stamped on messages (default: human)
  SQUAD_DIR       Override the data directory (skips repo-root resolution)
  SQUAD_STALE_MINUTES  Minutes of holder absence after which a claim lists as
                  stale (default 30)
`;

function fmt(m: Message): string {
  const time = m.ts.slice(11, 19);
  return m.kind === "system" ? `${time} -- ${m.body}` : `${time} <${m.sender}> ${m.body}`;
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
      "not pinned -- the MCP server autodetects from the host harness (Claude Code -> claude, " +
      "Codex -> codex, else 'agent'); this CLI defaults to 'human'",
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

export async function runCli(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  if (cmd === "help" || cmd === "--help" || cmd === "-h" || cmd === undefined) {
    process.stdout.write(HELP);
    return;
  }
  if (cmd === "path") {
    console.log(dbPath());
    return;
  }
  if (cmd === "doctor") {
    await runDoctor();
    return;
  }

  const persona = process.env.SQUAD_PERSONA ?? "human";
  const db = openDb();
  const squad = new Squad(db, persona);

  switch (cmd) {
    case "send": {
      const body = rest.join(" ").trim();
      if (!body) throw new Error("usage: squad send <text...>");
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
        throw new Error("usage: squad goals [add <text...> | done <id> | reopen <id>]");
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
      if (!path) throw new Error("usage: squad claim <path>");
      const c = squad.claim(path);
      console.log(`claimed ${c.path} (${c.persona})`);
      break;
    }
    case "release": {
      const path = rest.join(" ").trim();
      if (!path) throw new Error("usage: squad release <path>");
      const released = squad.release(path);
      if (released.length === 0) console.log(`no claim on ${path}`);
      else console.log(`released ${path} (was ${released.map((c) => c.persona).join(", ")})`);
      break;
    }
    case "diverge": {
      const [sub, ...args] = rest;
      if (sub === "open") {
        let cardId: number | undefined;
        let expectedParticipants: string[] | undefined;
        const positional: string[] = [];
        for (let i = 0; i < args.length; i++) {
          if (args[i] === "--card") {
            cardId = parseInt(args[++i] ?? "", 10);
          } else if (args[i] === "--participants") {
            expectedParticipants = (args[++i] ?? "")
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
          } else {
            positional.push(args[i]);
          }
        }
        const topic = positional.join(" ").trim();
        if (!topic) {
          throw new Error(
            "usage: squad diverge open <topic...> [--card <id>] [--participants a,b,c]",
          );
        }
        const round = squad.divergeOpen(topic, { cardId, expectedParticipants });
        console.log(`opened divergence round #${round.id}: ${round.topic}`);
      } else if (sub === "submit") {
        const roundId = parseInt(args[0] ?? "", 10);
        const body = args.slice(1).join(" ").trim();
        if (Number.isNaN(roundId) || !body) {
          throw new Error("usage: squad diverge submit <round_id> <text...>");
        }
        const status = squad.divergeSubmit(roundId, body);
        const closedNote = status.round.status === "closed" ? " (round is now closed)" : "";
        console.log(`submitted to round #${roundId}${closedNote}`);
      } else if (sub === "status") {
        const roundId = parseInt(args[0] ?? "", 10);
        if (Number.isNaN(roundId)) throw new Error("usage: squad diverge status <round_id>");
        console.log(JSON.stringify(squad.divergeStatus(roundId), null, 2));
      } else if (sub === "close") {
        const roundId = parseInt(args[0] ?? "", 10);
        if (Number.isNaN(roundId)) throw new Error("usage: squad diverge close <round_id>");
        console.log(JSON.stringify(squad.divergeClose(roundId), null, 2));
      } else {
        throw new Error("usage: squad diverge <open|submit|status|close> ...");
      }
      break;
    }
    case "who": {
      for (const m of squad.members()) console.log(`${m.persona}\tlast seen ${m.last_seen}`);
      break;
    }
    case "clear": {
      squad.clear();
      console.log(`cleared room at ${dbPath()}`);
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
      "send",
      "read",
      "tail",
      "goals",
      "claims",
      "claim",
      "release",
      "diverge",
      "who",
      "clear",
      "nuke",
      "path",
      "doctor",
      "help",
      "--help",
      "-h",
    ].includes(cmd)
  );
}

export { HELP };
