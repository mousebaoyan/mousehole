import type { NotNull, Transaction } from "kysely";
import type { DB } from "../../../db/types.ts";
import { db } from "../../platform/db.ts";
import { AppError } from "../../platform/errors.ts";
import type { Viewer } from "../../platform/http.ts";
import { hashToken, newToken } from "../../platform/tokens.ts";
import { recordAudit } from "../audit/service.ts";
import { recordLogin, recordSeen } from "../users/service.ts";

export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const LINK_TTL_MS = 10 * 60 * 1000;
// Sliding renewal rewrites the session row at most this often.
const RENEW_AFTER_MS = 60 * 60 * 1000;

type Client = { ip: string | null; userAgent: string };

export async function issueLoginLink(userId: number) {
  const token = newToken();
  await db
    .insertInto("login_tickets")
    .values({
      kind: "link",
      secret_hash: hashToken(token),
      user_id: userId,
      expires_at: new Date(Date.now() + LINK_TTL_MS),
    })
    .execute();
  return token;
}

export async function loginWithLink(token: string, client: Client) {
  return db.transaction().execute(async (trx) => {
    const ticket = await trx
      .deleteFrom("login_tickets")
      .where("kind", "=", "link")
      .where("secret_hash", "=", hashToken(token))
      .where("expires_at", ">", new Date())
      .returning("user_id")
      .$narrowType<{ user_id: NotNull }>()
      .executeTakeFirst();
    if (!ticket) throw new AppError(400, "login_link_invalid", "登录链接无效或已过期，请重新获取");
    await recordAudit(trx, {
      actor_id: ticket.user_id,
      action: "auth.login",
      data: { method: "link" },
      ip: client.ip,
    });
    return startSession(trx, ticket.user_id, client);
  });
}

async function startSession(trx: Transaction<DB>, userId: number, client: Client) {
  const token = newToken();
  await trx
    .insertInto("sessions")
    .values({
      token_hash: hashToken(token),
      user_id: userId,
      user_agent: client.userAgent,
      ip: client.ip,
      expires_at: new Date(Date.now() + SESSION_TTL_MS),
    })
    .execute();
  await recordLogin(trx, userId);
  return token;
}

export async function resolveSession(token: string) {
  const row = await db
    .selectFrom("sessions")
    .innerJoin("users", "users.id", "sessions.user_id")
    .select([
      "sessions.id",
      "sessions.last_seen_at",
      "users.id as user_id",
      "users.role",
      "users.member_status",
    ])
    .where("sessions.token_hash", "=", hashToken(token))
    .where("sessions.expires_at", ">", new Date())
    .executeTakeFirst();
  if (!row) return null;

  const renewed = Date.now() - row.last_seen_at.getTime() > RENEW_AFTER_MS;
  if (renewed) {
    await db
      .updateTable("sessions")
      .set({ last_seen_at: new Date(), expires_at: new Date(Date.now() + SESSION_TTL_MS) })
      .where("id", "=", row.id)
      .execute();
    await recordSeen(row.user_id);
  }
  const viewer: Viewer = { id: row.user_id, role: row.role, member_status: row.member_status };
  return { id: row.id, viewer, renewed };
}

export async function listSessions(userId: number) {
  return db
    .selectFrom("sessions")
    .select(["id", "user_agent", "ip", "created_at", "last_seen_at"])
    .where("user_id", "=", userId)
    .where("expires_at", ">", new Date())
    .orderBy("last_seen_at", "desc")
    .execute();
}

export async function endSession(userId: number, sessionId: number) {
  const ended = await db
    .deleteFrom("sessions")
    .where("id", "=", sessionId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (ended.numDeletedRows === 0n) throw new AppError(404, "not_found", "这个设备已经下线了");
}
