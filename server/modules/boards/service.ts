import { sql, type Transaction, type Updateable } from "kysely";
import { DatabaseError } from "pg";
import type { Boards, DB, Tags } from "../../../db/types.ts";
import type { Actor } from "../../platform/access.ts";
import { db } from "../../platform/db.ts";
import { AppError } from "../../platform/errors.ts";
import { recordAudit } from "../audit/service.ts";

const BOARD = [
  "id",
  "slug",
  "name",
  "description",
  "color",
  "visibility",
  "post_role",
  "default_kind",
  "thread_count",
] as const;

const TAG = ["id", "name", "kind", "thread_count"] as const;

export type BoardFields = Pick<
  Updateable<Boards>,
  "name" | "description" | "color" | "visibility" | "post_role" | "default_kind"
>;

export type TagFields = Pick<Updateable<Tags>, "name" | "kind">;

function boardNotFound() {
  return new AppError(404, "board_not_found", "版块不存在");
}

function tagNotFound() {
  return new AppError(404, "tag_not_found", "标签不存在");
}

// Guests don't learn that members-only boards exist.
export async function listBoards(members: boolean) {
  return db
    .selectFrom("boards")
    .select(BOARD)
    .$if(!members, (qb) => qb.where("visibility", "=", "public"))
    .orderBy("position")
    .orderBy("id")
    .execute();
}

export async function getBoard(slug: string, members: boolean) {
  const board = await db
    .selectFrom("boards")
    .select(BOARD)
    .where("slug", "=", slug)
    .$if(!members, (qb) => qb.where("visibility", "=", "public"))
    .executeTakeFirst();
  if (!board) throw boardNotFound();
  return board;
}

// New boards go to the end of the list.
export async function createBoard(
  actor: Actor,
  board: BoardFields & { slug: string; name: string },
) {
  return db.transaction().execute(async (trx) => {
    const created = await trx
      .insertInto("boards")
      .values({
        ...board,
        position: sql<number>`(SELECT coalesce(max(position) + 1, 0) FROM boards)`,
      })
      .onConflict((oc) => oc.column("slug").doNothing())
      .returning(BOARD)
      .executeTakeFirst();
    if (!created) throw new AppError(409, "board_exists", "这个地址已经有版块在用了");
    await recordAudit(trx, actor, {
      action: "board.create",
      target_type: "board",
      target_id: created.id,
      data: { slug: board.slug, name: board.name },
    });
    return created;
  });
}

// `position` moves the board to that index; the others close up around it.
export async function updateBoard(
  actor: Actor,
  slug: string,
  { position, ...change }: BoardFields & { position?: number },
) {
  return db.transaction().execute(async (trx) => {
    // All of them, locked: a move renumbers every board.
    const boards = await trx
      .selectFrom("boards")
      .select(["id", "slug"])
      .orderBy("position")
      .orderBy("id")
      .forUpdate()
      .execute();
    const board = boards.find((b) => b.slug === slug);
    if (!board) throw boardNotFound();

    if (Object.keys(change).length > 0) {
      await trx.updateTable("boards").set(change).where("id", "=", board.id).execute();
    }
    if (position !== undefined) {
      const order = boards.filter((b) => b !== board);
      order.splice(position, 0, board);
      await sql`
        UPDATE boards SET position = v.position
        FROM (VALUES ${sql.join(order.map((b, i) => sql`(${b.id}::integer, ${i}::integer)`))})
          AS v (id, position)
        WHERE boards.id = v.id`.execute(trx);
    }
    await recordAudit(trx, actor, {
      action: "board.update",
      target_type: "board",
      target_id: board.id,
      data: { ...change, position },
    });
    return trx
      .selectFrom("boards")
      .select(BOARD)
      .where("id", "=", board.id)
      .executeTakeFirstOrThrow();
  });
}

export async function deleteBoard(actor: Actor, slug: string) {
  await db.transaction().execute(async (trx) => {
    const deleted = await trx
      .deleteFrom("boards")
      .where("slug", "=", slug)
      .returning("id")
      .executeTakeFirst()
      .catch((error: unknown) => {
        // Threads keep their board even when deleted, so the foreign key refuses any board
        // that ever had one.
        if (error instanceof DatabaseError && error.code === "23503") {
          throw new AppError(409, "board_not_empty", "版块里有过主题，不能删除");
        }
        throw error;
      });
    if (!deleted) throw boardNotFound();
    await recordAudit(trx, actor, {
      action: "board.delete",
      target_type: "board",
      target_id: deleted.id,
      data: { slug },
    });
  });
}

// Topics first, then schools and majors; the most used first within each.
export async function listTags() {
  return db
    .selectFrom("tags")
    .select(TAG)
    .orderBy(sql`array_position(array['topic', 'school', 'major'], kind)`)
    .orderBy("thread_count", "desc")
    .orderBy("name")
    .execute();
}

export async function createTag(actor: Actor, tag: TagFields & { name: string }) {
  return db.transaction().execute(async (trx) => {
    const created = await trx
      .insertInto("tags")
      .values(tag)
      .onConflict((oc) => oc.column("name").doNothing())
      .returning(TAG)
      .executeTakeFirst();
    if (!created) throw new AppError(409, "tag_exists", "已经有这个标签了");
    await recordAudit(trx, actor, {
      action: "tag.create",
      target_type: "tag",
      target_id: created.id,
      data: tag,
    });
    return created;
  });
}

export async function updateTag(actor: Actor, id: number, change: TagFields) {
  return db.transaction().execute(async (trx) => {
    const updated = await trx
      .updateTable("tags")
      .set(change)
      .where("id", "=", id)
      .returning(TAG)
      .executeTakeFirst()
      .catch((error: unknown) => {
        if (error instanceof DatabaseError && error.code === "23505") {
          throw new AppError(409, "tag_exists", "已经有这个标签了，可以合并过去");
        }
        throw error;
      });
    if (!updated) throw tagNotFound();
    await recordAudit(trx, actor, {
      action: "tag.update",
      target_type: "tag",
      target_id: id,
      data: change,
    });
    return updated;
  });
}

// Moves the threads over, then drops the tag. Threads that had both keep one.
export async function mergeTag(actor: Actor, id: number, into: number) {
  if (id === into) throw new AppError(400, "invalid_request", "不能合并到自己");
  return db.transaction().execute(async (trx) => {
    const tags = await trx
      .selectFrom("tags")
      .select(["id", "name"])
      .where("id", "in", [id, into])
      .forUpdate()
      .execute();
    const from = tags.find((t) => t.id === id);
    const target = tags.find((t) => t.id === into);
    if (!from || !target) throw tagNotFound();

    await sql`
      INSERT INTO thread_tags (thread_id, tag_id, last_post_at)
      SELECT thread_id, ${into}, last_post_at FROM thread_tags WHERE tag_id = ${id}
      ON CONFLICT DO NOTHING`.execute(trx);
    await trx.deleteFrom("thread_tags").where("tag_id", "=", id).execute();
    await trx.deleteFrom("tags").where("id", "=", id).execute();
    await sql`
      UPDATE tags SET thread_count = (
        SELECT count(*) FROM thread_tags JOIN threads ON threads.id = thread_tags.thread_id
        WHERE thread_tags.tag_id = tags.id
          AND threads.deleted_at IS NULL AND threads.status = 'visible')
      WHERE id = ${into}`.execute(trx);

    await recordAudit(trx, actor, {
      action: "tag.merge",
      target_type: "tag",
      target_id: into,
      data: { from: from.name, into: target.name },
    });
    return trx.selectFrom("tags").select(TAG).where("id", "=", into).executeTakeFirstOrThrow();
  });
}

// Threads lose the tag along with it.
export async function deleteTag(actor: Actor, id: number) {
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom("thread_tags").where("tag_id", "=", id).execute();
    const deleted = await trx
      .deleteFrom("tags")
      .where("id", "=", id)
      .returning("name")
      .executeTakeFirst();
    if (!deleted) throw tagNotFound();
    await recordAudit(trx, actor, {
      action: "tag.delete",
      target_type: "tag",
      target_id: id,
      data: { name: deleted.name },
    });
  });
}

export async function getTagId(name: string) {
  const tag = await db.selectFrom("tags").select("id").where("name", "=", name).executeTakeFirst();
  if (!tag) throw tagNotFound();
  return tag.id;
}

// Tag IDs for names a thread is being given; every name must exist.
export async function findTags(names: string[]) {
  if (names.length === 0) return [];
  const rows = await db
    .selectFrom("tags")
    .select(["id", "name"])
    .where("name", "in", names)
    .execute();
  const missing = names.find((n) => !rows.some((r) => r.name === n));
  if (missing !== undefined) {
    throw new AppError(400, "invalid_request", `tags：没有「${missing}」这个标签`);
  }
  return rows.map((r) => r.id);
}

// Kept with the threads they count, in the same transaction: public, undeleted threads only.
export async function countThreads(
  trx: Transaction<DB>,
  {
    boardId,
    tagIds,
    threads,
    posts,
  }: {
    boardId: number;
    tagIds: number[];
    threads: number;
    posts: number;
  },
) {
  await trx
    .updateTable("boards")
    .set((eb) => ({
      thread_count: eb("thread_count", "+", threads),
      post_count: eb("post_count", "+", posts),
    }))
    .where("id", "=", boardId)
    .execute();
  if (threads !== 0 && tagIds.length > 0) {
    await trx
      .updateTable("tags")
      .set((eb) => ({ thread_count: eb("thread_count", "+", threads) }))
      .where("id", "in", tagIds)
      .execute();
  }
}
