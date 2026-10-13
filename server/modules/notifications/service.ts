import { EventEmitter } from "node:events";
import { sql, type Kysely, type Transaction } from "kysely";
import type { DB } from "../../../db/types.ts";
import { db } from "../../platform/db.ts";
import { env } from "../../platform/env.ts";
import { AppError } from "../../platform/errors.ts";
import { excerpt } from "../../platform/markdown.ts";
import { recordEvent } from "../events/service.ts";
import { userBriefs } from "../users/service.ts";

// What people are told of; see design §8.6. reply: someone replied to my floor; mention: @ me;
// like and boost: on my floor; watching: a new floor in a thread I watch; following: a new thread
// by someone I follow.
export const NOTIFICATION_TYPES = [
  "reply",
  "mention",
  "like",
  "boost",
  "watching",
  "following",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

// While unread, these become one per floor (likes, boosts) or per thread (new floors), counting
// up, with the latest person in front: "A 等 3 人".
const MERGED = new Set<NotificationType>(["like", "boost", "watching"]);

type Notice = {
  type: NotificationType;
  actorId: number;
  threadId: number;
  postId: number;
  data?: Record<string, string>;
};

// Unless turned off, every type shows on the site; QQ reminders only come for these.
const QQ_BY_DEFAULT = new Set<NotificationType>(["reply", "mention"]);

// What happened, as the QQ reminder says it after the person's name.
const SAID: Record<NotificationType, string> = {
  reply: "回复了你",
  mention: "提到了你",
  like: "赞了你",
  boost: "给你留了短评",
  watching: "回复了你关注的主题",
  following: "发了新主题",
};

// Characters of the floor in a QQ reminder.
const QQ_EXCERPT = 60;

// Written in the transaction that caused it. Nobody hears of their own doing, nor anyone who left
// the groups or muted the thread. Each type shows on the site, and goes to QQ as an event for the
// bot plugin, as each person set it.
async function notify(trx: Transaction<DB>, userIds: number[], notice: Notice) {
  const ids = [...new Set(userIds)].filter((id) => id !== notice.actorId);
  if (ids.length === 0) return;
  const prefs = sql`users.notify_prefs -> ${notice.type}`;
  const recipients = await trx
    .selectFrom("users")
    .leftJoin("thread_users", (join) =>
      join
        .onRef("thread_users.user_id", "=", "users.id")
        .on("thread_users.thread_id", "=", notice.threadId),
    )
    .select([
      "users.id",
      "users.display_name",
      "users.qq",
      sql<boolean>`coalesce((${prefs} ->> 'site')::boolean, true)`.as("site"),
      sql<boolean>`coalesce((${prefs} ->> 'qq')::boolean, ${QQ_BY_DEFAULT.has(notice.type)})`.as(
        "to_qq",
      ),
    ])
    .where("users.id", "in", ids)
    .where("users.member_status", "=", "member")
    .where("users.deleted_at", "is", null)
    .where(sql<boolean>`thread_users.notify_level IS DISTINCT FROM 'muted'`)
    .execute();
  const onSite = recipients.filter((r) => r.site);
  if (onSite.length > 0) {
    const key = notice.type === "watching" ? notice.threadId : notice.postId;
    await trx
      .insertInto("notifications")
      .values(
        onSite.map((r) => ({
          user_id: r.id,
          type: notice.type,
          actor_id: notice.actorId,
          thread_id: notice.threadId,
          post_id: notice.postId,
          group_key: MERGED.has(notice.type) ? `${notice.type}:${key}` : null,
          data: notice.data ?? {},
        })),
      )
      .onConflict((oc) =>
        oc
          .columns(["user_id", "group_key"])
          .where("group_key", "is not", null)
          .where("read_at", "is", null)
          .doUpdateSet({
            count: sql<number>`notifications.count + 1`,
            actor_id: sql<number>`excluded.actor_id`,
            data: sql`excluded.data`,
            created_at: sql<Date>`now()`,
          }),
      )
      .execute();
    await tellUnread(
      trx,
      onSite.map((r) => r.id),
    );
  }
  const toQq = recipients.filter((r) => r.to_qq);
  if (toQq.length > 0) await remindOnQq(trx, toQq, notice);
}

async function remindOnQq(
  trx: Transaction<DB>,
  people: { id: number; display_name: string; qq: number | null }[],
  notice: Notice,
) {
  const about = await trx
    .selectFrom("posts")
    .innerJoin("threads", "threads.id", "posts.thread_id")
    .innerJoin("users", (join) => join.on("users.id", "=", notice.actorId))
    .select([
      "posts.floor",
      "posts.html",
      "threads.title",
      "users.id as actor_id",
      "users.display_name as actor_name",
      "users.qq as actor_qq",
    ])
    .where("posts.id", "=", notice.postId)
    .executeTakeFirstOrThrow();
  const url = `${env.PUBLIC_URL}/t/${notice.threadId}${about.floor > 1 ? `?floor=${about.floor}` : ""}`;
  const text = `${about.actor_name} ${SAID[notice.type]}：${excerpt(about.html, QQ_EXCERPT)}\n${about.title}\n${url}`;
  for (const person of people) {
    await recordEvent(trx, "notification.created", {
      user: { id: person.id, display_name: person.display_name, qq: person.qq },
      type: notice.type,
      actor: { id: about.actor_id, display_name: about.actor_name, qq: about.actor_qq },
      thread: { id: notice.threadId, title: about.title },
      post: { id: notice.postId, floor: about.floor },
      url,
      qq_text: text,
    });
  }
}

// A new floor: its author's floor if it answers one, then those @-ed in it, then those watching the
// thread. Each person hears of it once, by the first of these that applies.
export async function notifyPost(
  trx: Transaction<DB>,
  post: { id: number; threadId: number; authorId: number; mentions: number[] },
  replyTo: number | null,
) {
  const notice = { actorId: post.authorId, threadId: post.threadId, postId: post.id };
  const told = new Set<number>();
  if (replyTo !== null) {
    await notify(trx, [replyTo], { ...notice, type: "reply" });
    told.add(replyTo);
  }
  const mentioned = post.mentions.filter((id) => !told.has(id));
  await notify(trx, mentioned, { ...notice, type: "mention" });
  for (const id of mentioned) told.add(id);
  const watchers = await trx
    .selectFrom("thread_users")
    .select("user_id")
    .where("thread_id", "=", post.threadId)
    .where("notify_level", "=", "watching")
    .execute();
  await notify(
    trx,
    watchers.map((w) => w.user_id).filter((id) => !told.has(id)),
    { ...notice, type: "watching" },
  );
}

// A new thread: those @-ed in its opening post, then the author's followers.
export async function notifyThread(
  trx: Transaction<DB>,
  thread: { id: number; postId: number; authorId: number; mentions: number[] },
) {
  const notice = { actorId: thread.authorId, threadId: thread.id, postId: thread.postId };
  await notify(trx, thread.mentions, { ...notice, type: "mention" });
  const followers = await trx
    .selectFrom("user_follows")
    .select("follower_id")
    .where("followee_id", "=", thread.authorId)
    .execute();
  const mentioned = new Set(thread.mentions);
  await notify(
    trx,
    followers.map((f) => f.follower_id).filter((id) => !mentioned.has(id)),
    { ...notice, type: "following" },
  );
}

// Someone liked or boosted a floor: its author hears of it, merged with others on that floor.
export async function notifyOnPost(
  trx: Transaction<DB>,
  type: "like" | "boost",
  post: { id: number; thread_id: number; author_id: number },
  actorId: number,
  data: Record<string, string>,
) {
  await notify(trx, [post.author_id], {
    type,
    actorId,
    threadId: post.thread_id,
    postId: post.id,
    data,
  });
}

// ---- Live unread counts: a NOTIFY names whose changed, so each of their open pages can update.

export const NOTIFICATIONS_CHANNEL = "mousehole_notifications";
// A NOTIFY payload is at most 8000 bytes.
const IDS_PER_NOTIFY = 500;

async function tellUnread(executor: Kysely<DB>, userIds: number[]) {
  for (let i = 0; i < userIds.length; i += IDS_PER_NOTIFY) {
    const ids = userIds.slice(i, i + IDS_PER_NOTIFY).join(",");
    await sql`SELECT pg_notify(${NOTIFICATIONS_CHANNEL}, ${ids})`.execute(executor);
  }
}

const changes = new EventEmitter();
changes.setMaxListeners(0);
const ANYONE = "anyone";

// For the LISTEN connection: whose unread notifications changed, comma-separated; null after
// connecting again, when it may be anyone's.
export function unreadChanged(payload: string | null) {
  if (payload === null) changes.emit(ANYONE);
  else for (const id of payload.split(",")) changes.emit(id);
}

export function onUnreadChange(userId: number, listener: () => void) {
  changes.on(String(userId), listener);
  changes.on(ANYONE, listener);
  return () => {
    changes.off(String(userId), listener);
    changes.off(ANYONE, listener);
  };
}

const PAGE = 30;
// Characters of the floor a notification is about.
const EXCERPT = 80;

function badCursor(): never {
  throw new AppError(400, "invalid_request", "cursor 无效");
}

// Newest first; a merged one moves up when it grows. The cursor is the last one's time in
// microseconds and its ID.
export async function listNotifications(userId: number, unreadOnly: boolean, cursor?: string) {
  let query = db
    .selectFrom("notifications")
    .innerJoin("threads", "threads.id", "notifications.thread_id")
    .innerJoin("posts", "posts.id", "notifications.post_id")
    .select([
      "notifications.id",
      "notifications.type",
      "notifications.actor_id",
      "notifications.count",
      sql<Record<string, string>>`notifications.data`.as("data"),
      "notifications.read_at",
      "notifications.created_at",
      sql<number>`(extract(epoch FROM notifications.created_at) * 1000000)::bigint`.as("micros"),
      "threads.id as thread_id",
      "threads.title",
      "posts.id as post_id",
      "posts.floor",
      "posts.html",
      "posts.deleted_at",
    ])
    .where("notifications.user_id", "=", userId)
    .orderBy("notifications.created_at", "desc")
    .orderBy("notifications.id", "desc")
    .limit(PAGE);
  if (unreadOnly) query = query.where("notifications.read_at", "is", null);
  if (cursor !== undefined) {
    const [, micros, id] = /^(\d+)_(\d+)$/.exec(cursor) ?? badCursor();
    query = query.where((eb) =>
      eb(
        eb.refTuple("notifications.created_at", "notifications.id"),
        "<",
        eb.tuple(
          sql<Date>`timestamptz 'epoch' + ${micros}::bigint * interval '1 microsecond'`,
          Number(id),
        ),
      ),
    );
  }
  const rows = await query.execute();
  const user = await userBriefs(rows.flatMap((r) => (r.actor_id === null ? [] : [r.actor_id])));
  const last = rows.at(-1);
  return {
    items: rows.map((r) => ({
      id: r.id,
      type: r.type,
      actor: r.actor_id === null ? null : user(r.actor_id),
      count: r.count,
      thread: { id: r.thread_id, title: r.title },
      post: { id: r.post_id, floor: r.floor },
      excerpt: r.deleted_at === null ? excerpt(r.html, EXCERPT) : "",
      data: r.data,
      read: r.read_at !== null,
      created_at: r.created_at,
    })),
    next_cursor: rows.length === PAGE && last ? `${last.micros}_${last.id}` : null,
  };
}

export async function countUnread(userId: number) {
  const { count } = await db
    .selectFrom("notifications")
    .select(sql<number>`count(*)::integer`.as("count"))
    .where("user_id", "=", userId)
    .where("read_at", "is", null)
    .executeTakeFirstOrThrow();
  return count;
}

export async function markRead(userId: number, ids: number[] | "all") {
  let query = db
    .updateTable("notifications")
    .set({ read_at: sql<Date>`now()` })
    .where("user_id", "=", userId)
    .where("read_at", "is", null);
  if (ids !== "all") query = query.where("id", "in", ids);
  await query.execute();
  await tellUnread(db, [userId]);
}

// Read ones are kept half a year.
export async function clearOldNotifications() {
  await db
    .deleteFrom("notifications")
    .where("read_at", "<", sql<Date>`now() - interval '180 days'`)
    .execute();
}
