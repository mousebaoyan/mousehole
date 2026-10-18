import { sql } from "kysely";
import { jsonObjectFrom } from "kysely/helpers/postgres";
import type { Actor, Reader, Viewer } from "../../platform/access.ts";
import { db } from "../../platform/db.ts";
import { AppError } from "../../platform/errors.ts";
import { recordAudit } from "../audit/service.ts";
import { findTags, getBoard } from "../boards/service.ts";
import { notifySuggestion } from "../notifications/service.ts";
import { userBriefs } from "../users/service.ts";
import {
  assertMayChange,
  assertMayPost,
  getThread,
  levelPower,
  saveThreadChange,
} from "./service.ts";

// L3 suggests a better title, board or tags for a thread by someone below them; its author or a
// moderator accepts or turns it down (design §6.6).

const PAGE = 30;

export async function suggestChange(
  actor: Actor,
  viewer: Viewer,
  reach: number,
  threadId: number,
  input: { title?: string; board?: string; tags?: string[]; reason?: string },
) {
  const thread = await getThread(threadId, { reach, id: viewer.id, staff: false });
  if ((await levelPower(viewer, thread.author_id, thread.author_anonymous)) < 3) {
    throw new AppError(403, "forbidden", "L3 起才能建议修改等级比自己低的人的帖子");
  }
  if (thread.locked) throw new AppError(403, "thread_locked", "帖子已锁定");
  // Only what would change.
  const board =
    input.board === undefined || input.board === thread.board_slug
      ? null
      : await getBoard(input.board, reach);
  if (board) assertMayPost(viewer, board);
  if (input.tags) await findTags(input.tags);
  const title = input.title !== undefined && input.title !== thread.title ? input.title : null;
  const boardId = board?.id ?? null;
  const tags =
    input.tags && input.tags.toSorted().join() !== thread.tags.toSorted().join()
      ? input.tags
      : null;
  if (title === null && boardId === null && tags === null) {
    throw new AppError(400, "invalid_request", "建议的标题、版块和标签都和现在一样");
  }

  await db.transaction().execute(async (trx) => {
    const created = await trx
      .insertInto("thread_suggestions")
      .values({
        thread_id: threadId,
        user_id: viewer.id,
        title,
        board_id: boardId,
        tags,
        reason: input.reason || null,
      })
      .onConflict((oc) =>
        oc.columns(["thread_id", "user_id"]).where("status", "=", "open").doNothing(),
      )
      .returning("id")
      .executeTakeFirst();
    if (!created) {
      throw new AppError(409, "suggestion_exists", "你对这个帖子的修改建议还在等待处理");
    }
    await recordAudit(trx, actor, {
      action: "suggestion.create",
      target_type: "thread",
      target_id: threadId,
      data: { suggestion: created.id, title, board_id: boardId, tags },
    });
    await notifySuggestion(trx, thread.author_id, viewer.id, threadId, "new");
  });
}

function selectSuggestions() {
  return db
    .selectFrom("thread_suggestions as s")
    .select((eb) => [
      "s.id",
      "s.user_id",
      "s.title",
      "s.tags",
      "s.reason",
      "s.created_at",
      jsonObjectFrom(
        eb
          .selectFrom("boards")
          .select(["slug", "name", "color"])
          .whereRef("boards.id", "=", "s.board_id"),
      ).as("board"),
    ])
    .where("s.status", "=", "open");
}

type Row = Awaited<ReturnType<ReturnType<typeof selectSuggestions>["execute"]>>[number];

async function withUsers<R extends Row>(rows: R[]) {
  const user = await userBriefs(rows.map((r) => r.user_id));
  return rows.map(({ user_id, ...r }) => ({ ...r, user: user(user_id) }));
}

export type Suggestion = Awaited<ReturnType<typeof threadSuggestions>>[number];

// Those waiting on a thread, for its author and moderators to decide; the first made first.
export async function threadSuggestions(threadId: number) {
  return withUsers(
    await selectSuggestions().where("s.thread_id", "=", threadId).orderBy("s.id").execute(),
  );
}

// For moderators: all those waiting on threads still there, newest first, with how each thread
// is now; the cursor is the last one's ID.
export async function listSuggestions(cursor: number | undefined) {
  let query = selectSuggestions()
    .innerJoin("threads", "threads.id", "s.thread_id")
    .innerJoin("boards", "boards.id", "threads.board_id")
    .select([
      "threads.id as thread_id",
      "threads.title as thread_title",
      "boards.slug as thread_board_slug",
      "boards.name as thread_board_name",
      "boards.color as thread_board_color",
      sql<string[]>`(SELECT coalesce(array_agg(tags.name ORDER BY tags.name), '{}')
        FROM thread_tags JOIN tags ON tags.id = thread_tags.tag_id
        WHERE thread_tags.thread_id = threads.id)`.as("thread_tags"),
    ])
    .where("threads.deleted_at", "is", null)
    .orderBy("s.id", "desc")
    .limit(PAGE);
  if (cursor !== undefined) query = query.where("s.id", "<", cursor);
  const rows = await query.execute();
  const last = rows.at(-1);
  return {
    items: (await withUsers(rows)).map(
      ({
        thread_id,
        thread_title,
        thread_board_slug,
        thread_board_name,
        thread_board_color,
        thread_tags,
        ...suggestion
      }) => ({
        ...suggestion,
        thread: {
          id: thread_id,
          title: thread_title,
          board: { slug: thread_board_slug, name: thread_board_name, color: thread_board_color },
          tags: thread_tags,
        },
      }),
    ),
    next_cursor: rows.length === PAGE && last ? String(last.id) : null,
  };
}

export async function countOpenSuggestions() {
  const { count } = await db
    .selectFrom("thread_suggestions")
    .innerJoin("threads", "threads.id", "thread_suggestions.thread_id")
    .select(sql<number>`count(*)::integer`.as("count"))
    .where("thread_suggestions.status", "=", "open")
    .where("threads.deleted_at", "is", null)
    .executeTakeFirstOrThrow();
  return count;
}

// By the thread's author or a moderator, whoever comes first. Accepted, the change is made as the
// suggester's. The suggester hears either way, and the author when a moderator changed it: nobody
// hears of their own doing.
export async function decideSuggestion(
  actor: Actor,
  viewer: Viewer,
  reader: Reader,
  id: number,
  status: "accepted" | "rejected",
) {
  const found = await db
    .selectFrom("thread_suggestions")
    .select("thread_id")
    .where("id", "=", id)
    .executeTakeFirst();
  if (!found) throw new AppError(404, "suggestion_not_found", "修改建议不存在");
  const thread = await getThread(found.thread_id, reader);
  assertMayChange(reader.staff, viewer, thread.author_id, thread.locked);

  await db.transaction().execute(async (trx) => {
    const s = await trx
      .selectFrom("thread_suggestions")
      .selectAll()
      .where("id", "=", id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (s.status !== "open") {
      throw new AppError(409, "suggestion_handled", "这条修改建议已经处理过了");
    }
    if (status === "accepted") {
      await saveThreadChange(trx, thread, s.user_id, {
        title: s.title ?? undefined,
        tagIds: s.tags && (await findTags(s.tags)),
        board_id: s.board_id ?? undefined,
      });
    }
    await trx
      .updateTable("thread_suggestions")
      .set({ status, handler_id: viewer.id, handled_at: sql<Date>`now()` })
      .where("id", "=", id)
      .execute();
    await recordAudit(trx, actor, {
      action: status === "accepted" ? "suggestion.accept" : "suggestion.reject",
      target_type: "thread",
      target_id: thread.id,
      data: { suggestion: id, by: s.user_id, title: s.title, board_id: s.board_id, tags: s.tags },
    });
    await notifySuggestion(trx, s.user_id, viewer.id, thread.id, status);
    if (status === "accepted") {
      await notifySuggestion(trx, thread.author_id, viewer.id, thread.id, "applied");
    }
  });
}
