import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openDb, dbPath } from "./db.js";
import { Squad } from "./core.js";

const MAX_WAIT_SECONDS = 240;

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export async function runMcpServer(): Promise<void> {
  const persona = process.env.SQUAD_PERSONA;
  if (!persona) {
    console.error(
      "squad: SQUAD_PERSONA is not set. Add it to the MCP server config, e.g.\n" +
        '  { "command": "squad", "env": { "SQUAD_PERSONA": "claude" } }',
    );
    process.exit(1);
  }
  const db = openDb();
  const squad = new Squad(db, persona);

  const server = new McpServer({ name: "squad", version: "0.1.0" });

  server.registerTool(
    "squad_join",
    {
      description:
        "Join the squad room: registers your presence and returns who else is here, the " +
        "current open goals, and recent chat history. Advances your read cursor past the " +
        "returned history, so squad_check afterwards yields only new messages. Idempotent — " +
        "call again anytime to re-sync.",
      inputSchema: {},
    },
    async () => json({ persona, db: dbPath(), ...squad.join() }),
  );

  server.registerTool(
    "squad_send",
    {
      description:
        "Post a message to the squad room. Everyone in the room sees it on their next check. " +
        "Address a specific teammate with an @mention in the body (e.g. '@codex can you take #2?').",
      inputSchema: { body: z.string().min(1).describe("The message text") },
    },
    async ({ body }) => json(squad.send(body)),
  );

  server.registerTool(
    "squad_check",
    {
      description:
        "Fetch your unread messages (your durable read cursor; excludes your own messages) and " +
        "consume them. Pass wait_seconds to long-poll: the call blocks until a new message " +
        "arrives or the wait expires, which is how to hold a live conversation without busy-" +
        "polling. Keep wait_seconds at 25 or below unless the MCP tool timeout has been raised.",
      inputSchema: {
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(MAX_WAIT_SECONDS)
          .optional()
          .describe("Block up to this many seconds waiting for new messages (default 0)"),
        peek: z
          .boolean()
          .optional()
          .describe("If true, do not advance the read cursor (default false)"),
      },
    },
    async ({ wait_seconds, peek }) => {
      const messages = await squad.checkWait(wait_seconds ?? 0, { peek });
      return json({ messages, open_goals: squad.goals().length });
    },
  );

  server.registerTool(
    "squad_goals",
    {
      description: "List the squad's shared goals. Open goals by default.",
      inputSchema: {
        include_done: z.boolean().optional().describe("Also include completed goals"),
      },
    },
    async ({ include_done }) => json(squad.goals(include_done ?? false)),
  );

  server.registerTool(
    "squad_goal_add",
    {
      description:
        "Add a shared goal to the squad board. The addition is announced in chat as a system " +
        "message, so teammates learn of it through their normal squad_check loop.",
      inputSchema: { body: z.string().min(1).describe("What the squad should accomplish") },
    },
    async ({ body }) => json(squad.goalAdd(body)),
  );

  server.registerTool(
    "squad_goal_done",
    {
      description:
        "Mark a shared goal as done, announced in chat as a system message. Only mark goals " +
        "you have actually verified complete.",
      inputSchema: { id: z.number().int().describe("The goal id") },
    },
    async ({ id }) => json(squad.goalDone(id)),
  );

  server.registerTool(
    "squad_clear",
    {
      description:
        "Wipe the room: deletes all messages, goals, cursors, and member records for a fresh " +
        "session. Destructive — only call when the user has asked for a reset.",
      inputSchema: {},
    },
    async () => {
      squad.clear();
      return json({ cleared: true });
    },
  );

  await server.connect(new StdioServerTransport());
}
