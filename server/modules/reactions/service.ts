import { sql } from "kysely";
import type { Actor, Reader, Viewer } from "../../platform/access.ts";
import { db } from "../../platform/db.ts";
import { AppError } from "../../platform/errors.ts";
import { recordAudit } from "../audit/service.ts";
import { notifyOnPost } from "../notifications/service.ts";
import { countBoosts, countReaction, getPost } from "../threads/service.ts";
import { shownToGuests, userBriefs } from "../users/service.ts";

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
  const post = await getPost(postId, { members, id: viewer.id, staff: false });
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
    if (previous === null && emoji !== null) {
      await notifyOnPost(trx, "like", post, viewer.id, { emoji });
    }
  });
}

const PAGE = 50;

// Who reacted, newest first, optionally with one emoji only; the cursor is how many were shown.
export async function listReactions(
  members: boolean,
  postId: number,
  emoji: Reaction | undefined,
  offset: number,
) {
  await getPost(postId, { members, id: null, staff: false });
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

// ---- Boosts: a short note under a floor. See design §8.1.

export const BOOST_MAX = 16;
// Shown with each floor; the rest when asked for.
const BOOSTS_SHOWN = 6;

// What people see as characters, so an emoji is one.
const graphemes = new Intl.Segmenter("zh", { granularity: "grapheme" });

export function boostLength(body: string) {
  return [...graphemes.segment(body)].length;
}

// One per person per floor; leaving another replaces it where it stood.
export async function setBoost(viewer: Viewer, members: boolean, postId: number, body: string) {
  const post = await getPost(postId, { members, id: viewer.id, staff: false });
  if (post.deleted_at !== null) throw new AppError(404, "post_not_found", "回复不存在");
  const row = await db.transaction().execute(async (trx) => {
    const { replaced, ...saved } = await trx
      .insertInto("boosts")
      .values({ post_id: postId, user_id: viewer.id, body })
      .onConflict((oc) => oc.columns(["post_id", "user_id"]).doUpdateSet({ body }))
      .returning(["id", "post_id", "user_id", "body", "created_at"])
      .returning(sql<number | null>`old.id`.as("replaced"))
      .executeTakeFirstOrThrow();
    if (replaced === null) {
      await countBoosts(trx, postId, 1);
      await notifyOnPost(trx, "boost", post, viewer.id, { body });
    }
    return saved;
  });
  const [boost] = await withBoostUsers([row]);
  return boost;
}

function boostNotFound() {
  return new AppError(404, "boost_not_found", "短评不存在");
}

export async function deleteOwnBoost(viewer: Viewer, postId: number) {
  await db.transaction().execute(async (trx) => {
    const deleted = await trx
      .deleteFrom("boosts")
      .where("post_id", "=", postId)
      .where("user_id", "=", viewer.id)
      .returning("post_id")
      .executeTakeFirst();
    if (!deleted) throw boostNotFound();
    await countBoosts(trx, deleted.post_id, -1);
  });
}

// Moderators remove anyone's, with what it said and why in the audit log.
export async function removeBoost(actor: Actor, id: number, reason: string | undefined) {
  await db.transaction().execute(async (trx) => {
    const deleted = await trx
      .deleteFrom("boosts")
      .where("id", "=", id)
      .returning(["post_id", "user_id", "body"])
      .executeTakeFirst();
    if (!deleted) throw boostNotFound();
    await countBoosts(trx, deleted.post_id, -1);
    await recordAudit(trx, actor, {
      action: "boost.delete",
      target_type: "boost",
      target_id: id,
      data: { ...deleted, reason: reason ?? null },
    });
  });
}

// Guests don't get the boosts of people who keep their content from them.
function selectBoosts(members: boolean) {
  return db
    .selectFrom("boosts")
    .select(["id", "post_id", "user_id", "body", "created_at"])
    .$if(!members, (qb) => qb.where(shownToGuests("boosts.user_id")));
}

async function withBoostUsers(
  rows: { id: number; post_id: number; user_id: number; body: string; created_at: Date }[],
) {
  const user = await userBriefs(rows.map((r) => r.user_id));
  return rows.map(({ user_id, ...r }) => ({ ...r, user: user(user_id) }));
}

// Someone's own boosts, for the export of their data.
export async function exportOwnBoosts(userId: number) {
  return db
    .selectFrom("boosts")
    .innerJoin("posts", "posts.id", "boosts.post_id")
    .select(["posts.thread_id", "posts.floor", "boosts.body", "boosts.created_at"])
    .where("boosts.user_id", "=", userId)
    .orderBy("boosts.id")
    .execute();
}

export async function listBoosts(members: boolean, postId: number) {
  await getPost(postId, { members, id: null, staff: false });
  const rows = await selectBoosts(members)
    .where("post_id", "=", postId)
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  return withBoostUsers(rows);
}

// What each floor carries besides its own row: its first boosts, and the reader's reaction and
// boost.
export async function floorExtras(reader: Pick<Reader, "id" | "members">, postIds: number[]) {
  const userId = reader.id;
  if (postIds.length === 0) {
    return {
      boosts: new Map<number, Boost[]>(),
      myReaction: new Map<number, string>(),
      myBoost: new Map<number, string>(),
    };
  }
  const [shown, reactions, own] = await Promise.all([
    db
      .selectFrom(
        selectBoosts(reader.members)
          .select(
            sql<string>`row_number() OVER (PARTITION BY post_id ORDER BY created_at, id)`.as("n"),
          )
          .where("post_id", "in", postIds)
          .as("ranked"),
      )
      .select(["id", "post_id", "user_id", "body", "created_at"])
      .where("n", "<=", String(BOOSTS_SHOWN))
      .orderBy("created_at")
      .orderBy("id")
      .execute()
      .then(withBoostUsers),
    userId === null
      ? []
      : db
          .selectFrom("reactions")
          .select(["post_id", "emoji"])
          .where("user_id", "=", userId)
          .where("post_id", "in", postIds)
          .execute(),
    userId === null
      ? []
      : db
          .selectFrom("boosts")
          .select(["post_id", "body"])
          .where("user_id", "=", userId)
          .where("post_id", "in", postIds)
          .execute(),
  ]);
  const boosts = new Map<number, Boost[]>();
  for (const b of shown) boosts.set(b.post_id, [...(boosts.get(b.post_id) ?? []), b]);
  return {
    boosts,
    myReaction: new Map(reactions.map((r) => [r.post_id, r.emoji])),
    myBoost: new Map(own.map((b) => [b.post_id, b.body])),
  };
}

export type Boost = Awaited<ReturnType<typeof withBoostUsers>>[number];
