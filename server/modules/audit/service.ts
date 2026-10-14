import { sql, type Insertable, type Transaction } from "kysely";
import type { AuditLogs, DB } from "../../../db/types.ts";
import type { Actor } from "../../platform/access.ts";
import { db } from "../../platform/db.ts";

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

const PAGE = 50;

// For admins: newest first, narrowed by who did it, what was done, or what to; the cursor is the
// last one's ID.
export async function listAuditLogs(filter: {
  actorId?: number;
  action?: string;
  targetType?: string;
  targetId?: number;
  cursor?: number;
}) {
  let query = db
    .selectFrom("audit_logs")
    .leftJoin("api_tokens", "api_tokens.id", "audit_logs.token_id")
    .select([
      "audit_logs.id",
      "audit_logs.actor_id",
      "audit_logs.operator_id",
      "api_tokens.name as token_name",
      "audit_logs.action",
      "audit_logs.target_type",
      "audit_logs.target_id",
      sql<Record<string, unknown>>`audit_logs.data`.as("data"),
      sql<string | null>`host(audit_logs.ip)`.as("ip"),
      "audit_logs.created_at",
    ])
    .orderBy("audit_logs.id", "desc")
    .limit(PAGE);
  if (filter.actorId !== undefined) query = query.where("audit_logs.actor_id", "=", filter.actorId);
  if (filter.action !== undefined) query = query.where("audit_logs.action", "=", filter.action);
  if (filter.targetType !== undefined) {
    query = query.where("audit_logs.target_type", "=", filter.targetType);
  }
  if (filter.targetId !== undefined)
    query = query.where("audit_logs.target_id", "=", filter.targetId);
  if (filter.cursor !== undefined) query = query.where("audit_logs.id", "<", filter.cursor);
  const rows = await query.execute();
  const last = rows.at(-1);
  return { rows, next_cursor: rows.length === PAGE && last ? String(last.id) : null };
}
