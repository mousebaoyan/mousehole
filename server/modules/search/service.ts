import { sql, type Transaction } from "kysely";
import type { DB } from "../../../db/types.ts";
import { GUEST } from "../../platform/access.ts";
import { db } from "../../platform/db.ts";
import { plainText } from "../../platform/markdown.ts";
import {
  anyQuery,
  documentTokens,
  phraseQuery,
  snippet,
  terms,
} from "../../platform/search-terms.ts";
import { readable } from "../boards/service.ts";
import { shownToGuests } from "../users/service.ts";

// ---- The index: one row per post, its text and, for an opening post, its thread's title weighted
// above it. Kept in step in the writer's transaction; see docs/data-model.md.

export async function indexPost(trx: Transaction<DB>, postId: number) {
  const post = await trx
    .selectFrom("posts")
    .innerJoin("threads", "threads.id", "posts.thread_id")
    .select(["posts.html", "posts.floor", "threads.title"])
    .where("posts.id", "=", postId)
    .executeTakeFirstOrThrow();
  const title = post.floor === 1 ? post.title : "";
  const document = sql<string>`setweight(to_tsvector('simple', ${documentTokens(title)}), 'A')
    || to_tsvector('simple', ${documentTokens(plainText(post.html))})`;
  await trx
    .insertInto("post_search")
    .values({ post_id: postId, document })
    .onConflict((oc) => oc.column("post_id").doUpdateSet({ document }))
    .execute();
}

export async function unindexPost(trx: Transaction<DB>, postId: number) {
  await trx.deleteFrom("post_search").where("post_id", "=", postId).execute();
}

// At start-up: posts written before the index was, or since it was emptied to be built anew.
export async function indexMissingPosts() {
  for (;;) {
    const missing = await db
      .selectFrom("posts")
      .leftJoin("post_search", "post_search.post_id", "posts.id")
      .select("posts.id")
      .where("post_search.post_id", "is", null)
      .where("posts.deleted_at", "is", null)
      .limit(500)
      .execute();
    if (missing.length === 0) return;
    await db.transaction().execute(async (trx) => {
      for (const { id } of missing) await indexPost(trx, id);
    });
  }
}

// ---- Searching. See design §8.5.

const PAGE = 20;
const SIMILAR = 5;

// Posts people may see: published, not deleted, in a thread and board they can open, and for
// guests not by someone who keeps their content from them. The same rules as the threads
// module's lists.
function visiblePosts(reach: number) {
  return db
    .selectFrom("post_search")
    .innerJoin("posts", "posts.id", "post_search.post_id")
    .innerJoin("threads", "threads.id", "posts.thread_id")
    .innerJoin("boards", "boards.id", "threads.board_id")
    .where("posts.deleted_at", "is", null)
    .where("posts.status", "=", "visible")
    .where("threads.deleted_at", "is", null)
    .where("threads.status", "=", "visible")
    .where(readable(reach))
    .$if(reach === GUEST, (qb) =>
      qb.where(shownToGuests("threads.author_id")).where(shownToGuests("posts.author_id")),
    );
}

export const SORTS = ["relevance", "created", "last_post", "hot"] as const;

// Relevance puts older ones gradually behind. Hot weighs replies, likes and views as the lists'
// 热门 does, without its decay: a search reaches back years (design §8.5).
const ORDERS = {
  relevance: sql`rank / (1 + extract(epoch FROM now() - created_at) / 86400 / 365)`,
  created: sql`created_at`,
  last_post: sql`last_post_at`,
  hot: sql`reply_count * 2 + like_count + view_count / 20.0`,
};

const SINCE = { week: "7 days", month: "1 month", year: "1 year" } as const;

export type SearchFilter = {
  boardId?: number;
  tagId?: number;
  // The thread's author, 楼主.
  authorId?: number;
  kind?: "discussion" | "question";
  // False is a question still waiting for its answer.
  solved?: boolean;
  since?: keyof typeof SINCE;
  titleOnly?: boolean;
  sort: (typeof SORTS)[number];
};

// Threads with the best-matching post of each; the cursor is how many were shown. By relevance,
// older ones gradually behind, or by one of the threads' own orders. A single Han character is
// too short to index, so it is looked for in titles instead.
export async function search(reach: number, q: string, filter: SearchFilter, offset: number) {
  const words = terms(q);
  if (words.length === 0) return { hits: [], next_cursor: null };
  const single = words.length === 1 && words[0].length === 1 && words[0][0].length === 1;
  const query = sql`to_tsquery('simple', ${phraseQuery(q, filter.titleOnly)})`;
  let matches = visiblePosts(reach).select([
    "posts.thread_id",
    "posts.id as post_id",
    "posts.floor",
    "posts.html",
    "threads.created_at",
    "threads.last_post_at",
    "threads.reply_count",
    "threads.like_count",
    "threads.view_count",
    single
      ? sql<number>`1`.as("rank")
      : sql<number>`ts_rank_cd(post_search.document, ${query})`.as("rank"),
  ]);
  matches = single
    ? matches.where("posts.floor", "=", 1).where("threads.title", "ilike", `%${q.trim()}%`)
    : matches.where(sql<boolean>`post_search.document @@ ${query}`);
  if (filter.titleOnly) matches = matches.where("posts.floor", "=", 1);
  if (filter.boardId !== undefined) {
    matches = matches.where("threads.board_id", "=", filter.boardId);
  }
  if (filter.authorId !== undefined) {
    matches = matches
      .where("threads.author_id", "=", filter.authorId)
      .where("threads.author_anonymous", "=", false);
  }
  if (filter.kind !== undefined) matches = matches.where("threads.kind", "=", filter.kind);
  if (filter.solved === true) matches = matches.where("threads.accepted_count", ">", 0);
  if (filter.solved === false) {
    matches = matches
      .where("threads.kind", "=", "question")
      .where("threads.accepted_count", "=", 0);
  }
  if (filter.since !== undefined) {
    const since = SINCE[filter.since];
    matches = matches.where("threads.created_at", ">", sql<Date>`now() - ${since}::interval`);
  }
  if (filter.tagId !== undefined) {
    const tagId = filter.tagId;
    matches = matches.where((eb) =>
      eb.exists(
        eb
          .selectFrom("thread_tags")
          .whereRef("thread_tags.thread_id", "=", "threads.id")
          .where("thread_tags.tag_id", "=", tagId),
      ),
    );
  }
  const rows = await db
    .selectFrom(
      matches
        .distinctOn("posts.thread_id")
        .orderBy("posts.thread_id")
        .orderBy("rank", "desc")
        .as("best"),
    )
    .selectAll()
    .orderBy(ORDERS[filter.sort], "desc")
    .orderBy("thread_id", "desc")
    .offset(offset)
    .limit(PAGE)
    .execute();
  const shown = q.split(/\s+/).filter((w) => w !== "");
  return {
    hits: rows.map((r) => ({
      thread_id: r.thread_id,
      post_id: r.post_id,
      floor: r.floor,
      snippet: snippet(plainText(r.html), shown),
    })),
    next_cursor: rows.length === PAGE ? String(offset + PAGE) : null,
  };
}

// The threads most like a question, for the bot to point to before anyone answers it again.
// Any shared token counts, against the post's length, as long posts have nearly every token;
// the score is between 0 and 1. Not ts_rank_cd: over the hundreds of tokens of a long question
// it takes minutes.
export async function similar(reach: number, text: string) {
  const query = anyQuery(text);
  if (query === "") return [];
  const tsquery = sql`to_tsquery('simple', ${query})`;
  return db
    .selectFrom(
      visiblePosts(reach)
        .select([
          "posts.thread_id",
          sql<number>`ts_rank(post_search.document, ${tsquery}, 1 | 32)`.as("score"),
        ])
        .where(sql<boolean>`post_search.document @@ ${tsquery}`)
        .as("matches"),
    )
    .select(["thread_id", (eb) => eb.fn.max("score").as("score")])
    .groupBy("thread_id")
    .orderBy("score", "desc")
    .limit(SIMILAR)
    .execute();
}

// ---- Search terms for the admin's stats (design §10.1): what is searched for on the site and
// how often nothing is found, without who. Each searcher counts once a Beijing day for a term, so
// that changing the filters or the order doesn't count again; who that was is kept in memory only.

const KEEP_DAYS = 400;

let searched = { day: "", by: new Set<string>() };

// `searcher` tells one person from another: a user ID, or a guest's address.
export async function recordSearch(searcher: string, q: string, empty: boolean) {
  const term = q.trim().replace(/\s+/g, " ").toLowerCase();
  const day = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
  if (searched.day !== day) searched = { day, by: new Set() };
  const key = `${searcher} ${term}`;
  if (searched.by.has(key)) return;
  searched.by.add(key);
  await sql`INSERT INTO search_terms AS s (day, term, searches, empty)
    VALUES (${day}, ${term}, 1, ${empty ? 1 : 0})
    ON CONFLICT (day, term) DO UPDATE
    SET searches = s.searches + 1, empty = s.empty + excluded.empty`.execute(db);
}

export async function clearOldSearchTerms() {
  await db
    .deleteFrom("search_terms")
    .where(
      "day",
      "<=",
      sql<Date>`(now() AT TIME ZONE 'Asia/Shanghai')::date - ${KEEP_DAYS}::integer`,
    )
    .execute();
}
