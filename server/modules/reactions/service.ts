import { sql } from "kysely";
import { GUEST, type Actor, type Reader, type Viewer } from "../../platform/access.ts";
import { db } from "../../platform/db.ts";
import { AppError } from "../../platform/errors.ts";
import { recordAudit } from "../audit/service.ts";
import { notifyOnPost } from "../notifications/service.ts";
import { postedAt, type Source } from "../qq/service.ts";
import {
  aliasIn,
  countBoosts,
  countReaction,
  getPost,
  writesAnonymously,
} from "../threads/service.ts";
import { shownToGuests, userBriefs, writer } from "../users/service.ts";

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

// A reaction or boost a bot brings over from a group: dated when it was said there, and nobody
// is told, as with the floors archived (design §6.5).
export type Archived = { source: Source; created_at?: number };

// One reaction per person per post: another emoji replaces it, none takes it back.
export async function react(
  actor: Actor,
  viewer: Viewer,
  reach: number,
  postId: number,
  emoji: Reaction | null,
  archived?: Archived,
) {
  const at = postedAt(actor, archived?.created_at);
  const post = await getPost(postId, { reach, id: viewer.id, staff: false });
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
        .values({ post_id: postId, user_id: viewer.id, emoji, created_at: at })
        .onConflict((oc) =>
          oc.columns(["post_id", "user_id"]).doUpdateSet({ emoji, created_at: at }),
        )
        .execute();
    }
    await countReaction(trx, postId, { from: previous, to: emoji });
    if (previous === null && emoji !== null && !archived) {
      await notifyOnPost(trx, "like", post, viewer.id, null, { emoji });
    }
  });
}

const PAGE = 50;

// Who reacted, newest first, optionally with one emoji only; the cursor is how many were shown.
export async function listReactions(
  reach: number,
  postId: number,
  emoji: Reaction | undefined,
  offset: number,
) {
  await getPost(postId, { reach, id: null, staff: false });
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
export async function setBoost(
  actor: Actor,
  viewer: Viewer,
  reach: number,
  postId: number,
  body: string,
  archived?: Archived,
) {
  const at = postedAt(actor, archived?.created_at);
  const post = await getPost(postId, { reach, id: viewer.id, staff: false });
  if (post.deleted_at !== null) throw new AppError(404, "post_not_found", "回复不存在");
  // As the person writes in this thread: anonymous or not (design §8.12).
  const thread = await db
    .selectFrom("threads")
    .select(["author_id", "author_anonymous", "anonymous_replies"])
    .where("id", "=", post.thread_id)
    .executeTakeFirstOrThrow();
  const anonymous = writesAnonymously(thread, viewer.id);
  const row = await db.transaction().execute(async (trx) => {
    const { replaced, ...saved } = await trx
      .insertInto("boosts")
      .values({ post_id: postId, user_id: viewer.id, body, anonymous, created_at: at })
      .onConflict((oc) => oc.columns(["post_id", "user_id"]).doUpdateSet({ body }))
      .returning(["id", "post_id", "user_id", "body", "created_at"])
      .returning(sql<number | null>`old.id`.as("replaced"))
      .executeTakeFirstOrThrow();
    const alias = anonymous ? await aliasIn(trx, post.thread_id, viewer.id) : null;
    if (replaced === null) {
      await countBoosts(trx, postId, 1);
      if (!archived) await notifyOnPost(trx, "boost", post, viewer.id, alias, { body });
    }
    await recordAudit(trx, actor, {
      action: "boost.set",
      target_type: "post",
      target_id: postId,
      data: { body },
    });
    return { ...saved, alias };
  });
  const [boost] = await withBoostUsers([row]);
  return boost;
}

function boostNotFound() {
  return new AppError(404, "boost_not_found", "短评不存在");
}

export async function deleteOwnBoost(actor: Actor, viewer: Viewer, postId: number) {
  await db.transaction().execute(async (trx) => {
    const deleted = await trx
      .deleteFrom("boosts")
      .where("post_id", "=", postId)
      .where("user_id", "=", viewer.id)
      .returning("post_id")
      .executeTakeFirst();
    if (!deleted) throw boostNotFound();
    await countBoosts(trx, deleted.post_id, -1);
    await recordAudit(trx, actor, {
      action: "boost.unset",
      target_type: "post",
      target_id: postId,
    });
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
// With the writer's number in the thread for anonymous ones.
function selectBoosts(reach: number) {
  return db
    .selectFrom("boosts")
    .innerJoin("posts", "posts.id", "boosts.post_id")
    .leftJoin("thread_aliases as alias", (join) =>
      join
        .onRef("alias.thread_id", "=", "posts.thread_id")
        .onRef("alias.user_id", "=", "boosts.user_id")
        .on("boosts.anonymous", "=", true),
    )
    .select([
      "boosts.id",
      "boosts.post_id",
      "boosts.user_id",
      "boosts.body",
      "boosts.created_at",
      "alias.number as alias",
    ])
    .$if(reach === GUEST, (qb) => qb.where(shownToGuests("boosts.user_id")));
}

async function withBoostUsers(
  rows: {
    id: number;
    post_id: number;
    user_id: number;
    body: string;
    created_at: Date;
    alias: number | null;
  }[],
) {
  const user = await userBriefs(rows.map((r) => r.user_id));
  return rows.map(({ user_id, alias, ...r }) => ({ ...r, user: writer(user, user_id, alias) }));
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

export async function listBoosts(reach: number, postId: number) {
  await getPost(postId, { reach, id: null, staff: false });
  const rows = await selectBoosts(reach)
    .where("boosts.post_id", "=", postId)
    .orderBy("boosts.created_at")
    .orderBy("boosts.id")
    .execute();
  return withBoostUsers(rows);
}

// What each floor carries besides its own row: its first boosts, and the reader's reaction and
// boost.
export async function floorExtras(reader: Pick<Reader, "id" | "reach">, postIds: number[]) {
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
        selectBoosts(reader.reach)
          .select(
            sql<string>`row_number() OVER (
              PARTITION BY boosts.post_id ORDER BY boosts.created_at, boosts.id)`.as("n"),
          )
          .where("boosts.post_id", "in", postIds)
          .as("ranked"),
      )
      .select(["id", "post_id", "user_id", "body", "created_at", "alias"])
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
