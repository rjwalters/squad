import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openDb, dbPath } from "./db.js";
import { Squad, CARD_PHASES, CARD_TERMINAL_PHASES, EVIDENCE_TYPES } from "./core.js";
import type { CardPhase, EvidenceType } from "./core.js";

const MAX_WAIT_SECONDS = 240;

// zod's `.enum()` wants a non-empty literal tuple; CARD_PHASES/EVIDENCE_TYPES
// are the runtime source of truth (src/core.ts) but are typed as plain
// `readonly CardPhase[]`/`readonly EvidenceType[]`, so the shape is asserted
// here rather than re-declared.
const CARD_PHASE_ENUM = CARD_PHASES as unknown as [CardPhase, ...CardPhase[]];
const EVIDENCE_TYPE_ENUM = EVIDENCE_TYPES as unknown as [EvidenceType, ...EvidenceType[]];

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

/**
 * Best-effort harness detection so the persona autofills when SQUAD_PERSONA
 * isn't configured. Claude Code sets CLAUDECODE in child processes; Codex
 * exports CODEX_*-prefixed variables.
 */
function detectPersona(): string | null {
  const env = process.env;
  if (env.CLAUDECODE || Object.keys(env).some((k) => k.startsWith("CLAUDE_CODE"))) {
    return "claude";
  }
  if (Object.keys(env).some((k) => k.startsWith("CODEX"))) return "codex";
  return null;
}

export async function runMcpServer(): Promise<void> {
  // An explicit SQUAD_PERSONA is pinned: it wins and cannot be renamed by the
  // agent (identity stays server-stamped). Otherwise autofill from the host
  // harness, with "agent" as the last resort — renameable via squad_join.
  const pinned = process.env.SQUAD_PERSONA;
  const persona = pinned ?? detectPersona() ?? "agent";
  const db = openDb();
  const squad = new Squad(db, persona);

  const server = new McpServer({ name: "squad", version: "0.2.0" });

  server.registerTool(
    "squad_join",
    {
      description:
        "Join the squad room: registers your presence and returns who else is here, the " +
        "current open goals, the advisory file claims, and recent chat history. Advances your read cursor past the " +
        "returned history, so squad_check afterwards yields only new messages. Idempotent — " +
        "call again anytime to re-sync. Your identity autofills from the host harness; the " +
        "optional persona argument renames this connection, but is ignored (with a note in " +
        "the result) when the identity was pinned via SQUAD_PERSONA config.",
      inputSchema: {
        persona: z
          .string()
          .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/i)
          .optional()
          .describe("Preferred identity for this connection (only honored when not pinned)"),
      },
    },
    async ({ persona: requested }) => {
      let note: string | undefined;
      if (requested && requested !== squad.persona) {
        if (pinned) note = `persona is pinned to '${pinned}' by config; rename ignored`;
        else squad.setPersona(requested);
      }
      return json({ persona: squad.persona, ...(note ? { note } : {}), db: dbPath(), ...squad.join() });
    },
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
      return json({
        messages,
        open_goals: squad.goals().length,
        active_claims: squad.claims().length,
      });
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
    "squad_goal_reopen",
    {
      description:
        "Reopen a goal that was mistakenly marked done: resets it to open and clears the " +
        "completion record, announced in chat as a system message. No-op if already open.",
      inputSchema: { id: z.number().int().describe("The goal id") },
    },
    async ({ id }) => json(squad.goalReopen(id)),
  );

  server.registerTool(
    "squad_claims",
    {
      description:
        "List the room's advisory claims: which persona says it is working on which file or " +
        "area, when the claim was staked, and whether it has gone stale (its holder has been " +
        "absent). Claims are visibility, not locks — check here before editing shared files.",
      inputSchema: {},
    },
    async () => json(squad.claims()),
  );

  server.registerTool(
    "squad_claim",
    {
      description:
        "Stake an advisory claim on a file path (or freeform area label) you are about to work " +
        "on, announced in chat as a system message so teammates see it in their normal " +
        "squad_check loop. Advisory, not a lock: claiming a path a teammate already holds is " +
        "allowed and the announcement names them so the conflict is visible. Claim before you " +
        "edit; release when you are done.",
      inputSchema: {
        path: z.string().min(1).describe("File path or area label you are working on"),
      },
    },
    async ({ path }) => json(squad.claim(path)),
  );

  server.registerTool(
    "squad_release",
    {
      description:
        "Drop your claim on a path, announced in chat as a system message. Releases your own " +
        "claim; if you hold none, releases a teammate's claim on that path — the explicit way " +
        "to take over a stale claim left by a departed agent. No-op when nothing is claimed.",
      inputSchema: { path: z.string().min(1).describe("The claimed path or label to release") },
    },
    async ({ path }) => json({ path, released: squad.release(path) }),
  );

  server.registerTool(
    "squad_card_create",
    {
      description:
        "Open a Science Card in the QUESTION phase, announced in chat as a system message. Only " +
        "title and question are required; the rest are optional fields filled in as the " +
        "investigation progresses.",
      inputSchema: {
        title: z.string().min(1).describe("Short card title"),
        question: z.string().min(1).describe("The question under investigation"),
        claim_kind: z
          .enum(["empirical", "formal"])
          .optional()
          .describe(
            "Whether SUPPORTED requires empirical evidence (default 'empirical') or can be " +
              "reached on formal evidence alone ('formal', for pure math/logic claims)",
          ),
        origin_method: z.string().optional().describe("Where this card came from"),
        origin_contributors: z.array(z.string()).optional().describe("Personas who contributed"),
        changed_assumptions: z.array(z.string()).optional().describe("Assumptions this card revises"),
        proposed_mechanism: z.string().optional().describe("The proposed mechanism"),
        math_model: z.string().optional().describe("The math model, if any"),
        standard_prediction: z.string().optional().describe("What the standard model predicts"),
        discriminating_prediction: z
          .string()
          .optional()
          .describe("What this card's mechanism predicts differently"),
        decisive_falsifier: z.string().optional().describe("What observation would falsify this card"),
        cheapest_test: z.string().optional().describe("The cheapest way to test the card"),
        prior_art_status: z.string().optional().describe("Known prior art, if any"),
        confidence: z.number().optional().describe("Current confidence, 0-1"),
        novelty: z.number().optional().describe("Estimated novelty, 0-1"),
        attempts: z.array(z.string()).optional().describe("Attempts made so far"),
        attacks: z.array(z.string()).optional().describe("Attacks/critiques made so far"),
        insights: z.array(z.string()).optional().describe("Insights gained so far"),
        post_mortems: z.array(z.string()).optional().describe("Post-mortems, if any"),
      },
    },
    async (fields) => json(squad.cardCreate(fields)),
  );

  server.registerTool(
    "squad_card_list",
    {
      description:
        "List Science Cards. Active (non-terminal-phase) cards by default; pass include_done to " +
        "also show SUPPORTED/FALSIFIED/INCONCLUSIVE/ABANDONED cards — negative outcomes are never " +
        "silently hidden when asked for.",
      inputSchema: {
        include_done: z
          .boolean()
          .optional()
          .describe("Also include SUPPORTED/FALSIFIED/INCONCLUSIVE/ABANDONED cards"),
      },
    },
    async ({ include_done }) => {
      const cards = squad.cardList();
      const filtered = include_done
        ? cards
        : cards.filter((c) => !CARD_TERMINAL_PHASES.includes(c.phase));
      return json(filtered);
    },
  );

  server.registerTool(
    "squad_card_get",
    {
      description:
        "Full detail for one Science Card: the card's fields plus its complete evidence and " +
        "phase-transition history.",
      inputSchema: { id: z.number().int().describe("The card id") },
    },
    async ({ id }) => json(squad.cardGet(id)),
  );

  server.registerTool(
    "squad_card_transition",
    {
      description:
        "Move a Science Card to a new phase, announced in chat as a system message. Validated " +
        "against the allowed-transition graph — an illegal transition (e.g. QUESTION -> " +
        "SUPPORTED) is rejected with an error naming the phases actually allowed from here. An " +
        "empirical-claim card also needs at least one experiment/observation evidence item " +
        "before it can reach SUPPORTED.",
      inputSchema: {
        id: z.number().int().describe("The card id"),
        to_phase: z.enum(CARD_PHASE_ENUM).describe("Target phase"),
        note: z.string().optional().describe("Optional note recorded with the transition"),
      },
    },
    async ({ id, to_phase, note }) => json(squad.cardTransition(id, to_phase, note)),
  );

  server.registerTool(
    "squad_card_evidence_add",
    {
      description:
        "Attach an evidence item to a Science Card, announced in chat as a system message. " +
        "Requires a type from the fixed enum and non-empty provenance.",
      inputSchema: {
        card_id: z.number().int().describe("The card id"),
        type: z.enum(EVIDENCE_TYPE_ENUM).describe("Evidence type"),
        provenance: z
          .string()
          .min(1)
          .describe("Where the evidence comes from (file path, run log, paper citation, etc.)"),
        body: z.string().optional().describe("Evidence content or summary"),
      },
    },
    async ({ card_id, type, provenance, body }) =>
      json(squad.cardEvidenceAdd(card_id, type, provenance, body)),
  );

  server.registerTool(
    "squad_diverge_open",
    {
      description:
        "Open a divergence round: a bounded window where each participant submits independently and " +
        "nobody's submission -- including your own, when someone else checks -- is visible to anyone " +
        "until the round closes, either explicitly via squad_diverge_close or automatically once every " +
        "persona in expected_participants has submitted. The chat announcement carries only the topic, " +
        "never a submission.",
      inputSchema: {
        topic: z.string().min(1).describe("What the round is diverging on"),
        card_id: z.number().int().optional().describe("Optional Science Card id this round belongs to"),
        expected_participants: z
          .array(z.string())
          .optional()
          .describe(
            "Personas expected to submit; once every one of them has submitted the round auto-closes",
          ),
      },
    },
    async ({ topic, card_id, expected_participants }) =>
      json(squad.divergeOpen(topic, { cardId: card_id, expectedParticipants: expected_participants })),
  );

  server.registerTool(
    "squad_diverge_submit",
    {
      description:
        "Submit your independent entry to an open divergence round. Resubmitting overwrites your prior " +
        "entry (idempotent, no duplicate). Never reveals another persona's submission -- those stay " +
        "hidden until the round closes.",
      inputSchema: {
        round_id: z.number().int().describe("The divergence round id"),
        body: z.string().min(1).describe("Your submission"),
      },
    },
    async ({ round_id, body }) => json(squad.divergeSubmit(round_id, body)),
  );

  server.registerTool(
    "squad_diverge_status",
    {
      description:
        "Check a divergence round. While open: shows which personas have submitted so far (never what " +
        "they submitted) plus your own submission, if you made one. Once closed: shows every submission.",
      inputSchema: { round_id: z.number().int().describe("The divergence round id") },
    },
    async ({ round_id }) => json(squad.divergeStatus(round_id)),
  );

  server.registerTool(
    "squad_diverge_close",
    {
      description:
        "Explicitly close a divergence round: reveals every submission to everyone and announces the " +
        "reveal in chat. Idempotent -- a no-op returning the current state if already closed.",
      inputSchema: { round_id: z.number().int().describe("The divergence round id") },
    },
    async ({ round_id }) => json(squad.divergeClose(round_id)),
  );

  server.registerTool(
    "squad_clear",
    {
      description:
        "Wipe the room: deletes all messages, goals, claims, cursors, and member records for a fresh " +
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
