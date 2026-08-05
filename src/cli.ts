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
  squad who                   Show members and last-seen times
  squad clear                 Wipe messages, goals, cursors, members
  squad path                  Print the database path
  squad help                  Show this help

The room is per-repo: data lives in <repo-root>/.squad/, found by walking up
from the current directory (falling back to ~/.squad outside any repo).

Environment:
  SQUAD_PERSONA   Identity stamped on messages (default: human)
  SQUAD_DIR       Override the data directory (skips repo-root resolution)
`;

function fmt(m: Message): string {
  const time = m.ts.slice(11, 19);
  return m.kind === "system" ? `${time} -- ${m.body}` : `${time} <${m.sender}> ${m.body}`;
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
      } else if (sub === undefined) {
        const goals = squad.goals(true);
        if (goals.length === 0) console.log("no goals yet — squad goals add <text...>");
        for (const g of goals) {
          const mark = g.status === "done" ? "x" : " ";
          console.log(`[${mark}] #${g.id} ${g.body} (${g.created_by})`);
        }
      } else {
        throw new Error("usage: squad goals [add <text...> | done <id>]");
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
    ["send", "read", "tail", "goals", "who", "clear", "nuke", "path", "help", "--help", "-h"].includes(cmd)
  );
}

export { HELP };
