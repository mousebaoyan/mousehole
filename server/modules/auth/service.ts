import type { NotNull, Transaction } from "kysely";
import type { DB } from "../../../db/types.ts";
import {
  STAFF,
  type Actor,
  type Bot,
  type Scope,
  type UserRef,
  type Viewer,
} from "../../platform/access.ts";
import { db } from "../../platform/db.ts";
import { AppError } from "../../platform/errors.ts";
import { hashToken, newToken } from "../../platform/tokens.ts";
import { recordAudit } from "../audit/service.ts";
import { ensureBotUser, findMember, recordLogin, recordSeen } from "../users/service.ts";

export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const LINK_TTL_MS = 10 * 60 * 1000;
// Sliding renewal rewrites the session row at most this often.
const RENEW_AFTER_MS = 60 * 60 * 1000;
const TOKEN_USE_WRITE_MS = 60 * 1000;

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
    const actor = { userId: ticket.user_id, operatorId: null, tokenId: null, ip: client.ip };
    await recordAudit(trx, actor, { action: "auth.login", data: { method: "link" } });
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

async function memberOrThrow(ref: UserRef, who: string) {
  const member = await findMember(ref);
  if (!member) throw new AppError(404, "unknown_member", `${who}不是论坛里已同步的成员`);
  return member;
}

// Resolves a bot request to the viewer it acts as. The rules are in docs/api.md §2.3; checks
// that depend on the route are in access.ts.
export async function resolveBot(
  token: string,
  actAs: UserRef | null,
  operatorRef: UserRef | null,
): Promise<{ viewer: Viewer; bot: Bot }> {
  const row = await db
    .selectFrom("api_tokens")
    .innerJoin("users", "users.id", "api_tokens.bot_user_id")
    .select([
      "api_tokens.id",
      "api_tokens.scopes",
      "api_tokens.last_used_at",
      "users.id as user_id",
      "users.role",
      "users.member_status",
    ])
    .where("api_tokens.token_hash", "=", hashToken(token))
    .where("api_tokens.revoked_at", "is", null)
    .executeTakeFirst();
  if (!row) throw new AppError(401, "invalid_token", "token 无效或已吊销");

  if (!row.last_used_at || Date.now() - row.last_used_at.getTime() > TOKEN_USE_WRITE_MS) {
    await db
      .updateTable("api_tokens")
      .set({ last_used_at: new Date() })
      .where("id", "=", row.id)
      .execute();
  }

  const member = actAs && (await memberOrThrow(actAs, "X-Act-As 指定的人"));
  const operator = operatorRef && (await memberOrThrow(operatorRef, "X-Operator 指定的人"));
  if (member && operator && operator.id !== member.id && !STAFF.includes(operator.role)) {
    throw new AppError(403, "operator_not_allowed", "只有版主和管理员能让 bot 代表别人操作");
  }

  const viewer: Viewer = member
    ? { id: member.id, role: member.role, member_status: member.member_status }
    : { id: row.user_id, role: row.role, member_status: row.member_status };
  const bot: Bot = {
    tokenId: row.id,
    scopes: row.scopes,
    actingAs: member !== null,
    operator: operator && { id: operator.id, role: operator.role },
    proxyAllowed: !member || member.allow_proxy || operator?.id === member.id,
  };
  return { viewer, bot };
}

export async function createBotToken(
  actor: Actor,
  input: { name: string; botQq: number; scopes: Scope[] },
) {
  return db.transaction().execute(async (trx) => {
    const botUserId = await ensureBotUser(trx, input.botQq, input.name);
    const token = newToken();
    const { id } = await trx
      .insertInto("api_tokens")
      .values({
        name: input.name,
        token_hash: hashToken(token),
        scopes: input.scopes,
        bot_user_id: botUserId,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await recordAudit(trx, actor, {
      action: "token.create",
      target_type: "token",
      target_id: id,
      data: { name: input.name, scopes: input.scopes, bot_user_id: botUserId },
    });
    return { id, token };
  });
}

export async function listBotTokens() {
  return db
    .selectFrom("api_tokens")
    .innerJoin("users", "users.id", "api_tokens.bot_user_id")
    .select([
      "api_tokens.id",
      "api_tokens.name",
      "api_tokens.scopes",
      "api_tokens.created_at",
      "api_tokens.last_used_at",
      "api_tokens.revoked_at",
      "users.id as bot_user_id",
      "users.qq as bot_qq",
      "users.display_name as bot_name",
    ])
    .orderBy("api_tokens.id", "desc")
    .execute();
}

export async function revokeBotToken(actor: Actor, id: number) {
  await db.transaction().execute(async (trx) => {
    const revoked = await trx
      .updateTable("api_tokens")
      .set({ revoked_at: new Date() })
      .where("id", "=", id)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    if (revoked.numUpdatedRows === 0n) throw new AppError(404, "not_found", "token 不存在或已吊销");
    await recordAudit(trx, actor, { action: "token.revoke", target_type: "token", target_id: id });
  });
}
