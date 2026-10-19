import { sql } from "kysely";
import { restrictionOf, type Actor } from "../../platform/access.ts";
import { db } from "../../platform/db.ts";
import { recordAudit } from "../audit/service.ts";
import { notifyLevel } from "../notifications/service.ts";
import { saveLevel } from "../users/service.ts";
import {
  earnedLevel,
  keepsL4,
  L4_GRACE_DAYS,
  RECENT_DAYS,
  requirements,
  type Recent,
  type Totals,
} from "./rules.ts";

// Levels go up as people are active and, for L4, down again; see design §6.6.

const DAY_MS = 86_400_000;
const SINCE = sql<Date>`now() - make_interval(days => ${RECENT_DAYS})`;
// The last RECENT_DAYS days in Beijing time, today included.
const FIRST_DAY = sql<Date>`(now() AT TIME ZONE 'Asia/Shanghai')::date - ${RECENT_DAYS - 1}::integer`;

// Other people's public threads someone replied in publicly, each counted once.
function threadsReplied(recent: boolean) {
  return sql<number>`(SELECT count(DISTINCT posts.thread_id)::integer FROM posts
    JOIN threads ON threads.id = posts.thread_id
    WHERE posts.author_id = users.id AND posts.floor > 1 AND posts.status = 'visible'
      AND posts.deleted_at IS NULL AND threads.author_id <> users.id
      AND threads.status = 'visible' AND threads.deleted_at IS NULL
      ${recent ? sql`AND posts.created_at > ${SINCE}` : sql``})`;
}

function selectStanding() {
  return db
    .selectFrom("users")
    .innerJoinLateral(
      (eb) =>
        eb
          .selectFrom("user_days")
          .select([
            sql<number>`count(*)::integer`.as("days"),
            sql<number>`coalesce(sum(posts_read), 0)::integer`.as("posts_read"),
            sql<number>`coalesce(sum(read_seconds), 0)::integer`.as("read_seconds"),
          ])
          .whereRef("user_days.user_id", "=", "users.id")
          .where("user_days.day", ">=", FIRST_DAY)
          .as("recent"),
      (join) => join.onTrue(),
    )
    .select([
      "users.id",
      "users.level",
      "users.level_locked",
      "users.restriction",
      "users.restricted_until",
      "users.restricted_through",
      "users.posts_read",
      "users.read_seconds",
      "users.days_visited",
      "users.like_received",
      sql<number>`(SELECT count(*)::integer FROM thread_users
        WHERE user_id = users.id AND last_read_at IS NOT NULL)`.as("threads_entered"),
      threadsReplied(false).as("threads_replied"),
      threadsReplied(true).as("recent_replied"),
      "recent.days as recent_days",
      "recent.posts_read as recent_posts_read",
      "recent.read_seconds as recent_read_seconds",
      sql<number>`(SELECT count(*)::integer FROM reactions
        JOIN posts ON posts.id = reactions.post_id
        WHERE posts.author_id = users.id AND posts.deleted_at IS NULL AND NOT posts.anonymous
          AND reactions.created_at > ${SINCE})`.as("recent_likes"),
    ]);
}

type Row = Awaited<ReturnType<ReturnType<typeof selectStanding>["execute"]>>[number];

// How many of the last RECENT_DAYS days were free of any mute or ban.
function cleanDays(row: Row) {
  if (restrictionOf(row.restriction, row.restricted_until)) return 0;
  if (row.restricted_through === null) return RECENT_DAYS;
  const days = Math.floor((Date.now() - row.restricted_through.getTime()) / DAY_MS);
  return Math.min(RECENT_DAYS, Math.max(0, days));
}

function standing(row: Row): { totals: Totals; recent: Recent } {
  return {
    totals: {
      threads_entered: row.threads_entered,
      posts_read: row.posts_read,
      threads_replied: row.threads_replied,
      likes: row.like_received,
      days_visited: row.days_visited,
      read_seconds: row.read_seconds,
    },
    recent: {
      days_visited: row.recent_days,
      threads_replied: row.recent_replied,
      posts_read: row.recent_posts_read,
      read_seconds: row.recent_read_seconds,
      likes: row.recent_likes,
      clean_days: cleanDays(row),
    },
  };
}

// Whose levels change by themselves: members, not bots or the owner, and not fixed by an admin.
// Frozen accounts keep theirs for when they come back.
function automatic() {
  return selectStanding()
    .where("users.level_locked", "=", false)
    .where("users.member_status", "=", "member")
    .where("users.role", "not in", ["bot", "owner"]);
}

// Hourly: whoever was active today or yesterday and has earned more goes up, several levels at
// once if need be, and is told.
export async function promoteActive() {
  const active = db
    .selectFrom("user_days")
    .select("user_id")
    .where("day", ">=", sql<Date>`(now() AT TIME ZONE 'Asia/Shanghai')::date - 1`);
  const rows = await automatic()
    .where("users.id", "in", active)
    .where("users.level", "<", 4)
    .execute();
  for (const row of rows) {
    const { totals, recent } = standing(row);
    const level = earnedLevel(totals, recent);
    if (level <= row.level) continue;
    const next = level < 4 ? level + 1 : null;
    await db.transaction().execute(async (trx) => {
      await saveLevel(trx, row.id, { level });
      await notifyLevel(trx, row.id, level, {
        earned: requirements(level, totals, recent),
        next: next === null ? null : { level: next, items: requirements(next, totals, recent) },
      });
    });
  }
}

// Daily: an L4 whose last RECENT_DAYS days no longer earn it goes back to L3, untold; not in its
// first two weeks.
export async function recheckL4() {
  const rows = await automatic()
    .where("users.level", "=", 4)
    .where("users.level_since", "<", sql<Date>`now() - make_interval(days => ${L4_GRACE_DAYS})`)
    .execute();
  for (const row of rows) {
    if (keepsL4(standing(row).recent)) continue;
    await db.transaction().execute((trx) => saveLevel(trx, row.id, { level: 3 }));
  }
}

// What someone needs for the level above, or to keep L4. Nothing for L5, which admins give, nor
// for a level they fixed.
export async function levelProgress(userId: number) {
  const row = await selectStanding().where("users.id", "=", userId).executeTakeFirstOrThrow();
  const { totals, recent } = standing(row);
  const target = row.level_locked || row.level === 5 ? null : Math.min(row.level + 1, 4);
  return {
    level: row.level,
    locked: row.level_locked,
    next: target === null ? null : { level: target, items: requirements(target, totals, recent) },
  };
}

// By an admin: any level, L5 included, and whether automatic changes leave it alone.
export async function setLevel(
  actor: Actor,
  userId: number,
  change: { level: number; locked: boolean },
) {
  await db.transaction().execute(async (trx) => {
    const from = await saveLevel(trx, userId, change);
    await recordAudit(trx, actor, {
      action: "user.level",
      target_type: "user",
      target_id: userId,
      data: { from, to: change.level, locked: change.locked },
    });
    if (change.level > from) await notifyLevel(trx, userId, change.level, null);
  });
}
