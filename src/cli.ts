import { openDb, dbPath, squadDir } from "./db.js";
import {
  Squad,
  CARD_TERMINAL_PHASES,
  type CardPhase,
  type EvidenceType,
  type Message,
} from "./core.js";
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
  squad diverge open [--card <id>] [--expect <p1,p2,...>] <topic...>
                               Open a divergence round (hidden until reveal)
  squad diverge submit <round_id> <text...>
                               Submit your independent entry to an open round
  squad diverge status <round_id>
                               Show round metadata (+ your own submission if made);
                               full submissions only once the round is closed
  squad diverge close <round_id>
                               Explicitly close a round and reveal all submissions
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
  squad who                   Show members and last-seen times
  squad clear                 Wipe messages, goals, claims, cursors, members, and
                               divergence rounds/submissions
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
        throw new Error("usage: squad diverge [open|submit|status|close] ...");
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
      } else {
        throw new Error("usage: squad card [create|list|show|transition|evidence] ...");
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
      "card",
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
