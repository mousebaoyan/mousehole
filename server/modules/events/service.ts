import { EventEmitter, once } from "node:events";
import { sql, type Transaction } from "kysely";
import type { DB, JsonObject } from "../../../db/types.ts";
import { db } from "../../platform/db.ts";
import { AppError } from "../../platform/errors.ts";
import { log } from "../../platform/log.ts";

// What the bot plugin hears about, through /bot/events; see docs/api.md §5.
export const EVENT_TYPES = [
  "thread.created",
  "post.created",
  "post.updated",
  "post.deleted",
  "thread.solved",
  "thread.merged",
  "content.pending",
  "member.activated",
  "report.created",
  "lottery.drawn",
  "badge.granted",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENTS_CHANNEL = "mousehole_events";

// Written in the transaction it tells of, so it exists exactly when that commits. So does the
// NOTIFY, which PostgreSQL only sends on commit.
export async function recordEvent(trx: Transaction<DB>, type: EventType, data: JsonObject) {
  await trx.insertInto("events").values({ type, data }).execute();
  await sql`SELECT pg_notify(${EVENTS_CHANNEL}, '')`.execute(trx);
}

const arrived = new EventEmitter();
arrived.setMaxListeners(0);

// For the LISTEN connection: wakes the bot streams waiting in nextEvents, and hands the new
// events to those listening in this process.
export function eventsArrived() {
  arrived.emit("events");
  pumpSoon();
}

// Resolves when events may have arrived, or after `ms` either way; false then.
export async function nextEvents(ms: number, signal: AbortSignal) {
  try {
    await once(arrived, "events", { signal: AbortSignal.any([signal, AbortSignal.timeout(ms)]) });
    return true;
  } catch {
    return false;
  }
}

// After the cursor, in ID order, only from transactions that have finished: one that started
// earlier may still commit an event with a smaller ID, which `id > cursor` would then skip.
// See docs/data-model.md.
export async function readEvents(after: number, types: string[] | null, limit: number) {
  let query = db
    .selectFrom("events")
    .select(["id", "type", sql<Record<string, unknown>>`data`.as("data"), "created_at"])
    .where("id", ">", after)
    .where(sql<boolean>`txid < pg_snapshot_xmin(pg_current_snapshot())`)
    .orderBy("id")
    .limit(limit);
  if (types !== null) query = query.where("type", "in", types);
  return query.execute();
}

// How soon events held back by a transaction still running are looked for again: that
// transaction may write no event, so no NOTIFY would say when it ends.
export const HELD_MS = 200;

// Whether there are events after the cursor not handed out yet: held back by a transaction still
// running, or readable since the last read. Usually for a moment.
export async function pending(after: number, types: string[] | null) {
  let query = db.selectFrom("events").select("id").where("id", ">", after).limit(1);
  if (types !== null) query = query.where("type", "in", types);
  return (await query.executeTakeFirst()) !== undefined;
}

// Kept 7 days; a cursor from before that can't be followed, and is told where to start over.
export async function checkCursor(after: number) {
  const { oldest, latest } = await db
    .selectFrom("events")
    .select((eb) => [
      eb.fn.min<number | null>("id").as("oldest"),
      eb.fn.max<number | null>("id").as("latest"),
    ])
    .executeTakeFirstOrThrow();
  if (oldest !== null && after < oldest - 1) {
    throw new AppError(410, "cursor_expired", "游标太旧，事件已经清理", {
      details: { latest_id: latest },
    });
  }
}

export async function latestEventId() {
  const { latest } = await db
    .selectFrom("events")
    .select((eb) => eb.fn.max<number | null>("id").as("latest"))
    .executeTakeFirstOrThrow();
  return latest ?? 0;
}

export async function clearOldEvents() {
  await db
    .deleteFrom("events")
    .where("created_at", "<", sql<Date>`now() - interval '7 days'`)
    .execute();
}

// How the bot plugin is listening, for the admin overview: event streams open now, and when it
// last fetched a batch. Kept in memory, as one process serves the forum.
let openStreams = 0;
let polledAt: Date | null = null;

export function streamOpened() {
  openStreams += 1;
}

export function streamClosed() {
  openStreams -= 1;
}

export function batchPolled() {
  polledAt = new Date();
}

export function botListening() {
  return { streams: openStreams, polled_at: polledAt };
}

// ---- Listening in this process: pages following a thread live. The events are read once for
// all of them, in order, as they arrive.

export type ForumEvent = Awaited<ReturnType<typeof readEvents>>[number];

const listeners = new Set<(event: ForumEvent) => void>();

export function onEvent(listener: (event: ForumEvent) => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

// The last event handed to listeners; from the latest at start-up.
let pumped: number | null = null;
let queue = Promise.resolve();
let queued = false;

// One read at a time; NOTIFYs that come while one waits to start are all covered by it.
function pumpSoon() {
  if (queued) return;
  queued = true;
  queue = queue.then(pumpNow);
}

async function pumpNow() {
  queued = false;
  try {
    await pump();
  } catch (error) {
    // The next NOTIFY tries again.
    log("error", "Reading events for listeners failed", { error });
  }
}

async function pump() {
  pumped ??= await latestEventId();
  for (;;) {
    const events = await readEvents(pumped, null, 100);
    for (const event of events) {
      pumped = event.id;
      for (const listener of listeners) listener(event);
    }
    if (events.length === 100) continue;
    if (!(await pending(pumped, null))) return;
    await new Promise((resolve) => setTimeout(resolve, HELD_MS));
  }
}
