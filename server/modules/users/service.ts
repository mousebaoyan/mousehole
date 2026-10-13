import type { Transaction } from "kysely";
import type { DB } from "../../../db/types.ts";
import type { UserRef } from "../../platform/access.ts";
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
