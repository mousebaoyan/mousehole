import type { Transaction } from "kysely";
import type { DB } from "../../../db/types.ts";
import { db } from "../../platform/db.ts";
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
    await recordAudit(trx, { action: "user.bootstrap", target_type: "user", target_id: id });
    return id;
  });
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
