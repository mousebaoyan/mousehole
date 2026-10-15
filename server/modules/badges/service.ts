import { sql, type NotNull, type Transaction } from "kysely";
import { DatabaseError } from "pg";
import type { DB } from "../../../db/types.ts";
import { GUEST, type Actor } from "../../platform/access.ts";
import { db } from "../../platform/db.ts";
import { env } from "../../platform/env.ts";
import { AppError } from "../../platform/errors.ts";
import { recordAudit } from "../audit/service.ts";
import { readable } from "../boards/service.ts";
import { recordEvent } from "../events/service.ts";
import { notifyBadges } from "../notifications/service.ts";
import { clearTitleBadge, shownToGuests, userBriefs } from "../users/service.ts";
import { GROUPINGS, RULES, type Tier } from "./rules.ts";

// Badges, see design §8.8: the automatic ones from rules.ts, checked every few minutes, and
// event badges admins create and give by hand.

const BADGE = ["id", "name", "description", "tier", "grouping", "multiple"] as const;

function badgeNotFound() {
  return new AppError(404, "badge_not_found", "徽章不存在");
}

// On start: the badges in rules.ts, as they are now.
export async function syncBadges() {
  await db
    .insertInto("badges")
    .values(
      RULES.map((r, position) => ({
        slug: r.slug,
        name: r.name,
        description: r.description,
        tier: r.tier,
        grouping: r.grouping,
        multiple: r.multiple ?? false,
        position,
      })),
    )
    .onConflict((oc) =>
      oc.column("slug").doUpdateSet((eb) => ({
        name: eb.ref("excluded.name"),
        description: eb.ref("excluded.description"),
        tier: eb.ref("excluded.tier"),
        grouping: eb.ref("excluded.grouping"),
        multiple: eb.ref("excluded.multiple"),
        position: eb.ref("excluded.position"),
      })),
    )
    .execute();
}

type Granted = { user_id: number; post_id: number | null };
type Badge = { id: number; name: string; description: string; tier: string };

// Tells of new badges: a notification, and an event the plugin congratulates gold ones from.
async function announce(trx: Transaction<DB>, badge: Badge, granted: Granted[]) {
  await notifyBadges(trx, badge, granted);
  const people = await trx
    .selectFrom("users")
    .select(["id", "display_name", "qq"])
    .where(
      "id",
      "in",
      granted.map((g) => g.user_id),
    )
    .execute();
  const person = new Map(people.map((p) => [p.id, p]));
  const postIds = granted.flatMap((g) => (g.post_id === null ? [] : [g.post_id]));
  const posts =
    postIds.length === 0
      ? []
      : await trx
          .selectFrom("posts")
          .select(["id", "floor", "thread_id"])
          .where("id", "in", postIds)
          .execute();
  const post = new Map(posts.map((p) => [p.id, p]));
  for (const g of granted) {
    await recordEvent(trx, "badge.granted", {
      user: person.get(g.user_id) ?? null,
      badge: { id: badge.id, name: badge.name, description: badge.description, tier: badge.tier },
      post: g.post_id === null ? null : (post.get(g.post_id) ?? null),
      url: `${env.PUBLIC_URL}/badges/${badge.id}`,
    });
  }
}

const CHECKED = "badges";

// Every few minutes: whoever now qualifies for a badge gets it, and hears of it. The very first
// run gives the badges already earned by what was there before badges existed, quietly.
export async function checkBadges() {
  const quiet = !(await db
    .selectFrom("job_runs")
    .select("name")
    .where("name", "=", CHECKED)
    .executeTakeFirst());
  const synced = await db
    .selectFrom("badges")
    .select([...BADGE, "slug"])
    .where("slug", "is not", null)
    .$narrowType<{ slug: NotNull }>()
    .execute();
  const bySlug = new Map(synced.map((b) => [b.slug, b]));
  for (const rule of RULES) {
    const badge = bySlug.get(rule.slug);
    if (!badge) throw new Error(`Badge ${rule.slug} is not synced`);
    await db.transaction().execute(async (trx) => {
      const { rows } = await sql<Granted>`
        INSERT INTO user_badges (user_id, badge_id, post_id)
        SELECT q.user_id, ${badge.id}, q.post_id FROM (${rule.earned}) q
          JOIN users ON users.id = q.user_id
        WHERE users.role NOT IN ('bot', 'owner')
          AND NOT EXISTS (SELECT 1 FROM user_badges b WHERE b.user_id = q.user_id
            AND b.badge_id = ${badge.id} AND b.post_id IS NOT DISTINCT FROM q.post_id)
        ON CONFLICT DO NOTHING
        RETURNING user_id, post_id`.execute(trx);
      if (!quiet && rows.length > 0) await announce(trx, badge, rows);
    });
  }
  await db
    .insertInto("job_runs")
    .values({ name: CHECKED, ran_at: new Date() })
    .onConflict((oc) => oc.column("name").doUpdateSet({ ran_at: new Date() }))
    .execute();
}

// ---- Reading

function selectBadges(viewerId: number | null) {
  return db.selectFrom("badges").select([
    ...BADGE,
    sql<boolean>`slug IS NULL`.as("manual"),
    sql<number>`(SELECT count(DISTINCT user_id)::integer FROM user_badges
        WHERE badge_id = badges.id)`.as("granted_count"),
    sql<number>`(SELECT count(*)::integer FROM user_badges
        WHERE badge_id = badges.id AND user_id = ${viewerId})`.as("granted"),
  ]);
}

// Every badge by group, how many people have it, and how often the reader has.
export async function listBadges(viewerId: number | null) {
  return selectBadges(viewerId)
    .orderBy(sql`array_position(${[...GROUPINGS]}::text[], grouping)`)
    .orderBy("position")
    .orderBy("id")
    .execute();
}

const HOLDERS_PAGE = 50;

// One badge and who has it, latest first; `cursor` is how many were shown. Guests don't see
// those who keep their content from them.
export async function getBadge(id: number, viewerId: number | null, reach: number, cursor: number) {
  const badge = await selectBadges(viewerId).where("id", "=", id).executeTakeFirst();
  if (!badge) throw badgeNotFound();
  const rows = await db
    .selectFrom("user_badges")
    .select(["user_id", sql<Date>`max(granted_at)`.as("granted_at")])
    .where("badge_id", "=", id)
    .$if(reach === GUEST, (qb) => qb.where(shownToGuests("user_badges.user_id")))
    .groupBy("user_id")
    .orderBy(sql`max(granted_at)`, "desc")
    .orderBy("user_id", "desc")
    .offset(cursor)
    .limit(HOLDERS_PAGE)
    .execute();
  const user = await userBriefs(rows.map((r) => r.user_id));
  return {
    badge,
    items: rows.map((r) => ({ user: user(r.user_id), granted_at: r.granted_at })),
    next: rows.length === HOLDERS_PAGE ? cursor + HOLDERS_PAGE : null,
  };
}

// Floors a badge earned more than once lists, latest first.
const FLOORS_SHOWN = 10;

// Someone's badges, gold first, each once with how often and when last; for those earned per
// floor, the latest floors the reader can open. Nothing for guests when they keep their content
// from them.
export async function listUserBadges(userId: number, reach: number) {
  if (reach === GUEST) {
    const hidden = await db
      .selectFrom("users")
      .select("id")
      .where("id", "=", userId)
      .where("hide_from_guests", "=", true)
      .executeTakeFirst();
    if (hidden) return [];
  }
  const earned = await db
    .selectFrom("user_badges")
    .innerJoin("badges", "badges.id", "user_badges.badge_id")
    .select([
      "badges.id",
      "badges.name",
      "badges.description",
      "badges.tier",
      "badges.grouping",
      "badges.multiple",
      sql<number>`count(*)::integer`.as("count"),
      sql<Date>`max(user_badges.granted_at)`.as("granted_at"),
    ])
    .where("user_badges.user_id", "=", userId)
    .groupBy("badges.id")
    .orderBy(sql`array_position('{gold,silver,bronze}'::text[], badges.tier)`)
    .orderBy(sql`max(user_badges.granted_at)`, "desc")
    .execute();
  const floors = await db
    .selectFrom("user_badges")
    .innerJoin("posts", "posts.id", "user_badges.post_id")
    .innerJoin("threads", "threads.id", "posts.thread_id")
    .innerJoin("boards", "boards.id", "threads.board_id")
    .select([
      "user_badges.badge_id",
      "user_badges.granted_at",
      "posts.id as post_id",
      "posts.floor",
      "threads.id as thread_id",
      "threads.title",
      sql<number>`row_number() OVER (PARTITION BY user_badges.badge_id
        ORDER BY user_badges.granted_at DESC)`.as("n"),
    ])
    .where("user_badges.user_id", "=", userId)
    .where("threads.status", "=", "visible")
    .where("threads.deleted_at", "is", null)
    .where(readable(reach))
    .execute();
  return earned.map((b) => ({
    ...b,
    posts: b.multiple
      ? floors
          .filter((f) => f.badge_id === b.id && f.n <= FLOORS_SHOWN)
          .map((f) => ({
            thread_id: f.thread_id,
            title: f.title,
            post_id: f.post_id,
            floor: f.floor,
            granted_at: f.granted_at,
          }))
      : [],
  }));
}

// ---- Event badges, by admins

export async function createBadge(
  actor: Actor,
  fields: { name: string; description: string; tier: Tier },
) {
  return db.transaction().execute(async (trx) => {
    const badge = await trx
      .insertInto("badges")
      .values({ ...fields, grouping: "limited", position: RULES.length })
      .onConflict((oc) => oc.column("name").doNothing())
      .returning("id")
      .executeTakeFirst();
    if (!badge) throw badgeExists();
    await recordAudit(trx, actor, {
      action: "badge.create",
      target_type: "badge",
      target_id: badge.id,
      data: fields,
    });
    return badge;
  });
}

function badgeExists() {
  return new AppError(409, "badge_exists", "已有同名的徽章");
}

// Only event badges change; the automatic ones are what rules.ts says.
async function manualBadge(trx: Transaction<DB>, id: number) {
  const badge = await trx
    .selectFrom("badges")
    .select([...BADGE, "slug"])
    .where("id", "=", id)
    .forUpdate()
    .executeTakeFirst();
  if (!badge) throw badgeNotFound();
  if (badge.slug !== null) throw new AppError(403, "forbidden", "自动授予的徽章不能手动修改");
  return badge;
}

export async function updateBadge(
  actor: Actor,
  id: number,
  change: { name?: string; description?: string },
) {
  await db.transaction().execute(async (trx) => {
    await manualBadge(trx, id);
    await trx
      .updateTable("badges")
      .set(change)
      .where("id", "=", id)
      .execute()
      .catch((error: unknown) => {
        throw error instanceof DatabaseError && error.code === "23505" ? badgeExists() : error;
      });
    await recordAudit(trx, actor, {
      action: "badge.update",
      target_type: "badge",
      target_id: id,
      data: change,
    });
  });
}

export async function grantBadge(actor: Actor, id: number, userId: number, reason: string) {
  await db.transaction().execute(async (trx) => {
    const badge = await manualBadge(trx, id);
    const granted = await trx
      .insertInto("user_badges")
      .values({ user_id: userId, badge_id: id, granted_by: actor.userId, reason })
      .onConflict((oc) => oc.doNothing())
      .returning(["user_id", "post_id"])
      .executeTakeFirst();
    if (!granted) throw new AppError(409, "badge_granted", "TA 已经有这枚徽章了");
    await recordAudit(trx, actor, {
      action: "badge.grant",
      target_type: "user",
      target_id: userId,
      data: { badge: badge.name, reason },
    });
    await announce(trx, badge, [granted]);
  });
}

// Taking an event badge back also takes it off as their title.
export async function revokeBadge(actor: Actor, id: number, userId: number, reason: string | null) {
  await db.transaction().execute(async (trx) => {
    const badge = await manualBadge(trx, id);
    const revoked = await trx
      .deleteFrom("user_badges")
      .where("badge_id", "=", id)
      .where("user_id", "=", userId)
      .executeTakeFirst();
    if (revoked.numDeletedRows === 0n) {
      throw new AppError(404, "badge_not_granted", "TA 没有这枚徽章");
    }
    await clearTitleBadge(trx, userId, id);
    await recordAudit(trx, actor, {
      action: "badge.revoke",
      target_type: "user",
      target_id: userId,
      data: { badge: badge.name, reason },
    });
  });
}
