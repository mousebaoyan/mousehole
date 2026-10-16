import { EventEmitter } from "node:events";
import { html } from "hono/html";
import { sql, type Kysely, type NotNull, type Transaction } from "kysely";
import type { DB } from "../../../db/types.ts";
import { db } from "../../platform/db.ts";
import { env } from "../../platform/env.ts";
import { AppError } from "../../platform/errors.ts";
import { queueMail, unsubscribeUrl } from "../../platform/mail.ts";
import { mailButton, mailPage, MUTED, optOut, TEAL } from "../../platform/mail-page.ts";
import { excerpt } from "../../platform/markdown.ts";
import { getSettings, type EmailPolicy, type Settings } from "../../platform/settings.ts";
import { levelName, SITE_NAME } from "../../platform/site.ts";
import { anonymousBrief, userBriefs, writer } from "../users/service.ts";
import { NOTIFICATION_LABELS, NOTIFICATION_TYPES, type NotificationType } from "./types.ts";

export { NOTIFICATION_TYPES };

// While unread, these become one per floor (likes, boosts) or per thread (new floors), counting
// up, with the latest person in front: "A 等 3 人".
const MERGED = new Set<NotificationType>(["like", "boost", "thread_reply", "watching"]);
const PER_THREAD = new Set<NotificationType>(["thread_reply", "watching"]);

// About something done to a floor; levels, lotteries and badges are told by their own.
type Notice = {
  type: Exclude<NotificationType, "level" | "lottery" | "badge">;
  actorId: number;
  // Their number in the thread when they did it anonymously (design §8.12).
  actorAlias: number | null;
  threadId: number;
  postId: number;
  data?: Record<string, string>;
};

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

// What happened, as the email says it after the person's name; levels and lotteries are said
// differently, having nobody behind them.
const SAID: Record<Notice["type"], string> = {
  reply: "回复了你",
  thread_reply: "回复了你的帖子",
  mention: "提到了你",
  like: "赞了你",
  boost: "给你留了短评",
  watching: "回复了你关注的帖子",
  following: "发了新帖",
  solved: "采纳了你的回答",
  moderation: "处理了你的内容",
};

// What a moderator did, for moderation notices, and what comes of it for the author.
const MODERATED: Record<string, string> = {
  approve: "通过了你的内容",
  reject: "未通过你的内容",
  hide: "隐藏了你的内容",
  unhide: "恢复了你的内容",
};
const NOT_SHOWN = "现在别人看不到它。对处理有疑问，可以在群里找版主。";
const MODERATED_AFTER: Record<string, string> = {
  approve: "现在大家都能看到它了。",
  reject: NOT_SHOWN,
  hide: NOT_SHOWN,
  unhide: "现在大家又能看到它了。",
};

// Characters of the floor in an email, and of the floor it replied to.
const MAIL_EXCERPT = 200;
const CONTEXT_EXCERPT = 60;

// Emails go to the QQ mailbox that comes with every QQ number, so they reach members who never
// logged in here too: someone whose question was brought over from a group learns of the answers.
function mailbox(qq: number) {
  return `${qq}@qq.com`;
}

// What a reminder says under what happened, in order: a title, a floor quoted, a line of small
// print, a sentence.
type Block = { kind: "title" | "quote" | "small" | "text"; text: string };

const BLOCK_STYLES: Record<Block["kind"], string> = {
  title: "margin:12px 0 0;font-size:19px;font-weight:600;",
  quote: `margin:12px 0 0;padding:8px 12px;border-left:3px solid ${TEAL};background:#f6f3ee;`,
  small: `margin:8px 0 0;font-size:13px;color:${MUTED};`,
  text: "margin:12px 0 0;",
};

// A reminder by email (design §8.6): what happened, then its blocks, and a button to it; under
// the card, why it came and the link that stops this type. Inboxes preview the floor quoted, or
// the first sentence.
async function reminder(
  person: { id: number; qq: number },
  type: NotificationType,
  mail: {
    subject: string;
    said: string;
    blocks: (Block | false)[];
    button: string;
    url: string;
  },
) {
  const unsubscribe = unsubscribeUrl(person.id, type);
  const footer = optOut(`「${NOTIFICATION_LABELS[type]}」的邮件提醒`, unsubscribe);
  const blocks = mail.blocks.filter((b) => b !== false);
  const card = html`<p style="margin:0;font-size:17px;font-weight:600;">${mail.said}</p>
    ${blocks.map((b) => html`<p style="${BLOCK_STYLES[b.kind]}">${b.text}</p>`)}
    ${mailButton(mail.button, mail.url)}`;
  const preview = blocks.find((b) => b.kind === "quote" || b.kind === "text")?.text ?? mail.said;
  return {
    address: mailbox(person.qq),
    subject: mail.subject,
    body: [mail.said, ...blocks.map((b) => b.text), mail.url, footer.text].join("\n\n"),
    html: await mailPage(preview, card, footer.html),
    unsubscribe,
  };
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
  if (byEmail.length > 0) await remindByEmail(trx, byEmail, notice);
}

// The floor a notice is about, its thread and who did it, with the numbers its email tells.
function aboutFloor(trx: Transaction<DB>, notice: Notice) {
  return trx
    .selectFrom("posts")
    .innerJoin("threads", "threads.id", "posts.thread_id")
    .innerJoin("boards", "boards.id", "threads.board_id")
    .innerJoin("users", (join) => join.on("users.id", "=", notice.actorId))
    .leftJoin("posts as parent", "parent.id", "posts.reply_to_id")
    .select([
      "posts.floor",
      "posts.html",
      "posts.like_count",
      "posts.boost_count",
      "parent.floor as parent_floor",
      "parent.html as parent_html",
      "threads.title",
      "threads.reply_count",
      "threads.view_count",
      "boards.name as board",
      sql<string[]>`ARRAY(SELECT tags.name FROM thread_tags
        JOIN tags ON tags.id = thread_tags.tag_id
        WHERE thread_tags.thread_id = threads.id ORDER BY tags.id)`.as("tags"),
      sql<number>`(SELECT count(DISTINCT p.author_id)::integer FROM posts p
        WHERE p.thread_id = threads.id AND p.status = 'visible' AND p.deleted_at IS NULL)`.as(
        "participants",
      ),
      "users.display_name as actor_name",
      "users.level as actor_level",
      "users.thread_count as actor_threads",
      "users.people_reached as actor_reached",
      sql<number>`(SELECT count(*)::integer FROM posts p WHERE p.author_id = users.id
        AND p.accepted_at IS NOT NULL AND p.deleted_at IS NULL AND NOT p.anonymous)`.as(
        "actor_accepted",
      ),
    ])
    .where("posts.id", "=", notice.postId)
    .executeTakeFirstOrThrow();
}

function small(parts: (string | false)[]): Block {
  return { kind: "small", text: parts.filter((p) => p !== false).join(" · ") };
}

// What each kind of floor notice tells besides the floor (design §8.6): a new floor, the thread's
// numbers; a new thread, its board and author; a like or a boost, the floor's numbers.
async function remindByEmail(
  trx: Transaction<DB>,
  people: { id: number; qq: number }[],
  notice: Notice,
) {
  const about = await aboutFloor(trx, notice);
  const url = `${env.PUBLIC_URL}/t/${notice.threadId}${about.floor > 1 ? `?floor=${about.floor}` : ""}`;
  const actor =
    notice.actorAlias === null ? about.actor_name : anonymousBrief(notice.actorAlias).display_name;
  // Their name and level, ready for what they did to follow.
  const who =
    notice.actorAlias === null && notice.type !== "moderation"
      ? `${actor}（${levelName(about.actor_level)}）`
      : `${actor} `;
  const where = about.floor > 1 ? `${about.title} #${about.floor}` : about.title;
  const quote: Block = { kind: "quote", text: excerpt(about.html, MAIL_EXCERPT) };
  const floorNumbers = small([
    where,
    about.like_count > 0 && `${about.like_count} 个赞`,
    about.boost_count > 0 && `${about.boost_count} 条短评`,
  ]);
  const verb =
    notice.type === "moderation" ? MODERATED[notice.data?.action ?? ""] : SAID[notice.type];
  let mail: { said: string; blocks: (Block | false)[]; button: string };
  switch (notice.type) {
    case "following": {
      const did = [
        `发过 ${about.actor_threads} 个帖子`,
        about.actor_accepted > 0 && `回答被采纳 ${about.actor_accepted} 次`,
        about.actor_reached > 0 && `帮到过 ${about.actor_reached} 位群友`,
      ].filter((d) => d !== false);
      mail = {
        said: `你关注的 ${who}发了新帖`,
        blocks: [
          { kind: "title", text: about.title },
          small([about.board, ...about.tags]),
          quote,
          { kind: "small", text: `TA 在${SITE_NAME}${did.join("，")}。` },
        ],
        button: "去看看",
      };
      break;
    }
    case "like":
    case "boost":
      mail = {
        said: `${who}${verb}${notice.type === "boost" ? `：「${notice.data?.body}」` : ""}`,
        blocks: [quote, floorNumbers],
        button: "查看",
      };
      break;
    case "solved":
      mail = { said: `${who}${verb}`, blocks: [quote, small([where])], button: "查看" };
      break;
    case "moderation":
      mail = {
        said: `${actor} ${verb}${notice.data?.reason ? `（${notice.data.reason}）` : ""}`,
        blocks: [
          quote,
          small([where]),
          { kind: "text", text: MODERATED_AFTER[notice.data?.action ?? ""] },
        ],
        button: "查看",
      };
      break;
    case "reply":
    case "mention":
    case "thread_reply":
    case "watching":
      mail = {
        said: `${who}${verb}`,
        blocks: [
          quote,
          notice.type === "reply" &&
            about.parent_floor !== null &&
            about.parent_html !== null && {
              kind: "small",
              text: `回复的是${about.parent_floor === 1 ? "你的主楼" : `你在 #${about.parent_floor} 说的`}：${excerpt(about.parent_html, CONTEXT_EXCERPT)}`,
            },
          small([
            where,
            about.reply_count > 0 && `${about.reply_count} 条回复`,
            about.participants > 1 && `${about.participants} 人参与`,
            about.view_count > 0 && `浏览 ${about.view_count}`,
          ]),
        ],
        button: "去回复",
      };
  }
  const full = { ...mail, subject: `${actor} ${verb}：${about.title}`, url };
  await queueMail(trx, await Promise.all(people.map((p) => reminder(p, notice.type, full))));
}

// Going up a level, automatically or from an admin (design §6.6); going down is not told, nor
// the owner, who has no QQ.
export async function notifyLevel(trx: Transaction<DB>, userId: number, level: number) {
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
  if (person.email) {
    const said = `你在${SITE_NAME}已升级到 ${levelName(level)}`;
    await queueMail(trx, [
      await reminder(person, type, {
        subject: said,
        said,
        blocks: [],
        button: "去我的主页",
        url: `${env.PUBLIC_URL}/u/${userId}`,
      }),
    ]);
  }
}

// A lottery drawn or called off (design §8.13): each entrant hears how it went for them, its author
// that it was drawn. Only a win and the author's go by email as well, or a draw would send
// hundreds of emails at once.
export async function notifyLottery(
  trx: Transaction<DB>,
  thread: { id: number; title: string },
  told: { userId: number; result: "won" | "lost" | "drawn" | "cancelled"; prize?: string }[],
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
          data: { result: t.result, ...(t.prize !== undefined && { prize: t.prize }) },
        })),
      )
      .execute();
    await tellUnread(
      trx,
      onSite.map((t) => t.userId),
    );
  }
  const url = `${env.PUBLIC_URL}/t/${thread.id}`;
  const mails = [];
  for (const t of told) {
    const p = person.get(t.userId);
    if (!p?.email || (t.result !== "won" && t.result !== "drawn")) continue;
    const said = t.result === "won" ? `你中奖了：${t.prize}` : "你发起的抽奖已开奖";
    mails.push(
      await reminder(p, type, {
        subject: said,
        said,
        blocks: [small([thread.title])],
        button: "查看抽奖",
        url,
      }),
    );
  }
  await queueMail(trx, mails);
}

// Badges earned (design §8.8), several people at once when a check finds them. One earned for a
// floor points there.
export async function notifyBadges(
  trx: Transaction<DB>,
  badge: { id: number; name: string; description: string },
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
  const said = `你在${SITE_NAME}得到了徽章「${badge.name}」`;
  const mail = {
    subject: said,
    said,
    blocks: [small([badge.description])],
    button: "查看徽章",
    url: `${env.PUBLIC_URL}/badges/${badge.id}`,
  };
  await queueMail(
    trx,
    await Promise.all(
      granted.flatMap((g) => {
        const p = person.get(g.user_id);
        return p?.email ? [reminder(p, type, mail)] : [];
      }),
    ),
  );
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
