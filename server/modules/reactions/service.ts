import { sql } from "kysely";
import type { Viewer } from "../../platform/access.ts";
import { db } from "../../platform/db.ts";
import { AppError } from "../../platform/errors.ts";
import { countReaction, getPost } from "../threads/service.ts";
import { userBriefs } from "../users/service.ts";

// The heart is the like; every reaction counts as one. See design §8.1.
export const REACTIONS = [
  "heart",
  "+1",
  "laughing",
  "open_mouth",
  "clap",
  "tada",
  "hugs",
  "thinking",
  "sob",
  "mouse",
] as const;

export type Reaction = (typeof REACTIONS)[number];

// One reaction per person per post: another emoji replaces it, none takes it back.
export async function react(
  viewer: Viewer,
  members: boolean,
  postId: number,
  emoji: Reaction | null,
) {
  const post = await getPost(postId, members);
  if (post.deleted_at !== null) throw new AppError(404, "post_not_found", "回复不存在");
  if (post.author_id === viewer.id) throw new AppError(403, "forbidden", "不能给自己点赞");

  await db.transaction().execute(async (trx) => {
    const before = await trx
      .selectFrom("reactions")
      .select("emoji")
      .where("post_id", "=", postId)
      .where("user_id", "=", viewer.id)
      .forUpdate()
      .executeTakeFirst();
    const previous = before?.emoji ?? null;
    if (previous === emoji) return;
    if (emoji === null) {
      await trx
        .deleteFrom("reactions")
        .where("post_id", "=", postId)
        .where("user_id", "=", viewer.id)
        .execute();
    } else {
      await trx
        .insertInto("reactions")
        .values({ post_id: postId, user_id: viewer.id, emoji })
        .onConflict((oc) =>
          oc.columns(["post_id", "user_id"]).doUpdateSet({ emoji, created_at: sql<Date>`now()` }),
        )
        .execute();
    }
    await countReaction(trx, postId, { from: previous, to: emoji });
  });
}

// The reader's own reaction to each of these posts.
export async function myReactions(userId: number | null, postIds: number[]) {
  if (userId === null || postIds.length === 0) return new Map<number, string>();
  const rows = await db
    .selectFrom("reactions")
    .select(["post_id", "emoji"])
    .where("user_id", "=", userId)
    .where("post_id", "in", postIds)
    .execute();
  return new Map(rows.map((r) => [r.post_id, r.emoji]));
}

const PAGE = 50;

// Who reacted, newest first, optionally with one emoji only; the cursor is how many were shown.
export async function listReactions(
  members: boolean,
  postId: number,
  emoji: Reaction | undefined,
  offset: number,
) {
  await getPost(postId, members);
  let query = db
    .selectFrom("reactions")
    .select(["user_id", "emoji", "created_at"])
    .where("post_id", "=", postId)
    .orderBy("created_at", "desc")
    .orderBy("user_id")
    .offset(offset)
    .limit(PAGE);
  if (emoji !== undefined) query = query.where("emoji", "=", emoji);
  const rows = await query.execute();
  const user = await userBriefs(rows.map((r) => r.user_id));
  return {
    items: rows.map(({ user_id, ...r }) => ({ ...r, user: user(user_id) })),
    next: rows.length === PAGE ? offset + PAGE : null,
  };
}
