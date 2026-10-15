import { sql, type Transaction } from "kysely";
import type { DB } from "../../../db/types.ts";
import { db } from "../../platform/db.ts";
import { AppError } from "../../platform/errors.ts";
import type { LotterySpec } from "../threads/lotteries.ts";
import type { PollSpec } from "../threads/polls.ts";

// What people are still writing, saved by the composer as they type; see design §8.2. A null
// thread is the one new thread each person may have in progress.

type DraftPoll = Omit<Extract<PollSpec, { options: string[] }>, "preset" | "rows"> & {
  days: number | null;
};
type DraftLottery = Omit<LotterySpec, "draws_at"> & {
  days: number | null;
  draws_at: number | null;
};

// The background a 保研定位 thread asks for (design §8.14), and the schools to rate.
type DraftPositioning = { fields: Record<string, string>; schools: string[] };

export type DraftContent = {
  body: string;
  title?: string;
  board?: string | null;
  kind?: "discussion" | "question" | "poll" | "positioning" | "lottery" | null;
  // As far as it has been written: options may still be blank, and the end may be a number of
  // days still to count from posting.
  poll?: DraftPoll | null;
  // Likewise: prizes may still be unnamed, and the time a number of days.
  lottery?: DraftLottery | null;
  positioning?: DraftPositioning | null;
  tags?: string[];
  author_anonymous?: boolean;
  anonymous_replies?: boolean;
  reply_to_id?: number | null;
};

function draftNotFound() {
  return new AppError(404, "draft_not_found", "没有这份草稿");
}

function ofThread(threadId: number | null) {
  return threadId === null
    ? sql<boolean>`drafts.thread_id IS NULL`
    : sql<boolean>`drafts.thread_id = ${threadId}`;
}

// For the sidebar and the drafts page, the latest first.
export async function listDrafts(userId: number) {
  const rows = await db
    .selectFrom("drafts")
    .leftJoin("threads", "threads.id", "drafts.thread_id")
    .select([
      "drafts.thread_id",
      "threads.title as thread_title",
      "drafts.title",
      "drafts.body",
      "drafts.updated_at",
    ])
    .where("drafts.user_id", "=", userId)
    .orderBy("drafts.updated_at", "desc")
    .execute();
  return rows.map((r) => ({
    thread: r.thread_id === null ? null : { id: r.thread_id, title: r.thread_title ?? "" },
    title: r.title,
    excerpt: r.body.replaceAll(/\s+/g, " ").trim().slice(0, 100),
    updated_at: r.updated_at,
  }));
}

export async function getDraft(userId: number, threadId: number | null) {
  const row = await db
    .selectFrom("drafts")
    .leftJoin("boards", "boards.id", "drafts.board_id")
    .leftJoin("posts as target", "target.id", "drafts.reply_to_id")
    .leftJoin("users as target_author", "target_author.id", "target.author_id")
    .select([
      "drafts.thread_id",
      "drafts.title",
      "boards.slug as board",
      "drafts.kind",
      sql<DraftPoll | null>`drafts.poll`.as("poll"),
      sql<DraftLottery | null>`drafts.lottery`.as("lottery"),
      sql<DraftPositioning | null>`drafts.positioning`.as("positioning"),
      "drafts.tags",
      "drafts.author_anonymous",
      "drafts.anonymous_replies",
      "drafts.body",
      "drafts.updated_at",
      "target.id as target_id",
      "target.floor as target_floor",
      "target_author.display_name as target_name",
    ])
    .where("drafts.user_id", "=", userId)
    .where(ofThread(threadId))
    .executeTakeFirst();
  if (!row) throw draftNotFound();
  const { target_id, target_floor, target_name, ...draft } = row;
  return {
    ...draft,
    reply_to:
      target_id === null || target_floor === null || target_name === null
        ? null
        : { id: target_id, floor: target_floor, name: target_name },
  };
}

// Saved whole each time. A reply's thread has to exist; a floor it answers that isn't in the
// thread, or a board that is gone, is simply not kept.
export async function saveDraft(userId: number, threadId: number | null, content: DraftContent) {
  if (threadId !== null) {
    const thread = await db
      .selectFrom("threads")
      .select("id")
      .where("id", "=", threadId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!thread) throw new AppError(404, "thread_not_found", "帖子不存在");
  }
  const values = {
    user_id: userId,
    thread_id: threadId,
    title: content.title ?? "",
    board_id: content.board
      ? sql<number | null>`(SELECT id FROM boards WHERE slug = ${content.board})`
      : null,
    kind: content.kind ?? null,
    poll: content.poll ?? null,
    lottery: content.lottery ?? null,
    positioning: content.positioning ?? null,
    tags: content.tags ?? [],
    author_anonymous: content.author_anonymous ?? false,
    anonymous_replies: content.anonymous_replies ?? false,
    body: content.body,
    reply_to_id:
      threadId !== null && content.reply_to_id
        ? sql<number | null>`(SELECT id FROM posts
            WHERE id = ${content.reply_to_id} AND thread_id = ${threadId})`
        : null,
    updated_at: new Date(),
  };
  await db
    .insertInto("drafts")
    .values(values)
    .onConflict((oc) =>
      oc.columns(["user_id", "thread_id"]).doUpdateSet((eb) => ({
        title: eb.ref("excluded.title"),
        board_id: eb.ref("excluded.board_id"),
        kind: eb.ref("excluded.kind"),
        poll: eb.ref("excluded.poll"),
        lottery: eb.ref("excluded.lottery"),
        tags: eb.ref("excluded.tags"),
        author_anonymous: eb.ref("excluded.author_anonymous"),
        anonymous_replies: eb.ref("excluded.anonymous_replies"),
        body: eb.ref("excluded.body"),
        reply_to_id: eb.ref("excluded.reply_to_id"),
        updated_at: eb.ref("excluded.updated_at"),
      })),
    )
    .execute();
}

export async function deleteDraft(userId: number, threadId: number | null) {
  const { numDeletedRows } = await db
    .deleteFrom("drafts")
    .where("user_id", "=", userId)
    .where(ofThread(threadId))
    .executeTakeFirst();
  if (numDeletedRows === 0n) throw draftNotFound();
}

// Posting what was drafted ends the draft, in the same transaction as the post.
export async function discardDraft(trx: Transaction<DB>, userId: number, threadId: number | null) {
  await trx.deleteFrom("drafts").where("user_id", "=", userId).where(ofThread(threadId)).execute();
}

export async function clearOldDrafts() {
  await db
    .deleteFrom("drafts")
    .where("updated_at", "<", sql<Date>`now() - interval '180 days'`)
    .execute();
}
