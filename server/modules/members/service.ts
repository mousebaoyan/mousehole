import type { Insertable, Transaction } from "kysely";
import type { DB, GroupMembers } from "../../../db/types.ts";
import type { Actor, UserRef } from "../../platform/access.ts";
import { db } from "../../platform/db.ts";
import { AppError } from "../../platform/errors.ts";
import { recordAudit } from "../audit/service.ts";
import {
  applyStanding,
  ensureMembers,
  findMember,
  saveCustomName,
  saveRole,
} from "../users/service.ts";
import { deriveAccount, mergeRecord, shouldHold, type MemberRecord } from "./rules.ts";

const WRITE_BATCH = 1000;

async function lockGroup(trx: Transaction<DB>, groupId: number) {
  const group = await trx
    .selectFrom("qq_groups")
    .select(["id", "full_synced_at", "delta_synced_at", "shrink_held_at"])
    .where("id", "=", groupId)
    .forUpdate()
    .executeTakeFirst();
  if (!group) throw new AppError(404, "group_not_linked", "这个群还没有在后台关联");
  return group;
}

// Re-derives standing, role and display name for these accounts from all their groups.
async function refreshAccounts(
  trx: Transaction<DB>,
  actor: Actor | null,
  userIds: number[],
  robots = new Map<number, boolean>(),
) {
  if (userIds.length === 0) return;
  const accounts = await trx
    .selectFrom("users")
    .select([
      "id",
      "qq",
      "role",
      "role_locked",
      "custom_name",
      "qq_nickname",
      "display_name",
      "member_status",
    ])
    .where("id", "in", userIds)
    .execute();
  const memberships = await trx
    .selectFrom("group_members as m")
    .innerJoin("qq_groups as g", "g.id", "m.group_id")
    .select([
      "m.user_id",
      "m.card",
      "m.role",
      "m.joined_at",
      "m.left_at",
      "g.enabled",
      "g.is_primary",
    ])
    .where("m.user_id", "in", userIds)
    .execute();

  const byUser = Map.groupBy(memberships, (m) => m.user_id);
  const standings = accounts.map((account) => ({
    id: account.id,
    ...deriveAccount(account, byUser.get(account.id) ?? [], robots.get(account.id)),
  }));
  await applyStanding(trx, actor, standings);
}

function ownerOnly() {
  return new AppError(403, "forbidden", "只有站长能任免管理员");
}

// Admins set a role by hand, which syncing then leaves alone; null hands it back to the groups.
// Bot accounts keep theirs, nobody changes their own, and only the owner makes or unmakes admins,
// including by handing a group owner's role back to the groups.
export async function setRole(
  actor: Actor,
  byOwner: boolean,
  ref: UserRef,
  role: "user" | "moderator" | "admin" | null,
) {
  const user = await findMember(ref);
  if (!user) throw new AppError(404, "user_not_found", "用户不存在");
  if (user.role === "bot") throw new AppError(403, "forbidden", "bot 账号的角色不能修改");
  if (user.id === actor.userId) throw new AppError(403, "forbidden", "不能修改自己的角色");
  if (!byOwner && (user.role === "admin" || role === "admin")) throw ownerOnly();
  await db.transaction().execute(async (trx) => {
    const { from, locked } = await saveRole(trx, user.id, role);
    if (role !== null) {
      if (from !== role || !locked) {
        await recordAudit(trx, actor, {
          action: "member.role",
          target_type: "user",
          target_id: user.id,
          data: { from, to: role },
        });
      }
      return;
    }
    if (!locked) return;
    await recordAudit(trx, actor, {
      action: "member.role_unlock",
      target_type: "user",
      target_id: user.id,
    });
    // Logs the role the groups give, when it differs.
    await refreshAccounts(trx, actor, [user.id]);
    const after = await trx
      .selectFrom("users")
      .select("role")
      .where("id", "=", user.id)
      .executeTakeFirstOrThrow();
    if (!byOwner && after.role === "admin") throw ownerOnly();
  });
}

// A name of one's own, or null to follow QQ again; the display name follows at once.
export async function setCustomName(actor: Actor, userId: number, name: string | null) {
  await db.transaction().execute(async (trx) => {
    await saveCustomName(trx, userId, name);
    await refreshAccounts(trx, actor, [userId]);
    await recordAudit(trx, actor, {
      action: "user.rename",
      target_type: "user",
      target_id: userId,
      data: { name },
    });
  });
}

async function saveRows(trx: Transaction<DB>, rows: Insertable<GroupMembers>[]) {
  for (let i = 0; i < rows.length; i += WRITE_BATCH) {
    await trx
      .insertInto("group_members")
      .values(rows.slice(i, i + WRITE_BATCH))
      .onConflict((oc) =>
        oc.columns(["group_id", "user_id"]).doUpdateSet((eb) => ({
          card: eb.ref("excluded.card"),
          role: eb.ref("excluded.role"),
          title: eb.ref("excluded.title"),
          joined_at: eb.ref("excluded.joined_at"),
          last_sent_at: eb.ref("excluded.last_sent_at"),
          left_at: eb.ref("excluded.left_at"),
          left_reason: eb.ref("excluded.left_reason"),
          observed_at: eb.ref("excluded.observed_at"),
        })),
      )
      .execute();
  }
}

export type SyncCounts = {
  joined: number;
  left: number;
  updated: number;
  unchanged: number;
  stale: number;
  held: boolean;
};

// A full list (`full`) or a delta of member records; see docs/api.md §4.
export async function syncMembers(
  actor: Actor,
  groupId: number,
  push: { observedAt: Date; members: MemberRecord[]; full: boolean },
) {
  return db.transaction().execute(async (trx) => {
    const group = await lockGroup(trx, groupId);
    const counts: SyncCounts = {
      joined: 0,
      left: 0,
      updated: 0,
      unchanged: 0,
      stale: 0,
      held: false,
    };
    // The latest full list already reflects anything observed before it.
    if (group.full_synced_at && push.observedAt < group.full_synced_at) {
      counts.stale = push.members.length;
      return counts;
    }

    const records = [...new Map(push.members.map((m) => [m.user_id, m])).values()];
    const { ids, renamed } = await ensureMembers(
      trx,
      records.map((r) => ({ qq: r.user_id, nickname: r.nickname })),
    );
    const rows = await trx
      .selectFrom("group_members")
      .selectAll()
      .where("group_id", "=", groupId)
      .execute();
    const existing = new Map(rows.map((r) => [r.user_id, r]));

    const writes: Insertable<GroupMembers>[] = [];
    const affected = new Set(renamed);
    const robots = new Map<number, boolean>();
    const listed = new Set<number>();
    for (const record of records) {
      const userId = ids.get(record.user_id);
      if (userId === undefined) throw new Error(`No account for QQ ${record.user_id}`);
      listed.add(userId);
      if (record.is_robot !== undefined) {
        robots.set(userId, record.is_robot);
        affected.add(userId);
      }
      const known = existing.get(userId);
      if (known && push.observedAt < known.observed_at) {
        counts.stale++;
        continue;
      }
      const present = push.full || (record.in_group ?? true);
      const { row, change } = mergeRecord(known, record, push.observedAt, present);
      counts[change]++;
      if (change !== "unchanged") {
        writes.push({ group_id: groupId, user_id: userId, ...row });
        affected.add(userId);
      }
    }

    if (push.full) {
      const current = rows.filter((r) => r.left_at === null);
      const missing = current.filter(
        (r) => !listed.has(r.user_id) && r.observed_at < push.observedAt,
      );
      counts.held = shouldHold(current.length, missing.length, group.shrink_held_at !== null);
      if (!counts.held) {
        for (const r of missing) {
          const left = {
            left_at: push.observedAt,
            left_reason: "unknown",
            observed_at: push.observedAt,
          };
          writes.push({ ...r, ...left });
          affected.add(r.user_id);
        }
        counts.left += missing.length;
      }
    }

    await saveRows(trx, writes);

    await trx
      .updateTable("qq_groups")
      .set(
        !push.full
          ? { delta_synced_at: push.observedAt }
          : counts.held
            ? { shrink_held_at: new Date() }
            : { full_synced_at: push.observedAt, shrink_held_at: null },
      )
      .where("id", "=", groupId)
      .execute();
    await refreshAccounts(trx, actor, [...affected], robots);
    return counts;
  });
}

export async function updateGroupInfo(
  groupId: number,
  observedAt: Date,
  info: { name?: string; memberCount?: number; maxMemberCount?: number },
) {
  const updated = await db
    .updateTable("qq_groups")
    .set({
      name: info.name,
      member_count: info.memberCount,
      max_member_count: info.maxMemberCount,
      info_synced_at: observedAt,
    })
    .where("id", "=", groupId)
    .where((eb) =>
      eb.or([eb("info_synced_at", "is", null), eb("info_synced_at", "<=", observedAt)]),
    )
    .executeTakeFirst();
  if (updated.numUpdatedRows > 0n) return { stale: false };
  const exists = await db
    .selectFrom("qq_groups")
    .select("id")
    .where("id", "=", groupId)
    .executeTakeFirst();
  if (!exists) throw new AppError(404, "group_not_linked", "这个群还没有在后台关联");
  return { stale: true };
}

const GROUP_COLUMNS = [
  "id",
  "name",
  "member_count",
  "max_member_count",
  "is_primary",
  "enabled",
  "info_synced_at",
  "full_synced_at",
  "delta_synced_at",
  "shrink_held_at",
] as const;

export async function listGroups(enabledOnly: boolean) {
  return db
    .selectFrom("qq_groups")
    .select(GROUP_COLUMNS)
    .$if(enabledOnly, (qb) => qb.where("enabled", "=", true))
    .orderBy("is_primary", "desc")
    .orderBy("created_at")
    .execute();
}

export async function linkGroup(actor: Actor, groupId: number) {
  await db.transaction().execute(async (trx) => {
    const hasPrimary = await trx
      .selectFrom("qq_groups")
      .select("id")
      .where("is_primary", "=", true)
      .executeTakeFirst();
    const linked = await trx
      .insertInto("qq_groups")
      .values({ id: groupId, is_primary: !hasPrimary })
      .onConflict((oc) => oc.column("id").doNothing())
      .returning("id")
      .executeTakeFirst();
    if (!linked) throw new AppError(409, "group_exists", "这个群已经关联过了");
    await recordAudit(trx, actor, {
      action: "group.link",
      target_type: "group",
      data: { group_id: groupId },
    });
  });
}

// Enabling or disabling a group changes who is a member; moving the primary group changes
// display names. Either way its members are re-derived.
export async function updateGroup(
  actor: Actor,
  groupId: number,
  change: { enabled?: boolean; isPrimary?: true },
) {
  await db.transaction().execute(async (trx) => {
    await lockGroup(trx, groupId);
    const touched = [groupId];
    if (change.isPrimary) {
      const previous = await trx
        .updateTable("qq_groups")
        .set({ is_primary: false })
        .where("is_primary", "=", true)
        .where("id", "<>", groupId)
        .returning("id")
        .executeTakeFirst();
      if (previous) touched.push(previous.id);
    }
    await trx
      .updateTable("qq_groups")
      .set({ enabled: change.enabled, is_primary: change.isPrimary })
      .where("id", "=", groupId)
      .execute();
    await recordAudit(trx, actor, {
      action: "group.update",
      target_type: "group",
      data: { group_id: groupId, ...change },
    });

    const members = await trx
      .selectFrom("group_members")
      .select("user_id")
      .distinct()
      .where("group_id", "in", touched)
      .execute();
    await refreshAccounts(
      trx,
      actor,
      members.map((m) => m.user_id),
    );
  });
}
