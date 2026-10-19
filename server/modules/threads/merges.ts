import { sql, type Transaction } from "kysely";
import type { DB } from "../../../db/types.ts";
import type { Actor, Reader, Viewer } from "../../platform/access.ts";
import { db } from "../../platform/db.ts";
import { AppError } from "../../platform/errors.ts";
import { recordAudit } from "../audit/service.ts";
import { countBoard, findTags, getBoard } from "../boards/service.ts";
import { moveDrafts } from "../drafts/service.ts";
import { moveNotifications, notifyOnPost } from "../notifications/service.ts";
import { moveLinks } from "../qq/service.ts";
import { indexPost } from "../search/service.ts";
import { dropSummary } from "../summaries/service.ts";
import { countUserPosts } from "../users/service.ts";
import { threadMerged } from "./events.ts";
import { whyUnmergeable } from "./merge-rules.ts";
import { countThread, getThread, saveThreadChange } from "./service.ts";

// A moderator merges one thread into another (design §8.20): its floors join the other's, all
// numbered anew by when they were posted, and it is gone, its old address leading to where its
// floors are now. A moderator may also number a thread's floors anew alone, when archiving put
// them out of order.

const MAX_TAGS = 5;

export type MergeChoice = {
  into: number;
  title?: string;
  board?: string;
  tags?: string[];
  kind?: "discussion" | "question";
};

type Floor = { id: number; thread_id: number; floor: number };

export async function mergeThread(
  actor: Actor,
  viewer: Viewer,
  reader: Reader,
  threadId: number,
  choice: MergeChoice,
) {
  if (choice.into === threadId) {
    throw new AppError(400, "invalid_request", "不能把帖子合并到它自己");
  }
  const thread = await getThread(threadId, reader);
  const into = await getThread(choice.into, reader);
  const board = choice.board === undefined ? null : await getBoard(choice.board, reader.reach);
  const tags = choice.tags ?? [...new Set([...into.tags, ...thread.tags])];
  if (tags.length > MAX_TAGS) {
    throw new AppError(400, "invalid_request", `两个帖子合起来有 ${tags.length} 个标签，最多 5 个`);
  }
  const tagIds = await findTags(tags);

  return db.transaction().execute(async (trx) => {
    // Both locked, so nothing is posted to either meanwhile, and checked as they are now; the
    // lower ID first, so two merges of the same pair wait for each other rather than deadlock.
    const lock = async (id: number) => {
      const row = await trx
        .selectFrom("threads")
        .select([
          "id",
          "kind",
          "status",
          "author_anonymous",
          "anonymous_replies",
          "board_id",
          "author_id",
          "reply_count",
          "view_count",
          "last_post_at",
          "last_poster_id",
          "pinned",
          "featured",
        ])
        .where("id", "=", id)
        .where("deleted_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw new AppError(404, "thread_not_found", "帖子不存在");
      const why = whyUnmergeable(row);
      if (why) throw new AppError(400, "invalid_request", why);
      return row;
    };
    const first = await lock(Math.min(threadId, choice.into));
    const second = await lock(Math.max(threadId, choice.into));
    const [gone, kept] = first.id === threadId ? [first, second] : [second, first];

    await countThread(trx, gone.id, gone, -1);
    const floors = await trx
      .selectFrom("posts")
      .select(["id", "thread_id", "floor"])
      .where("thread_id", "in", [gone.id, kept.id])
      .orderBy(sql`(thread_id = ${kept.id} AND floor = 1) DESC`)
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    const goneFloors = floors.filter((f) => f.thread_id === gone.id).toSorted(byFloor);
    const opening = goneFloors[0].id;
    await trx
      .insertInto("thread_merges")
      .values({ thread_id: gone.id, post_ids: goneFloors.map((f) => f.id) })
      .execute();
    await number(trx, kept.id, floors);
    await mergeReaders(trx, gone.id, kept.id);

    // What answered its author now answers their floor, which is no longer the opening post.
    const answering = await trx
      .updateTable("posts")
      .set({ reply_to_id: opening })
      .where(
        "id",
        "in",
        goneFloors.map((f) => f.id),
      )
      .where("id", "<>", opening)
      .where("reply_to_id", "is", null)
      .returning(sql<boolean>`status = 'visible' AND deleted_at IS NULL`.as("counted"))
      .execute();
    await trx
      .updateTable("posts")
      .set((eb) => ({
        reply_count: eb("reply_count", "+", answering.filter((p) => p.counted).length),
      }))
      .where("id", "=", opening)
      .execute();
    // A discussion has no answers to accept.
    const kind = choice.kind ?? kept.kind;
    if (kind === "discussion") {
      await trx
        .updateTable("posts")
        .set({ accepted_at: null })
        .where("thread_id", "=", kept.id)
        .where("accepted_at", "is not", null)
        .execute();
    }
    const later = gone.last_post_at > kept.last_post_at ? gone : kept;
    await trx
      .updateTable("threads")
      .set((eb) => ({
        kind,
        floor_count: floors.length,
        reply_count: eb("reply_count", "+", gone.reply_count + 1),
        view_count: eb("view_count", "+", gone.view_count),
        // From the row, not the Date read from it, which would drop the microseconds.
        last_post_at: eb
          .selectFrom("threads as later")
          .select("later.last_post_at")
          .where("later.id", "=", later.id),
        last_poster_id: later.last_poster_id,
        accepted_count: eb
          .selectFrom("posts")
          .select(sql<number>`count(*)::smallint`.as("n"))
          .where("thread_id", "=", kept.id)
          .where("accepted_at", "is not", null)
          .where("status", "=", "visible"),
      }))
      .where("id", "=", kept.id)
      .execute();
    // The replies come along, and the opening post as one of them.
    await countBoard(trx, kept.board_id, { threads: 0, posts: gone.reply_count + 1 });
    await countUserPosts(trx, gone.author_id, { threads: 0, posts: 1 });

    await trx
      .updateTable("threads")
      .set({ deleted_at: sql<Date>`now()` })
      .where("id", "=", gone.id)
      .execute();
    await trx.deleteFrom("thread_tags").where("thread_id", "=", gone.id).execute();
    await trx
      .deleteFrom("thread_suggestions")
      .where("thread_id", "=", gone.id)
      .where("status", "=", "open")
      .execute();
    await moveLinks(trx, gone.id, kept.id);
    await moveNotifications(trx, gone.id, kept.id);
    await moveDrafts(trx, gone.id, kept.id);
    await dropSummary(trx, gone.id);
    await dropSummary(trx, kept.id);

    await saveThreadChange(trx, { id: kept.id, status: "visible" }, viewer.id, {
      title: choice.title,
      tagIds,
      board_id: board?.id,
      pinned: Math.max(gone.pinned, kept.pinned),
      featured: gone.featured || kept.featured,
    });
    // Its title no longer goes with it.
    await indexPost(trx, opening);

    await threadMerged(trx, gone.id, opening, viewer.id);
    // Content brought over from the groups tells nobody (design §8.6).
    const landed = await trx
      .selectFrom("posts")
      .select(["via", "floor"])
      .where("id", "=", opening)
      .executeTakeFirstOrThrow();
    if (landed.via !== "qq") {
      await notifyOnPost(
        trx,
        "moderation",
        { id: opening, thread_id: kept.id, author_id: gone.author_id },
        viewer.id,
        null,
        { action: "merge", reason: "" },
      );
    }
    await recordAudit(trx, actor, {
      action: "thread.merge",
      target_type: "thread",
      target_id: gone.id,
      data: { into: kept.id, title: choice.title, board: choice.board, tags, kind },
    });
    return { thread_id: kept.id, floor: landed.floor };
  });
}

// Out of order where archiving posted floors late, or in a few seconds' disorder; returns how
// many floors changed number.
export async function renumberThread(actor: Actor, reader: Reader, threadId: number) {
  await getThread(threadId, reader);
  return db.transaction().execute(async (trx) => {
    await trx
      .selectFrom("threads")
      .select("id")
      .where("id", "=", threadId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const floors = await trx
      .selectFrom("posts")
      .select(["id", "thread_id", "floor"])
      .where("thread_id", "=", threadId)
      .orderBy(sql`floor = 1 DESC`)
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    const moved = floors.filter((f, i) => f.floor !== i + 1).length;
    if (moved === 0) return 0;
    await number(trx, threadId, floors);
    await dropSummary(trx, threadId);
    await recordAudit(trx, actor, {
      action: "thread.renumber",
      target_type: "thread",
      target_id: threadId,
      data: { moved },
    });
    return moved;
  });
}

function byFloor(a: Floor, b: Floor) {
  return a.floor - b.floor;
}

// `floors` go to `threadId` numbered from 1 in their order, below zero first so the unique
// (thread, floor) never meets two at once; what each reader read is numbered with them.
async function number(trx: Transaction<DB>, threadId: number, floors: Floor[]) {
  const ids = floors.map((f) => f.id);
  await trx
    .updateTable("posts")
    .set({ thread_id: threadId, floor: sql<number>`-array_position(${ids}::int[], id)` })
    .where("id", "in", ids)
    .execute();
  await trx
    .updateTable("posts")
    .set({ floor: sql<number>`-floor` })
    .where("thread_id", "=", threadId)
    .where("floor", "<", 0)
    .execute();
  for (const from of new Set(floors.map((f) => f.thread_id))) {
    const old = floors.filter((f) => f.thread_id === from);
    await trx
      .updateTable("thread_users")
      .set({
        read_floors: renumbered(
          old.map((f) => f.floor),
          old.map((f) => floors.indexOf(f) + 1),
        ),
      })
      .where("thread_id", "=", from)
      .execute();
  }
}

// A reader's floors read (an int4multirange), each one by its new number.
function renumbered(old: number[], now: number[]) {
  return sql<string>`(SELECT coalesce(range_agg(int4range(m.now, m.now + 1)), '{}')
    FROM unnest(${old}::int[], ${now}::int[]) AS m(old, now)
    WHERE thread_users.read_floors @> m.old)`;
}

// Those who read, bookmarked or followed the thread merged away keep it in the one kept: the
// floors read of both, the earlier bookmark, how closely they followed the one kept if they did.
async function mergeReaders(trx: Transaction<DB>, goneId: number, keptId: number) {
  await trx
    .insertInto("thread_users")
    .columns([
      "thread_id",
      "user_id",
      "read_floors",
      "last_read_at",
      "bookmarked_at",
      "notify_level",
    ])
    .expression((eb) =>
      eb
        .selectFrom("thread_users")
        .select([
          sql<number>`${keptId}::integer`.as("thread_id"),
          "user_id",
          "read_floors",
          "last_read_at",
          "bookmarked_at",
          "notify_level",
        ])
        .where("thread_id", "=", goneId),
    )
    .onConflict((oc) =>
      oc.columns(["user_id", "thread_id"]).doUpdateSet({
        read_floors: sql<string>`thread_users.read_floors + excluded.read_floors`,
        last_read_at: sql<Date>`greatest(thread_users.last_read_at, excluded.last_read_at)`,
        bookmarked_at: sql<Date>`least(thread_users.bookmarked_at, excluded.bookmarked_at)`,
      }),
    )
    .execute();
  await trx.deleteFrom("thread_users").where("thread_id", "=", goneId).execute();
}
