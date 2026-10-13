import type { Insertable, Transaction } from "kysely";
import type { AuditLogs, DB } from "../../../db/types.ts";

export async function recordAudit(trx: Transaction<DB>, entry: Insertable<AuditLogs>) {
  await trx.insertInto("audit_logs").values(entry).execute();
}
