import { sql, type Transaction } from "kysely";
import type { DB } from "../../../db/types.ts";
import type { Actor, UserRef } from "../../platform/access.ts";
import { db } from "../../platform/db.ts";
import { AppError } from "../../platform/errors.ts";
import { recordAudit } from "../audit/service.ts";

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

export async function recordLogin(trx: Transaction<DB>, userId: number) {
  await trx
    .updateTable("users")
    .set((eb) => ({
      activated_at: eb.fn.coalesce("activated_at", eb.val(new Date())),
      last_seen_at: new Date(),
    }))
    .where("id", "=", userId)
    .execute();
}

export async function recordSeen(userId: number) {
  await db
    .updateTable("users")
    .set({ last_seen_at: new Date() })
    .where("id", "=", userId)
    .execute();
}

export async function getProfile(userId: number) {
  return db
    .selectFrom("users")
    .select(["id", "display_name", "role", "qq", "member_status", "activated_at"])
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();
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

// How people appear next to their posts: the title is their custom one in the primary group.
// Returns a lookup for the IDs asked for.
export async function userBriefs(ids: number[]) {
  const rows = await db
    .selectFrom("users")
    .leftJoin("qq_groups", (join) => join.on("qq_groups.is_primary", "=", true))
    .leftJoin("group_members", (join) =>
      join
        .onRef("group_members.group_id", "=", "qq_groups.id")
        .onRef("group_members.user_id", "=", "users.id")
        .on("group_members.left_at", "is", null),
    )
    .select((eb) => [
      "users.id",
      "users.display_name",
      "users.role",
      "users.level",
      eb.fn.coalesce("group_members.title", eb.val("")).as("title"),
    ])
    .where("users.id", "=", sql<number>`any(${[...new Set(ids)]}::integer[])`)
    .execute();
  const users = new Map(rows.map((r) => [r.id, r]));
  return (id: number) => {
    const user = users.get(id);
    if (!user) throw new Error(`User ${id} was not looked up`);
    return user;
  };
}
