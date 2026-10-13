import type { Insertable, Transaction } from "kysely";
import type { AuditLogs, DB } from "../../../db/types.ts";
import type { Actor } from "../../platform/access.ts";

type Entry = Omit<Insertable<AuditLogs>, "actor_id" | "operator_id" | "token_id" | "ip">;

// Written in the caller's transaction, so the log and the change commit together.
export async function recordAudit(trx: Transaction<DB>, actor: Actor | null, entry: Entry) {
  await trx
    .insertInto("audit_logs")
    .values({
      ...entry,
      actor_id: actor?.userId,
      operator_id: actor?.operatorId,
      token_id: actor?.tokenId,
      ip: actor?.ip,
    })
    .execute();
}
