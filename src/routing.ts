import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { canonicalRoomDir, roomDirForPath } from "./db.js";

/**
 * Optional per-room cross-room routing policy (#144), read from
 * `<room>/routing.json` (the room's `.squad` directory, next to squad.db):
 *
 *   {
 *     "accept_from": ["../repo-a", "/abs/path/to/repo-b"],
 *     "reply_to":    ["../repo-a"]
 *   }
 *
 * - `accept_from`: rooms allowed to `squad send --room` *into* this room.
 * - `reply_to`: rooms this room may deliver explicit replies *to*.
 *
 * An absent file or an absent key leaves that direction unrestricted, which
 * is exactly the behavior before policies existed. An explicitly empty list
 * denies that direction entirely. Each entry is a path naming a room the way
 * `squad send --room` does (a repo checkout, any directory inside it, a linked
 * worktree, or the `.squad` dir itself); relative entries resolve against the
 * repo root that holds this room. Entries and the rooms being checked are both
 * canonicalized (symlinks resolved, worktrees mapped to their primary clone),
 * so an alias cannot slip past a list.
 *
 * These are cooperative application policies enforced by squad itself, not an
 * operating-system access-control boundary: any process that can write the
 * other room's files can bypass them.
 */
export const ROUTING_POLICY_FILE = "routing.json";

export interface RoutingPolicy {
  /** Canonical rooms allowed to send in; null = unrestricted. */
  accept_from: string[] | null;
  /** Canonical rooms replies may be delivered to; null = unrestricted. */
  reply_to: string[] | null;
  /** Where the policy was read from, or null when the room has none. */
  file: string | null;
}

const POLICY_KEYS = ["accept_from", "reply_to"] as const;
const POLICY_SHAPE = '{"accept_from": ["<repo-path>", ...], "reply_to": ["<repo-path>", ...]}';

/** The canonical room an allowlist entry names. */
function canonicalEntry(entry: string, roomDir: string): string {
  const base = basename(roomDir) === ".squad" ? dirname(roomDir) : roomDir;
  const abs = isAbsolute(entry) ? entry : resolve(base, entry);
  return roomDirForPath(abs) ?? canonicalRoomDir(abs);
}

/**
 * Load and validate a room's routing policy. Throws an actionable error for a
 * malformed file rather than guessing: a policy someone wrote to restrict a
 * room must never be silently treated as "no policy".
 */
export function loadRoutingPolicy(roomDir: string): RoutingPolicy {
  const file = join(roomDir, ROUTING_POLICY_FILE);
  if (!existsSync(file)) return { accept_from: null, reply_to: null, file: null };
  const fail = (why: string): never => {
    throw new Error(`invalid routing policy at ${file}: ${why}. Expected ${POLICY_SHAPE} (either key may be omitted).`);
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    fail(`not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("the top level must be a JSON object");
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record))
    if (!(POLICY_KEYS as readonly string[]).includes(key)) fail(`unknown key "${key}"`);
  const list = (key: (typeof POLICY_KEYS)[number]): string[] | null => {
    const value = record[key];
    if (value === undefined) return null;
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v.trim()))
      fail(`"${key}" must be an array of non-empty path strings`);
    return (value as string[]).map((entry) => canonicalEntry(entry.trim(), roomDir));
  };
  return { accept_from: list("accept_from"), reply_to: list("reply_to"), file };
}

/** Refuse a cross-room send from `sourceRoom` that `destRoom`'s policy does not accept. */
export function assertInboundAllowed(destRoom: string, sourceRoom: string): void {
  const policy = loadRoutingPolicy(destRoom);
  if (policy.accept_from === null) return;
  const source = canonicalRoomDir(sourceRoom);
  if (!policy.accept_from.includes(source))
    throw new Error(
      `the room at ${destRoom} does not accept cross-room messages from ${source} ` +
        `(routing policy ${policy.file}: "accept_from"${policy.accept_from.length ? "" : " is empty"}); nothing was sent`,
    );
}

/** Refuse delivering a reply from `replyingRoom` to `destRoom` that the replying room's policy does not allow. */
export function assertReplyAllowed(replyingRoom: string, destRoom: string): void {
  const policy = loadRoutingPolicy(replyingRoom);
  if (policy.reply_to === null) return;
  const dest = canonicalRoomDir(destRoom);
  if (!policy.reply_to.includes(dest))
    throw new Error(
      `this room's routing policy (${policy.file}: "reply_to"${policy.reply_to.length ? "" : " is empty"}) ` +
        `does not allow delivering replies to ${dest}`,
    );
}

/**
 * A short display label for a room -- the name of the repo directory holding
 * its `.squad` (or the directory itself for a custom SQUAD_DIR). Used to
 * qualify routed senders as `<persona>@<label>`, which also keeps a routed
 * sender from ever matching a local persona (whose names cannot contain '@'),
 * so self-suppression in check() never hides a routed message.
 */
export function roomLabel(roomDir: string): string {
  const base = basename(roomDir);
  const label = base === ".squad" ? basename(dirname(roomDir)) : base;
  return (label || "room").replace(/\s+/g, "-");
}
