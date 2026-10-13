import { sql, type ExpressionBuilder, type RawBuilder, type Transaction } from "kysely";
import type { DB, Json } from "../../../db/types.ts";
import { STAFF, type Actor, type Viewer } from "../../platform/access.ts";
import { db } from "../../platform/db.ts";
import { AppError } from "../../platform/errors.ts";
import { log } from "../../platform/log.ts";
import { excerpt, renderMarkdown } from "../../platform/markdown.ts";
import { recordAudit } from "../audit/service.ts";
import { countBoard, countTags, findTags, getBoard, getTagId } from "../boards/service.ts";
import { onebotToMarkdown, type Segment } from "../qq/onebot.ts";
import { notifyOnPost, notifyPost, notifyThread } from "../notifications/service.ts";
import { assertNotLinked, findLink, linkSource, type Source } from "../qq/service.ts";
import { fetchUpload, linkUploads, showImages } from "../uploads/service.ts";
import {
  countLikes,
  countReading,
  countUserPosts,
  membersByQq,
  userBriefs,
} from "../users/service.ts";
import {
  postCreated,
  postDeleted,
  postUpdated,
  threadCreated,
  threadDeleted,
  threadSolved,
} from "./events.ts";

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
  return new AppError(404, "thread_not_found", "主题不存在");
}

// What a viewer may open: published, not deleted, and in a board they can see.
function visibleThreads(members: boolean) {
  return db
    .selectFrom("threads")
    .innerJoin("boards", "boards.id", "threads.board_id")
    .where("threads.deleted_at", "is", null)
    .where("threads.status", "=", "visible")
    .$if(!members, (qb) => qb.where("boards.visibility", "=", "public"));
}

// With the reader's own row in thread_users, which a guest doesn't have.
function selectThreads(members: boolean, userId: number | null) {
  return visibleThreads(members)
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
      "threads.solved_post_id",
      "threads.reply_count",
      "threads.floor_count",
      "threads.view_count",
      "threads.like_count",
      "threads.last_post_at",
      "threads.created_at",
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
      // For lists: the latest people to reply besides the author, among the last 20 floors.
      sql<number[]>`(
      SELECT coalesce(array_agg(author_id ORDER BY last_floor DESC), '{}') FROM (
        SELECT author_id, max(floor) AS last_floor FROM (
          SELECT author_id, floor FROM posts
          WHERE posts.thread_id = threads.id AND posts.deleted_at IS NULL
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
    author: user(row.author_id),
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

  let query = selectThreads(members, userId)
    // Microseconds, exact for PostgreSQL timestamps, unlike a JavaScript Date.
    .select(sql<number>`(extract(epoch FROM ${sql.ref(time)}) * 1000000)::bigint`.as("micros"))
    .where(inScope(scope))
    .limit(PAGE_SIZE);
  if (filter.author !== undefined) query = query.where("threads.author_id", "=", filter.author);
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
    .where("posts.floor", ">", 1)
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

// ---- One thread and its floors

export async function getThread(id: number, members: boolean, userId: number | null) {
  const row = await selectThreads(members, userId)
    .select([
      sql<[number, number][]>`(
        SELECT coalesce(json_agg(json_build_array(lower(r), upper(r) - 1) ORDER BY lower(r)), '[]')
        FROM unnest(mine.read_floors) r)`.as("read_floors"),
      sql<number | null>`(SELECT floor FROM posts WHERE posts.id = threads.solved_post_id)`.as(
        "solved_floor",
      ),
    ])
    .where("threads.id", "=", id)
    .executeTakeFirst();
  if (!row) throw threadNotFound();
  const [thread] = await withUsers([row]);
  return thread;
}

function selectPosts() {
  return db
    .selectFrom("posts")
    .leftJoin("posts as target", "target.id", "posts.reply_to_id")
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
    ])
    .where("posts.status", "=", "visible");
}

type PostRow = Awaited<ReturnType<ReturnType<typeof selectPosts>["execute"]>>[number];

async function withPostUsers(rows: PostRow[]) {
  const user = await userBriefs(
    rows.flatMap((r) =>
      r.target_author_id === null ? [r.author_id] : [r.author_id, r.target_author_id],
    ),
  );
  return rows.map(({ target_id, target_floor, target_author_id, ...post }) => ({
    ...post,
    author: user(post.author_id),
    reply_to:
      target_id === null || target_floor === null || target_author_id === null
        ? null
        : { id: target_id, floor: target_floor, author: user(target_author_id) },
  }));
}

async function assertVisible(threadId: number, members: boolean) {
  const thread = await visibleThreads(members)
    .select(["threads.id", "threads.locked", "threads.board_id", "threads.floor_count"])
    .where("threads.id", "=", threadId)
    .executeTakeFirst();
  if (!thread) throw threadNotFound();
  return thread;
}

// Up to a batch of floors after or before one; fewer means that end of the thread was reached.
export async function listPosts(
  threadId: number,
  members: boolean,
  range: { after: number } | { before: number },
) {
  await assertVisible(threadId, members);
  let query = selectPosts().where("posts.thread_id", "=", threadId).limit(FLOOR_BATCH);
  query =
    "after" in range
      ? query.where("posts.floor", ">", range.after).orderBy("posts.floor")
      : query.where("posts.floor", "<", range.before).orderBy("posts.floor", "desc");
  const rows = await query.execute();
  if ("before" in range) rows.reverse();
  return withPostUsers(rows);
}

export async function getPost(id: number, members: boolean) {
  const row = await selectPosts().where("posts.id", "=", id).executeTakeFirst();
  if (!row) throw new AppError(404, "post_not_found", "回复不存在");
  await assertVisible(row.thread_id, members);
  const [post] = await withPostUsers([row]);
  return post;
}

// The floors that answer a post, in floor order, a batch at a time.
export async function listReplies(postId: number, members: boolean, after: number) {
  const post = await getPost(postId, members);
  const rows = await selectPosts()
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
async function auditBot(
  trx: Transaction<DB>,
  actor: Actor,
  action: string,
  type: string,
  id: number,
) {
  if (actor.tokenId === null) return;
  await recordAudit(trx, actor, { action, target_type: type, target_id: id });
}

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

export async function createThread(
  actor: Actor,
  viewer: Viewer,
  members: boolean,
  input: {
    board: string;
    title: string;
    content: Content;
    kind?: string;
    tags: string[];
    source?: Source;
  },
) {
  const board = await getBoard(input.board, members);
  if (board.post_role === "moderator" && !STAFF.includes(viewer.role)) {
    throw new AppError(403, "forbidden", "这个版块只有版主能发主题");
  }
  const tagIds = await findTags(input.tags);
  if (input.source) await assertNotLinked(input.source);
  const { markdown } = await resolveContent(viewer, input.content, input.source, null);
  const { html, images, mentions } = await renderMarkdown(markdown, showImages);

  const id = await db.transaction().execute(async (trx) => {
    const thread = await trx
      .insertInto("threads")
      .values({
        board_id: board.id,
        author_id: viewer.id,
        kind: input.kind ?? board.default_kind,
        title: input.title,
        last_poster_id: viewer.id,
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
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await linkUploads(trx, opening.id, images);
    if (input.source) await linkSource(trx, input.source, thread.id, opening.id);
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
    await countBoard(trx, board.id, { threads: 1, posts: 0 });
    await countTags(trx, tagIds, 1);
    await countUserPosts(trx, viewer.id, { threads: 1, posts: 0 });
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
    await threadCreated(trx, opening.id);
    await notifyThread(trx, { id: thread.id, postId: opening.id, authorId: viewer.id, mentions });
    await auditBot(trx, actor, "thread.create", "thread", thread.id);
    return thread.id;
  });
  return getThread(id, members, viewer.id);
}

export async function createPost(
  actor: Actor,
  viewer: Viewer,
  members: boolean,
  threadId: number,
  input: { content: Content; reply_to_id?: number; source?: Source },
) {
  const thread = await assertVisible(threadId, members);
  if (thread.locked && !STAFF.includes(viewer.role)) {
    throw new AppError(403, "thread_locked", "主题已锁定");
  }
  if (input.source) await assertNotLinked(input.source);
  const { markdown, replyToId } = await resolveContent(
    viewer,
    input.content,
    input.source,
    threadId,
  );
  const replyTo = input.reply_to_id ?? replyToId ?? undefined;
  const { html, images, mentions } = await renderMarkdown(markdown, showImages);

  const id = await db.transaction().execute(async (trx) => {
    let replyToAuthor: number | null = null;
    if (replyTo !== undefined) {
      const target = await trx
        .updateTable("posts")
        .set((eb) => ({ reply_count: eb("reply_count", "+", 1) }))
        .where("id", "=", replyTo)
        .where("thread_id", "=", threadId)
        .where("deleted_at", "is", null)
        .returning("author_id")
        .executeTakeFirst();
      if (!target) {
        throw new AppError(400, "invalid_request", "回复的那一层不在这个主题里，或者已删除");
      }
      replyToAuthor = target.author_id;
    }
    // Locks the thread row, so concurrent replies take floor numbers one after another.
    const numbered = await trx
      .updateTable("threads")
      .set((eb) => ({
        floor_count: eb("floor_count", "+", 1),
        reply_count: eb("reply_count", "+", 1),
        last_post_at: sql<Date>`now()`,
        last_poster_id: viewer.id,
      }))
      .where("id", "=", threadId)
      .returning(["floor_count", "last_post_at"])
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
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await linkUploads(trx, post.id, images);
    if (input.source) await linkSource(trx, input.source, threadId, post.id);
    await trx
      .updateTable("thread_tags")
      .set({ last_post_at: numbered.last_post_at })
      .where("thread_id", "=", threadId)
      .execute();
    await countBoard(trx, thread.board_id, { threads: 0, posts: 1 });
    await countUserPosts(trx, viewer.id, { threads: 0, posts: 1 });
    await addReadFloors(trx, viewer.id, threadId, [[numbered.floor_count, numbered.floor_count]]);
    await postCreated(trx, post.id);
    await notifyPost(trx, { id: post.id, threadId, authorId: viewer.id, mentions }, replyToAuthor);
    await auditBot(trx, actor, "post.create", "post", post.id);
    return post.id;
  });
  return getPost(id, members);
}

// ---- Changing and removing

function forbidden(message: string) {
  return new AppError(403, "forbidden", message);
}

// Authors change their own content; moderators anyone's. A locked thread is moderators' only.
function assertMayChange(staff: boolean, viewer: Viewer, authorId: number, locked: boolean) {
  if (staff) return;
  if (authorId !== viewer.id) throw forbidden("只能修改自己发的内容");
  if (locked) throw new AppError(403, "thread_locked", "主题已锁定");
}

// Moderators changing other people's content, and bots changing anyone's, go to the audit log.
async function auditChange(
  trx: Transaction<DB>,
  actor: Actor,
  authorId: number,
  entry: Parameters<typeof recordAudit>[2],
) {
  if (actor.tokenId === null && actor.userId === authorId) return;
  await recordAudit(trx, actor, entry);
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
  const post = await getPost(postId, members);
  if (post.deleted_at !== null) throw new AppError(404, "post_not_found", "回复不存在");
  const thread = await assertVisible(post.thread_id, members);
  assertMayChange(staff, viewer, post.author_id, thread.locked);
  if (markdown === post.body) return post;
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
    await postUpdated(trx, postId, viewer.id);
    await auditChange(trx, actor, post.author_id, {
      action: "post.edit",
      target_type: "post",
      target_id: postId,
    });
  });
  return getPost(postId, members);
}

export async function listRevisions(
  viewer: Viewer,
  staff: boolean,
  members: boolean,
  postId: number,
) {
  const post = await getPost(postId, members);
  if (!staff && post.author_id !== viewer.id) throw forbidden("只有作者和版主能看编辑记录");
  const rows = await db
    .selectFrom("post_revisions")
    .select(["rev", "title", "body", "editor_id", "created_at"])
    .where("post_id", "=", postId)
    .orderBy("rev", "desc")
    .execute();
  const user = await userBriefs(rows.map((r) => r.editor_id));
  return rows.map(({ editor_id, ...rev }) => ({ ...rev, editor: user(editor_id) }));
}

export type ThreadChange = {
  title?: string;
  tags?: string[];
  board?: string;
  pinned?: number;
  featured?: boolean;
  locked?: boolean;
};

// Authors may retitle and retag; moving, pinning, featuring and locking are for moderators.
export async function editThread(
  actor: Actor,
  viewer: Viewer,
  staff: boolean,
  members: boolean,
  threadId: number,
  change: ThreadChange,
) {
  const { title, tags, board: slug, ...moderation } = change;
  const thread = await getThread(threadId, members, viewer.id);
  assertMayChange(staff, viewer, thread.author_id, thread.locked);
  if (!staff && (slug !== undefined || Object.keys(moderation).length > 0)) {
    throw forbidden("只有版主能移动、置顶、加精和锁定主题");
  }
  const board = slug === undefined ? null : await getBoard(slug, members);
  const tagIds = tags === undefined ? null : await findTags(tags);

  await db.transaction().execute(async (trx) => {
    const old = await trx
      .selectFrom("threads")
      .select(["title", "board_id", "reply_count", "last_post_at"])
      .where("id", "=", threadId)
      .forUpdate()
      .executeTakeFirstOrThrow();

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
      await countTags(trx, removed, -1);
      await countTags(trx, added, 1);
    }

    if (board && board.id !== old.board_id) {
      await countBoard(trx, old.board_id, { threads: -1, posts: -old.reply_count });
      await countBoard(trx, board.id, { threads: 1, posts: old.reply_count });
    }

    const columns = { title, board_id: board?.id, ...moderation };
    if (Object.values(columns).some((v) => v !== undefined)) {
      await trx.updateTable("threads").set(columns).where("id", "=", threadId).execute();
    }
    await auditChange(trx, actor, thread.author_id, {
      action: "thread.update",
      target_type: "thread",
      target_id: threadId,
      data: change,
    });
  });
  return getThread(threadId, members, viewer.id);
}

// Authors can take back a thread nobody has replied to; moderators can remove any.
export async function deleteThread(
  actor: Actor,
  viewer: Viewer,
  staff: boolean,
  members: boolean,
  threadId: number,
) {
  const thread = await getThread(threadId, members, viewer.id);
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
    const tags = await trx
      .selectFrom("thread_tags")
      .select("tag_id")
      .where("thread_id", "=", threadId)
      .execute();
    await countBoard(trx, thread.board_id, { threads: -1, posts: -thread.reply_count });
    await countTags(
      trx,
      tags.map((t) => t.tag_id),
      -1,
    );
    await countUserPosts(trx, thread.author_id, { threads: -1, posts: 0 });
    await threadDeleted(trx, threadId, viewer.id);
    await auditChange(trx, actor, thread.author_id, {
      action: "thread.delete",
      target_type: "thread",
      target_id: threadId,
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
  const post = await getPost(postId, members);
  if (post.deleted_at !== null) throw new AppError(404, "post_not_found", "回复不存在");
  if (post.floor === 1) {
    throw new AppError(400, "invalid_request", "主楼不能单独删除，可以删除整个主题");
  }
  const thread = await assertVisible(post.thread_id, members);
  assertMayChange(staff, viewer, post.author_id, thread.locked);

  await db.transaction().execute(async (trx) => {
    const deleted = await trx
      .updateTable("posts")
      .set({ deleted_at: sql<Date>`now()` })
      .where("id", "=", postId)
      .where("deleted_at", "is", null)
      .returning("reply_to_id")
      .executeTakeFirst();
    if (!deleted) throw new AppError(404, "post_not_found", "回复不存在");
    // A deleted answer is no longer the accepted one.
    await trx
      .updateTable("threads")
      .set((eb) => ({
        reply_count: eb("reply_count", "-", 1),
        solved_post_id: sql<number | null>`nullif(solved_post_id, ${postId}::integer)`,
      }))
      .where("id", "=", post.thread_id)
      .execute();
    if (deleted.reply_to_id !== null) {
      await trx
        .updateTable("posts")
        .set((eb) => ({ reply_count: eb("reply_count", "-", 1) }))
        .where("id", "=", deleted.reply_to_id)
        .execute();
    }
    await countBoard(trx, thread.board_id, { threads: 0, posts: -1 });
    await countUserPosts(trx, post.author_id, { threads: 0, posts: -1 });
    await postDeleted(trx, postId, viewer.id);
    await auditChange(trx, actor, post.author_id, {
      action: "post.delete",
      target_type: "post",
      target_id: postId,
    });
  });
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
  const thread = await getThread(threadId, members, viewer.id);
  assertMayChange(staff, viewer, thread.author_id, thread.locked);
  if (thread.kind !== "question") {
    throw new AppError(400, "invalid_request", "只有问答主题能采纳答案");
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
          .where("deleted_at", "is", null)
          .executeTakeFirst();
  if (answer === undefined) {
    throw new AppError(400, "invalid_request", "只能采纳这个主题里没删的回复");
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
        {},
      );
    }
    await auditChange(trx, actor, thread.author_id, {
      action: answer ? "thread.solve" : "thread.unsolve",
      target_type: "thread",
      target_id: threadId,
      data: { post_id: answer?.id ?? null },
    });
  });
  return getThread(threadId, members, viewer.id);
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

// Bookmarking again keeps the first time, which the bookmark list is ordered by.
export async function setBookmark(
  viewer: Viewer,
  members: boolean,
  threadId: number,
  bookmarked: boolean,
) {
  await assertVisible(threadId, members);
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
  await assertVisible(threadId, members);
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
// the end of the thread are dropped.
export async function recordReading(
  viewer: Viewer,
  members: boolean,
  threadId: number,
  ranges: [number, number][],
  seconds: number,
) {
  const thread = await assertVisible(threadId, members);
  const floors = ranges
    .map(([from, to]): [number, number] => [from, Math.min(to, thread.floor_count)])
    .filter(([from, to]) => from <= to);
  await db.transaction().execute(async (trx) => {
    const added = await addReadFloors(trx, viewer.id, threadId, floors);
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
