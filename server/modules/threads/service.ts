import { sql, type ExpressionBuilder, type RawBuilder, type Transaction } from "kysely";
import type { DB, Json } from "../../../db/types.ts";
import { STAFF, type Actor, type Reader, type Viewer } from "../../platform/access.ts";
import { db } from "../../platform/db.ts";
import { AppError } from "../../platform/errors.ts";
import { log } from "../../platform/log.ts";
import { excerpt, renderMarkdown } from "../../platform/markdown.ts";
import { recordAudit } from "../audit/service.ts";
import { countBoard, countTags, findTags, getBoard, getTagId } from "../boards/service.ts";
import { discardDraft } from "../drafts/service.ts";
import { onebotToMarkdown, type Segment } from "../qq/onebot.ts";
import { notifyOnPost, notifyPost, notifyThread } from "../notifications/service.ts";
import { assertNotLinked, findLink, linkSource, type Source } from "../qq/service.ts";
import { indexPost, unindexPost } from "../search/service.ts";
import { fetchUpload, linkUploads, showImages } from "../uploads/service.ts";
import {
  countLikes,
  countPosting,
  countReading,
  countUserPosts,
  membersByQq,
  shownToGuests,
  userBriefs,
  writer,
} from "../users/service.ts";
import {
  contentPending,
  postCreated,
  postDeleted,
  postUpdated,
  threadCreated,
  threadDeleted,
  threadSolved,
} from "./events.ts";
import { createPoll, getPoll, type PollSpec } from "./polls.ts";

export const PAGE_SIZE = 30;
// Longest Markdown a post may have.
export const MAX_BODY = 30_000;
export const FLOOR_BATCH = 20;
// Characters of a reply shown where it is listed away from its thread.
const EXCERPT = 140;

export const VIEWS = [
  "latest",
  "created",
  "hot",
  "unsolved",
  "new",
  "unread",
  "read",
  "posted",
  "bookmarked",
] as const;
export type ThreadView = (typeof VIEWS)[number];

function threadNotFound() {
  return new AppError(404, "thread_not_found", "帖子不存在");
}

// What a viewer may open: published, not deleted, in a board they can see, and for guests not by
// someone who keeps their content from them.
function visibleThreads(members: boolean) {
  return openableThreads({ members, id: null, staff: false });
}

// Also threads waiting for review or hidden, for moderators and their authors. See design §8.4.
function openableThreads(reader: Reader) {
  return db
    .selectFrom("threads")
    .innerJoin("boards", "boards.id", "threads.board_id")
    .where("threads.deleted_at", "is", null)
    .$if(!reader.staff, (qb) =>
      qb.where((eb) =>
        reader.id === null
          ? eb("threads.status", "=", "visible")
          : eb.or([eb("threads.status", "=", "visible"), eb("threads.author_id", "=", reader.id)]),
      ),
    )
    .$if(!reader.members, (qb) =>
      qb.where("boards.visibility", "=", "public").where(shownToGuests("threads.author_id")),
    );
}

// With the reader's own row in thread_users, which a guest doesn't have.
function selectThreads(from: ReturnType<typeof openableThreads>, userId: number | null) {
  return from
    .leftJoin("thread_users as mine", (join) =>
      join.onRef("mine.thread_id", "=", "threads.id").on(sql<boolean>`mine.user_id = ${userId}`),
    )
    .select([
      "threads.id",
      "threads.kind",
      "threads.title",
      "threads.author_id",
      "threads.board_id",
      "threads.pinned",
      "threads.featured",
      "threads.locked",
      "threads.status",
      "threads.solved_post_id",
      "threads.reply_count",
      "threads.floor_count",
      "threads.view_count",
      "threads.like_count",
      "threads.last_post_at",
      "threads.created_at",
      "threads.author_anonymous",
      "threads.anonymous_replies",
      "boards.slug as board_slug",
      "boards.name as board_name",
      "boards.color as board_color",
      "mine.bookmarked_at",
      "mine.notify_level",
      sql<number | null>`upper(mine.read_floors) - 1`.as("last_read_floor"),
      // Topics first, then schools and majors.
      sql<string[]>`(
      SELECT coalesce(array_agg(tags.name ORDER BY
        array_position(array['topic', 'school', 'major'], tags.kind), tags.name), '{}')
      FROM thread_tags JOIN tags ON tags.id = thread_tags.tag_id
      WHERE thread_tags.thread_id = threads.id)`.as("tags"),
      // For lists: the latest people to reply besides the author, among the last 20 floors; those
      // who replied anonymously aren't shown.
      sql<number[]>`(
      SELECT coalesce(array_agg(author_id ORDER BY last_floor DESC), '{}') FROM (
        SELECT author_id, max(floor) AS last_floor FROM (
          SELECT author_id, floor FROM posts
          WHERE posts.thread_id = threads.id AND posts.deleted_at IS NULL AND NOT posts.anonymous
          ORDER BY floor DESC LIMIT 20
        ) recent
        WHERE author_id <> threads.author_id
        GROUP BY author_id ORDER BY last_floor DESC LIMIT 4
      ) latest)`.as("poster_ids"),
    ]);
}

type ThreadRow = Awaited<ReturnType<ReturnType<typeof selectThreads>["execute"]>>[number];

async function withUsers<Row extends ThreadRow>(rows: Row[]) {
  const user = await userBriefs(rows.flatMap((r) => [r.author_id, ...r.poster_ids]));
  return rows.map((row) => ({
    ...row,
    // An anonymous author is the thread's first number.
    author: writer(user, row.author_id, row.author_anonymous ? 1 : null),
    posters: row.poster_ids.map(user),
  }));
}

// ---- Lists

// Recomputed at most every 10 minutes: this week's threads by replies, likes and views, decayed
// by age. Visibility and filters still apply when a list is read.
const HOT_TTL_MS = 10 * 60_000;
let hot: { ids: number[]; at: number } | undefined;

async function hotIds() {
  if (hot && Date.now() - hot.at < HOT_TTL_MS) return hot.ids;
  const rows = await db
    .selectFrom("threads")
    .select("id")
    .where("created_at", ">", sql<Date>`now() - interval '7 days'`)
    .where("deleted_at", "is", null)
    .where("status", "=", "visible")
    .orderBy(
      sql`(reply_count * 2 + like_count + view_count / 20.0 + 1)
        / power(extract(epoch FROM now() - created_at) / 3600 + 2, 1.5)`,
      "desc",
    )
    .limit(500)
    .execute();
  hot = { ids: rows.map((r) => r.id), at: Date.now() };
  return hot.ids;
}

function badCursor(): never {
  throw new AppError(400, "invalid_request", "cursor 无效");
}

// The reader's own, from their row in thread_users: new is this week's and never opened; unread
// has floors past the highest one they read. See design §8.9.
const NEW = sql<boolean>`threads.created_at > now() - interval '7 days'
  AND mine.last_read_at IS NULL`;
const UNREAD = sql<boolean>`mine.last_read_at IS NOT NULL
  AND coalesce(upper(mine.read_floors) - 1, 0) < threads.floor_count`;

// A board and a tag to narrow a list to; either may be left out.
async function scopeOf(members: boolean, filter: { board?: string; tag?: string }) {
  return {
    board: filter.board === undefined ? null : await getBoard(filter.board, members),
    tagId: filter.tag === undefined ? null : await getTagId(filter.tag),
  };
}

function inScope({ board, tagId }: Awaited<ReturnType<typeof scopeOf>>) {
  return (eb: ExpressionBuilder<DB, "threads">) =>
    eb.and([
      ...(board ? [eb("threads.board_id", "=", board.id)] : []),
      ...(tagId === null
        ? []
        : [
            eb.exists(
              eb
                .selectFrom("thread_tags")
                .whereRef("thread_tags.thread_id", "=", "threads.id")
                .where("thread_tags.tag_id", "=", tagId),
            ),
          ]),
    ]);
}

// Cursors: the last thread's ID for `created`, an offset for `hot`, otherwise the time the list
// is ordered by (last activity, or when the reader bookmarked or last read it) and the ID. The
// reader's own lists are empty for guests.
export async function listThreads(
  members: boolean,
  userId: number | null,
  filter: { board?: string; tag?: string; author?: number; view: ThreadView; cursor?: string },
) {
  const { view, cursor } = filter;
  const scope = await scopeOf(members, filter);
  const { board, tagId } = scope;
  const time =
    view === "bookmarked"
      ? "mine.bookmarked_at"
      : view === "read"
        ? "mine.last_read_at"
        : "threads.last_post_at";

  let query = selectThreads(visibleThreads(members), userId)
    // Microseconds, exact for PostgreSQL timestamps, unlike a JavaScript Date.
    .select(sql<number>`(extract(epoch FROM ${sql.ref(time)}) * 1000000)::bigint`.as("micros"))
    .where(inScope(scope))
    .limit(PAGE_SIZE);
  if (filter.author !== undefined) {
    query = query
      .where("threads.author_id", "=", filter.author)
      .where("threads.author_anonymous", "=", false);
  }
  // Pinned threads lead the first page of the latest list instead of taking their turn: site-wide
  // ones on the home page, the board's own ones as well on a board page. Tag lists don't pin.
  const pinFrom = view === "latest" && tagId === null ? (board ? 1 : 2) : null;
  const pinned =
    pinFrom !== null && cursor === undefined
      ? await query
          .where("threads.pinned", ">=", pinFrom)
          .orderBy("threads.pinned", "desc")
          .orderBy("threads.last_post_at", "desc")
          .execute()
      : [];

  let next: (last: { id: number; micros: number }) => string;
  if (view === "created") {
    query = query.orderBy("threads.id", "desc");
    if (cursor !== undefined) {
      if (!/^\d+$/.test(cursor)) badCursor();
      query = query.where("threads.id", "<", Number(cursor));
    }
    next = (last) => String(last.id);
  } else if (view === "hot") {
    const ids = await hotIds();
    if (cursor !== undefined && !/^\d+$/.test(cursor)) badCursor();
    const offset = Number(cursor ?? 0);
    query = query
      .where("threads.id", "=", sql<number>`any(${ids}::integer[])`)
      .orderBy(sql`array_position(${ids}::integer[], threads.id)`)
      .offset(offset);
    next = () => String(offset + PAGE_SIZE);
  } else {
    if (view === "unsolved") {
      query = query
        .where("threads.kind", "=", "question")
        .where("threads.solved_post_id", "is", null);
    }
    if (view === "new") query = query.where(NEW);
    if (view === "unread") query = query.where(UNREAD);
    if (view === "read") query = query.where("mine.last_read_at", "is not", null);
    if (view === "bookmarked") query = query.where("mine.bookmarked_at", "is not", null);
    if (view === "posted") {
      query = query.where("threads.id", "in", (eb) =>
        eb
          .selectFrom("posts")
          .select("posts.thread_id")
          .where(sql<boolean>`posts.author_id = ${userId}`)
          .where("posts.deleted_at", "is", null),
      );
    }
    if (pinFrom !== null) query = query.where("threads.pinned", "<", pinFrom);
    query = query.orderBy(time, "desc").orderBy("threads.id", "desc");
    if (cursor !== undefined) {
      const [, micros, id] = /^(\d+)_(\d+)$/.exec(cursor) ?? badCursor();
      query = query.where((eb) =>
        eb(
          eb.refTuple(time, "threads.id"),
          "<",
          eb.tuple(
            sql<Date>`timestamptz 'epoch' + ${micros}::bigint * interval '1 microsecond'`,
            Number(id),
          ),
        ),
      );
    }
    next = (last) => `${last.micros}_${last.id}`;
  }

  const rows = await query.execute();
  const last = rows.at(-1);
  return {
    items: await withUsers([...pinned, ...rows]),
    next_cursor: rows.length === PAGE_SIZE && last ? next(last) : null,
  };
}

// For the list's tabs: how many threads in this board or tag are new and unread to the reader.
export async function countUnread(
  members: boolean,
  userId: number,
  filter: { board?: string; tag?: string },
) {
  return visibleThreads(members)
    .leftJoin("thread_users as mine", (join) =>
      join.onRef("mine.thread_id", "=", "threads.id").on("mine.user_id", "=", userId),
    )
    .select([
      sql<number>`(count(*) FILTER (WHERE ${NEW}))::integer`.as("new"),
      sql<number>`(count(*) FILTER (WHERE ${UNREAD}))::integer`.as("unread"),
    ])
    .where(inScope(await scopeOf(members, filter)))
    .executeTakeFirstOrThrow();
}

// Someone's replies, newest first, with the thread each is in; the cursor is the last one's ID.
export async function listUserPosts(members: boolean, authorId: number, cursor?: number) {
  let query = visibleThreads(members)
    .innerJoin("posts", "posts.thread_id", "threads.id")
    .select([
      "posts.id",
      "posts.floor",
      "posts.html",
      "posts.like_count",
      "posts.created_at",
      "threads.id as thread_id",
      "threads.title",
    ])
    .where("posts.author_id", "=", authorId)
    .where("posts.anonymous", "=", false)
    .$if(!members, (qb) => qb.where(shownToGuests("posts.author_id")))
    .where("posts.floor", ">", 1)
    .where("posts.status", "=", "visible")
    .where("posts.deleted_at", "is", null)
    .orderBy("posts.id", "desc")
    .limit(PAGE_SIZE);
  if (cursor !== undefined) query = query.where("posts.id", "<", cursor);
  const rows = await query.execute();
  const last = rows.at(-1);
  return {
    items: rows.map(({ html, ...r }) => ({ ...r, excerpt: excerpt(html, EXCERPT) })),
    next_cursor: rows.length === PAGE_SIZE && last ? String(last.id) : null,
  };
}

// For the sitemap: what guests may read, most recently active first.
export async function publicThreads(limit: number) {
  return visibleThreads(false)
    .select(["threads.id", "threads.last_post_at"])
    .orderBy("threads.last_post_at", "desc")
    .limit(limit)
    .execute();
}

// These threads as lists show them, for search results; ones the viewer can't see are left out.
export async function threadsByIds(members: boolean, userId: number | null, ids: number[]) {
  if (ids.length === 0) return new Map<number, Awaited<ReturnType<typeof withUsers>>[number]>();
  const rows = await selectThreads(visibleThreads(members), userId)
    .where("threads.id", "in", ids)
    .execute();
  return new Map((await withUsers(rows)).map((t) => [t.id, t]));
}

// ---- One thread and its floors

export async function getThread(id: number, reader: Reader) {
  const row = await selectThreads(openableThreads(reader), reader.id)
    .select([
      sql<[number, number][]>`(
        SELECT coalesce(json_agg(json_build_array(lower(r), upper(r) - 1) ORDER BY lower(r)), '[]')
        FROM unnest(mine.read_floors) r)`.as("read_floors"),
      sql<number | null>`(SELECT floor FROM posts WHERE posts.id = threads.solved_post_id)`.as(
        "solved_floor",
      ),
      sql<string>`(SELECT html FROM posts WHERE posts.thread_id = threads.id AND posts.floor = 1)`.as(
        "opening_html",
      ),
      // Which number is the reader's, where they wrote anonymously.
      sql<number | null>`(SELECT number FROM thread_aliases
        WHERE thread_aliases.thread_id = threads.id AND user_id = ${reader.id})`.as("my_alias"),
    ])
    .where("threads.id", "=", id)
    .executeTakeFirst();
  if (!row) {
    if (!reader.members && (await keptFromGuests(id))) {
      throw new AppError(401, "login_required", "楼主设置了仅成员可见");
    }
    throw threadNotFound();
  }
  const [thread] = await withUsers([row]);
  return { ...thread, poll: thread.kind === "poll" ? await getPoll(id, reader.id) : null };
}

// A thread guests could read but for its author's switch: they are asked to log in rather than
// told it is gone.
async function keptFromGuests(id: number) {
  const row = await openableThreads({ members: true, id: null, staff: false })
    .innerJoin("users", "users.id", "threads.author_id")
    .select("threads.id")
    .where("threads.id", "=", id)
    .where("boards.visibility", "=", "public")
    .where("users.hide_from_guests", "=", true)
    .executeTakeFirst();
  return row !== undefined;
}

// Floors waiting for review or hidden show to moderators and their authors only.
function selectPosts(reader: Reader) {
  return db
    .selectFrom("posts")
    .leftJoin("posts as target", "target.id", "posts.reply_to_id")
    .leftJoin("thread_aliases as alias", (join) =>
      join
        .onRef("alias.thread_id", "=", "posts.thread_id")
        .onRef("alias.user_id", "=", "posts.author_id")
        .on("posts.anonymous", "=", true),
    )
    .leftJoin("thread_aliases as target_alias", (join) =>
      join
        .onRef("target_alias.thread_id", "=", "target.thread_id")
        .onRef("target_alias.user_id", "=", "target.author_id")
        .on("target.anonymous", "=", true),
    )
    .select([
      "posts.id",
      "posts.thread_id",
      "posts.floor",
      "posts.author_id",
      "posts.body",
      "posts.html",
      "posts.via",
      "posts.reply_count",
      "posts.like_count",
      "posts.boost_count",
      sql<Record<string, number>>`posts.reactions`.as("reactions"),
      "posts.edited_at",
      "posts.created_at",
      "posts.deleted_at",
      "target.id as target_id",
      "target.floor as target_floor",
      "target.author_id as target_author_id",
      "alias.number as alias",
      "target_alias.number as target_alias",
      "posts.status",
      // Floors guests get without their content (design §8.10).
      (reader.members
        ? sql<boolean>`false`
        : sql<boolean>`NOT ${shownToGuests("posts.author_id")}`
      ).as("members_only"),
    ])
    .$if(!reader.staff, (qb) =>
      qb.where((eb) =>
        reader.id === null
          ? eb("posts.status", "=", "visible")
          : eb.or([eb("posts.status", "=", "visible"), eb("posts.author_id", "=", reader.id)]),
      ),
    );
}

type PostRow = Awaited<ReturnType<ReturnType<typeof selectPosts>["execute"]>>[number];

async function withPostUsers(rows: PostRow[]) {
  const user = await userBriefs(
    rows.flatMap((r) =>
      r.target_author_id === null ? [r.author_id] : [r.author_id, r.target_author_id],
    ),
  );
  return rows.map(({ target_id, target_floor, target_author_id, target_alias, ...post }) => ({
    ...post,
    author: writer(user, post.author_id, post.alias),
    reply_to:
      target_id === null || target_floor === null || target_author_id === null
        ? null
        : {
            id: target_id,
            floor: target_floor,
            author: writer(user, target_author_id, target_alias),
          },
  }));
}

async function assertVisible(threadId: number, reader: Reader) {
  const thread = await openableThreads(reader)
    .select([
      "threads.id",
      "threads.locked",
      "threads.board_id",
      "threads.floor_count",
      "threads.status",
      "threads.author_id",
      "threads.author_anonymous",
      "threads.anonymous_replies",
      "boards.review_mode",
    ])
    .where("threads.id", "=", threadId)
    .executeTakeFirst();
  if (!thread) throw threadNotFound();
  return thread;
}

// Whether someone writes anonymously in a thread: the author as the thread says for them, anyone
// else as it says for replies (design §8.12).
export function writesAnonymously(
  thread: { author_id: number; author_anonymous: boolean; anonymous_replies: boolean },
  userId: number,
) {
  return userId === thread.author_id ? thread.author_anonymous : thread.anonymous_replies;
}

// Someone's number in a thread: the one they have, or the next. The thread's row is locked so
// that two people can't take the same number.
export async function aliasIn(trx: Transaction<DB>, threadId: number, userId: number) {
  await trx.selectFrom("threads").select("id").where("id", "=", threadId).forUpdate().execute();
  await trx
    .insertInto("thread_aliases")
    .values((eb) => ({
      thread_id: threadId,
      user_id: userId,
      number: eb
        .selectFrom("thread_aliases")
        .select(sql<number>`coalesce(max(number), 0) + 1`.as("next"))
        .where("thread_id", "=", threadId),
    }))
    .onConflict((oc) => oc.columns(["thread_id", "user_id"]).doNothing())
    .execute();
  const { number } = await trx
    .selectFrom("thread_aliases")
    .select("number")
    .where("thread_id", "=", threadId)
    .where("user_id", "=", userId)
    .executeTakeFirstOrThrow();
  return number;
}

// Up to a batch of floors after or before one; fewer means that end of the thread was reached.
export async function listPosts(
  threadId: number,
  reader: Reader,
  range: { after: number } | { before: number },
) {
  await assertVisible(threadId, reader);
  let query = selectPosts(reader).where("posts.thread_id", "=", threadId).limit(FLOOR_BATCH);
  query =
    "after" in range
      ? query.where("posts.floor", ">", range.after).orderBy("posts.floor")
      : query.where("posts.floor", "<", range.before).orderBy("posts.floor", "desc");
  const rows = await query.execute();
  if ("before" in range) rows.reverse();
  return withPostUsers(rows);
}

export async function getPost(id: number, reader: Reader) {
  const row = await selectPosts(reader).where("posts.id", "=", id).executeTakeFirst();
  if (!row) throw new AppError(404, "post_not_found", "回复不存在");
  await assertVisible(row.thread_id, reader);
  const [post] = await withPostUsers([row]);
  return post;
}

// The floors that answer a post, in floor order, a batch at a time.
export async function listReplies(postId: number, reader: Reader, after: number) {
  const post = await getPost(postId, reader);
  const rows = await selectPosts(reader)
    .where("posts.thread_id", "=", post.thread_id)
    .where("posts.reply_to_id", "=", postId)
    .where("posts.deleted_at", "is", null)
    .where("posts.floor", ">", after)
    .orderBy("posts.floor")
    .limit(FLOOR_BATCH)
    .execute();
  return withPostUsers(rows);
}

// ---- Writing

// Bots' writes go to the audit log; people's own posts are their own record.
// What the audit log keeps of a post's text: enough to recognise it.
const AUDIT_EXCERPT = 100;

// What a post says: Markdown, or a QQ message's segments that become Markdown. See docs/api.md
// §2.5.
export type Content = { markdown: string } | { onebot: Segment[] };

// Images in a message are copied here now, before QQ's links expire; one that can't be fetched
// becomes "[图片已失效]". A quoted message counts as replying to the floor it became, within the
// same thread.
async function resolveContent(
  viewer: Viewer,
  content: Content,
  source: Source | undefined,
  threadId: number | null,
) {
  if ("markdown" in content) return { markdown: content.markdown, replyToId: null };
  const converted = await onebotToMarkdown(content.onebot, {
    members: membersByQq,
    image: (url) =>
      fetchUpload(viewer.id, url).then(
        (upload) => upload.url,
        (error: unknown) => {
          log("warn", "QQ image not copied", { error, url });
          return null;
        },
      ),
    quoted: async (messageId) => {
      if (!source || threadId === null) return null;
      const link = await findLink({ ...source, message_id: messageId });
      return link?.thread_id === threadId ? link.post_id : null;
    },
  });
  if (!converted.markdown) {
    throw new AppError(400, "invalid_request", "content：消息里没有能转成正文的内容");
  }
  if (converted.markdown.length > MAX_BODY) {
    throw new AppError(400, "invalid_request", "content：消息太长");
  }
  return converted;
}

function via(actor: Actor, source: Source | undefined) {
  return source ? "qq" : actor.tokenId === null ? "web" : "bot";
}

// What levels allow (design §6.6). Moderators and admins aren't held by any of it.
const POLL_LEVEL = 2;
// L0's limits, which content synced from the groups doesn't count towards.
const L0_LINKS = 2;
const L0_PER_DAY = { thread: 3, reply: 20 };

function levelRequired(message: string) {
  return new AppError(403, "level_required", message);
}

async function assertWithinL0(
  viewer: Viewer,
  source: Source | undefined,
  links: string[],
  kind: "thread" | "reply",
) {
  if (viewer.level > 0 || STAFF.includes(viewer.role) || source) return;
  if (links.length > L0_LINKS) {
    throw levelRequired(`L0 每层最多 ${L0_LINKS} 个站外链接，升到 L1 后不限`);
  }
  const today = await db
    .selectFrom("posts")
    .select(sql<number>`count(*)::integer`.as("count"))
    .where("author_id", "=", viewer.id)
    .where("deleted_at", "is", null)
    .where("via", "<>", "qq")
    .where("floor", kind === "thread" ? "=" : ">", 1)
    .where("created_at", ">=", sql<Date>`date_trunc('day', now(), 'Asia/Shanghai')`)
    .executeTakeFirstOrThrow();
  if (today.count >= L0_PER_DAY[kind]) {
    const what = kind === "thread" ? "个帖子" : "条回复";
    throw levelRequired(`L0 每天最多发 ${L0_PER_DAY[kind]} ${what}，升到 L1 后不限`);
  }
}

function assertMayPost(viewer: Viewer, board: { post_role: string }) {
  if (board.post_role === "moderator" && !STAFF.includes(viewer.role)) {
    throw forbidden("这个版块只有版主能发帖");
  }
}

// The power a level gives over someone else's content, from L3 up: the viewer's level when the
// writer is below it and not a moderator or admin, else 0. Nothing anonymous, whose writer's
// level would show in what is allowed.
async function levelPower(viewer: Viewer, authorId: number, anonymous: boolean) {
  if (viewer.level < 3 || anonymous || authorId === viewer.id) return 0;
  const author = await db
    .selectFrom("users")
    .select(["level", "role"])
    .where("id", "=", authorId)
    .executeTakeFirstOrThrow();
  return author.level < viewer.level && !STAFF.includes(author.role) ? viewer.level : 0;
}

export async function createThread(
  actor: Actor,
  viewer: Viewer,
  members: boolean,
  input: {
    board: string;
    title: string;
    content: Content;
    kind?: string;
    poll?: PollSpec;
    tags: string[];
    source?: Source;
    anonymous?: boolean;
    anonymous_replies?: boolean;
  },
) {
  const reader: Reader = { members, id: viewer.id, staff: false };
  const board = await getBoard(input.board, members);
  const anonymous = input.anonymous ?? false;
  assertMayPost(viewer, board);
  if (input.poll && viewer.level < POLL_LEVEL && !STAFF.includes(viewer.role)) {
    throw levelRequired(`L${POLL_LEVEL} 起才能发投票帖`);
  }
  const tagIds = await findTags(input.tags);
  if (input.source) await assertNotLinked(input.source);
  const { markdown } = await resolveContent(viewer, input.content, input.source, null);
  const { html, images, mentions, links } = await renderMarkdown(markdown, showImages);
  await assertWithinL0(viewer, input.source, links, "thread");

  const status = statusFor(board.review_mode, viewer);
  const id = await db.transaction().execute(async (trx) => {
    const thread = await trx
      .insertInto("threads")
      .values({
        board_id: board.id,
        author_id: viewer.id,
        kind: input.kind ?? board.default_kind,
        title: input.title,
        last_poster_id: viewer.id,
        status,
        author_anonymous: anonymous,
        anonymous_replies: input.anonymous_replies ?? false,
      })
      .returning(["id", "last_post_at"])
      .executeTakeFirstOrThrow();
    const opening = await trx
      .insertInto("posts")
      .values({
        thread_id: thread.id,
        floor: 1,
        author_id: viewer.id,
        body: markdown,
        html,
        via: via(actor, input.source),
        status,
        anonymous,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    // Number 1, the thread being new.
    if (anonymous) await aliasIn(trx, thread.id, viewer.id);
    if (input.poll) await createPoll(trx, thread.id, input.poll);
    await linkUploads(trx, opening.id, images);
    if (input.source) await linkSource(trx, input.source, thread.id, opening.id);
    // Posted from the composer; what a bot posts for them leaves their draft alone.
    if (actor.tokenId === null) await discardDraft(trx, viewer.id, null);
    await countPosting(trx, viewer.id);
    if (tagIds.length > 0) {
      await trx
        .insertInto("thread_tags")
        .values(
          tagIds.map((tag_id) => ({
            thread_id: thread.id,
            tag_id,
            last_post_at: thread.last_post_at,
          })),
        )
        .execute();
    }
    await trx
      .insertInto("thread_users")
      .values({
        user_id: viewer.id,
        thread_id: thread.id,
        notify_level: "watching",
        read_floors: readFloors([[1, 1]]),
        last_read_at: sql<Date>`now()`,
      })
      .execute();
    await indexPost(trx, opening.id);
    if (status === "visible") await publishThread(trx, thread.id, { mentions });
    else await contentPending(trx, opening.id);
    await recordAudit(trx, actor, {
      action: "thread.create",
      target_type: "thread",
      target_id: thread.id,
      data: { title: input.title, board: board.slug, text: excerpt(html, AUDIT_EXCERPT) },
    });
    return thread.id;
  });
  return getThread(id, reader);
}

export async function createPost(
  actor: Actor,
  viewer: Viewer,
  members: boolean,
  threadId: number,
  input: { content: Content; reply_to_id?: number; source?: Source },
) {
  const reader: Reader = { members, id: viewer.id, staff: false };
  const thread = await assertVisible(threadId, reader);
  assertPublic(thread);
  if (thread.locked && !STAFF.includes(viewer.role)) {
    throw new AppError(403, "thread_locked", "帖子已锁定");
  }
  if (input.source) await assertNotLinked(input.source);
  const { markdown, replyToId } = await resolveContent(
    viewer,
    input.content,
    input.source,
    threadId,
  );
  const replyTo = input.reply_to_id ?? replyToId ?? undefined;
  const { html, images, mentions, links } = await renderMarkdown(markdown, showImages);
  await assertWithinL0(viewer, input.source, links, "reply");
  const anonymous = writesAnonymously(thread, viewer.id);

  const status = statusFor(thread.review_mode, viewer);
  const id = await db.transaction().execute(async (trx) => {
    if (actor.tokenId === null) await discardDraft(trx, viewer.id, threadId);
    await countPosting(trx, viewer.id);
    if (replyTo !== undefined) {
      const target = await trx
        .selectFrom("posts")
        .select("id")
        .where("id", "=", replyTo)
        .where("thread_id", "=", threadId)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (!target) {
        throw new AppError(400, "invalid_request", "回复的那一层不在这个帖子里，或者已删除");
      }
    }
    // Locks the thread row, so concurrent replies take floor numbers one after another.
    const numbered = await trx
      .updateTable("threads")
      .set((eb) => ({ floor_count: eb("floor_count", "+", 1) }))
      .where("id", "=", threadId)
      .returning("floor_count")
      .executeTakeFirstOrThrow();
    const post = await trx
      .insertInto("posts")
      .values({
        thread_id: threadId,
        floor: numbered.floor_count,
        reply_to_id: replyTo,
        author_id: viewer.id,
        body: markdown,
        html,
        via: via(actor, input.source),
        status,
        anonymous,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    if (anonymous) await aliasIn(trx, threadId, viewer.id);
    await linkUploads(trx, post.id, images);
    if (input.source) await linkSource(trx, input.source, threadId, post.id);
    await addReadFloors(trx, viewer.id, threadId, [[numbered.floor_count, numbered.floor_count]]);
    await indexPost(trx, post.id);
    if (status === "visible") await publishPost(trx, post.id, { mentions });
    else await contentPending(trx, post.id);
    await recordAudit(trx, actor, {
      action: "post.create",
      target_type: "post",
      target_id: post.id,
      data: {
        thread_id: threadId,
        floor: numbered.floor_count,
        text: excerpt(html, AUDIT_EXCERPT),
      },
    });
    return post.id;
  });
  return getPost(id, reader);
}

// ---- Changing and removing

function forbidden(message: string) {
  return new AppError(403, "forbidden", message);
}

// Authors change their own content; moderators anyone's. A locked thread is moderators' only.
function assertMayChange(staff: boolean, viewer: Viewer, authorId: number, locked: boolean) {
  if (staff) return;
  if (authorId !== viewer.id) throw forbidden("只能修改自己发的内容");
  if (locked) throw new AppError(403, "thread_locked", "帖子已锁定");
}

// The old text goes into the post's edit history.
export async function editPost(
  actor: Actor,
  viewer: Viewer,
  staff: boolean,
  members: boolean,
  postId: number,
  markdown: string,
) {
  const reader: Reader = { members, id: viewer.id, staff };
  const post = await getPost(postId, reader);
  if (post.deleted_at !== null) throw new AppError(404, "post_not_found", "回复不存在");
  const thread = await assertVisible(post.thread_id, reader);
  // L5 edits the floors of those below them.
  const power = staff ? 0 : await levelPower(viewer, post.author_id, "anonymous" in post.author);
  if (power < 5) assertMayChange(staff, viewer, post.author_id, thread.locked);
  if (markdown === post.body) return post;
  const shown = post.status === "visible" && thread.status === "visible";
  const { html, images } = await renderMarkdown(markdown, showImages);

  await db.transaction().execute(async (trx) => {
    const edited = await trx
      .updateTable("posts")
      .set((eb) => ({
        body: markdown,
        html,
        edit_count: eb("edit_count", "+", 1),
        edited_at: sql<Date>`now()`,
      }))
      .where("id", "=", postId)
      .returning(["edit_count", sql<string>`old.body`.as("old_body")])
      .executeTakeFirstOrThrow();
    await trx
      .insertInto("post_revisions")
      .values({
        post_id: postId,
        rev: edited.edit_count,
        body: edited.old_body,
        editor_id: viewer.id,
      })
      .execute();
    await linkUploads(trx, postId, images);
    await indexPost(trx, postId);
    if (shown) await postUpdated(trx, postId, viewer.id);
    await recordAudit(trx, actor, {
      action: "post.edit",
      target_type: "post",
      target_id: postId,
      data: {
        thread_id: post.thread_id,
        floor: post.floor,
        rev: edited.edit_count,
        text: excerpt(html, AUDIT_EXCERPT),
      },
    });
  });
  return getPost(postId, reader);
}

// For admins: who each number in a thread is. Looking is logged.
export async function revealAliases(actor: Actor, threadId: number) {
  const thread = await db
    .selectFrom("threads")
    .select("id")
    .where("id", "=", threadId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!thread) throw threadNotFound();
  const rows = await db
    .selectFrom("thread_aliases")
    .select(["number", "user_id"])
    .where("thread_id", "=", threadId)
    .orderBy("number")
    .execute();
  await db.transaction().execute(async (trx) => {
    await recordAudit(trx, actor, {
      action: "thread.reveal",
      target_type: "thread",
      target_id: threadId,
    });
  });
  const user = await userBriefs(rows.map((r) => r.user_id));
  return rows.map((r) => ({ number: r.number, user: user(r.user_id) }));
}

export async function listRevisions(
  viewer: Viewer,
  staff: boolean,
  members: boolean,
  postId: number,
) {
  const reader: Reader = { members, id: viewer.id, staff };
  const post = await getPost(postId, reader);
  if (!staff && post.author_id !== viewer.id) throw forbidden("只有作者和版主能看编辑记录");
  const rows = await db
    .selectFrom("post_revisions")
    .select(["rev", "title", "body", "editor_id", "created_at"])
    .where("post_id", "=", postId)
    .orderBy("rev", "desc")
    .execute();
  const user = await userBriefs(rows.map((r) => r.editor_id));
  // The anonymous author's own edits keep their number.
  return rows.map(({ editor_id, ...rev }) => ({
    ...rev,
    editor: editor_id === post.author_id ? post.author : user(editor_id),
  }));
}

export type ThreadChange = {
  title?: string;
  tags?: string[];
  board?: string;
  pinned?: number;
  featured?: boolean;
  locked?: boolean;
};

// Authors may retitle and retag; moderators may do anything. Pinning and featuring are theirs
// alone; moving and locking also go to L3 and L5 over those below them.
export async function editThread(
  actor: Actor,
  viewer: Viewer,
  staff: boolean,
  members: boolean,
  threadId: number,
  change: ThreadChange,
) {
  const reader: Reader = { members, id: viewer.id, staff };
  const { title, tags, board: slug, locked, ...moderation } = change;
  const thread = await getThread(threadId, reader);
  // L3 changes the title, tags and board of threads by those below them, L5 also locks them; a
  // locked one only L5 may change.
  const power = staff ? 0 : await levelPower(viewer, thread.author_id, thread.author_anonymous);
  if (power < 3) assertMayChange(staff, viewer, thread.author_id, thread.locked);
  else if (thread.locked && power < 5) throw new AppError(403, "thread_locked", "帖子已锁定");
  if (!staff && (Object.keys(moderation).length > 0 || (slug !== undefined && power < 3))) {
    throw forbidden("只有版主能置顶、加精和移动自己的帖子");
  }
  if (!staff && locked !== undefined && power < 5) {
    throw forbidden("只有版主和 L5 能锁定帖子，L5 只能锁定等级比自己低的人的帖子");
  }
  const board = slug === undefined ? null : await getBoard(slug, members);
  if (board && !staff) assertMayPost(viewer, board);
  const tagIds = tags === undefined ? null : await findTags(tags);

  await db.transaction().execute(async (trx) => {
    const old = await trx
      .selectFrom("threads")
      .select(["title", "board_id", "reply_count", "last_post_at"])
      .where("id", "=", threadId)
      .forUpdate()
      .executeTakeFirstOrThrow();

    let retitled: number | null = null;
    if (title !== undefined && title !== old.title) {
      // A new title is an edit of the opening post, kept in its history with the old title.
      const opening = await trx
        .updateTable("posts")
        .set((eb) => ({ edit_count: eb("edit_count", "+", 1), edited_at: sql<Date>`now()` }))
        .where("thread_id", "=", threadId)
        .where("floor", "=", 1)
        .returning(["id", "edit_count", "body"])
        .executeTakeFirstOrThrow();
      await trx
        .insertInto("post_revisions")
        .values({
          post_id: opening.id,
          rev: opening.edit_count,
          title: old.title,
          body: opening.body,
          editor_id: viewer.id,
        })
        .execute();
      retitled = opening.id;
    }

    if (tagIds !== null) {
      const current = await trx
        .selectFrom("thread_tags")
        .select("tag_id")
        .where("thread_id", "=", threadId)
        .execute();
      const had = current.map((r) => r.tag_id);
      const removed = had.filter((id) => !tagIds.includes(id));
      const added = tagIds.filter((id) => !had.includes(id));
      if (removed.length > 0) {
        await trx
          .deleteFrom("thread_tags")
          .where("thread_id", "=", threadId)
          .where("tag_id", "in", removed)
          .execute();
      }
      if (added.length > 0) {
        await trx
          .insertInto("thread_tags")
          .values(
            added.map((tag_id) => ({
              thread_id: threadId,
              tag_id,
              last_post_at: old.last_post_at,
            })),
          )
          .execute();
      }
      if (thread.status === "visible") {
        await countTags(trx, removed, -1);
        await countTags(trx, added, 1);
      }
    }

    if (board && board.id !== old.board_id && thread.status === "visible") {
      await countBoard(trx, old.board_id, { threads: -1, posts: -old.reply_count });
      await countBoard(trx, board.id, { threads: 1, posts: old.reply_count });
    }

    const columns = { title, board_id: board?.id, locked, ...moderation };
    if (Object.values(columns).some((v) => v !== undefined)) {
      await trx.updateTable("threads").set(columns).where("id", "=", threadId).execute();
    }
    if (retitled !== null) await indexPost(trx, retitled);
    await recordAudit(trx, actor, {
      action: "thread.update",
      target_type: "thread",
      target_id: threadId,
      data: change,
    });
  });
  return getThread(threadId, reader);
}

// Authors can take back a thread nobody has replied to; moderators can remove any.
export async function deleteThread(
  actor: Actor,
  viewer: Viewer,
  staff: boolean,
  members: boolean,
  threadId: number,
) {
  const reader: Reader = { members, id: viewer.id, staff };
  const thread = await getThread(threadId, reader);
  assertMayChange(staff, viewer, thread.author_id, thread.locked);
  if (!staff && thread.reply_count > 0) {
    throw forbidden("已经有人回复了，不能删除；需要的话请联系版主");
  }
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("threads")
      .set({ deleted_at: sql<Date>`now()` })
      .where("id", "=", threadId)
      .execute();
    if (thread.status === "visible") await withdrawThread(trx, threadId, viewer.id, null);
    await recordAudit(trx, actor, {
      action: "thread.delete",
      target_type: "thread",
      target_id: threadId,
      data: { title: thread.title },
    });
  });
}

// The floor keeps its number and shows as deleted. The opening post goes with its thread.
export async function deletePost(
  actor: Actor,
  viewer: Viewer,
  staff: boolean,
  members: boolean,
  postId: number,
) {
  const reader: Reader = { members, id: viewer.id, staff };
  const post = await getPost(postId, reader);
  if (post.deleted_at !== null) throw new AppError(404, "post_not_found", "回复不存在");
  if (post.floor === 1) {
    throw new AppError(400, "invalid_request", "主楼不能单独删除，可以删除整个帖子");
  }
  const thread = await assertVisible(post.thread_id, reader);
  assertMayChange(staff, viewer, post.author_id, thread.locked);

  await db.transaction().execute(async (trx) => {
    const deleted = await trx
      .updateTable("posts")
      .set({ deleted_at: sql<Date>`now()` })
      .where("id", "=", postId)
      .where("deleted_at", "is", null)
      .returning("id")
      .executeTakeFirst();
    if (!deleted) throw new AppError(404, "post_not_found", "回复不存在");
    // A deleted answer is no longer the accepted one.
    await trx
      .updateTable("threads")
      .set({ solved_post_id: sql<number | null>`nullif(solved_post_id, ${postId}::integer)` })
      .where("id", "=", post.thread_id)
      .execute();
    await unindexPost(trx, postId);
    if (post.status === "visible") await withdrawPost(trx, postId, viewer.id, null);
    await recordAudit(trx, actor, {
      action: "post.delete",
      target_type: "post",
      target_id: postId,
      data: { thread_id: post.thread_id, floor: post.floor },
    });
  });
}

// ---- Review: see design §8.4. In a board reviewed before publishing, what anyone but a
// moderator posts waits as pending. Content becoming visible is counted, indexed and told of;
// hidden again, it is taken back out of all of these.

type Status = "visible" | "pending" | "hidden";

function statusFor(reviewMode: string, viewer: Viewer): Status {
  return reviewMode === "before" && !STAFF.includes(viewer.role) ? "pending" : "visible";
}

// `announce` is for the first time: the bot plugin and those it concerns hear of it then.
async function publishThread(
  trx: Transaction<DB>,
  threadId: number,
  announce: { mentions: number[] } | null,
) {
  const thread = await trx
    .selectFrom("threads")
    .innerJoin("posts", (join) =>
      join.onRef("posts.thread_id", "=", "threads.id").on("posts.floor", "=", 1),
    )
    .select([
      "threads.board_id",
      "threads.author_id",
      "threads.author_anonymous",
      "threads.reply_count",
      "posts.id as opening",
    ])
    .where("threads.id", "=", threadId)
    .executeTakeFirstOrThrow();
  await countThread(trx, threadId, thread, 1);
  if (announce) {
    await threadCreated(trx, thread.opening);
    await notifyThread(trx, {
      id: threadId,
      postId: thread.opening,
      authorId: thread.author_id,
      authorAlias: thread.author_anonymous ? 1 : null,
      mentions: announce.mentions,
    });
  }
}

async function withdrawThread(
  trx: Transaction<DB>,
  threadId: number,
  byId: number,
  reason: string | null,
) {
  const thread = await trx
    .selectFrom("threads")
    .select(["board_id", "author_id", "reply_count"])
    .where("id", "=", threadId)
    .executeTakeFirstOrThrow();
  await countThread(trx, threadId, thread, -1);
  await threadDeleted(trx, threadId, byId, reason);
}

// A thread in or out of its board's, tags' and author's counts, with the replies in it.
async function countThread(
  trx: Transaction<DB>,
  threadId: number,
  thread: { board_id: number; author_id: number; reply_count: number },
  delta: 1 | -1,
) {
  const tags = await trx
    .selectFrom("thread_tags")
    .select("tag_id")
    .where("thread_id", "=", threadId)
    .execute();
  await countBoard(trx, thread.board_id, { threads: delta, posts: delta * thread.reply_count });
  await countTags(
    trx,
    tags.map((t) => t.tag_id),
    delta,
  );
  await countUserPosts(trx, thread.author_id, { threads: delta, posts: 0 });
}

// A reply going public: its thread's replies and, the first time, last activity; the board's
// and author's counts; the floor it answers; the index.
async function publishPost(
  trx: Transaction<DB>,
  postId: number,
  announce: { mentions: number[] } | null,
) {
  const post = await trx
    .selectFrom("posts")
    .innerJoin("threads", "threads.id", "posts.thread_id")
    .leftJoin("thread_aliases as alias", (join) =>
      join
        .onRef("alias.thread_id", "=", "posts.thread_id")
        .onRef("alias.user_id", "=", "posts.author_id")
        .on("posts.anonymous", "=", true),
    )
    .select([
      "posts.thread_id",
      "posts.author_id",
      "posts.reply_to_id",
      "threads.board_id",
      "threads.status as thread_status",
      "alias.number as alias",
    ])
    .where("posts.id", "=", postId)
    .executeTakeFirstOrThrow();
  const replyTo = await countReply(trx, post, 1);
  if (announce) {
    const { last_post_at } = await trx
      .updateTable("threads")
      .set({ last_post_at: sql<Date>`now()`, last_poster_id: post.author_id })
      .where("id", "=", post.thread_id)
      .returning("last_post_at")
      .executeTakeFirstOrThrow();
    await trx
      .updateTable("thread_tags")
      .set({ last_post_at })
      .where("thread_id", "=", post.thread_id)
      .execute();
  }
  if (announce) {
    await postCreated(trx, postId);
    await notifyPost(
      trx,
      {
        id: postId,
        threadId: post.thread_id,
        authorId: post.author_id,
        authorAlias: post.alias,
        mentions: announce.mentions,
      },
      replyTo,
    );
  }
}

async function withdrawPost(
  trx: Transaction<DB>,
  postId: number,
  byId: number,
  reason: string | null,
) {
  const post = await trx
    .selectFrom("posts")
    .innerJoin("threads", "threads.id", "posts.thread_id")
    .select([
      "posts.thread_id",
      "posts.author_id",
      "posts.reply_to_id",
      "threads.board_id",
      "threads.status as thread_status",
    ])
    .where("posts.id", "=", postId)
    .executeTakeFirstOrThrow();
  await countReply(trx, post, -1);
  await postDeleted(trx, postId, byId, reason);
}

// A reply in or out of the counts: its thread's, its author's, the floor it answers, and its
// board's while the thread is public; countThread moves the rest. Returns who wrote that floor.
async function countReply(
  trx: Transaction<DB>,
  post: {
    thread_id: number;
    author_id: number;
    reply_to_id: number | null;
    board_id: number;
    thread_status: string;
  },
  delta: 1 | -1,
) {
  await trx
    .updateTable("threads")
    .set((eb) => ({ reply_count: eb("reply_count", "+", delta) }))
    .where("id", "=", post.thread_id)
    .execute();
  if (post.thread_status === "visible") {
    await countBoard(trx, post.board_id, { threads: 0, posts: delta });
  }
  await countUserPosts(trx, post.author_id, { threads: 0, posts: delta });
  if (post.reply_to_id === null) return null;
  const target = await trx
    .updateTable("posts")
    .set((eb) => ({ reply_count: eb("reply_count", "+", delta) }))
    .where("id", "=", post.reply_to_id)
    .returning("author_id")
    .executeTakeFirstOrThrow();
  return target.author_id;
}

// Who was @-ed in a post, to tell them when it is published after review.
async function mentionsOf(body: string) {
  return (await renderMarkdown(body, showImages)).mentions;
}

// An L4 reporting a floor by someone below them hides it until a moderator looks (design §6.6):
// whether this report would. Not the opening post, which goes with its thread.
export async function reportHolds(viewer: Viewer, post: Awaited<ReturnType<typeof getPost>>) {
  if (post.floor === 1 || post.status !== "visible") return false;
  return (await levelPower(viewer, post.author_id, "anonymous" in post.author)) >= 4;
}

export async function holdReported(trx: Transaction<DB>, postId: number, reporterId: number) {
  await trx.updateTable("posts").set({ status: "hidden" }).where("id", "=", postId).execute();
  await withdrawPost(trx, postId, reporterId, "被举报，等版主处理");
}

// A held floor comes back when its report is dismissed, unless a moderator dealt with it since.
export async function releaseReported(trx: Transaction<DB>, postId: number) {
  const released = await trx
    .updateTable("posts")
    .set({ status: "visible" })
    .where("id", "=", postId)
    .where("status", "=", "hidden")
    .where("deleted_at", "is", null)
    .returning("id")
    .executeTakeFirst();
  if (released) await publishPost(trx, postId, null);
}

// Replying, accepting an answer and reviewing a reply wait until the thread itself is public.
function assertPublic(thread: { status: string }) {
  if (thread.status !== "visible") throw forbidden("帖子待审核或已隐藏，暂时不能这样做");
}

// What the audit log and the author's notice call a change of status.
function statusAction(from: string, to: "visible" | "hidden") {
  if (from === "pending") return to === "visible" ? "approve" : "reject";
  return to === "hidden" ? "hide" : "unhide";
}

// Moderators approve what waits, hide what is visible and show again what was hidden. The
// opening post goes with its thread. The author is told, with the reason when it is hidden.
export async function setThreadStatus(
  actor: Actor,
  viewer: Viewer,
  members: boolean,
  threadId: number,
  status: "visible" | "hidden",
  reason: string | null,
) {
  const reader: Reader = { members, id: viewer.id, staff: true };
  const thread = await getThread(threadId, reader);
  if (thread.status === status) return;
  const opening = await db
    .selectFrom("posts")
    .select(["id", "body"])
    .where("thread_id", "=", threadId)
    .where("floor", "=", 1)
    .executeTakeFirstOrThrow();
  const action = statusAction(thread.status, status);
  const mentions = action === "approve" ? await mentionsOf(opening.body) : [];
  await db.transaction().execute(async (trx) => {
    await trx.updateTable("threads").set({ status }).where("id", "=", threadId).execute();
    await trx.updateTable("posts").set({ status }).where("id", "=", opening.id).execute();
    if (status === "visible") {
      await publishThread(trx, threadId, action === "approve" ? { mentions } : null);
    } else if (action === "hide") {
      await withdrawThread(trx, threadId, viewer.id, reason);
    }
    const post = { id: opening.id, thread_id: threadId, author_id: thread.author_id };
    await notifyOnPost(trx, "moderation", post, viewer.id, null, {
      action,
      reason: reason ?? "",
    });
    await recordAudit(trx, actor, {
      action: `thread.${action}`,
      target_type: "thread",
      target_id: threadId,
      data: { reason },
    });
  });
}

export async function setPostStatus(
  actor: Actor,
  viewer: Viewer,
  members: boolean,
  postId: number,
  status: "visible" | "hidden",
  reason: string | null,
) {
  const reader: Reader = { members, id: viewer.id, staff: true };
  const post = await getPost(postId, reader);
  if (post.deleted_at !== null) throw new AppError(404, "post_not_found", "回复不存在");
  if (post.floor === 1) {
    throw new AppError(400, "invalid_request", "主楼随帖子，请修改帖子的状态");
  }
  assertPublic(await assertVisible(post.thread_id, reader));
  if (post.status === status) return;
  const action = statusAction(post.status, status);
  const mentions = action === "approve" ? await mentionsOf(post.body) : [];
  await db.transaction().execute(async (trx) => {
    await trx.updateTable("posts").set({ status }).where("id", "=", postId).execute();
    if (status === "visible") {
      await publishPost(trx, postId, action === "approve" ? { mentions } : null);
    } else if (action === "hide") {
      await withdrawPost(trx, postId, viewer.id, reason);
    }
    await notifyOnPost(trx, "moderation", post, viewer.id, null, {
      action,
      reason: reason ?? "",
    });
    await recordAudit(trx, actor, {
      action: `post.${action}`,
      target_type: "post",
      target_id: postId,
      data: { reason },
    });
  });
}

const MODERATED_PAGE = 30;

// For moderators: what waits for review, or was hidden, newest first; a thread shows as its
// opening post. The cursor is the last one's ID.
export async function listModerated(status: "pending" | "hidden", cursor: number | undefined) {
  let query = db
    .selectFrom("posts")
    .innerJoin("threads", "threads.id", "posts.thread_id")
    .innerJoin("boards", "boards.id", "threads.board_id")
    .leftJoin("thread_aliases as alias", (join) =>
      join
        .onRef("alias.thread_id", "=", "posts.thread_id")
        .onRef("alias.user_id", "=", "posts.author_id")
        .on("posts.anonymous", "=", true),
    )
    .select([
      "posts.id",
      "posts.floor",
      "posts.html",
      "posts.author_id",
      "alias.number as alias",
      "posts.created_at",
      "threads.id as thread_id",
      "threads.title",
      "boards.slug as board_slug",
      "boards.name as board_name",
    ])
    .where("posts.status", "=", status)
    .where("posts.deleted_at", "is", null)
    .where("threads.deleted_at", "is", null)
    .orderBy("posts.id", "desc")
    .limit(MODERATED_PAGE);
  if (cursor !== undefined) query = query.where("posts.id", "<", cursor);
  const rows = await query.execute();
  const user = await userBriefs(rows.map((r) => r.author_id));
  const last = rows.at(-1);
  return {
    items: rows.map(({ html, author_id, alias, ...r }) => ({
      ...r,
      author: writer(user, author_id, alias),
      excerpt: excerpt(html, EXCERPT),
    })),
    next_cursor: rows.length === MODERATED_PAGE && last ? String(last.id) : null,
  };
}

// For the admin overview: what was published today, Beijing time, and what waits for review.
export async function contentStats() {
  const today = sql<Date>`date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai')
    AT TIME ZONE 'Asia/Shanghai'`;
  const published = await db
    .selectFrom("posts")
    .select([
      sql<number>`count(*) FILTER (WHERE floor = 1)::integer`.as("threads"),
      sql<number>`count(*) FILTER (WHERE floor > 1)::integer`.as("posts"),
    ])
    .where("created_at", ">=", today)
    .where("status", "=", "visible")
    .where("deleted_at", "is", null)
    .executeTakeFirstOrThrow();
  const { pending } = await db
    .selectFrom("posts")
    .innerJoin("threads", "threads.id", "posts.thread_id")
    .select(sql<number>`count(*)::integer`.as("pending"))
    .where("posts.status", "=", "pending")
    .where("posts.deleted_at", "is", null)
    .where("threads.deleted_at", "is", null)
    .executeTakeFirstOrThrow();
  return { threads_today: published.threads, posts_today: published.posts, pending };
}

// ---- Accepted answers

// The asker, or a moderator, picks the floor that answered a question; another pick replaces it,
// null takes it back. The answerer hears of it.
export async function setSolution(
  actor: Actor,
  viewer: Viewer,
  staff: boolean,
  members: boolean,
  threadId: number,
  postId: number | null,
) {
  const reader: Reader = { members, id: viewer.id, staff };
  const thread = await getThread(threadId, reader);
  assertMayChange(staff, viewer, thread.author_id, thread.locked);
  assertPublic(thread);
  if (thread.kind !== "question") {
    throw new AppError(400, "invalid_request", "只有问答帖子能采纳答案");
  }
  const answer =
    postId === null
      ? null
      : await db
          .selectFrom("posts")
          .select(["id", "author_id"])
          .where("id", "=", postId)
          .where("thread_id", "=", threadId)
          .where("floor", ">", 1)
          .where("status", "=", "visible")
          .where("deleted_at", "is", null)
          .executeTakeFirst();
  if (answer === undefined) {
    throw new AppError(400, "invalid_request", "只能采纳这个帖子里公开的回复");
  }
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("threads")
      .set({ solved_post_id: answer?.id ?? null })
      .where("id", "=", threadId)
      .execute();
    if (answer) {
      await threadSolved(trx, answer.id);
      await notifyOnPost(
        trx,
        "solved",
        { id: answer.id, thread_id: threadId, author_id: answer.author_id },
        viewer.id,
        // The author accepting, by their number when anonymous.
        viewer.id === thread.author_id && thread.author_anonymous ? 1 : null,
        {},
      );
    }
    await recordAudit(trx, actor, {
      action: answer ? "thread.solve" : "thread.unsolve",
      target_type: "thread",
      target_id: threadId,
      data: { post_id: answer?.id ?? null },
    });
  });
  return getThread(threadId, reader);
}

// ---- Reactions

// One emoji's count in a post's `reactions`, dropped when it reaches zero.
function adjust(json: RawBuilder<Json>, emoji: string, delta: number) {
  const count = sql`coalesce((${json} ->> ${emoji}::text)::integer, 0) + ${delta}::integer`;
  return sql<Json>`CASE WHEN ${count} > 0
    THEN jsonb_set(${json}, ARRAY[${emoji}::text], to_jsonb(${count}))
    ELSE ${json} - ${emoji}::text END`;
}

// Kept with the reaction, in its transaction: the post's counts by emoji, and since every reaction
// is a like, the likes of the post, of its thread when it is the opening post, and of its author.
export async function countReaction(
  trx: Transaction<DB>,
  postId: number,
  { from, to }: { from: string | null; to: string | null },
) {
  let reactions = sql<Json>`posts.reactions`;
  if (from !== null) reactions = adjust(reactions, from, -1);
  if (to !== null) reactions = adjust(reactions, to, 1);
  const likes = (to === null ? 0 : 1) - (from === null ? 0 : 1);
  const post = await trx
    .updateTable("posts")
    .set((eb) => ({ reactions, like_count: eb("like_count", "+", likes) }))
    .where("id", "=", postId)
    .returning(["thread_id", "floor", "author_id"])
    .executeTakeFirstOrThrow();
  if (likes === 0) return;
  if (post.floor === 1) {
    await trx
      .updateTable("threads")
      .set((eb) => ({ like_count: eb("like_count", "+", likes) }))
      .where("id", "=", post.thread_id)
      .execute();
  }
  await countLikes(trx, post.author_id, likes);
}

export async function countBoosts(trx: Transaction<DB>, postId: number, boosts: number) {
  await trx
    .updateTable("posts")
    .set((eb) => ({ boost_count: eb("boost_count", "+", boosts) }))
    .where("id", "=", postId)
    .execute();
}

// ---- The reader's own: bookmarks and how closely they follow a thread

export const NOTIFY_LEVELS = ["watching", "normal", "muted"] as const;
export type NotifyLevel = (typeof NOTIFY_LEVELS)[number];

// Everything someone wrote that is still there, whatever its review status, and what they
// bookmarked; for the export of their own data. See design §13.
export async function exportOwnPosts(userId: number) {
  const posts = await db
    .selectFrom("posts")
    .innerJoin("threads", "threads.id", "posts.thread_id")
    .innerJoin("boards", "boards.id", "threads.board_id")
    .select([
      "posts.id",
      "posts.thread_id",
      "threads.title",
      "boards.slug as board",
      "posts.floor",
      "posts.body",
      "posts.status",
      "posts.created_at",
      "posts.edited_at",
    ])
    .where("posts.author_id", "=", userId)
    .where("posts.deleted_at", "is", null)
    .where("threads.deleted_at", "is", null)
    .orderBy("posts.id")
    .execute();
  const bookmarks = await db
    .selectFrom("thread_users")
    .innerJoin("threads", "threads.id", "thread_users.thread_id")
    .select(["threads.id as thread_id", "threads.title", "thread_users.bookmarked_at"])
    .where("thread_users.user_id", "=", userId)
    .where("thread_users.bookmarked_at", "is not", null)
    .where("threads.deleted_at", "is", null)
    .orderBy("thread_users.bookmarked_at")
    .execute();
  return { posts, bookmarks };
}

// Bookmarking again keeps the first time, which the bookmark list is ordered by.
export async function setBookmark(
  viewer: Viewer,
  members: boolean,
  threadId: number,
  bookmarked: boolean,
) {
  const reader: Reader = { members, id: viewer.id, staff: false };
  await assertVisible(threadId, reader);
  await db
    .insertInto("thread_users")
    .values({
      user_id: viewer.id,
      thread_id: threadId,
      bookmarked_at: bookmarked ? sql<Date>`now()` : null,
    })
    .onConflict((oc) =>
      oc.columns(["user_id", "thread_id"]).doUpdateSet({
        bookmarked_at: bookmarked ? sql<Date>`coalesce(thread_users.bookmarked_at, now())` : null,
      }),
    )
    .execute();
}

export async function setNotifyLevel(
  viewer: Viewer,
  members: boolean,
  threadId: number,
  level: NotifyLevel,
) {
  const reader: Reader = { members, id: viewer.id, staff: false };
  await assertVisible(threadId, reader);
  await db
    .insertInto("thread_users")
    .values({ user_id: viewer.id, thread_id: threadId, notify_level: level })
    .onConflict((oc) => oc.columns(["user_id", "thread_id"]).doUpdateSet({ notify_level: level }))
    .execute();
}

// ---- Reading. See design §8.9.

// A report counts this much reading time at most; it is sent every minute or so.
const MAX_READ_SECONDS = 120;

// Floor ranges, both ends included, as an int4multirange: adjacent ones merge on the way in.
function readFloors(ranges: [number, number][]) {
  return sql<string>`int4multirange(${sql.join(
    ranges.map(([from, to]) => sql`int4range(${from}, ${to}, '[]')`),
  )})`;
}

function floorsIn(set: "old" | "new") {
  return sql<number>`(SELECT coalesce(sum(upper(r) - lower(r)), 0)::integer
    FROM unnest(${sql.raw(set)}.read_floors) r)`;
}

// Joins floors to what the reader has read, and returns how many of them they hadn't.
async function addReadFloors(
  trx: Transaction<DB>,
  userId: number,
  threadId: number,
  ranges: [number, number][],
) {
  const { added } = await trx
    .insertInto("thread_users")
    .values({
      user_id: userId,
      thread_id: threadId,
      read_floors: readFloors(ranges),
      last_read_at: sql<Date>`now()`,
    })
    .onConflict((oc) =>
      oc.columns(["user_id", "thread_id"]).doUpdateSet({
        read_floors: sql<string>`thread_users.read_floors + excluded.read_floors`,
        last_read_at: sql<Date>`now()`,
      }),
    )
    .returning(sql<number>`${floorsIn("new")} - ${floorsIn("old")}`.as("added"))
    .executeTakeFirstOrThrow();
  return added;
}

// What the browser reports: the floors read since the last report and for how long. Floors past
// the end of the thread are dropped. Floors the reader can't see, waiting for review or hidden,
// are taken as read once they read past them, or reach the last floor they can see, so the
// thread doesn't stay unread; they don't count as reading. See design §8.9.
export async function recordReading(
  viewer: Viewer,
  members: boolean,
  threadId: number,
  ranges: [number, number][],
  seconds: number,
) {
  const reader: Reader = { members, id: viewer.id, staff: false };
  const thread = await assertVisible(threadId, reader);
  const floors = ranges
    .map(([from, to]): [number, number] => [from, Math.min(to, thread.floor_count)])
    .filter(([from, to]) => from <= to);
  const reached = Math.max(0, ...floors.map(([, to]) => to));
  const unseen = new Set(
    (
      await db
        .selectFrom("posts")
        .select("floor")
        .where("thread_id", "=", threadId)
        .where("status", "<>", "visible")
        .where("author_id", "<>", viewer.id)
        .execute()
    ).map((p) => p.floor),
  );
  let lastSeen = thread.floor_count;
  while (unseen.has(lastSeen)) lastSeen--;
  const upTo = reached >= lastSeen ? thread.floor_count : reached;
  const skipped = [...unseen].filter((f) => f <= upTo).map((f): [number, number] => [f, f]);
  await db.transaction().execute(async (trx) => {
    const added = await addReadFloors(trx, viewer.id, threadId, floors);
    if (skipped.length > 0) await addReadFloors(trx, viewer.id, threadId, skipped);
    await countReading(trx, viewer.id, {
      posts: added,
      seconds: Math.min(seconds, MAX_READ_SECONDS),
    });
  });
}

// ---- Views

// Counted in memory and written once a minute; the same reader within that minute counts once.
let views = new Set<string>();

export function recordView(threadId: number, reader: string) {
  views.add(`${threadId} ${reader}`);
}

export async function flushViews() {
  if (views.size === 0) return;
  const counts = new Map<number, number>();
  for (const key of views) {
    const id = Number(key.split(" ")[0]);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  views = new Set();
  await sql`
    UPDATE threads SET view_count = view_count + v.n
    FROM (VALUES ${sql.join([...counts].map(([id, n]) => sql`(${id}::integer, ${n}::integer)`))})
      AS v (id, n)
    WHERE threads.id = v.id`.execute(db);
}
