import { sql, type Transaction } from "kysely";
import type { DB } from "../../../db/types.ts";
import { GUEST, type Actor, type Reader } from "../../platform/access.ts";
import { db } from "../../platform/db.ts";
import { AppError } from "../../platform/errors.ts";
import { excerpt } from "../../platform/markdown.ts";
import { getSettings } from "../../platform/settings.ts";
import { recordAudit } from "../audit/service.ts";

// AI summaries of busy threads, written by the bot plugin's LLM (design §8.18).

// Replies a thread needs before it is summarized, and more it needs before it is summarized
// again: half as many again as last time, and at least this many.
const MIN_REPLIES = 5;
const MORE_REPLIES = 5;
// A thread is summarized once its talk has stopped this long.
const QUIET = sql`interval '1 hour'`;
// Characters of each floor the LLM is given.
const FLOOR_TEXT = 1000;

export type Point = { text: string; floors: number[] };

function notFound() {
  return new AppError(404, "thread_not_found", "帖子不存在，或者不写 AI 总结");
}

// Public threads that can have one; lotteries are only people taking part.
function summarizable() {
  return db
    .selectFrom("threads")
    .where("threads.deleted_at", "is", null)
    .where("threads.status", "=", "visible")
    .where("threads.kind", "<>", "lottery");
}

// The latest active first, once quiet; none while summaries are off.
export async function dueSummaries(limit: number) {
  if (!(await getSettings()).site.summaries) return [];
  return summarizable()
    .leftJoin("thread_summaries as s", "s.thread_id", "threads.id")
    .select(["threads.id as thread_id", "threads.reply_count as replies"])
    .where("threads.reply_count", ">=", MIN_REPLIES)
    .where("threads.last_post_at", "<", sql<Date>`now() - ${QUIET}`)
    .where((eb) =>
      eb.or([
        eb("s.thread_id", "is", null),
        eb.and([
          eb("s.disabled", "=", false),
          eb(
            "threads.reply_count",
            ">=",
            sql<number>`greatest(s.replies + ${MORE_REPLIES}, ceil(s.replies * 1.5))`,
          ),
        ]),
      ]),
    )
    .orderBy("threads.last_post_at", "desc")
    .limit(limit)
    .execute();
}

// What the LLM is given: the public floors as plain text, with no names, nor a poll's results,
// which those who haven't voted can't see yet. Only for threads the reader may open.
export async function summarySource(threadId: number, reach: number) {
  const thread = await summarizable()
    .innerJoin("boards", "boards.id", "threads.board_id")
    .leftJoin("thread_summaries as s", "s.thread_id", "threads.id")
    .select([
      "threads.id",
      "threads.kind",
      "threads.title",
      "threads.author_id",
      "threads.reply_count",
      "boards.name as board",
      sql<string[]>`(SELECT coalesce(array_agg(tags.name ORDER BY tags.name), '{}')
        FROM thread_tags JOIN tags ON tags.id = thread_tags.tag_id
        WHERE thread_tags.thread_id = threads.id)`.as("tags"),
      sql<boolean>`EXISTS (SELECT 1 FROM polls
        WHERE polls.thread_id = threads.id AND polls.preset = 'positioning')`.as("positioning"),
    ])
    .where("threads.id", "=", threadId)
    .where("boards.read_level", "<=", reach)
    .where(sql<boolean>`s.disabled IS NOT TRUE`)
    .executeTakeFirst();
  if (!thread) throw notFound();
  const posts = await db
    .selectFrom("posts")
    .select(["floor", "author_id", "html", "like_count", "accepted_at"])
    .where("thread_id", "=", threadId)
    .where("status", "=", "visible")
    .where("deleted_at", "is", null)
    .orderBy("floor")
    .execute();
  return {
    thread: {
      id: thread.id,
      kind: thread.kind,
      title: thread.title,
      board: thread.board,
      tags: thread.tags,
      positioning: thread.positioning,
    },
    replies: thread.reply_count,
    posts: posts.map((p) => ({
      floor: p.floor,
      op: p.author_id === thread.author_id,
      accepted: p.accepted_at !== null,
      likes: p.like_count,
      text: excerpt(p.html.replaceAll(/<img\b[^>]*>/g, "[图片]"), FLOOR_TEXT),
    })),
  };
}

// From the plugin, over what was there before; not for a thread a moderator turned it off for.
export async function saveSummary(
  actor: Actor,
  threadId: number,
  summary: { lead: string; points: Point[]; replies: number },
) {
  if (!(await getSettings()).site.summaries) {
    throw new AppError(403, "forbidden", "AI 总结没有打开");
  }
  const thread = await summarizable()
    .select("floor_count")
    .where("id", "=", threadId)
    .executeTakeFirst();
  if (!thread) throw notFound();
  const floors = [...new Set(summary.points.flatMap((p) => p.floors))].toSorted((a, b) => a - b);
  if (floors.some((f) => f < 1 || f > thread.floor_count)) {
    throw new AppError(400, "invalid_request", "引用的楼层不在这个帖子里");
  }
  await db.transaction().execute(async (trx) => {
    const saved = await trx
      .insertInto("thread_summaries")
      .values({
        thread_id: threadId,
        lead: summary.lead,
        points: JSON.stringify(summary.points),
        floors,
        replies: summary.replies,
      })
      .onConflict((oc) =>
        oc
          .column("thread_id")
          .doUpdateSet((eb) => ({
            lead: eb.ref("excluded.lead"),
            points: eb.ref("excluded.points"),
            floors: eb.ref("excluded.floors"),
            replies: eb.ref("excluded.replies"),
            created_at: sql<Date>`now()`,
          }))
          .where("thread_summaries.disabled", "=", false),
      )
      .returning("thread_id")
      .executeTakeFirst();
    if (!saved) throw new AppError(409, "summary_disabled", "版主关闭了这个帖子的 AI 总结");
    await recordAudit(trx, actor, {
      action: "summary.save",
      target_type: "thread",
      target_id: threadId,
      data: { lead: summary.lead, replies: summary.replies },
    });
  });
}

// By a moderator: off drops the summary and keeps it from being written again; back on, it is
// written by the rules.
export async function setSummaryDisabled(actor: Actor, threadId: number, disabled: boolean) {
  const thread = await db
    .selectFrom("threads")
    .select("id")
    .where("id", "=", threadId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!thread) throw new AppError(404, "thread_not_found", "帖子不存在");
  await db.transaction().execute(async (trx) => {
    if (disabled) {
      await trx
        .insertInto("thread_summaries")
        .values({ thread_id: threadId, disabled: true })
        .onConflict((oc) =>
          oc
            .column("thread_id")
            .doUpdateSet({ disabled: true, lead: null, points: null, floors: [], replies: 0 }),
        )
        .execute();
    } else {
      await trx.deleteFrom("thread_summaries").where("thread_id", "=", threadId).execute();
    }
    await recordAudit(trx, actor, {
      action: disabled ? "summary.disable" : "summary.enable",
      target_type: "thread",
      target_id: threadId,
    });
  });
}

// For a thread's page: its summary, unless summaries are off, or the reader is a guest and some
// floor in it is by someone who keeps theirs from guests (design §8.10). Moderators also learn
// whether it was turned off.
export async function threadSummary(threadId: number, reader: Reader) {
  if (!(await getSettings()).site.summaries) return null;
  const row = await db
    .selectFrom("thread_summaries")
    .select([
      "lead",
      sql<Point[] | null>`points`.as("points"),
      "replies",
      "disabled",
      "created_at",
      sql<boolean>`EXISTS (SELECT 1 FROM posts JOIN users ON users.id = posts.author_id
        WHERE posts.thread_id = thread_summaries.thread_id AND posts.status = 'visible'
          AND posts.deleted_at IS NULL AND users.hide_from_guests)`.as("kept_from_guests"),
    ])
    .where("thread_id", "=", threadId)
    .executeTakeFirst();
  const shown =
    row &&
    row.lead !== null &&
    row.points !== null &&
    !(reader.reach === GUEST && row.kept_from_guests)
      ? { lead: row.lead, points: row.points, replies: row.replies, created_at: row.created_at }
      : null;
  return { summary: shown, disabled: row?.disabled ?? false };
}

// A floor gone or hidden takes down the summary that cites it, to be written again.
export async function dropCitingSummary(trx: Transaction<DB>, threadId: number, floor: number) {
  await trx
    .deleteFrom("thread_summaries")
    .where("thread_id", "=", threadId)
    .where("disabled", "=", false)
    .where(sql<boolean>`${floor} = ANY(floors)`)
    .execute();
}
