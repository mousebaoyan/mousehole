import { EventEmitter, once } from "node:events";
import { sql, type Transaction } from "kysely";
import type { DB, JsonObject } from "../../../db/types.ts";
import { db, listen } from "../../platform/db.ts";
import { AppError } from "../../platform/errors.ts";

// What the bot plugin hears about, through /bot/events; see docs/api.md §5.
export const EVENT_TYPES = [
  "thread.created",
  "post.created",
  "post.updated",
  "post.deleted",
  "notification.created",
  "member.activated",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

const CHANNEL = "mousehole_events";

// Written in the transaction it tells of, so it exists exactly when that commits. So does the
// NOTIFY, which PostgreSQL only sends on commit.
export async function recordEvent(trx: Transaction<DB>, type: EventType, data: JsonObject) {
  await trx.insertInto("events").values({ type, data }).execute();
  await sql`SELECT pg_notify(${CHANNEL}, '')`.execute(trx);
}

const arrived = new EventEmitter();
arrived.setMaxListeners(0);

// Called once at start-up: from then on, every NOTIFY wakes those waiting in nextEvents.
export function startEvents() {
  listen(CHANNEL, () => arrived.emit("events"));
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

// Whether events after the cursor are there but not readable yet, behind a transaction that is
// still running; usually for a moment.
export async function heldBack(after: number) {
  const row = await db
    .selectFrom("events")
    .select("id")
    .where("id", ">", after)
    .where(sql<boolean>`txid >= pg_snapshot_xmin(pg_current_snapshot())`)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
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
