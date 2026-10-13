import { mkdir, readFile, rename, stat, utimes, writeFile } from "node:fs/promises";
import { sql, type Transaction } from "kysely";
import type { DB } from "../../../db/types.ts";
import type { Actor, UserRef, Viewer } from "../../platform/access.ts";
import { readCapped } from "../../platform/body.ts";
import { db } from "../../platform/db.ts";
import { AppError } from "../../platform/errors.ts";
import { processAvatar } from "../../platform/images.ts";
import { log } from "../../platform/log.ts";
import { recordAudit } from "../audit/service.ts";
import { recordEvent } from "../events/service.ts";

// For the bootstrap command: the first admin logs in before any group is synced.
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
  if (!row) throw new AppError(409, "bot_qq_taken", "这个 QQ 号是登录过的群友，不能用作 bot");
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
  level: number | null;
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
    UPDATE users SET member_status = v.member_status, role = v.role, level = v.level,
      display_name = v.display_name
    FROM (VALUES ${sql.join(
      rows.map(
        (r) =>
          sql`(${r.id}::integer, ${r.member_status}, ${r.role}, ${r.level}::smallint, ${r.display_name})`,
      ),
    )}) AS v (id, member_status, role, level, display_name)
    WHERE users.id = v.id
      AND (users.member_status, users.role, users.level, users.display_name)
        IS DISTINCT FROM (v.member_status, v.role, v.level, v.display_name)
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

export async function findMember(ref: UserRef) {
  return db
    .selectFrom("users")
    .select(["id", "role", "member_status", "allow_proxy"])
    .where((eb) => ("id" in ref ? eb("id", "=", ref.id) : eb("qq", "=", ref.qq)))
    .where("deleted_at", "is", null)
    .executeTakeFirst();
}

// Seen now; the first visit on a new day in Beijing time adds a day visited.
const SEEN = {
  last_seen_at: sql<Date>`now()`,
  days_visited: sql<number>`days_visited + (last_seen_at IS NULL
    OR (last_seen_at AT TIME ZONE 'Asia/Shanghai')::date
      < (now() AT TIME ZONE 'Asia/Shanghai')::date)::integer`,
};

// The first login activates the account, which the bot plugin hears of.
export async function recordLogin(trx: Transaction<DB>, userId: number) {
  const user = await trx
    .updateTable("users")
    .set((eb) => ({ activated_at: eb.fn.coalesce("activated_at", eb.val(new Date())), ...SEEN }))
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
  await db.updateTable("users").set(SEEN).where("id", "=", userId).execute();
}

// Reading reports count as being seen too.
export async function countReading(
  trx: Transaction<DB>,
  userId: number,
  { posts, seconds }: { posts: number; seconds: number },
) {
  await trx
    .updateTable("users")
    .set((eb) => ({
      posts_read: eb("posts_read", "+", posts),
      read_seconds: eb("read_seconds", "+", seconds),
      ...SEEN,
    }))
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
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!row) throw userNotFound();
  return row.id;
}

// What the profile card and the user's page show; see design §6.1 and §9. `viewerId` is for
// whether the reader follows and has endorsed them.
export async function getUser(ref: UserRef, viewerId: number | null) {
  const row = await withPrimaryGroup()
    .select((eb) => [
      "users.id",
      "users.display_name",
      "users.avatar_version",
      "users.role",
      "users.level",
      eb.fn.coalesce("group_members.title", eb.val("")).as("title"),
      "group_members.card",
      "group_members.joined_at",
      "group_members.last_sent_at",
      "users.bio",
      "users.qq",
      "users.member_status",
      "users.activated_at",
      "users.thread_count",
      "users.post_count",
      "users.like_received",
      "users.days_visited",
      "users.read_seconds",
      "users.posts_read",
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
    ])
    .where((eb) => ("id" in ref ? eb("users.id", "=", ref.id) : eb("users.qq", "=", ref.qq)))
    // Only deleted accounts have no QQ number.
    .where("users.deleted_at", "is", null)
    .$narrowType<{ qq: number }>()
    .executeTakeFirst();
  if (!row) throw userNotFound();
  const { avatar_version, ...user } = row;
  return { ...user, avatar_url: avatarUrl(user.id, avatar_version) };
}

// ---- One's own settings: see design §6.1 and §9.

export async function getSettings(userId: number) {
  return db
    .selectFrom("users")
    .select([
      "custom_name",
      "bio",
      "allow_proxy",
      sql<Record<string, { site?: boolean; qq?: boolean }>>`notify_prefs`.as("notify_prefs"),
    ])
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();
}

// Only what is given changes; each notification type given replaces what was saved for it.
export async function updateSettings(
  userId: number,
  change: {
    bio?: string;
    allow_proxy?: boolean;
    notify_prefs?: Record<string, { site: boolean; qq: boolean }>;
  },
) {
  const { notify_prefs, ...rest } = change;
  if (Object.keys(change).length === 0) return;
  await db
    .updateTable("users")
    .set({
      ...rest,
      ...(notify_prefs && {
        notify_prefs: sql`notify_prefs || ${JSON.stringify(notify_prefs)}::jsonb`,
      }),
    })
    .where("id", "=", userId)
    .execute();
}

// Written by members, which then works out the display name from it.
export async function saveCustomName(trx: Transaction<DB>, userId: number, name: string | null) {
  await trx.updateTable("users").set({ custom_name: name }).where("id", "=", userId).execute();
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
    .select(["id", "display_name", "avatar_version", "role", "qq", "member_status", "activated_at"])
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();
  return { ...profile, avatar_url: avatarUrl(userId, avatar_version) };
}

// Member counts for the admin overview; bots and deleted accounts aside.
export async function memberStats() {
  return db
    .selectFrom("users")
    .select((eb) => [
      eb.fn.countAll<number>().as("total"),
      eb.fn.countAll<number>().filterWhere("activated_at", "is not", null).as("activated"),
      eb.fn.countAll<number>().filterWhere("member_status", "=", "frozen").as("frozen"),
    ])
    .where("role", "<>", "bot")
    .where("deleted_at", "is", null)
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

// Users with their membership of the primary group, which their title and card come from.
function withPrimaryGroup() {
  return db
    .selectFrom("users")
    .leftJoin("qq_groups", (join) => join.on("qq_groups.is_primary", "=", true))
    .leftJoin("group_members", (join) =>
      join
        .onRef("group_members.group_id", "=", "qq_groups.id")
        .onRef("group_members.user_id", "=", "users.id")
        .on("group_members.left_at", "is", null),
    );
}

// How people appear next to their posts: the title is their custom one in the primary group.
// Returns a lookup for the IDs asked for.
export async function userBriefs(ids: number[]) {
  const rows = await withPrimaryGroup()
    .select((eb) => [
      "users.id",
      "users.display_name",
      "users.avatar_version",
      "users.role",
      "users.level",
      eb.fn.coalesce("group_members.title", eb.val("")).as("title"),
    ])
    .where("users.id", "=", sql<number>`any(${[...new Set(ids)]}::integer[])`)
    .execute();
  const users = new Map(
    rows.map(({ avatar_version, ...r }) => [
      r.id,
      { ...r, avatar_url: avatarUrl(r.id, avatar_version) },
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
export async function searchUsers(text: string) {
  const pattern = text.replaceAll(/[\\%_]/g, "\\$&");
  const rows = await db
    .selectFrom("users")
    .select("id")
    .where("display_name", "ilike", `%${pattern}%`)
    .where("role", "<>", "bot")
    .where("member_status", "=", "member")
    .where("deleted_at", "is", null)
    .orderBy(sql`display_name ILIKE ${`${pattern}%`}`, "desc")
    .orderBy(sql`last_seen_at DESC NULLS LAST`)
    .orderBy("id")
    .limit(8)
    .execute();
  const user = await userBriefs(rows.map((r) => r.id));
  return rows.map((r) => user(r.id));
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
          .where("deleted_at", "is", null)
          .execute();
  return new Map(rows.flatMap((r) => (r.qq === null ? [] : [[r.qq, r] as const])));
}

export async function countLikes(trx: Transaction<DB>, userId: number, likes: number) {
  await trx
    .updateTable("users")
    .set((eb) => ({ like_received: eb("like_received", "+", likes) }))
    .where("id", "=", userId)
    .execute();
}

// ---- Avatars: copies of QQ avatars, so pages don't carry links with QQ numbers in them. See
// design §6.1.

export const AVATARS_DIR = "data/avatars";
// Each copy is fetched again once it is this old. The job runs hourly, so new members don't wait.
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

// One at a time: a daily trickle to QQ rather than a burst. A picture that didn't change only
// has its copy's time renewed; one that couldn't be fetched is tried again next hour.
export async function refreshAvatars() {
  const users = await db
    .selectFrom("users")
    .select(["id", "qq"])
    .where("qq", "is not", null)
    .where("deleted_at", "is", null)
    .$narrowType<{ qq: number }>()
    .execute();
  await mkdir(AVATARS_DIR, { recursive: true });
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
      await writeFile(`${path}.tmp`, avatar);
      await rename(`${path}.tmp`, path);
      await db
        .updateTable("users")
        .set((eb) => ({ avatar_version: eb("avatar_version", "+", 1) }))
        .where("id", "=", id)
        .execute();
    } catch (error) {
      failed.push({ id, error });
    }
  }
  if (failed.length > 0) {
    log("warn", "Some avatars could not be refreshed", { count: failed.length, first: failed[0] });
  }
}
