import type { DatabaseSync } from "node:sqlite";
import { basename, dirname } from "node:path";
import { hostname } from "node:os";
import { squadDir } from "./db.js";

/**
 * Relay engine (#112, phase 1 of #109): ship room chat to a remote
 * OpenTelemetry collector (SigNoz and anything else speaking OTLP/HTTP) so a
 * room is visible somewhere other than the machine it lives on.
 *
 * This module is the engine only -- no CLI command, no MCP hook, nothing that
 * runs on its own. `relayOnce()` is a plain function a later phase wires up.
 * It is off unless `SQUAD_RELAY_ENDPOINT` is set, and it never throws at the
 * caller: a relay is an observability side channel, so an unreachable
 * collector must degrade to "nothing shipped, cursor unmoved" rather than
 * failing the room operation that triggered it.
 *
 * Delivery is a cursor-based outbox over the `messages` table: read rows past
 * `relay_cursors.last_message_id`, POST them as OTLP log records, and advance
 * the cursor only once the collector has accepted them. That is at-least-once
 * -- a 2xx lost on the way back re-ships the batch -- so every record carries
 * `squad.message_id`, which is stable for the life of the row and is the
 * de-dupe key on the dashboard side.
 *
 * No OTel SDK is involved. OTLP/HTTP's JSON encoding is an ordinary JSON body
 * (`ExportLogsServiceRequest`), so `fetch` is the whole transport and squad
 * takes no new dependency for it.
 *
 * Credential hygiene: `SQUAD_RELAY_HEADERS` is read from the environment on
 * every call and held only in the in-memory config. Nothing here writes it to
 * squad.db (and `target` below strips any query string, so a key smuggled
 * through the endpoint URL is not persisted either); the installer's .mcp.json
 * env block is an explicit allowlist that does not include it.
 */

/** OTLP/HTTP+JSON attribute value. int64 is a string in proto3 JSON. */
type OtlpValue = { stringValue: string } | { intValue: string };
interface OtlpAttribute {
  key: string;
  value: OtlpValue;
}

export interface OtlpLogRecord {
  timeUnixNano: string;
  observedTimeUnixNano: string;
  severityNumber: number;
  severityText: string;
  body: { stringValue: string };
  attributes: OtlpAttribute[];
}

export interface RelayConfig {
  /** Full OTLP logs endpoint, e.g. https://collector.example/v1/logs */
  endpoint: string;
  /** Extra request headers (auth). Never persisted. */
  headers: Record<string, string>;
  /** `squad.room` on every record. */
  room: string;
  /** `squad.repo_path` on every record. */
  repoPath: string;
  /** `host.name` (resource) and `squad.host` (record). */
  host: string;
  /** Message kinds to ship; null ships every kind. */
  kinds: string[] | null;
  /** Cursor key: the endpoint with query/userinfo stripped. */
  target: string;
  /** Max `messages` rows read (and records POSTed) per batch. */
  batchSize: number;
  /** Per-request timeout, ms. */
  timeoutMs: number;
  /** Shipping-lease duration, ms. */
  leaseMs: number;
}

export type RelayStatus = "ok" | "empty" | "lease-held" | "failed";

export interface RelayResult {
  /** The cursor key this pass operated on. */
  target: string;
  status: RelayStatus;
  /** `messages` rows consumed (including ones filtered out by `kinds`). */
  scanned: number;
  /** Log records the collector accepted. */
  shipped: number;
  /** Records the collector reported as rejected via OTLP partial success. */
  rejected: number;
  /** HTTP requests issued. */
  batches: number;
  /** `relay_cursors.last_message_id` after this pass. */
  cursor: number;
  /** Set when `status` is "failed": why nothing further was shipped. */
  error?: string;
}

/** A `messages` row, in outbox order. */
interface MessageRow {
  id: number;
  sender: string;
  kind: string;
  body: string;
  ts: string;
  occurrences: number;
}

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_LEASE_MS = 60_000;
/** Cap on a collector error body quoted back in `RelayResult.error`. */
const ERROR_BODY_LIMIT = 500;
/** RFC 7230 token, i.e. what may legally be a header field name. */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * The cursor key for an endpoint: scheme, host, port and path only. Any query
 * string, fragment, or userinfo is dropped -- some collectors accept an
 * ingestion key as a URL parameter, and `target` is the one piece of relay
 * config that reaches disk.
 */
export function relayTarget(endpoint: string): string {
  const url = new URL(endpoint);
  return `${url.protocol}//${url.host}${url.pathname}`;
}

/**
 * True when `value` contains a C0 control character or DEL. Written as a code
 * point scan rather than a regex character class so the source stays plain
 * ASCII -- a literal control character embedded in a source file is invisible
 * to review and easy for an editor or a patch to mangle.
 */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Parse `SQUAD_RELAY_HEADERS` -- comma-separated `name=value` pairs, matching
 * the `OTEL_EXPORTER_OTLP_HEADERS` convention (e.g.
 * `signoz-ingestion-key=abc123`). Values are used verbatim after trimming; no
 * percent-decoding, so a value containing `,` or `=` beyond the first is not
 * expressible and a literal one is not silently mangled. Rejects anything that
 * is not a legal header name, and any value containing a control character, so
 * a malformed env var cannot smuggle a second header into the request.
 */
export function parseRelayHeaders(raw: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!raw) return headers;
  for (const pair of raw.split(",")) {
    if (!pair.trim()) continue;
    const eq = pair.indexOf("=");
    if (eq < 0) throw new Error("relay: SQUAD_RELAY_HEADERS entries must be name=value");
    const name = pair.slice(0, eq).trim(),
      value = pair.slice(eq + 1).trim();
    if (!HEADER_NAME_RE.test(name))
      throw new Error(`relay: invalid header name in SQUAD_RELAY_HEADERS: ${name}`);
    // Deliberately does not echo the value: it is a credential.
    if (hasControlCharacter(value))
      throw new Error(`relay: header ${name} has a control character in its value`);
    headers[name] = value;
  }
  return headers;
}

/**
 * The room's name when `SQUAD_RELAY_ROOM_NAME` is unset: the directory holding
 * the room, i.e. the repository directory for the usual `<repo>/.squad` layout
 * (and the home directory name for the machine-global `~/.squad` fallback).
 * Derived from the resolved room path rather than from cwd or `git remote`, so
 * two worktrees of one repository -- which share a room -- also share a name,
 * with no subprocess on the delivery path.
 */
export function defaultRelayRoomName(dir: string = squadDir()): string {
  return basename(dirname(dir)) || basename(dir) || "squad";
}

/**
 * Build a config from the environment, or null when relaying is off (no
 * `SQUAD_RELAY_ENDPOINT`). Throws only on config that is present but invalid:
 * a caller that set it wrongly wants to hear so, whereas an unset endpoint is
 * the normal state of every room.
 *
 *  - `SQUAD_RELAY_ENDPOINT`   OTLP logs endpoint (http/https), e.g.
 *                             `https://collector.example/v1/logs`
 *  - `SQUAD_RELAY_HEADERS`    `name=value,name=value` auth headers
 *  - `SQUAD_RELAY_ROOM_NAME`  override for `squad.room`
 *  - `SQUAD_RELAY_KINDS`      comma-separated message kinds to ship
 */
export function relayConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<RelayConfig> = {},
): RelayConfig | null {
  const endpoint = env.SQUAD_RELAY_ENDPOINT?.trim();
  if (!endpoint) return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`relay: SQUAD_RELAY_ENDPOINT is not a URL: ${endpoint}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error(`relay: SQUAD_RELAY_ENDPOINT must be http(s), got ${url.protocol}`);
  const kinds = (env.SQUAD_RELAY_KINDS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  const dir = squadDir();
  return {
    endpoint,
    headers: parseRelayHeaders(env.SQUAD_RELAY_HEADERS),
    room: env.SQUAD_RELAY_ROOM_NAME?.trim() || defaultRelayRoomName(dir),
    repoPath: dirname(dir),
    host: hostname(),
    kinds: kinds.length ? kinds : null,
    target: relayTarget(endpoint),
    batchSize: DEFAULT_BATCH_SIZE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    leaseMs: DEFAULT_LEASE_MS,
    ...overrides,
  };
}

function attr(key: string, value: string): OtlpAttribute {
  return { key, value: { stringValue: value } };
}
function intAttr(key: string, value: number): OtlpAttribute {
  return { key, value: { intValue: String(Math.trunc(value)) } };
}

/**
 * Nanoseconds-since-epoch for an OTLP timestamp. `messages.ts` is an ISO
 * string with millisecond precision; an unparseable one falls back to `now`
 * rather than emitting a record stamped 1970 (a collector may drop records
 * outside its retention window, which would lose the message entirely).
 */
function unixNano(ts: string, now: number): string {
  const ms = Date.parse(ts);
  return `${BigInt(Number.isFinite(ms) ? ms : now) * 1_000_000n}`;
}

/**
 * One OTLP log record per message row. The body is the message body verbatim;
 * everything a dashboard needs to slice by (room, repo, host, sender, kind)
 * is an attribute, and `squad.message_id` is the de-dupe key that makes
 * at-least-once delivery safe to display.
 */
export function toLogRecord(row: MessageRow, config: RelayConfig, now = Date.now()): OtlpLogRecord {
  const time = unixNano(row.ts, now);
  return {
    timeUnixNano: time,
    observedTimeUnixNano: `${BigInt(now) * 1_000_000n}`,
    severityNumber: 9, // INFO
    severityText: "INFO",
    body: { stringValue: row.body },
    attributes: [
      attr("squad.room", config.room),
      attr("squad.repo_path", config.repoPath),
      attr("squad.host", config.host),
      intAttr("squad.message_id", row.id),
      attr("squad.sender", row.sender),
      attr("squad.kind", row.kind),
      intAttr("squad.occurrences", row.occurrences),
    ],
  };
}

/** The full OTLP/HTTP+JSON `ExportLogsServiceRequest` for one batch. */
export function toExportRequest(records: OtlpLogRecord[], config: RelayConfig): unknown {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [attr("service.name", "squad"), attr("host.name", config.host)],
        },
        scopeLogs: [{ scope: { name: "squad" }, logRecords: records }],
      },
    ],
  };
}

/**
 * Acquire (or steal an expired) shipping lease for `target`, returning the
 * fencing token -- the exact `lease_expires` written -- or null when another
 * process holds a live one. A single statement, so two racing processes cannot
 * both observe a free lease: the upsert's `WHERE` is evaluated by SQLite under
 * the same write lock that applies the update, exactly like the
 * `UPDATE node_reviews ... WHERE lease_expires>?` runner lease in core.ts.
 */
function acquireLease(db: DatabaseSync, target: string, leaseMs: number, now: number): number | null {
  const token = now + leaseMs;
  const changed = db
    .prepare(
      "INSERT INTO relay_cursors (target, last_message_id, updated_at, lease_expires) VALUES (?, 0, NULL, ?) " +
        "ON CONFLICT(target) DO UPDATE SET lease_expires=excluded.lease_expires " +
        "WHERE relay_cursors.lease_expires<=?",
    )
    .run(target, token, now);
  return Number(changed.changes) > 0 ? token : null;
}

/** Release a lease we still hold. Fenced: never clears a re-acquired one. */
function releaseLease(db: DatabaseSync, target: string, token: number): void {
  db.prepare("UPDATE relay_cursors SET lease_expires=0 WHERE target=? AND lease_expires=?").run(
    target,
    token,
  );
}

function readCursor(db: DatabaseSync, target: string): number {
  const row = db.prepare("SELECT last_message_id FROM relay_cursors WHERE target=?").get(target) as
    | { last_message_id: number }
    | undefined;
  return row ? Number(row.last_message_id) : 0;
}

/**
 * Advance the cursor, fenced by the lease token. Returns false when the lease
 * was lost (expired and taken by another process) -- the caller stops rather
 * than writing a cursor it no longer owns.
 */
function advanceCursor(
  db: DatabaseSync,
  target: string,
  id: number,
  token: number,
  nowIso: string,
): boolean {
  const changed = db
    .prepare(
      "UPDATE relay_cursors SET last_message_id=?, updated_at=? WHERE target=? AND lease_expires=?",
    )
    .run(id, nowIso, target, token);
  return Number(changed.changes) > 0;
}

/** Quote a collector's error body without assuming it is JSON, or large. */
async function errorDetail(response: Response): Promise<string> {
  let body = "";
  try {
    body = (await response.text()).trim().replace(/\s+/g, " ");
  } catch {
    body = "";
  }
  if (body.length > ERROR_BODY_LIMIT) body = `${body.slice(0, ERROR_BODY_LIMIT)}...`;
  return body ? `${response.status} ${response.statusText}: ${body}` : `${response.status} ${response.statusText}`;
}

/**
 * OTLP partial success: a 2xx whose body reports some records rejected. The
 * accepted ones are still accepted, so the cursor advances -- a rejected
 * record is a record the collector will never take, and re-sending it forever
 * would wedge the outbox. Any non-JSON (or empty) 2xx body means full success.
 */
async function rejectedCount(response: Response): Promise<number> {
  try {
    const text = (await response.text()).trim();
    if (!text) return 0;
    const parsed = JSON.parse(text) as { partialSuccess?: { rejectedLogRecords?: string | number } };
    return Number(parsed?.partialSuccess?.rejectedLogRecords ?? 0) || 0;
  } catch {
    return 0;
  }
}

/**
 * Ship every message past the cursor for `config.target`, in batches, and
 * report what happened. Never throws.
 *
 * Semantics worth knowing:
 *  - **Cursor advances only after the collector accepts a batch** (2xx). A
 *    network error, a timeout, or any non-2xx stops the pass with
 *    `status: "failed"` and leaves the cursor where it was, so the next call
 *    re-sends the same rows.
 *  - **Filtered rows still advance the cursor.** With `SQUAD_RELAY_KINDS` set,
 *    a batch whose rows all filter out ships nothing and advances past them:
 *    the cursor tracks *considered*, not *sent*. Otherwise a room whose recent
 *    traffic is entirely excluded would re-scan the same rows on every pass
 *    forever, and flipping the filter later would back-fill kinds the operator
 *    had deliberately excluded.
 *  - **One shipper per target.** A live lease means a concurrent pass is
 *    already draining this outbox; this one returns `status: "lease-held"`
 *    having sent nothing, rather than duplicating its batch.
 */
export async function relayOnce(db: DatabaseSync, config: RelayConfig): Promise<RelayResult> {
  const result: RelayResult = {
    target: config.target,
    status: "ok",
    scanned: 0,
    shipped: 0,
    rejected: 0,
    batches: 0,
    cursor: 0,
  };
  const token = acquireLease(db, config.target, config.leaseMs, Date.now());
  if (token === null) {
    result.status = "lease-held";
    result.cursor = readCursor(db, config.target);
    return result;
  }
  try {
    let cursor = readCursor(db, config.target);
    result.cursor = cursor;
    const select = db.prepare(
      "SELECT id, sender, kind, body, ts, occurrences FROM messages WHERE id>? ORDER BY id LIMIT ?",
    );
    for (;;) {
      const rows = select.all(cursor, config.batchSize) as unknown as MessageRow[];
      if (!rows.length) break;
      result.scanned += rows.length;
      const batchEnd = Number(rows[rows.length - 1]!.id);
      const shipping = config.kinds ? rows.filter((r) => config.kinds!.includes(r.kind)) : rows;
      if (shipping.length) {
        const now = Date.now();
        const records = shipping.map((row) => toLogRecord(row, config, now));
        let response: Response;
        try {
          response = await fetch(config.endpoint, {
            method: "POST",
            headers: { "content-type": "application/json", ...config.headers },
            body: JSON.stringify(toExportRequest(records, config)),
            signal: AbortSignal.timeout(config.timeoutMs),
          });
        } catch (err) {
          result.status = "failed";
          result.error = `relay: POST ${config.target} failed: ${err instanceof Error ? err.message : String(err)}`;
          return result;
        }
        result.batches += 1;
        if (!response.ok) {
          result.status = "failed";
          result.error = `relay: ${config.target} rejected the batch: ${await errorDetail(response)}`;
          return result;
        }
        const rejected = await rejectedCount(response);
        result.rejected += rejected;
        result.shipped += Math.max(0, records.length - rejected);
      }
      if (!advanceCursor(db, config.target, batchEnd, token, new Date().toISOString())) {
        result.status = "failed";
        result.error = `relay: lost the shipping lease for ${config.target} mid-pass`;
        return result;
      }
      cursor = batchEnd;
      result.cursor = cursor;
      if (rows.length < config.batchSize) break;
    }
    if (result.batches === 0 && result.scanned === 0) result.status = "empty";
    return result;
  } finally {
    releaseLease(db, config.target, token);
  }
}
