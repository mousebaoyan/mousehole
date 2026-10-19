import { sql, type ExpressionBuilder, type RawBuilder, type Transaction } from "kysely";
import type { DB, Json } from "../../../db/types.ts";
import { EVERY_BOARD, GUEST, type Actor, type Reader, type Viewer } from "../../platform/access.ts";
import { STAFF } from "../../platform/site.ts";
import { db } from "../../platform/db.ts";
import { AppError } from "../../platform/errors.ts";
import { log } from "../../platform/log.ts";
import { excerpt, RENDER_VERSION, renderMarkdown } from "../../platform/markdown.ts";
import { recordAudit } from "../audit/service.ts";
import {
  countBoard,
  countTags,
  findTags,
  getBoard,
  getTagId,
  readable,
} from "../boards/service.ts";
import { QUESTION_COST } from "../coins/rules.ts";
import { spendCoins } from "../coins/service.ts";
import { discardDraft } from "../drafts/service.ts";
import { onebotToMarkdown, type Segment } from "../qq/onebot.ts";
import {
  markReadByFloors,
  notifyOnPost,
  notifyPost,
  notifyThread,
} from "../notifications/service.ts";
import { assertNotLinked, findLink, linkSource, postedAt, type Source } from "../qq/service.ts";
import { indexPost, unindexPost } from "../search/service.ts";
import { dropCitingSummary } from "../summaries/service.ts";
import { fetchUpload, linkUploads, showImages, uploadName } from "../uploads/service.ts";
import {
  countLikes,
  countActive,
  countReading,
  countReadsReceived,
  countThreadReplies,
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
import { createLottery, getLottery, type LotterySpec } from "./lotteries.ts";
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
function visibleThreads(reach: number) {
  return openableThreads({ reach, id: null, staff: false });
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
    .where(readable(reader.reach))
    .$if(reader.reach === GUEST, (qb) => qb.where(shownToGuests("threads.author_id")));
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
      "threads.accepted_count",
      "threads.reply_count",
      "threads.floor_count",
      "threads.view_count",
      "threads.like_count",
      "threads.last_post_at",
      "threads.created_at",
      "threads.author_anonymous",
      "threads.anonymous_replies",
      "threads.bounty_at",
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
      // For lists: the latest people to reply besides the author, among the last 20 public floors;
      // those who replied anonymously aren't shown.
      sql<number[]>`(
      SELECT coalesce(array_agg(author_id ORDER BY last_floor DESC), '{}') FROM (
        SELECT author_id, max(floor) AS last_floor FROM (
          SELECT author_id, floor FROM posts
          WHERE posts.thread_id = threads.id AND posts.status = 'visible'
            AND posts.deleted_at IS NULL AND NOT posts.anonymous
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
// Questions asked on the forum with no accepted answer. Those collected from the groups are left
// out: the groups mostly answered them, and their askers seldom come to accept (design §8.1).
const UNSOLVED = sql<boolean>`threads.kind = 'question' AND threads.accepted_count = 0
  AND NOT EXISTS (SELECT 1 FROM posts
    WHERE posts.thread_id = threads.id AND posts.floor = 1 AND posts.via = 'qq')`;

// The threads someone started or replied in, deleted replies aside.
function postedIn(userId: number | null) {
  return db
    .selectFrom("posts")
    .select("posts.thread_id")
    .where(sql<boolean>`posts.author_id = ${userId}`)
    .where("posts.deleted_at", "is", null);
}

// A board and a tag to narrow a list to; either may be left out. Members are told the level a
// board needs when theirs is short of it.
async function scopeOf(reach: number, filter: { board?: string; tag?: string }) {
  const board = filter.board === undefined ? null : await getBoard(filter.board, reach);
  if (board && reach !== GUEST && board.read_level > reach) {
    throw needsLevelToRead(board.read_level);
  }
  return { board, tagId: filter.tag === undefined ? null : await getTagId(filter.tag) };
}

function needsLevelToRead(level: number) {
  return levelRequired(`此版块 L${level} 起才能查看`);
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

// The threads someone pinned to their page, in their order (design §8.16); those the reader can't
// open, and any since hidden, drop out.
export async function listPins(reach: number, ids: number[]) {
  return visibleThreads(reach)
    .select([
      "threads.id",
      "threads.title",
      "threads.reply_count",
      "threads.like_count",
      "boards.slug as board_slug",
      "boards.name as board_name",
      "boards.color as board_color",
    ])
    .where("threads.id", "=", sql<number>`any(${ids}::integer[])`)
    .where("threads.author_anonymous", "=", false)
    .orderBy(sql`array_position(${ids}::integer[], threads.id)`)
    .execute();
}

// Cursors: the last thread's ID for `created`, an offset for `hot`, otherwise the time the list
// is ordered by (last activity, or when the reader bookmarked or last read it) in microseconds and
// the ID. An ID or offset has at most 9 digits, as the integer it is compared with holds. The
// reader's own lists are empty for guests.
export async function listThreads(
  reach: number,
  userId: number | null,
  filter: {
    board?: string;
    tag?: string;
    author?: number;
    view: ThreadView;
    cursor?: string;
    limit?: number;
  },
) {
  const { view, cursor, limit = PAGE_SIZE } = filter;
  const scope = await scopeOf(reach, filter);
  const { board, tagId } = scope;
  const time =
    view === "bookmarked"
      ? "mine.bookmarked_at"
      : view === "read"
        ? "mine.last_read_at"
        : "threads.last_post_at";

  let query = selectThreads(visibleThreads(reach), userId)
    // Microseconds, exact for PostgreSQL timestamps, unlike a JavaScript Date.
    .select(sql<number>`(extract(epoch FROM ${sql.ref(time)}) * 1000000)::bigint`.as("micros"))
    .where(inScope(scope))
    .limit(limit);
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
      if (!/^\d{1,9}$/.test(cursor)) badCursor();
      query = query.where("threads.id", "<", Number(cursor));
    }
    next = (last) => String(last.id);
  } else if (view === "hot") {
    const ids = await hotIds();
    if (cursor !== undefined && !/^\d{1,9}$/.test(cursor)) badCursor();
    const offset = Number(cursor ?? 0);
    query = query
      .where("threads.id", "=", sql<number>`any(${ids}::integer[])`)
      .orderBy(sql`array_position(${ids}::integer[], threads.id)`)
      .offset(offset);
    next = () => String(offset + limit);
  } else {
    if (view === "unsolved") query = query.where(UNSOLVED);
    if (view === "new") query = query.where(NEW);
    if (view === "unread") query = query.where(UNREAD);
    if (view === "read") query = query.where("mine.last_read_at", "is not", null);
    if (view === "bookmarked") query = query.where("mine.bookmarked_at", "is not", null);
    if (view === "posted") query = query.where("threads.id", "in", postedIn(userId));
    if (pinFrom !== null) query = query.where("threads.pinned", "<", pinFrom);
    query = query.orderBy(time, "desc").orderBy("threads.id", "desc");
    if (cursor !== undefined) {
      const [, micros, id] = /^(\d{1,18})_(\d{1,9})$/.exec(cursor) ?? badCursor();
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
    next_cursor: rows.length === limit && last ? next(last) : null,
  };
}

// For the list's tabs: how many threads in this board or tag are new and unread to the reader,
// and how many are unsolved.
export async function countTabs(
  reach: number,
  userId: number,
  filter: { board?: string; tag?: string },
) {
  return visibleThreads(reach)
    .leftJoin("thread_users as mine", (join) =>
      join.onRef("mine.thread_id", "=", "threads.id").on("mine.user_id", "=", userId),
    )
    .select([
      sql<number>`(count(*) FILTER (WHERE ${NEW}))::integer`.as("new"),
      sql<number>`(count(*) FILTER (WHERE ${UNREAD}))::integer`.as("unread"),
      sql<number>`(count(*) FILTER (WHERE ${UNSOLVED}))::integer`.as("unsolved"),
    ])
    .where(inScope(await scopeOf(reach, filter)))
    .executeTakeFirstOrThrow();
}

// How many threads the reader's own lists have, for the sidebar (design §9).
export async function countMine(reach: number, userId: number) {
  const [{ posted }, mine] = await Promise.all([
    visibleThreads(reach)
      .select(sql<number>`count(*)::integer`.as("posted"))
      .where("threads.id", "in", postedIn(userId))
      .executeTakeFirstOrThrow(),
    visibleThreads(reach)
      .innerJoin("thread_users as mine", (join) =>
        join.onRef("mine.thread_id", "=", "threads.id").on("mine.user_id", "=", userId),
      )
      .select([
        sql<number>`(count(*) FILTER (WHERE mine.bookmarked_at IS NOT NULL))::integer`.as(
          "bookmarked",
        ),
        sql<number>`(count(*) FILTER (WHERE mine.last_read_at IS NOT NULL))::integer`.as("read"),
      ])
      .executeTakeFirstOrThrow(),
  ]);
  return { posted, ...mine };
}

// Someone's replies, newest first, with the thread each is in, or only their answers accepted in
// other people's questions; the cursor is the last one's ID.
export async function listUserPosts(
  reach: number,
  authorId: number,
  { solved, cursor }: { solved: boolean; cursor?: number },
) {
  let query = visibleThreads(reach)
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
    .$if(reach === GUEST, (qb) => qb.where(shownToGuests("posts.author_id")))
    .where("posts.floor", ">", 1)
    .where("posts.status", "=", "visible")
    .where("posts.deleted_at", "is", null)
    .$if(solved, (qb) =>
      qb
        .where("posts.accepted_at", "is not", null)
        .whereRef("posts.author_id", "<>", "threads.author_id"),
    )
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

// Floors in boards the reader can open, shown and not deleted, with their thread.
function readableFloors(reach: number) {
  return visibleThreads(reach)
    .innerJoin("posts", "posts.thread_id", "threads.id")
    .where("posts.status", "=", "visible")
    .where("posts.deleted_at", "is", null);
}

const TOP_POSTS = 5;

// Someone's most liked floors, opening posts included (design §9).
export async function topPosts(reach: number, authorId: number) {
  const rows = await readableFloors(reach)
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
    .$if(reach === GUEST, (qb) => qb.where(shownToGuests("posts.author_id")))
    .where("posts.like_count", ">", 0)
    .orderBy("posts.like_count", "desc")
    .orderBy("posts.id", "desc")
    .limit(TOP_POSTS)
    .execute();
  return rows.map(({ html, ...r }) => ({ ...r, excerpt: excerpt(html, EXCERPT) }));
}

// The floors someone reacted to, newest first; the cursor is how many were shown. For members
// only, so guests' limits don't apply.
export async function listLikedPosts(reach: number, userId: number, offset: number) {
  const rows = await readableFloors(reach)
    .innerJoin("reactions", "reactions.post_id", "posts.id")
    .select([
      "posts.id",
      "posts.floor",
      "posts.html",
      "posts.like_count",
      "posts.created_at",
      "reactions.emoji",
      "reactions.created_at as liked_at",
      "threads.id as thread_id",
      "threads.title",
    ])
    .where("reactions.user_id", "=", userId)
    .orderBy("reactions.created_at", "desc")
    .orderBy("posts.id", "desc")
    .offset(offset)
    .limit(PAGE_SIZE)
    .execute();
  return {
    items: rows.map(({ html, ...r }) => ({ ...r, excerpt: excerpt(html, EXCERPT) })),
    next: rows.length === PAGE_SIZE ? offset + PAGE_SIZE : null,
  };
}

const TALLY_SIZE = 10;

// Who liked someone's floors most, and whose floors they liked most (design §9). Anonymous
// floors don't count, which would tell who wrote them, nor people who keep their likes and
// relations to themselves.
export async function likeTallies(reach: number, userId: number) {
  const tally = (by: "reactions.user_id" | "posts.author_id", of: typeof by) =>
    readableFloors(reach)
      .innerJoin("reactions", "reactions.post_id", "posts.id")
      .innerJoin("users", "users.id", by)
      .select([`${by} as id`, (eb) => eb.fn.countAll<number>().as("count")])
      .where(of, "=", userId)
      .where("posts.anonymous", "=", false)
      .where("users.relations_public", "=", true)
      .groupBy(by)
      .orderBy("count", "desc")
      .orderBy(by)
      .limit(TALLY_SIZE)
      .execute();
  const [likers, liked] = await Promise.all([
    tally("reactions.user_id", "posts.author_id"),
    tally("posts.author_id", "reactions.user_id"),
  ]);
  return { likers, liked };
}

// For the sitemap: what guests may read, most recently active first.
export async function publicThreads(limit: number) {
  return visibleThreads(GUEST)
    .select(["threads.id", "threads.last_post_at"])
    .orderBy("threads.last_post_at", "desc")
    .limit(limit)
    .execute();
}

// These threads as lists show them, for search results; ones the viewer can't see are left out.
export async function threadsByIds(reach: number, userId: number | null, ids: number[]) {
  if (ids.length === 0) return new Map<number, Awaited<ReturnType<typeof withUsers>>[number]>();
  const rows = await selectThreads(visibleThreads(reach), userId)
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
      sql<number[]>`ARRAY(SELECT floor FROM posts
        WHERE posts.thread_id = threads.id AND posts.accepted_at IS NOT NULL
          AND posts.status = 'visible' ORDER BY floor)`.as("accepted_floors"),
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
    if (reader.reach === GUEST && (await keptFromGuests(id))) {
      throw new AppError(401, "login_required", "楼主设置了仅成员可见");
    }
    const above = reader.reach === GUEST ? undefined : await boardLevel(id);
    if (above !== undefined && above > reader.reach) throw needsLevelToRead(above);
    throw (await mergedAway(id, 1)) ?? threadNotFound();
  }
  const [thread] = await withUsers([row]);
  return {
    ...thread,
    poll: thread.kind === "poll" ? await getPoll(id, reader.id) : null,
    lottery: thread.kind === "lottery" ? await getLottery(id, reader.id) : null,
  };
}

// A thread merged into another (design §8.20) tells where a floor of it is now; one past its last
// floor leads to its opening post.
async function mergedAway(id: number, floor: number) {
  const now = await db
    .selectFrom("thread_merges")
    .innerJoin("posts", (join) =>
      join.on(
        sql<boolean>`posts.id = coalesce(thread_merges.post_ids[${floor}], thread_merges.post_ids[1])`,
      ),
    )
    .select(["posts.thread_id", "posts.floor"])
    .where("thread_merges.thread_id", "=", id)
    .executeTakeFirst();
  return (
    now &&
    new AppError(404, "thread_merged", "这个帖子已合并到另一个帖子", {
      details: { thread_id: now.thread_id, floor: now.floor },
    })
  );
}

// The level a thread's board needs to be read, for a member it is out of reach of.
async function boardLevel(id: number) {
  const row = await visibleThreads(EVERY_BOARD)
    .select("boards.read_level")
    .where("threads.id", "=", id)
    .executeTakeFirst();
  return row?.read_level;
}

// A thread guests could read but for its author's switch: they are asked to log in rather than
// told it is gone.
async function keptFromGuests(id: number) {
  const row = await openableThreads({ reach: 0, id: null, staff: false })
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
      sql<boolean>`posts.accepted_at IS NOT NULL`.as("accepted"),
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
      (reader.reach !== GUEST
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

// `floor` is the one wanted, should the thread have been merged into another.
async function assertVisible(threadId: number, reader: Reader, floor = 1) {
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
  if (!thread) throw (await mergedAway(threadId, floor)) ?? threadNotFound();
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
  await assertVisible(threadId, reader, "after" in range ? range.after + 1 : range.before - 1);
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
// becomes "[图片已失效]". One already stored here stays as it is, so a floor organized anew from
// older messages keeps their pictures. A quoted message counts as replying to the floor it became, within the
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
    image: async (url) =>
      uploadName(url)
        ? url
        : fetchUpload(viewer.id, url).then(
            (upload) => upload.url,
            (error: unknown) => {
              log("warn", "QQ image not copied", { error, url });
              return null;
            },
          ),
    quoted: async (messageId) => {
      if (!source || threadId === null) return null;
      const link = await findLink({
        chat_type: source.chat_type,
        chat_id: source.chat_id,
        message_id: messageId,
      });
      return link?.thread_id === threadId ? link.post_id : null;
    },
  });
  if (!converted.markdown) {
    throw new AppError(400, "invalid_request", "消息里没有能转成正文的内容");
  }
  if (converted.markdown.length > MAX_BODY) {
    throw new AppError(400, "invalid_request", "消息太长");
  }
  return converted;
}

function via(actor: Actor, source: Source | undefined) {
  return source ? "qq" : actor.tokenId === null ? "web" : "bot";
}

// What levels allow (design §6.6). Moderators and admins aren't held by any of it.
// Polls and lotteries.
const KIND_LEVEL = 2;
// L0's limits, which content synced from the groups doesn't count towards: links in a floor, as
// posted or edited, and floors posted a day.
const L0_LINKS = 2;
const L0_PER_DAY = { thread: 3, reply: 20 };

function levelRequired(message: string) {
  return new AppError(403, "level_required", message);
}

// `kind` is null for an edit.
async function assertWithinL0(
  viewer: Viewer,
  source: Source | undefined,
  links: string[],
  kind: "thread" | "reply" | null,
) {
  if (viewer.level > 0 || STAFF.includes(viewer.role) || source) return;
  if (links.length > L0_LINKS) {
    throw levelRequired(`L0 每层最多 ${L0_LINKS} 个站外链接，升到 L1 后不限`);
  }
  if (kind === null) return;
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

// Starting threads in a board, or moving them there: some boards are for moderators, some want a
// level, for reading them and for posting (design §8.1).
export function assertMayPost(
  viewer: Viewer,
  board: { post_role: string; read_level: number; post_level: number },
) {
  if (STAFF.includes(viewer.role)) return;
  if (board.post_role === "moderator") throw forbidden("这个版块只有版主能发帖");
  const level = Math.max(board.read_level, board.post_level);
  if (viewer.level < level) throw levelRequired(`这个版块 L${level} 起才能发帖`);
}

// The power a level gives over someone else's content, from L3 up: the viewer's level when the
// writer is below it and not a moderator or admin, else 0. Nothing anonymous, whose writer's
// level would show in what is allowed.
export async function levelPower(viewer: Viewer, authorId: number, anonymous: boolean) {
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
  reach: number,
  input: {
    board: string;
    title: string;
    content: Content;
    kind?: string;
    poll?: PollSpec;
    lottery?: LotterySpec;
    tags: string[];
    source?: Source;
    created_at?: number;
    anonymous?: boolean;
    anonymous_replies?: boolean;
  },
) {
  const reader: Reader = { reach, id: viewer.id, staff: false };
  const at = postedAt(actor, input.created_at);
  const board = await getBoard(input.board, reach);
  const anonymous = input.anonymous ?? false;
  assertMayPost(viewer, board);
  // 保研定位 is for newcomers above all (design §8.14).
  const leveled = input.lottery || (input.poll && input.poll.preset !== "positioning");
  if (leveled && viewer.level < KIND_LEVEL && !STAFF.includes(viewer.role)) {
    throw levelRequired(`L${KIND_LEVEL} 起才能发${input.poll ? "投票帖" : "抽奖帖"}`);
  }
  const tagIds = await findTags(input.tags);
  if (input.source) await assertNotLinked(input.source, null);
  const { markdown } = await resolveContent(viewer, input.content, input.source, null);
  const { html, images, mentions, links } = await renderMarkdown(markdown, showImages);
  await assertWithinL0(viewer, input.source, links, "thread");

  const status = statusFor(board.review_mode, viewer);
  const kind = input.kind ?? board.default_kind;
  const id = await db.transaction().execute(async (trx) => {
    const thread = await trx
      .insertInto("threads")
      .values({
        board_id: board.id,
        author_id: viewer.id,
        kind,
        title: input.title,
        last_poster_id: viewer.id,
        status,
        author_anonymous: anonymous,
        anonymous_replies: input.anonymous_replies ?? false,
        created_at: at,
        last_post_at: at,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    // A question costs a coin (design §8.17); one collected from the groups was asked there.
    if (kind === "question" && !input.source) {
      await spendCoins(trx, viewer.id, QUESTION_COST, { reason: "question", thread_id: thread.id });
    }
    const opening = await trx
      .insertInto("posts")
      .values({
        thread_id: thread.id,
        floor: 1,
        author_id: viewer.id,
        body: markdown,
        html,
        render_version: RENDER_VERSION,
        via: via(actor, input.source),
        status,
        anonymous,
        created_at: at,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    // Number 1, the thread being new.
    if (anonymous) await aliasIn(trx, thread.id, viewer.id);
    if (input.poll) await createPoll(trx, thread.id, input.poll);
    if (input.lottery) await createLottery(trx, thread.id, input.lottery);
    await linkUploads(trx, opening.id, images);
    if (input.source) await linkSource(trx, input.source, thread.id, opening.id);
    // Posted from the composer; what a bot posts for them leaves their draft alone.
    if (actor.tokenId === null) await discardDraft(trx, viewer.id, null);
    await countActive(trx, viewer.id, at);
    if (tagIds.length > 0) {
      await trx
        .insertInto("thread_tags")
        .values(tagIds.map((tag_id) => ({ thread_id: thread.id, tag_id })))
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
  reach: number,
  threadId: number,
  input: { content: Content; reply_to_id?: number; source?: Source; created_at?: number },
) {
  const reader: Reader = { reach, id: viewer.id, staff: false };
  const at = postedAt(actor, input.created_at);
  const thread = await assertVisible(threadId, reader);
  assertPublic(thread);
  if (thread.locked && !STAFF.includes(viewer.role)) {
    throw new AppError(403, "thread_locked", "帖子已锁定");
  }
  if (input.source) await assertNotLinked(input.source, null);
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
    await countActive(trx, viewer.id, at);
    if (replyTo !== undefined) {
      const target = await trx
        .selectFrom("posts")
        .select("id")
        .where("id", "=", replyTo)
        .where("thread_id", "=", threadId)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (!target) {
        throw new AppError(400, "invalid_request", "所回复的楼层不在此帖子中，或已被删除");
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
        render_version: RENDER_VERSION,
        via: via(actor, input.source),
        status,
        anonymous,
        created_at: at,
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
export function assertMayChange(staff: boolean, viewer: Viewer, authorId: number, locked: boolean) {
  if (staff) return;
  if (authorId !== viewer.id) throw forbidden("只能修改自己发的内容");
  if (locked) throw new AppError(403, "thread_locked", "帖子已锁定");
}

// The old text goes into the post's edit history. A floor archived from a group is organized
// anew from its messages, which come along in full.
export async function editPost(
  actor: Actor,
  viewer: Viewer,
  staff: boolean,
  reach: number,
  postId: number,
  change: { content: Content; source?: Source },
) {
  const reader: Reader = { reach, id: viewer.id, staff };
  const post = await getPost(postId, reader);
  if (post.deleted_at !== null) throw new AppError(404, "post_not_found", "回复不存在");
  const thread = await assertVisible(post.thread_id, reader);
  // L5 edits the floors of those below them.
  const power = staff ? 0 : await levelPower(viewer, post.author_id, "anonymous" in post.author);
  if (power < 5) assertMayChange(staff, viewer, post.author_id, thread.locked);
  const { source } = change;
  if (source) await assertNotLinked(source, postId);
  const { markdown } = await resolveContent(viewer, change.content, source, post.thread_id);
  if (markdown === post.body && !source) return post;
  const shown = post.status === "visible" && thread.status === "visible";
  const { html, images, links } = await renderMarkdown(markdown, showImages);
  await assertWithinL0(viewer, source, links, null);

  await db.transaction().execute(async (trx) => {
    if (source) await linkSource(trx, source, post.thread_id, postId);
    if (markdown === post.body) return;
    const edited = await trx
      .updateTable("posts")
      .set((eb) => ({
        body: markdown,
        html,
        render_version: RENDER_VERSION,
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

export async function listRevisions(viewer: Viewer, staff: boolean, reach: number, postId: number) {
  const reader: Reader = { reach, id: viewer.id, staff };
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
// alone; moving and locking also go to L4 and L5 over those below them.
export async function editThread(
  actor: Actor,
  viewer: Viewer,
  staff: boolean,
  reach: number,
  threadId: number,
  change: ThreadChange,
) {
  const reader: Reader = { reach, id: viewer.id, staff };
  const { title, tags, board: slug, locked, ...moderation } = change;
  const thread = await getThread(threadId, reader);
  // L4 changes the title, tags and board of threads by those below them, L5 also locks them; a
  // locked one only L5 may change. L3 only suggests (suggestions.ts).
  const power = staff ? 0 : await levelPower(viewer, thread.author_id, thread.author_anonymous);
  if (power < 4) assertMayChange(staff, viewer, thread.author_id, thread.locked);
  else if (thread.locked && power < 5) throw new AppError(403, "thread_locked", "帖子已锁定");
  if (!staff && (Object.keys(moderation).length > 0 || (slug !== undefined && power < 4))) {
    throw forbidden("只有版主能置顶、加精和移动自己的帖子");
  }
  if (!staff && locked !== undefined && power < 5) {
    throw forbidden("只有版主和 L5 能锁定帖子，L5 只能锁定等级比自己低的人的帖子");
  }
  const board = slug === undefined ? null : await getBoard(slug, reach);
  if (board && !staff) assertMayPost(viewer, board);
  const tagIds = tags === undefined ? null : await findTags(tags);

  await db.transaction().execute(async (trx) => {
    await saveThreadChange(trx, thread, viewer.id, {
      title,
      tagIds,
      board_id: board?.id,
      locked,
      ...moderation,
    });
    await recordAudit(trx, actor, {
      action: "thread.update",
      target_type: "thread",
      target_id: threadId,
      data: change,
    });
  });
  return getThread(threadId, reader);
}

// A change to a thread, in the transaction that makes it. A new title is an edit of the opening
// post by `editorId`, kept in its history with the old title; counts follow the tags and board.
export async function saveThreadChange(
  trx: Transaction<DB>,
  thread: { id: number; status: string },
  editorId: number,
  change: {
    tagIds: number[] | null;
    title?: string;
    board_id?: number;
    pinned?: number;
    featured?: boolean;
    locked?: boolean;
  },
) {
  const { tagIds, title, board_id, pinned, featured, locked } = change;
  const columns = { title, board_id, pinned, featured, locked };
  const old = await trx
    .selectFrom("threads")
    .select(["title", "board_id", "reply_count"])
    .where("id", "=", thread.id)
    .forUpdate()
    .executeTakeFirstOrThrow();

  let retitled: number | null = null;
  if (title !== undefined && title !== old.title) {
    const opening = await trx
      .updateTable("posts")
      .set((eb) => ({ edit_count: eb("edit_count", "+", 1), edited_at: sql<Date>`now()` }))
      .where("thread_id", "=", thread.id)
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
        editor_id: editorId,
      })
      .execute();
    retitled = opening.id;
  }

  if (tagIds !== null) {
    const current = await trx
      .selectFrom("thread_tags")
      .select("tag_id")
      .where("thread_id", "=", thread.id)
      .execute();
    const had = current.map((r) => r.tag_id);
    const removed = had.filter((id) => !tagIds.includes(id));
    const added = tagIds.filter((id) => !had.includes(id));
    if (removed.length > 0) {
      await trx
        .deleteFrom("thread_tags")
        .where("thread_id", "=", thread.id)
        .where("tag_id", "in", removed)
        .execute();
    }
    if (added.length > 0) {
      await trx
        .insertInto("thread_tags")
        .values(added.map((tag_id) => ({ thread_id: thread.id, tag_id })))
        .execute();
    }
    if (thread.status === "visible") {
      await countTags(trx, removed, -1);
      await countTags(trx, added, 1);
    }
  }

  if (board_id !== undefined && board_id !== old.board_id && thread.status === "visible") {
    await countBoard(trx, old.board_id, { threads: -1, posts: -old.reply_count });
    await countBoard(trx, board_id, { threads: 1, posts: old.reply_count });
  }

  if (Object.values(columns).some((v) => v !== undefined)) {
    await trx.updateTable("threads").set(columns).where("id", "=", thread.id).execute();
  }
  if (retitled !== null) await indexPost(trx, retitled);
}

// Authors can take back a thread nobody has replied to; moderators can remove any.
export async function deleteThread(
  actor: Actor,
  viewer: Viewer,
  staff: boolean,
  reach: number,
  threadId: number,
) {
  const reader: Reader = { reach, id: viewer.id, staff };
  const thread = await getThread(threadId, reader);
  assertMayChange(staff, viewer, thread.author_id, thread.locked);
  if (!staff && thread.reply_count > 0) {
    throw forbidden("帖子已有回复，不能删除；如需删除请联系版主");
  }
  await db.transaction().execute(async (trx) => {
    // As the row was, locked: someone else may have just deleted or hidden it.
    const deleted = await trx
      .updateTable("threads")
      .set({ deleted_at: sql<Date>`now()` })
      .where("id", "=", threadId)
      .where("deleted_at", "is", null)
      .returning(sql<string>`old.status`.as("status"))
      .executeTakeFirst();
    if (!deleted) throw threadNotFound();
    if (deleted.status === "visible") await withdrawThread(trx, threadId, viewer.id, null);
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
  reach: number,
  postId: number,
) {
  const reader: Reader = { reach, id: viewer.id, staff };
  const post = await getPost(postId, reader);
  if (post.deleted_at !== null) throw new AppError(404, "post_not_found", "回复不存在");
  if (post.floor === 1) {
    throw new AppError(400, "invalid_request", "主楼不能单独删除，可以删除整个帖子");
  }
  const thread = await assertVisible(post.thread_id, reader);
  assertMayChange(staff, viewer, post.author_id, thread.locked);

  await db.transaction().execute(async (trx) => {
    // A deleted answer is no longer accepted. As the row was, locked, as in deleteThread.
    const deleted = await trx
      .updateTable("posts")
      .set({ deleted_at: sql<Date>`now()`, accepted_at: null })
      .where("id", "=", postId)
      .where("deleted_at", "is", null)
      .returning([
        sql<boolean>`old.accepted_at IS NOT NULL`.as("accepted"),
        sql<string>`old.status`.as("status"),
      ])
      .executeTakeFirst();
    if (!deleted) throw new AppError(404, "post_not_found", "回复不存在");
    if (deleted.accepted && deleted.status === "visible") {
      await countAnswers(trx, post.thread_id, -1);
    }
    await unindexPost(trx, postId);
    if (deleted.status === "visible") await withdrawPost(trx, postId, viewer.id, null);
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
      "posts.via",
    ])
    .where("threads.id", "=", threadId)
    .executeTakeFirstOrThrow();
  await countThread(trx, threadId, thread, 1);
  if (announce) {
    await threadCreated(trx, thread.opening);
    // Content brought over from the groups tells nobody (design §8.6).
    if (thread.via === "qq") return;
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
    .select(["board_id", "author_id", "author_anonymous", "reply_count"])
    .where("id", "=", threadId)
    .executeTakeFirstOrThrow();
  await countThread(trx, threadId, thread, -1);
  await threadDeleted(trx, threadId, byId, reason);
}

// A thread in or out of its board's, tags' and author's counts, with the replies in it, also in
// their authors'. Anonymous threads stay out of the author's, which would otherwise rise as one is
// posted and give them away.
export async function countThread(
  trx: Transaction<DB>,
  threadId: number,
  thread: { board_id: number; author_id: number; author_anonymous: boolean; reply_count: number },
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
  if (!thread.author_anonymous) {
    await countUserPosts(trx, thread.author_id, { threads: delta, posts: 0 });
  }
  await countThreadReplies(trx, threadId, delta);
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
      "posts.anonymous",
      sql<boolean>`posts.accepted_at IS NOT NULL`.as("accepted"),
      "posts.via",
      "posts.created_at",
      "threads.board_id",
      "threads.author_id as thread_author_id",
      "threads.status as thread_status",
      "alias.number as alias",
    ])
    .where("posts.id", "=", postId)
    .executeTakeFirstOrThrow();
  const replyTo = await countReply(trx, post, 1);
  if (announce) {
    // An archived floor is as old as its messages, maybe older than the thread's last activity.
    const at = post.via === "qq" ? sql<Date>`${post.created_at}` : sql<Date>`now()`;
    await trx
      .updateTable("threads")
      .set({ last_post_at: at, last_poster_id: post.author_id })
      .where("id", "=", post.thread_id)
      .where("last_post_at", "<=", at)
      .execute();
    await postCreated(trx, postId);
    // Content brought over from the groups tells nobody (design §8.6).
    if (post.via === "qq") return;
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
      post.thread_author_id,
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
      "posts.floor",
      "posts.author_id",
      "posts.reply_to_id",
      "posts.anonymous",
      sql<boolean>`posts.accepted_at IS NOT NULL`.as("accepted"),
      "threads.board_id",
      "threads.status as thread_status",
    ])
    .where("posts.id", "=", postId)
    .executeTakeFirstOrThrow();
  await countReply(trx, post, -1);
  await dropCitingSummary(trx, post.thread_id, post.floor);
  await postDeleted(trx, postId, byId, reason);
}

// A reply in or out of the counts: its thread's replies and, accepted, answers; the floor it
// answers; its board's and author's while the thread is public, as countThread moves them.
// Anonymous replies stay out of the author's, as anonymous threads do. Returns who wrote that floor.
async function countReply(
  trx: Transaction<DB>,
  post: {
    thread_id: number;
    author_id: number;
    reply_to_id: number | null;
    anonymous: boolean;
    accepted: boolean;
    board_id: number;
    thread_status: string;
  },
  delta: 1 | -1,
) {
  await trx
    .updateTable("threads")
    .set((eb) => ({
      reply_count: eb("reply_count", "+", delta),
      accepted_count: eb("accepted_count", "+", post.accepted ? delta : 0),
    }))
    .where("id", "=", post.thread_id)
    .execute();
  if (post.thread_status === "visible") {
    await countBoard(trx, post.board_id, { threads: 0, posts: delta });
    if (!post.anonymous) await countUserPosts(trx, post.author_id, { threads: 0, posts: delta });
  }
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

// Whether it held it: one hidden or deleted meanwhile is left as it is.
export async function holdReported(trx: Transaction<DB>, postId: number, reporterId: number) {
  const held = await trx
    .updateTable("posts")
    .set({ status: "hidden" })
    .where("id", "=", postId)
    .where("status", "=", "visible")
    .where("deleted_at", "is", null)
    .returning("id")
    .executeTakeFirst();
  if (held) await withdrawPost(trx, postId, reporterId, "被举报，等待版主处理");
  return held !== undefined;
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
  if (thread.status !== "visible") throw forbidden("帖子待审核或已隐藏，暂不能进行此操作");
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
  reach: number,
  threadId: number,
  status: "visible" | "hidden",
  reason: string | null,
) {
  const reader: Reader = { reach, id: viewer.id, staff: true };
  const thread = await getThread(threadId, reader);
  const opening = await db
    .selectFrom("posts")
    .select(["id", "body"])
    .where("thread_id", "=", threadId)
    .where("floor", "=", 1)
    .executeTakeFirstOrThrow();
  await db.transaction().execute(async (trx) => {
    // What it was, the row locked: another moderator may have just changed it.
    const { from } = await trx
      .updateTable("threads")
      .set({ status })
      .where("id", "=", threadId)
      .returning(sql<string>`old.status`.as("from"))
      .executeTakeFirstOrThrow();
    if (from === status) return;
    const action = statusAction(from, status);
    const mentions = action === "approve" ? await mentionsOf(opening.body) : [];
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
  reach: number,
  postId: number,
  status: "visible" | "hidden",
  reason: string | null,
) {
  const reader: Reader = { reach, id: viewer.id, staff: true };
  const post = await getPost(postId, reader);
  if (post.deleted_at !== null) throw new AppError(404, "post_not_found", "回复不存在");
  if (post.floor === 1) {
    throw new AppError(400, "invalid_request", "主楼的状态随帖子变化，请修改帖子的状态");
  }
  assertPublic(await assertVisible(post.thread_id, reader));
  await db.transaction().execute(async (trx) => {
    // As in setThreadStatus; deleted meanwhile, it is gone.
    const changed = await trx
      .updateTable("posts")
      .set({ status })
      .where("id", "=", postId)
      .where("deleted_at", "is", null)
      .returning(sql<string>`old.status`.as("from"))
      .executeTakeFirst();
    if (!changed) throw new AppError(404, "post_not_found", "回复不存在");
    if (changed.from === status) return;
    const action = statusAction(changed.from, status);
    const mentions = action === "approve" ? await mentionsOf(post.body) : [];
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

// The asker, or a moderator, accepts the floors that answered a question, as many as answered
// it (design §8.1), or takes one back. Each writer accepted hears of it.
export async function setAnswer(
  actor: Actor,
  viewer: Viewer,
  staff: boolean,
  reach: number,
  threadId: number,
  postId: number,
  accepted: boolean,
) {
  const reader: Reader = { reach, id: viewer.id, staff };
  const thread = await getThread(threadId, reader);
  assertMayChange(staff, viewer, thread.author_id, thread.locked);
  assertPublic(thread);
  if (thread.kind !== "question") {
    throw new AppError(400, "invalid_request", "只有问答帖子能采纳答案");
  }
  await db.transaction().execute(async (trx) => {
    const answer = await trx
      .updateTable("posts")
      // Accepting again keeps when it was first accepted.
      .set({ accepted_at: accepted ? sql<Date>`coalesce(accepted_at, now())` : null })
      .where("id", "=", postId)
      .where("thread_id", "=", threadId)
      .where("floor", ">", 1)
      .where("deleted_at", "is", null)
      // Taking one back works on a floor hidden since.
      .$if(accepted, (qb) => qb.where("status", "=", "visible"))
      .returning(["id", "author_id", "status", sql<boolean>`old.accepted_at IS NOT NULL`.as("was")])
      .executeTakeFirst();
    if (!answer) throw new AppError(400, "invalid_request", "只能采纳此帖子中公开的回复");
    if (answer.was === accepted) return;
    // A hidden one is already out of the count (countReply).
    if (answer.status === "visible") await countAnswers(trx, threadId, accepted ? 1 : -1);
    if (accepted) {
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
      action: accepted ? "thread.solve" : "thread.unsolve",
      target_type: "thread",
      target_id: threadId,
      data: { post_id: answer.id },
    });
  });
  return getThread(threadId, reader);
}

async function countAnswers(trx: Transaction<DB>, threadId: number, delta: 1 | -1) {
  await trx
    .updateTable("threads")
    .set((eb) => ({ accepted_count: eb("accepted_count", "+", delta) }))
    .where("id", "=", threadId)
    .execute();
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
// is a like, the likes of the post, of its thread when it is the opening post, and of its author
// unless the post is anonymous, whose author a changing count would give away.
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
    .returning(["thread_id", "floor", "author_id", "anonymous"])
    .executeTakeFirstOrThrow();
  if (likes === 0) return;
  if (post.floor === 1) {
    await trx
      .updateTable("threads")
      .set((eb) => ({ like_count: eb("like_count", "+", likes) }))
      .where("id", "=", post.thread_id)
      .execute();
  }
  if (!post.anonymous) await countLikes(trx, post.author_id, likes);
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
  reach: number,
  threadId: number,
  bookmarked: boolean,
) {
  const reader: Reader = { reach, id: viewer.id, staff: false };
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
  reach: number,
  threadId: number,
  level: NotifyLevel,
) {
  const reader: Reader = { reach, id: viewer.id, staff: false };
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

// Joins floors to what the reader has read, and returns how many of them they hadn't, and which
// (an int4multirange).
async function addReadFloors(
  trx: Transaction<DB>,
  userId: number,
  threadId: number,
  ranges: [number, number][],
) {
  return trx
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
    .returning([
      sql<number>`${floorsIn("new")} - ${floorsIn("old")}`.as("added"),
      sql<string>`new.read_floors - coalesce(old.read_floors, '{}')`.as("fresh"),
    ])
    .executeTakeFirstOrThrow();
}

// What the browser reports: the floors read since the last report and for how long. Floors past
// the end of the thread are dropped. Floors the reader can't see, waiting for review or hidden,
// are taken as read once they read past them, or reach the last floor they can see, so the
// thread doesn't stay unread; they don't count as reading. See design §8.9.
export async function recordReading(
  viewer: Viewer,
  reach: number,
  threadId: number,
  ranges: [number, number][],
  seconds: number,
) {
  const reader: Reader = { reach, id: viewer.id, staff: false };
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
    const { added, fresh } = await addReadFloors(trx, viewer.id, threadId, floors);
    if (skipped.length > 0) await addReadFloors(trx, viewer.id, threadId, skipped);
    await countReadsReceived(trx, viewer.id, threadId, fresh);
    await markReadByFloors(trx, viewer.id, threadId, fresh);
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

// ---- Rendering again

// At start-up: floors whose html an older renderer wrote (design §8.2), with their search index.
// A floor edited meanwhile is already current, and its new html stays.
export async function rerenderPosts() {
  for (;;) {
    const stale = await db
      .selectFrom("posts")
      .select(["id", "body", "deleted_at"])
      .where("render_version", "<", RENDER_VERSION)
      .orderBy("id")
      .limit(100)
      .execute();
    if (stale.length === 0) return;
    const rendered = await Promise.all(
      stale.map(async (post) => ({ ...post, ...(await renderMarkdown(post.body, showImages)) })),
    );
    await db.transaction().execute(async (trx) => {
      for (const post of rendered) {
        const { numUpdatedRows } = await trx
          .updateTable("posts")
          .set({ html: post.html, render_version: RENDER_VERSION })
          .where("id", "=", post.id)
          .where("render_version", "<", RENDER_VERSION)
          .executeTakeFirst();
        if (numUpdatedRows > 0n && post.deleted_at === null) await indexPost(trx, post.id);
      }
    });
  }
}
