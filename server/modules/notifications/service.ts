import { EventEmitter } from "node:events";
import { sql, type Kysely, type NotNull, type Transaction } from "kysely";
import type { DB } from "../../../db/types.ts";
import { db } from "../../platform/db.ts";
import { AppError } from "../../platform/errors.ts";
import { queueMail } from "../../platform/mail.ts";
import { excerpt } from "../../platform/markdown.ts";
import { getSettings, type EmailPolicy, type Settings } from "../../platform/settings.ts";
import { userBriefs, writer } from "../users/service.ts";
import {
  badgeReminders,
  floorReminders,
  levelReminder,
  lotteryReminders,
  type Notice,
  type Standing,
  type Told,
} from "./reminders.ts";
import { NOTIFICATION_TYPES, type NotificationType } from "./types.ts";

export { NOTIFICATION_TYPES };

// While unread, these become one per floor (likes, boosts) or per thread (new floors), counting
// up, with the latest person in front: "A 等 3 人".
const MERGED = new Set<NotificationType>(["like", "boost", "thread_reply", "watching"]);
const PER_THREAD = new Set<NotificationType>(["thread_reply", "watching"]);

// Unless turned off, every type shows on the site; emails only come for these, unless the owner
// says otherwise.
const EMAIL_BY_DEFAULT = new Set<NotificationType>([
  "reply",
  "mention",
  "solved",
  "moderation",
  "level",
  "lottery",
]);

function policyOf(settings: Settings, type: NotificationType): EmailPolicy {
  return settings.notify.email[type] ?? (EMAIL_BY_DEFAULT.has(type) ? "on" : "off");
}

// Whether each type may go by email, and whether it does for people who never set it.
export async function emailPolicies() {
  const settings = await getSettings();
  return Object.fromEntries(NOTIFICATION_TYPES.map((type) => [type, policyOf(settings, type)]));
}

// Whether someone gets a type on the site and by email: what they set, else the default; no
// email at all with emails turned off, or with the owner allowing none of this type.
async function switches(type: NotificationType) {
  const prefs = sql`users.notify_prefs -> ${type}`;
  const policy = policyOf(await getSettings(), type);
  return [
    sql<boolean>`coalesce((${prefs} ->> 'site')::boolean, true)`.as("site"),
    (policy === "never"
      ? sql<boolean>`false`
      : sql<boolean>`users.notify_email AND coalesce((${prefs} ->> 'email')::boolean, ${policy === "on"})`
    ).as("email"),
  ];
}

// Someone's switches for every type, what they set over the defaults; email is null for types the
// owner allows no email for.
export async function notifyPrefs(saved: Record<string, { site?: boolean; email?: boolean }>) {
  const settings = await getSettings();
  return Object.fromEntries(
    NOTIFICATION_TYPES.map((type) => {
      const policy = policyOf(settings, type);
      return [
        type,
        {
          site: saved[type]?.site ?? true,
          email: policy === "never" ? null : (saved[type]?.email ?? policy === "on"),
        },
      ];
    }),
  );
}

// Written in the transaction that caused it. Nobody hears of their own doing, nor anyone who left
// the groups or muted the thread, nor the owner, who has no QQ and is in no group. Each type shows on the site and goes by email, as each person
// set it.
async function notify(trx: Transaction<DB>, userIds: number[], notice: Notice) {
  const ids = [...new Set(userIds)].filter((id) => id !== notice.actorId);
  if (ids.length === 0) return;
  const recipients = await trx
    .selectFrom("users")
    .leftJoin("thread_users", (join) =>
      join
        .onRef("thread_users.user_id", "=", "users.id")
        .on("thread_users.thread_id", "=", notice.threadId),
    )
    .select(["users.id", "users.qq", ...(await switches(notice.type))])
    .where("users.id", "in", ids)
    .where("users.member_status", "=", "member")
    .where(sql<boolean>`thread_users.notify_level IS DISTINCT FROM 'muted'`)
    .where("users.qq", "is not", null)
    .$narrowType<{ qq: NotNull }>()
    .execute();
  const onSite = recipients.filter((r) => r.site);
  if (onSite.length > 0) {
    const key = PER_THREAD.has(notice.type) ? notice.threadId : notice.postId;
    await trx
      .insertInto("notifications")
      .values(
        onSite.map((r) => ({
          user_id: r.id,
          type: notice.type,
          actor_id: notice.actorId,
          actor_alias: notice.actorAlias,
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
            actor_alias: sql<number | null>`excluded.actor_alias`,
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
  const byEmail = recipients.filter((r) => r.email);
  if (byEmail.length > 0) await queueMail(trx, await floorReminders(trx, byEmail, notice));
}

// Going up a level, automatically or from an admin (design §6.6); going down is not told, nor
// the owner, who has no QQ.
export async function notifyLevel(
  trx: Transaction<DB>,
  userId: number,
  level: number,
  standing: Standing,
) {
  const type = "level";
  const person = await trx
    .selectFrom("users")
    .select(["id", "qq", ...(await switches(type))])
    .where("id", "=", userId)
    .where("qq", "is not", null)
    .$narrowType<{ qq: NotNull }>()
    .executeTakeFirst();
  if (!person) return;
  if (person.site) {
    await trx
      .insertInto("notifications")
      .values({ user_id: userId, type, data: { level: String(level) } })
      .execute();
    await tellUnread(trx, [userId]);
  }
  if (person.email) await queueMail(trx, [await levelReminder(person, level, standing)]);
}

// A lottery drawn or called off (design §8.13): each entrant hears how it went for them, its author
// that it was drawn.
export async function notifyLottery(
  trx: Transaction<DB>,
  thread: { id: number; title: string },
  told: Told[],
) {
  if (told.length === 0) return;
  const type = "lottery";
  const people = await trx
    .selectFrom("users")
    .select(["id", "qq", ...(await switches(type))])
    .where(
      "id",
      "in",
      told.map((t) => t.userId),
    )
    .where("member_status", "=", "member")
    .where("qq", "is not", null)
    .$narrowType<{ qq: NotNull }>()
    .execute();
  const person = new Map(people.map((p) => [p.id, p]));
  const onSite = told.filter((t) => person.get(t.userId)?.site);
  if (onSite.length > 0) {
    await trx
      .insertInto("notifications")
      .values(
        onSite.map((t) => ({
          user_id: t.userId,
          type,
          thread_id: thread.id,
          data: { result: t.result, ...(t.result === "won" && { prize: t.prize }) },
        })),
      )
      .execute();
    await tellUnread(
      trx,
      onSite.map((t) => t.userId),
    );
  }
  const emailed = new Map(people.filter((p) => p.email).map((p) => [p.id, p]));
  await queueMail(trx, await lotteryReminders(trx, thread, told, emailed));
}

// Badges earned (design §8.8), several people at once when a check finds them. One earned for a
// floor points there.
export async function notifyBadges(
  trx: Transaction<DB>,
  badge: { id: number; name: string; description: string; tier: string },
  granted: { user_id: number; post_id: number | null }[],
) {
  const type = "badge";
  const people = await trx
    .selectFrom("users")
    .select(["id", "qq", ...(await switches(type))])
    .where(
      "id",
      "in",
      granted.map((g) => g.user_id),
    )
    .where("member_status", "=", "member")
    .where("qq", "is not", null)
    .$narrowType<{ qq: NotNull }>()
    .execute();
  const person = new Map(people.map((p) => [p.id, p]));
  const postIds = granted.flatMap((g) => (g.post_id === null ? [] : [g.post_id]));
  const threadOf = new Map(
    postIds.length === 0
      ? []
      : (
          await trx
            .selectFrom("posts")
            .select(["id", "thread_id"])
            .where("id", "in", postIds)
            .execute()
        ).map((p) => [p.id, p.thread_id]),
  );
  const onSite = granted.filter((g) => person.get(g.user_id)?.site);
  if (onSite.length > 0) {
    await trx
      .insertInto("notifications")
      .values(
        onSite.map((g) => ({
          user_id: g.user_id,
          type,
          thread_id: g.post_id === null ? null : threadOf.get(g.post_id),
          post_id: g.post_id,
          data: { badge_id: String(badge.id), name: badge.name },
        })),
      )
      .execute();
    await tellUnread(
      trx,
      onSite.map((g) => g.user_id),
    );
  }
  const emailed = granted.flatMap((g) => {
    const p = person.get(g.user_id);
    return p?.email ? [{ person: p, post_id: g.post_id }] : [];
  });
  if (emailed.length > 0) await queueMail(trx, await badgeReminders(trx, badge, emailed));
}

// A new floor: the author of the floor it replies to, then those @-ed in it, then the thread's
// author when it names no floor, then those watching the thread. Each person hears of it once, by
// the first of these that applies.
export async function notifyPost(
  trx: Transaction<DB>,
  post: {
    id: number;
    threadId: number;
    authorId: number;
    authorAlias: number | null;
    mentions: number[];
  },
  // Whose floor it replies to, or null for the thread.
  repliedTo: number | null,
  threadAuthorId: number,
) {
  const notice = {
    actorId: post.authorId,
    actorAlias: post.authorAlias,
    threadId: post.threadId,
    postId: post.id,
  };
  const told = new Set<number>();
  async function tell(ids: number[], type: Notice["type"]) {
    const fresh = ids.filter((id) => !told.has(id));
    await notify(trx, fresh, { ...notice, type });
    for (const id of fresh) told.add(id);
  }
  if (repliedTo !== null) await tell([repliedTo], "reply");
  await tell(post.mentions, "mention");
  if (repliedTo === null) await tell([threadAuthorId], "thread_reply");
  const watchers = await trx
    .selectFrom("thread_users")
    .select("user_id")
    .where("thread_id", "=", post.threadId)
    .where("notify_level", "=", "watching")
    .execute();
  await tell(
    watchers.map((w) => w.user_id),
    "watching",
  );
}

// A new thread: those @-ed in its opening post, then the author's followers, unless the author
// is anonymous.
export async function notifyThread(
  trx: Transaction<DB>,
  thread: {
    id: number;
    postId: number;
    authorId: number;
    authorAlias: number | null;
    mentions: number[];
  },
) {
  const notice = {
    actorId: thread.authorId,
    actorAlias: thread.authorAlias,
    threadId: thread.id,
    postId: thread.postId,
  };
  await notify(trx, thread.mentions, { ...notice, type: "mention" });
  if (thread.authorAlias !== null) return;
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

// Something happened to a floor: liked, boosted, accepted as the answer. Its author hears of it;
// likes and boosts merge with others on that floor. `actorAlias` is the actor's number when they
// did it anonymously.
export async function notifyOnPost(
  trx: Transaction<DB>,
  type: "like" | "boost" | "solved" | "moderation",
  post: { id: number; thread_id: number; author_id: number },
  actorId: number,
  actorAlias: number | null,
  data: Record<string, string>,
) {
  await notify(trx, [post.author_id], {
    type,
    actorId,
    actorAlias,
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
    .leftJoin("threads", "threads.id", "notifications.thread_id")
    .leftJoin("posts", "posts.id", "notifications.post_id")
    .select([
      "notifications.id",
      "notifications.type",
      "notifications.actor_id",
      "notifications.actor_alias",
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
      "posts.author_id",
      "posts.status",
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
      actor: r.actor_id === null ? null : writer(user, r.actor_id, r.actor_alias),
      count: r.count,
      // Only about a level has neither.
      thread: r.thread_id === null || r.title === null ? null : { id: r.thread_id, title: r.title },
      post: r.post_id === null || r.floor === null ? null : { id: r.post_id, floor: r.floor },
      // Content waiting for review or hidden shows to its author only.
      excerpt:
        r.html !== null &&
        r.deleted_at === null &&
        (r.status === "visible" || r.author_id === userId)
          ? excerpt(r.html, EXCERPT)
          : "",
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

// About a floor someone else wrote, so reading that floor in the thread has seen it too. Likes,
// boosts and the like are about the reader's own floors, which count as read from the start.
const SEEN_BY_READING: NotificationType[] = [
  "reply",
  "thread_reply",
  "mention",
  "watching",
  "following",
];

// Floors just read in a thread (an int4multirange) mark what told of them read.
export async function markReadByFloors(
  trx: Transaction<DB>,
  userId: number,
  threadId: number,
  floors: string,
) {
  const marked = await trx
    .updateTable("notifications")
    .set({ read_at: sql<Date>`now()` })
    .where("user_id", "=", userId)
    .where("thread_id", "=", threadId)
    .where("read_at", "is", null)
    .where("type", "in", SEEN_BY_READING)
    .where("post_id", "in", (eb) =>
      eb
        .selectFrom("posts")
        .select("id")
        .where("thread_id", "=", threadId)
        .where(sql<boolean>`${floors}::int4multirange @> floor`),
    )
    .returning("id")
    .execute();
  if (marked.length > 0) await tellUnread(trx, [userId]);
}

// Read ones are kept half a year.
export async function clearOldNotifications() {
  await db
    .deleteFrom("notifications")
    .where("read_at", "<", sql<Date>`now() - interval '180 days'`)
    .execute();
}
