import { mkdir, readFile, rename, stat, utimes, writeFile } from "node:fs/promises";
import {
  sql,
  type ExpressionBuilder,
  type Kysely,
  type NotNull,
  type RawBuilder,
  type Transaction,
} from "kysely";
import type { DB } from "../../../db/types.ts";
import type { Actor, UserRef, Viewer } from "../../platform/access.ts";
import { readCapped } from "../../platform/body.ts";
import { db } from "../../platform/db.ts";
import { AppError } from "../../platform/errors.ts";
import { processAvatar } from "../../platform/images.ts";
import { renderMarkdown } from "../../platform/markdown.ts";
import { log } from "../../platform/log.ts";
import { recordAudit } from "../audit/service.ts";
import { recordEvent } from "../events/service.ts";
import { removeBackground } from "./backgrounds.ts";
import {
  BACKGROUND_PRESETS,
  FRAME_LOOKS,
  FRAMES,
  reaches,
  unlockedFrames,
  type BackgroundPreset,
  type Clearable,
  type Frame,
  type Theme,
} from "./customization.ts";

// For the bootstrap command: the owner sets the site up before any group is synced (design
// §10). There is one, with no QQ number.
export async function ensureOwner() {
  return db.transaction().execute(async (trx) => {
    const owner = await trx
      .selectFrom("users")
      .select("id")
      .where("role", "=", "owner")
      .executeTakeFirst();
    if (owner) return owner.id;
    const { id } = await trx
      .insertInto("users")
      .values({ qq: null, display_name: "站长", role: "owner", role_locked: true })
      .returning("id")
      .executeTakeFirstOrThrow();
    await recordAudit(trx, null, { action: "user.bootstrap", target_type: "user", target_id: id });
    return id;
  });
}

// For the bootstrap command on a local copy: an admin with a QQ number, who can post too.
export async function ensureAdmin(qq: number) {
  return db.transaction().execute(async (trx) => {
    const { id } = await trx
      .insertInto("users")
      .values({ qq, display_name: String(qq), role: "admin", role_locked: true })
      .onConflict((oc) => oc.column("qq").doUpdateSet({ role: "admin", role_locked: true }))
      .returning("id")
      .executeTakeFirstOrThrow();
    await recordAudit(trx, null, { action: "user.bootstrap", target_type: "user", target_id: id });
    return id;
  });
}

// A token's bot account, keyed by the bot's QQ number so it matches what the group shows.
// Created here when the group has not been synced yet. Bots never log in, so refusing activated
// accounts keeps a mistyped number from turning a member into a bot.
export async function ensureBotUser(trx: Transaction<DB>, qq: number, name: string) {
  const row = await trx
    .insertInto("users")
    .values({ qq, display_name: name, role: "bot", role_locked: true })
    .onConflict((oc) =>
      oc
        .column("qq")
        .doUpdateSet({ role: "bot", role_locked: true })
        .where("users.activated_at", "is", null),
    )
    .returning("id")
    .executeTakeFirst();
  if (!row) throw new AppError(409, "bot_qq_taken", "该 QQ 号属于已登录过的成员，不能用作 bot");
  return row.id;
}

// Accounts for the QQ numbers a member sync mentions: creates the missing ones and keeps QQ
// nicknames current. Returns the IDs, and who got a new nickname (their display name may change).
export async function ensureMembers(
  trx: Transaction<DB>,
  people: { qq: number; nickname: string | undefined }[],
) {
  await trx
    .insertInto("users")
    .values(
      people.map((p) => ({
        qq: p.qq,
        display_name: p.nickname || String(p.qq),
        qq_nickname: p.nickname ?? "",
      })),
    )
    .onConflict((oc) => oc.column("qq").doNothing())
    .execute();

  const named = people.filter((p) => p.nickname !== undefined);
  const renamed = named.length
    ? await sql<{ id: number }>`
        UPDATE users SET qq_nickname = v.nickname
        FROM (VALUES ${sql.join(named.map((p) => sql`(${p.qq}::bigint, ${p.nickname})`))})
          AS v (qq, nickname)
        WHERE users.qq = v.qq AND users.qq_nickname <> v.nickname
        RETURNING users.id`.execute(trx)
    : { rows: [] };

  const rows = await trx
    .selectFrom("users")
    .select(["id", "qq"])
    .where(
      "qq",
      "in",
      people.map((p) => p.qq),
    )
    .execute();
  return {
    ids: new Map(rows.map((r) => [r.qq, r.id])),
    renamed: renamed.rows.map((r) => r.id),
  };
}

export type Standing = {
  id: number;
  member_status: string;
  role: string;
  display_name: string;
};

// Writes what member sync derived, only where it changed, and logs freezes, restores and role
// changes.
export async function applyStanding(trx: Transaction<DB>, actor: Actor | null, rows: Standing[]) {
  if (rows.length === 0) return;
  const changed = await sql<{
    id: number;
    old_status: string;
    new_status: string;
    old_role: string;
    new_role: string;
  }>`
    UPDATE users SET member_status = v.member_status, role = v.role, display_name = v.display_name
    FROM (VALUES ${sql.join(
      rows.map((r) => sql`(${r.id}::integer, ${r.member_status}, ${r.role}, ${r.display_name})`),
    )}) AS v (id, member_status, role, display_name)
    WHERE users.id = v.id
      AND (users.member_status, users.role, users.display_name)
        IS DISTINCT FROM (v.member_status, v.role, v.display_name)
    RETURNING users.id, old.member_status AS old_status, new.member_status AS new_status,
      old.role AS old_role, new.role AS new_role`.execute(trx);

  for (const row of changed.rows) {
    const target = { target_type: "user", target_id: row.id };
    if (row.old_status !== row.new_status) {
      const action = row.new_status === "frozen" ? "member.freeze" : "member.restore";
      await recordAudit(trx, actor, { action, ...target });
    }
    if (row.old_role !== row.new_role) {
      await recordAudit(trx, actor, {
        action: "member.role",
        ...target,
        data: { from: row.old_role, to: row.new_role },
      });
    }
  }
}

// Someone a bot acts for or an admin manages: anyone but the owner, who is in no group.
export async function findMember(ref: UserRef) {
  return db
    .selectFrom("users")
    .select([
      "id",
      "role",
      "level",
      "member_status",
      "allow_proxy",
      "restriction",
      "restricted_until",
    ])
    .where((eb) => ("id" in ref ? eb("id", "=", ref.id) : eb("qq", "=", ref.qq)))
    .where("role", "<>", "owner")
    .executeTakeFirst();
}

// A day someone was active, in Beijing time: they visited, read, or had content synced from the
// groups, on the day it was said there. Returns 1 for the first of a day, which counts as a day
// visited, else 0. What they read adds to the day's reading, which L4 looks at (design §6.6).
async function recordDay(
  trx: Transaction<DB>,
  userId: number,
  read: { posts: number; seconds: number } = { posts: 0, seconds: 0 },
  at = sql<Date>`now()`,
) {
  const day = sql<Date>`(${at} AT TIME ZONE 'Asia/Shanghai')::date`;
  const first = await trx
    .insertInto("user_days")
    .values({ user_id: userId, day, posts_read: read.posts, read_seconds: read.seconds })
    .onConflict((oc) => oc.doNothing())
    .returning("user_id")
    .executeTakeFirst();
  if (first) {
    // Days in a row up to the latest, for the badges, kept in users: user_days keeps only 35 days.
    // An archived day may come before the latest and join the days in a row; they are counted
    // anew then, as far back as user_days goes.
    const latest = sql<Date>`(SELECT max(day) FROM user_days
      WHERE user_id = ${userId} AND day <> ${day})`;
    const inARow = sql<number>`(SELECT count(*)::integer FROM (
        SELECT first_value(day) OVER w - day AS back, row_number() OVER w - 1 AS n
        FROM user_days WHERE user_id = ${userId} WINDOW w AS (ORDER BY day DESC)
      ) d WHERE back = n)`;
    await trx
      .updateTable("users")
      .set({
        visit_streak: sql<number>`CASE
          WHEN ${latest} IS NULL OR ${latest} < ${day} - 1 THEN 1
          WHEN ${latest} = ${day} - 1 THEN visit_streak + 1
          ELSE greatest(visit_streak, ${inARow}) END`,
      })
      .where("id", "=", userId)
      .execute();
    return 1;
  }
  if (read.posts > 0 || read.seconds > 0) {
    await trx
      .updateTable("user_days")
      .set((eb) => ({
        posts_read: eb("posts_read", "+", read.posts),
        read_seconds: eb("read_seconds", "+", read.seconds),
      }))
      .where("user_id", "=", userId)
      .where("day", "=", day)
      .execute();
  }
  return 0;
}

// Seen on the site now.
function seen(days: number) {
  return (eb: ExpressionBuilder<DB, "users">) => ({
    last_seen_at: sql<Date>`now()`,
    days_visited: eb("days_visited", "+", days),
  });
}

// The first login activates the account, which the bot plugin hears of.
export async function recordLogin(trx: Transaction<DB>, userId: number) {
  const days = await recordDay(trx, userId);
  const user = await trx
    .updateTable("users")
    .set((eb) => ({
      activated_at: eb.fn.coalesce("activated_at", eb.val(new Date())),
      ...seen(days)(eb),
    }))
    .where("id", "=", userId)
    .returning(["id", "display_name", "qq", sql<Date | null>`old.activated_at`.as("was")])
    .executeTakeFirstOrThrow();
  if (user.was === null) {
    await recordEvent(trx, "member.activated", {
      user: { id: user.id, display_name: user.display_name, qq: user.qq },
    });
  }
}

export async function recordSeen(userId: number) {
  await db.transaction().execute(async (trx) => {
    const days = await recordDay(trx, userId);
    await trx.updateTable("users").set(seen(days)).where("id", "=", userId).execute();
  });
}

// Reading reports count as being seen too.
export async function countReading(
  trx: Transaction<DB>,
  userId: number,
  read: { posts: number; seconds: number },
) {
  const days = await recordDay(trx, userId, read);
  await trx
    .updateTable("users")
    .set((eb) => ({
      posts_read: eb("posts_read", "+", read.posts),
      read_seconds: eb("read_seconds", "+", read.seconds),
      ...seen(days)(eb),
    }))
    .where("id", "=", userId)
    .execute();
}

// Levels look back 30 days and the weekly mail one week; a few more are kept so a day is never
// cut short.
export async function clearOldDays() {
  const before = sql<Date>`(now() AT TIME ZONE 'Asia/Shanghai')::date - 35`;
  await db.deleteFrom("user_days").where("day", "<", before).execute();
  await db.deleteFrom("user_reads").where("day", "<", before).execute();
}

// ---- Impact (design §8.15)

// Floors someone just read for the first time count as read for their authors: public ones, not
// anonymous, not the reader's own. `floors` is an int4multirange.
export async function countReadsReceived(
  trx: Transaction<DB>,
  readerId: number,
  threadId: number,
  floors: string,
) {
  const authors = await trx
    .selectFrom("posts")
    .select(["author_id", sql<number>`count(*)::integer`.as("reads")])
    .where("thread_id", "=", threadId)
    .where(sql<boolean>`${floors}::int4multirange @> floor`)
    .where("status", "=", "visible")
    .where("deleted_at", "is", null)
    .where("anonymous", "=", false)
    .where("author_id", "<>", readerId)
    .groupBy("author_id")
    .execute();
  if (authors.length === 0) return;
  await trx
    .insertInto("user_reads")
    .values(
      authors.map((a) => ({
        user_id: a.author_id,
        day: sql<Date>`(now() AT TIME ZONE 'Asia/Shanghai')::date`,
        reads: a.reads,
      })),
    )
    .onConflict((oc) =>
      oc.columns(["user_id", "day"]).doUpdateSet({
        reads: sql<number>`user_reads.reads + excluded.reads`,
      }),
    )
    .execute();
  for (const a of authors) {
    await trx
      .updateTable("users")
      .set((eb) => ({ reads_received: eb("reads_received", "+", a.reads) }))
      .where("id", "=", a.author_id)
      .execute();
  }
}

// Hourly: how many people have read the floors of those read today, each reader once.
export async function recountPeopleReached() {
  await sql`
    UPDATE users SET people_reached = reached.people
    FROM (
      SELECT posts.author_id, count(DISTINCT thread_users.user_id)::integer AS people
      FROM posts
      JOIN thread_users ON thread_users.thread_id = posts.thread_id
        AND thread_users.read_floors @> posts.floor AND thread_users.user_id <> posts.author_id
      WHERE posts.author_id IN (SELECT user_id FROM user_reads
          WHERE day = (now() AT TIME ZONE 'Asia/Shanghai')::date)
        AND posts.status = 'visible' AND posts.deleted_at IS NULL AND NOT posts.anonymous
      GROUP BY posts.author_id
    ) reached
    WHERE users.id = reached.author_id AND users.people_reached <> reached.people`.execute(db);
}

// Posting, reacting or leaving a boost is being active the day it is done, also when it comes from
// the groups or a bot.
export async function countActive(trx: Transaction<DB>, userId: number, at: RawBuilder<Date>) {
  if ((await recordDay(trx, userId, undefined, at)) === 0) return;
  await trx
    .updateTable("users")
    .set((eb) => ({ days_visited: eb("days_visited", "+", 1) }))
    .where("id", "=", userId)
    .execute();
}

function userNotFound() {
  return new AppError(404, "user_not_found", "用户不存在");
}

export async function findUserId(ref: UserRef) {
  const row = await db
    .selectFrom("users")
    .select("id")
    .where((eb) => ("id" in ref ? eb("id", "=", ref.id) : eb("qq", "=", ref.qq)))
    .executeTakeFirst();
  if (!row) throw userNotFound();
  return row.id;
}

// Whether someone's likes and relations show to this member (design §9): to themselves always,
// to others unless they turned that off.
export async function relationsShown(viewerId: number, userId: number) {
  if (viewerId === userId) return true;
  const { relations_public } = await db
    .selectFrom("users")
    .select("relations_public")
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();
  return relations_public;
}

export async function assertRelationsShown(viewerId: number, userId: number) {
  if (!(await relationsShown(viewerId, userId))) {
    throw new AppError(403, "relations_hidden", "TA 没有公开自己的赞和关系");
  }
}

export const RELATION_LISTS = ["following", "followers", "endorsing", "endorsers"] as const;
export type RelationList = (typeof RELATION_LISTS)[number];

// Each list as the table it comes from, whose rows are about the person, and who is listed.
const RELATIONS = {
  following: { table: "user_follows", of: "follower_id", who: "followee_id" },
  followers: { table: "user_follows", of: "followee_id", who: "follower_id" },
  endorsing: { table: "endorsements", of: "endorser_id", who: "user_id" },
  endorsers: { table: "endorsements", of: "user_id", who: "endorser_id" },
} as const;

const PEOPLE_PAGE = 50;

// Whom someone follows or endorses, or who follows or endorses them, newest first; the cursor is
// how many were shown. People who keep their relations to themselves are left out (design §9).
export async function listPeople(userId: number, list: RelationList, offset: number) {
  const { table, of, who } = RELATIONS[list];
  const { rows } = await sql<{ id: number; created_at: Date }>`
    SELECT r.${sql.ref(who)} AS id, r.created_at FROM ${sql.table(table)} r
    JOIN users ON users.id = r.${sql.ref(who)}
    WHERE r.${sql.ref(of)} = ${userId} AND users.relations_public
    ORDER BY r.created_at DESC, id
    OFFSET ${offset} LIMIT ${PEOPLE_PAGE}`.execute(db);
  const user = await userBriefs(rows.map((r) => r.id));
  return {
    items: rows.map((r) => ({ user: user(r.id), created_at: r.created_at })),
    next: rows.length === PEOPLE_PAGE ? offset + PEOPLE_PAGE : null,
  };
}

// Badges on the profile card when they haven't picked theirs: the best first (design §8.8).
const CARD_BADGES = 3;

// Their status until it runs out (design §8.16).
const USER_STATUS = sql<{ emoji: string; text: string } | null>`CASE
  WHEN users.status_text IS NOT NULL AND (users.status_until IS NULL OR users.status_until > now())
  THEN json_build_object('emoji', users.status_emoji, 'text', users.status_text) END`;

// What the profile card and the user's page show; see design §6.1 and §9. `viewerId` is for
// whether the reader follows and has endorsed them.
export async function getUser(ref: UserRef, viewerId: number | null) {
  const row = await withHomeGroup()
    .select((eb) => [
      "users.id",
      "users.display_name",
      "users.avatar_version",
      "users.role",
      "users.level",
      eb.fn.coalesce("title_badge.name", "home.title", eb.val("")).as("title"),
      "title_badge.tier as title_tier",
      "home.card",
      "home.joined_at",
      "home.last_sent_at",
      eb.fn.coalesce("users.custom_bio", "users.qq_bio").as("bio"),
      USER_STATUS.as("user_status"),
      "users.frame",
      "users.theme",
      "users.background",
      "users.background_version",
      "users.hide_from_guests",
      "users.relations_public",
      "users.qq",
      "users.member_status",
      "users.activated_at",
      "users.restriction",
      "users.restricted_until",
      "users.thread_count",
      "users.post_count",
      "users.like_received",
      "users.days_visited",
      "users.read_seconds",
      "users.posts_read",
      "users.reads_received",
      "users.people_reached",
      sql<number>`(SELECT coalesce(sum(reads), 0)::integer FROM user_reads
        WHERE user_reads.user_id = users.id
          AND day > (now() AT TIME ZONE 'Asia/Shanghai')::date - 7)`.as("reads_week"),
      sql<number>`(SELECT count(*)::integer FROM thread_users
        WHERE thread_users.user_id = users.id AND last_read_at IS NOT NULL)`.as("threads_read"),
      sql<number>`(SELECT count(*)::integer FROM user_follows
        WHERE followee_id = users.id)`.as("followers"),
      sql<number>`(SELECT count(*)::integer FROM user_follows
        WHERE follower_id = users.id)`.as("following"),
      sql<number>`(SELECT count(*)::integer FROM endorsements
        WHERE endorsements.user_id = users.id)`.as("endorsements"),
      sql<boolean>`EXISTS (SELECT 1 FROM user_follows
        WHERE followee_id = users.id AND follower_id = ${viewerId})`.as("followed"),
      sql<boolean>`EXISTS (SELECT 1 FROM endorsements
        WHERE endorsements.user_id = users.id AND endorser_id = ${viewerId})`.as("endorsed"),
      sql<{ id: number; name: string; tier: string }[]>`CASE
        WHEN users.shown_badge_ids IS NULL THEN (SELECT coalesce(json_agg(b), '[]')
          FROM (SELECT badges.id, badges.name, badges.tier FROM user_badges
            JOIN badges ON badges.id = user_badges.badge_id
            WHERE user_badges.user_id = users.id
            GROUP BY badges.id
            ORDER BY array_position('{gold,silver,bronze}'::text[], badges.tier),
              max(user_badges.granted_at) DESC
            LIMIT ${CARD_BADGES}) b)
        ELSE (SELECT coalesce(json_agg(b ORDER BY array_position(users.shown_badge_ids, b.id)), '[]')
          FROM (SELECT id, name, tier FROM badges WHERE id = ANY(users.shown_badge_ids)) b)
        END`.as("badges"),
    ])
    .where((eb) => ("id" in ref ? eb("users.id", "=", ref.id) : eb("users.qq", "=", ref.qq)))
    .executeTakeFirst();
  if (!row) throw userNotFound();
  const { avatar_version, frame, ...user } = row;
  return { ...user, frame: frameOf(frame), avatar_url: avatarUrl(user.id, avatar_version) };
}

// The frame as pages draw it.
function frameOf(key: string | null) {
  return FRAMES.find((frame) => frame === key) ?? null;
}

// What someone's badges open of the frames.
async function badgeUnlocks(executor: Kysely<DB>, userId: number) {
  return executor
    .selectFrom("user_badges")
    .innerJoin("badges", "badges.id", "user_badges.badge_id")
    .select(["badges.slug", "badges.tier", "badges.frame"])
    .distinct()
    .where("user_badges.user_id", "=", userId)
    .execute();
}

// For what guests get: leaves out what people who keep their content from guests wrote, given the
// column holding the writer's user ID (design §8.10).
export function shownToGuests(
  column: "threads.author_id" | "posts.author_id" | "boosts.user_id" | "user_badges.user_id",
) {
  return sql<boolean>`NOT EXISTS (SELECT 1 FROM users
    WHERE users.id = ${sql.ref(column)} AND users.hide_from_guests)`;
}

// ---- One's own settings: see design §6.1 and §9.

export const MAX_BIO = 60;

export async function getSettings(userId: number) {
  const settings = await db
    .selectFrom("users")
    .select([
      "custom_name",
      "custom_bio",
      "qq_bio",
      "avatar_custom",
      "allow_proxy",
      "hide_from_guests",
      "relations_public",
      "title_badge_id",
      "shown_badge_ids",
      "frame",
      "theme",
      "background",
      "background_version",
      "level",
      "role",
      sql<{ emoji: string; text: string; until: number | null } | null>`CASE
        WHEN status_text IS NOT NULL AND (status_until IS NULL OR status_until > now())
        THEN json_build_object('emoji', status_emoji, 'text', status_text,
          'until', extract(epoch FROM status_until)::integer) END`.as("user_status"),
      // The ones still shown: deleted and hidden threads drop out when the list is next saved.
      sql<{ id: number; title: string }[]>`(SELECT coalesce(json_agg(json_build_object(
          'id', t.id, 'title', t.title) ORDER BY array_position(users.pins, t.id)), '[]')
        FROM threads t
        WHERE t.id = ANY(users.pins) AND t.deleted_at IS NULL AND t.status = 'visible')`.as("pins"),
      "showcase",
      "weekly_email",
      sql<
        { id: number; name: string; tier: string }[]
      >`(SELECT coalesce(json_agg(b ORDER BY b.tier DESC, b.name), '[]')
        FROM (SELECT DISTINCT badges.id, badges.name, badges.tier FROM user_badges
          JOIN badges ON badges.id = user_badges.badge_id
          WHERE user_badges.user_id = users.id AND badges.tier IN ('gold', 'silver')) b)`.as(
        "title_badges",
      ),
      sql<{ id: number; name: string; tier: string }[]>`(SELECT coalesce(json_agg(b
          ORDER BY array_position('{gold,silver,bronze}'::text[], b.tier), b.name), '[]')
        FROM (SELECT DISTINCT badges.id, badges.name, badges.tier FROM user_badges
          JOIN badges ON badges.id = user_badges.badge_id
          WHERE user_badges.user_id = users.id) b)`.as("badges"),
      "notify_email",
      sql<Record<string, { site?: boolean; email?: boolean }>>`notify_prefs`.as("notify_prefs"),
    ])
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();
  return { ...settings, badge_unlocks: await badgeUnlocks(db, userId) };
}

// Only what is given changes, down to each notification switch: one never set follows the
// owner's default.
export async function updateSettings(
  actor: Actor,
  change: {
    custom_bio?: string | null;
    allow_proxy?: boolean;
    hide_from_guests?: boolean;
    relations_public?: boolean;
    title_badge_id?: number | null;
    shown_badge_ids?: number[] | null;
    theme?: Theme | null;
    background?: BackgroundPreset | null;
    frame?: Frame | null;
    user_status?: { emoji: string; text: string; until: number | null } | null;
    pins?: number[];
    showcase?: string | null;
    weekly_email?: boolean;
    notify_email?: boolean;
    notify_prefs?: Record<string, { site?: boolean; email?: boolean }>;
  },
) {
  const { notify_prefs, user_status, ...rest } = change;
  if (Object.keys(change).length === 0) return;
  const was = await db.transaction().execute(async (trx) => {
    const background =
      change.background === undefined
        ? undefined
        : await assertBackground(trx, actor.userId, change.background);
    if (change.title_badge_id != null)
      await assertTitleBadge(trx, actor.userId, change.title_badge_id);
    if (change.shown_badge_ids) await assertOwnBadges(trx, actor.userId, change.shown_badge_ids);
    if (change.pins) await assertPinnable(trx, actor.userId, change.pins);
    if (change.frame !== undefined) await assertFrame(trx, actor.userId, change.frame);
    await trx
      .updateTable("users")
      .set({
        ...rest,
        ...(user_status !== undefined && statusColumns(user_status)),
        ...(notify_prefs && {
          notify_prefs: sql`notify_prefs || coalesce((
            SELECT jsonb_object_agg(key, coalesce(notify_prefs -> key, '{}') || value)
            FROM jsonb_each(${JSON.stringify(notify_prefs)}::jsonb)), '{}')`,
        }),
      })
      .where("id", "=", actor.userId)
      .execute();
    await recordAudit(trx, actor, { action: "user.settings", data: change });
    return { background };
  });
  // Their own picture's files go once another background takes its place.
  if (was.background === "custom") await removeBackground(actor.userId);
}

// A preset is taken once unlocked; the one already worn needs nothing, even after a level is lost
// (design §8.16). Returns the background before.
async function assertBackground(
  trx: Transaction<DB>,
  userId: number,
  next: BackgroundPreset | null,
) {
  const user = await trx
    .selectFrom("users")
    .select(["background", "level", "role"])
    .where("id", "=", userId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  if (next !== null && next !== user.background && !reaches(user, BACKGROUND_PRESETS[next].level)) {
    throw new AppError(403, "cosmetic_locked", "还没有解锁这个背景");
  }
  return user.background;
}

// As with backgrounds: the frame already worn needs nothing.
async function assertFrame(trx: Transaction<DB>, userId: number, next: Frame | null) {
  const user = await trx
    .selectFrom("users")
    .select(["frame", "level", "role"])
    .where("id", "=", userId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  if (next === null || next === user.frame) return;
  if (!unlockedFrames(user, await badgeUnlocks(trx, userId)).includes(next)) {
    throw new AppError(403, "cosmetic_locked", "还没有解锁这个头像框");
  }
}

// Only a gold or silver badge of one's own makes a title (design §8.8).
async function assertTitleBadge(trx: Transaction<DB>, userId: number, badgeId: number) {
  const own = await trx
    .selectFrom("user_badges")
    .innerJoin("badges", "badges.id", "user_badges.badge_id")
    .select("badges.id")
    .where("user_badges.user_id", "=", userId)
    .where("user_badges.badge_id", "=", badgeId)
    .where("badges.tier", "in", ["gold", "silver"])
    .executeTakeFirst();
  if (!own) throw new AppError(400, "badge_not_title", "只能选自己得到的金徽章或银徽章作为头衔");
}

async function assertOwnBadges(trx: Transaction<DB>, userId: number, badgeIds: number[]) {
  const { owned } = await trx
    .selectFrom("user_badges")
    .select(sql<number>`count(DISTINCT badge_id)::integer`.as("owned"))
    .where("user_id", "=", userId)
    .where("badge_id", "=", sql<number>`any(${badgeIds}::integer[])`)
    .executeTakeFirstOrThrow();
  if (owned !== badgeIds.length) {
    throw new AppError(400, "badge_not_owned", "只能展示自己得到的徽章");
  }
}

// Only one's own threads, as everyone sees them, make their page (design §8.16).
async function assertPinnable(trx: Transaction<DB>, userId: number, threadIds: number[]) {
  const { pinnable } = await trx
    .selectFrom("threads")
    .select(sql<number>`count(*)::integer`.as("pinnable"))
    .where("id", "=", sql<number>`any(${threadIds}::integer[])`)
    .where("author_id", "=", userId)
    .where("author_anonymous", "=", false)
    .where("deleted_at", "is", null)
    .where("status", "=", "visible")
    .executeTakeFirstOrThrow();
  if (pinnable !== threadIds.length) {
    throw new AppError(400, "thread_not_pinnable", "代表作只能选自己公开发布的帖子");
  }
}

function statusColumns(status: { emoji: string; text: string; until: number | null } | null) {
  return {
    status_emoji: status && status.emoji,
    status_text: status && status.text,
    status_until: status?.until ? new Date(status.until * 1000) : null,
  };
}

export async function clearCustomization(
  actor: Actor,
  ref: UserRef,
  item: Clearable,
  reason: string,
) {
  const userId = await findUserId(ref);
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("users")
      .set(
        item === "background"
          ? { background: null }
          : item === "status"
            ? statusColumns(null)
            : { showcase: null },
      )
      .where("id", "=", userId)
      .execute();
    await recordAudit(trx, actor, {
      action: "user.clear",
      target_type: "user",
      target_id: userId,
      data: { item, reason },
    });
  });
  if (item === "background") await removeBackground(userId);
}

// Their showcase for their page, and which threads they pinned there; see design §8.16.
// Images in it show as links: it is about them, and keeps the page light.
export async function getShowcase(ref: UserRef) {
  const { showcase, ...rest } = await db
    .selectFrom("users")
    .select(["showcase", "pins", "hide_from_guests"])
    .where((eb) => ("id" in ref ? eb("id", "=", ref.id) : eb("qq", "=", ref.qq)))
    .executeTakeFirstOrThrow(userNotFound);
  const html = showcase && (await renderMarkdown(showcase, async () => new Map())).html;
  return { ...rest, html };
}

// A badge taken back is no longer worn as their title, nor shown on their card; a frame it alone
// opened comes off too. Frames opened by levels stay, as they do when a level is lost.
export async function dropRevokedBadge(trx: Transaction<DB>, userId: number, badgeId: number) {
  const user = await trx
    .updateTable("users")
    .set({
      title_badge_id: sql`nullif(title_badge_id, ${badgeId})`,
      shown_badge_ids: sql`array_remove(shown_badge_ids, ${badgeId})`,
    })
    .where("id", "=", userId)
    .returning(["frame", "level", "role"])
    .executeTakeFirstOrThrow();
  const frame = frameOf(user.frame);
  if (
    frame !== null &&
    !("level" in FRAME_LOOKS[frame].unlock) &&
    !unlockedFrames(user, await badgeUnlocks(trx, userId)).includes(frame)
  ) {
    await trx.updateTable("users").set({ frame: null }).where("id", "=", userId).execute();
  }
}

// The QQ signature, which the bot looks up when someone first logs in. Shown until they write
// their own; longer ones are cut to fit, by characters as people see them so an emoji stays
// whole.
export async function setQqBio(actor: Actor, userId: number, bio: string) {
  const characters = Array.from(new Intl.Segmenter().segment(bio), (s) => s.segment);
  const qq_bio = characters.slice(0, MAX_BIO).join("");
  await db.transaction().execute(async (trx) => {
    await trx.updateTable("users").set({ qq_bio }).where("id", "=", userId).execute();
    await recordAudit(trx, actor, {
      action: "user.qq_bio",
      target_type: "user",
      target_id: userId,
      data: { bio: qq_bio },
    });
  });
}

// Written by members, which then works out the display name from it.
export async function saveCustomName(trx: Transaction<DB>, userId: number, name: string | null) {
  await trx.updateTable("users").set({ custom_name: name }).where("id", "=", userId).execute();
}

// Written by moderation, which checks who may and records why.
export async function saveRestriction(
  trx: Transaction<DB>,
  userId: number,
  restriction: { type: "mute" | "ban"; until: Date | null } | null,
) {
  await trx
    .updateTable("users")
    .set({
      restriction: restriction?.type ?? null,
      restricted_until: restriction?.until ?? null,
      // When it runs out, or now: one with no end is in force until lifted, and lifting it is now.
      restricted_through: restriction?.until ?? sql<Date>`now()`,
    })
    .where("id", "=", userId)
    .execute();
}

// Written by levels. A new level starts its time at it; `locked` set by an admin keeps automatic
// changes away. Returns the level before.
export async function saveLevel(
  trx: Transaction<DB>,
  userId: number,
  change: { level: number; locked?: boolean },
) {
  const { from } = await trx
    .updateTable("users")
    .set({
      level: change.level,
      level_since: sql<Date | null>`CASE WHEN level = ${change.level} THEN level_since ELSE now() END`,
      ...(change.locked !== undefined && { level_locked: change.locked }),
    })
    .where("id", "=", userId)
    .returning(sql<number>`old.level`.as("from"))
    .executeTakeFirstOrThrow();
  return from;
}

// Written by members: a role set by hand is locked, so syncing leaves it; none unlocks it, and
// the groups decide again. Returns the role before and whether it was locked.
export async function saveRole(trx: Transaction<DB>, userId: number, role: string | null) {
  return trx
    .updateTable("users")
    .set(role === null ? { role_locked: false } : { role, role_locked: true })
    .where("id", "=", userId)
    .returning([sql<string>`old.role`.as("from"), sql<boolean>`old.role_locked`.as("locked")])
    .executeTakeFirstOrThrow();
}

const MEMBERS_PAGE = 50;

// For staff: newest accounts first, found by name or QQ number, and by standing, role or a
// restriction in force; the cursor is the last one's ID.
export async function listMembers(filter: {
  q?: string;
  status?: "member" | "frozen";
  role?: string;
  level?: number;
  restricted?: boolean;
  cursor?: number;
}) {
  let query = db
    .selectFrom("users")
    .select([
      "id",
      "display_name",
      "avatar_version",
      "qq",
      "role",
      "role_locked",
      "level",
      "level_locked",
      "member_status",
      "activated_at",
      "restriction",
      "restricted_until",
      "last_seen_at",
      "thread_count",
      "post_count",
    ])
    .orderBy("id", "desc")
    .limit(MEMBERS_PAGE);
  const { q } = filter;
  if (q !== undefined) {
    const name = `%${q.replaceAll(/[\\%_]/g, "\\$&")}%`;
    query = query.where((eb) =>
      /^\d{5,12}$/.test(q)
        ? eb.or([eb("display_name", "ilike", name), eb("qq", "=", Number(q))])
        : eb("display_name", "ilike", name),
    );
  }
  if (filter.status !== undefined) query = query.where("member_status", "=", filter.status);
  if (filter.role !== undefined) query = query.where("role", "=", filter.role);
  if (filter.level !== undefined) query = query.where("level", "=", filter.level);
  if (filter.restricted) {
    query = query
      .where("restriction", "is not", null)
      .where((eb) =>
        eb.or([eb("restricted_until", "is", null), eb("restricted_until", ">", sql<Date>`now()`)]),
      );
  }
  if (filter.cursor !== undefined) query = query.where("id", "<", filter.cursor);
  const rows = await query.execute();
  const last = rows.at(-1);
  return {
    items: rows.map(({ avatar_version, ...r }) => ({
      ...r,
      avatar_url: avatarUrl(r.id, avatar_version),
    })),
    next_cursor: rows.length === MEMBERS_PAGE && last ? String(last.id) : null,
  };
}

// ---- Following and 认可; see design §8.7. Doing either again changes nothing.

async function otherUser(viewer: Viewer, ref: UserRef, self: string) {
  const id = await findUserId(ref);
  if (id === viewer.id) throw new AppError(400, "invalid_request", self);
  return id;
}

export async function setFollow(viewer: Viewer, ref: UserRef, follow: boolean) {
  const id = await otherUser(viewer, ref, "不能关注自己");
  if (follow) {
    await db
      .insertInto("user_follows")
      .values({ follower_id: viewer.id, followee_id: id })
      .onConflict((oc) => oc.doNothing())
      .execute();
  } else {
    await db
      .deleteFrom("user_follows")
      .where("follower_id", "=", viewer.id)
      .where("followee_id", "=", id)
      .execute();
  }
}

export async function setEndorsement(viewer: Viewer, ref: UserRef, endorse: boolean) {
  const id = await otherUser(viewer, ref, "不能认可自己");
  if (endorse) {
    await db
      .insertInto("endorsements")
      .values({ user_id: id, endorser_id: viewer.id })
      .onConflict((oc) => oc.doNothing())
      .execute();
  } else {
    await db
      .deleteFrom("endorsements")
      .where("user_id", "=", id)
      .where("endorser_id", "=", viewer.id)
      .execute();
  }
}

export async function getProfile(userId: number) {
  const { avatar_version, ...profile } = await db
    .selectFrom("users")
    .select([
      "id",
      "display_name",
      "avatar_version",
      "role",
      "level",
      "qq",
      "member_status",
      "activated_at",
    ])
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();
  return { ...profile, avatar_url: avatarUrl(userId, avatar_version) };
}

// Member counts for the admin overview; bots and the owner aside.
export async function memberStats() {
  return db
    .selectFrom("users")
    .select((eb) => [
      eb.fn.countAll<number>().as("total"),
      eb.fn.countAll<number>().filterWhere("activated_at", "is not", null).as("activated"),
      eb.fn.countAll<number>().filterWhere("member_status", "=", "frozen").as("frozen"),
    ])
    .where("role", "not in", ["bot", "owner"])
    .executeTakeFirstOrThrow();
}

export async function countUserPosts(
  trx: Transaction<DB>,
  userId: number,
  { threads, posts }: { threads: number; posts: number },
) {
  await trx
    .updateTable("users")
    .set((eb) => ({
      thread_count: eb("thread_count", "+", threads),
      post_count: eb("post_count", "+", posts),
    }))
    .where("id", "=", userId)
    .execute();
}

// Users with their membership of the group that speaks for them, which their card and QQ title
// come from: the primary group, otherwise the one they joined first, as with their name
// (members/rules). A badge they chose as their title goes before the QQ one (design §8.8).
function withHomeGroup() {
  return db
    .selectFrom("users")
    .leftJoin("badges as title_badge", "title_badge.id", "users.title_badge_id")
    .leftJoinLateral(
      (eb) =>
        eb
          .selectFrom("group_members")
          .innerJoin("qq_groups", "qq_groups.id", "group_members.group_id")
          .select(["title", "card", "joined_at", "last_sent_at"])
          .whereRef("group_members.user_id", "=", "users.id")
          .where("group_members.left_at", "is", null)
          .where("qq_groups.enabled", "=", true)
          .orderBy("qq_groups.is_primary", "desc")
          .orderBy(sql`joined_at ASC NULLS LAST`)
          .orderBy("group_members.group_id")
          .limit(1)
          .as("home"),
      (join) => join.onTrue(),
    );
}

export function anonymousBrief(number: number) {
  return { anonymous: true as const, number, display_name: `匿名鼠 ${number}` };
}

type UserBrief = ReturnType<Awaited<ReturnType<typeof userBriefs>>>;

// Who wrote something, as shown: their number in the thread when they wrote it anonymously.
export function writer(user: (id: number) => UserBrief, id: number, alias: number | null) {
  return alias === null ? user(id) : anonymousBrief(alias);
}

// How people appear next to their posts: the title is the badge they chose, else their custom
// one in their home group.
// Returns a lookup for the IDs asked for.
export async function userBriefs(ids: number[]) {
  const rows = await withHomeGroup()
    .select((eb) => [
      "users.id",
      "users.display_name",
      "users.avatar_version",
      "users.role",
      "users.level",
      eb.fn.coalesce("title_badge.name", "home.title", eb.val("")).as("title"),
      "title_badge.tier as title_tier",
      USER_STATUS.as("user_status"),
      "users.frame",
    ])
    .where("users.id", "=", sql<number>`any(${[...new Set(ids)]}::integer[])`)
    .execute();
  const users = new Map(
    rows.map(({ avatar_version, frame, ...r }) => [
      r.id,
      { ...r, frame: frameOf(frame), avatar_url: avatarUrl(r.id, avatar_version) },
    ]),
  );
  return (id: number) => {
    const user = users.get(id);
    if (!user) throw new Error(`User ${id} was not looked up`);
    return user;
  };
}

// For @ in the editor: members whose name contains the text, names starting with it first, then
// the recently active.
// Members by name, and by QQ number when the text is digits: the numbers starting with them,
// that very number first. Each comes with the number, which tells namesakes apart.
export async function searchUsers(text: string) {
  const pattern = text.replaceAll(/[\\%_]/g, "\\$&");
  const digits = /^\d+$/.test(text);
  const rows = await db
    .selectFrom("users")
    .select(["id", "qq"])
    .where((eb) =>
      digits
        ? eb.or([
            eb("display_name", "ilike", `%${pattern}%`),
            eb(sql<string>`qq::text`, "like", `${text}%`),
          ])
        : eb("display_name", "ilike", `%${pattern}%`),
    )
    .where("role", "<>", "bot")
    .where("member_status", "=", "member")
    .where("qq", "is not", null)
    .$narrowType<{ qq: NotNull }>()
    .orderBy(sql`qq::text = ${text}`, "desc")
    .orderBy(sql`display_name ILIKE ${`${pattern}%`}`, "desc")
    .orderBy(sql`last_seen_at DESC NULLS LAST`)
    .orderBy("id")
    .limit(8)
    .execute();
  const user = await userBriefs(rows.map((r) => r.id));
  return rows.map((r) => ({ ...user(r.id), qq: r.qq }));
}

// Forum members by QQ number, for @ in messages from QQ.
export async function membersByQq(qqs: number[]) {
  const rows =
    qqs.length === 0
      ? []
      : await db
          .selectFrom("users")
          .select(["id", "qq", "display_name"])
          .where("qq", "in", qqs)
          .$narrowType<{ qq: NotNull }>()
          .execute();
  return new Map(rows.map((r) => [r.qq, r]));
}

export async function countLikes(trx: Transaction<DB>, userId: number, likes: number) {
  await trx
    .updateTable("users")
    .set((eb) => ({ like_received: eb("like_received", "+", likes) }))
    .where("id", "=", userId)
    .execute();
}

// ---- Avatars: copies of QQ avatars, so pages don't carry links with QQ numbers in them, or
// pictures people uploaded instead. See design §6.1.

export const AVATARS_DIR = "data/avatars";
// Each copy is fetched again once it is this old. The job runs every minute, so new members get
// theirs within one.
const AVATAR_TTL_MS = 23 * 3600_000;
const MAX_AVATAR = 1024 * 1024;

// The version changes with the picture, so the address can be cached for good. None before the
// first copy is made.
function avatarUrl(id: number, version: number) {
  return version === 0 ? null : `/avatars/${id}.webp?v=${version}`;
}

async function fetchAvatar(qq: number) {
  const res = await fetch(`https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=100`, {
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok || !res.body) throw new Error(`QQ avatar request answered ${res.status}`);
  const data = await readCapped(res.body, MAX_AVATAR, () => {
    throw new Error("QQ avatar too large");
  });
  return processAvatar(data);
}

async function modifiedAt(path: string) {
  return stat(path).then(
    (s) => s.mtimeMs,
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    },
  );
}

// Uploaded or put back by the person, with the audit entry; the daily refresh writes no entry.
async function saveAvatar(id: number, avatar: Buffer, custom: boolean, actor?: Actor) {
  await mkdir(AVATARS_DIR, { recursive: true });
  const path = `${AVATARS_DIR}/${id}.webp`;
  await writeFile(`${path}.tmp`, avatar);
  await rename(`${path}.tmp`, path);
  const avatar_version = await db.transaction().execute(async (trx) => {
    const row = await trx
      .updateTable("users")
      .set((eb) => ({ avatar_version: eb("avatar_version", "+", 1), avatar_custom: custom }))
      .where("id", "=", id)
      .returning("avatar_version")
      .executeTakeFirstOrThrow();
    if (actor) await recordAudit(trx, actor, { action: "user.avatar", data: { custom } });
    return row.avatar_version;
  });
  return avatarUrl(id, avatar_version);
}

export async function uploadAvatar(actor: Actor, file: Buffer) {
  return saveAvatar(actor.userId, await processAvatar(file), true, actor);
}

// Back to the QQ avatar, fetched right away so the page shows it.
export async function restoreQqAvatar(actor: Actor) {
  const { qq } = await db
    .selectFrom("users")
    .select("qq")
    .where("id", "=", actor.userId)
    .$narrowType<{ qq: number }>()
    .executeTakeFirstOrThrow();
  const avatar = await fetchAvatar(qq).catch((error: unknown) => {
    throw new AppError(502, "fetch_failed", "QQ 头像获取失败，请稍后重试", { cause: error });
  });
  return saveAvatar(actor.userId, avatar, false, actor);
}

// One at a time: a daily trickle to QQ rather than a burst. A picture that didn't change only
// has its copy's time renewed; one that couldn't be fetched is tried again next hour. Uploaded
// avatars are left alone.
export async function refreshAvatars() {
  const users = await db
    .selectFrom("users")
    .select(["id", "qq"])
    .where("avatar_custom", "=", false)
    // The owner has no QQ, so no QQ avatar.
    .where("qq", "is not", null)
    .$narrowType<{ qq: NotNull }>()
    .execute();
  const failed: { id: number; error: unknown }[] = [];
  for (const { id, qq } of users) {
    const path = `${AVATARS_DIR}/${id}.webp`;
    const checked = await modifiedAt(path);
    if (checked !== null && Date.now() - checked < AVATAR_TTL_MS) continue;
    try {
      const avatar = await fetchAvatar(qq);
      if (checked !== null && avatar.equals(await readFile(path))) {
        const now = new Date();
        await utimes(path, now, now);
        continue;
      }
      await saveAvatar(id, avatar, false);
    } catch (error) {
      failed.push({ id, error });
    }
  }
  if (failed.length > 0) {
    log("warn", "Some avatars could not be refreshed", { count: failed.length, first: failed[0] });
  }
}
