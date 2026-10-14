import { randomInt } from "node:crypto";
import type { Kysely, NotNull, Transaction } from "kysely";
import type { DB } from "../../../db/types.ts";
import {
  restrictionOf,
  STAFF,
  type Actor,
  type Bot,
  type Scope,
  type UserRef,
  type Viewer,
} from "../../platform/access.ts";
import { db } from "../../platform/db.ts";
import { AppError } from "../../platform/errors.ts";
import { sendMail } from "../../platform/mail.ts";
import { rateLimit } from "../../platform/rate-limit.ts";
import { getSettings } from "../../platform/settings.ts";
import { hashToken, newToken } from "../../platform/tokens.ts";
import { recordAudit } from "../audit/service.ts";
import { deviceSummary } from "./device.ts";
import { ensureBotUser, findMember, recordLogin, recordSeen } from "../users/service.ts";
import { SITE_NAME } from "../../platform/site.ts";

export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const LINK_TTL_MS = 10 * 60 * 1000;
// Sliding renewal rewrites the session row at most this often.
const RENEW_AFTER_MS = 60 * 60 * 1000;
const TOKEN_USE_WRITE_MS = 60 * 1000;
const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
const LOGIN_CODE_TTL_MS = 5 * 60 * 1000;
const EMAIL_CODE_ATTEMPTS = 5;
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

type Client = { ip: string | null; userAgent: string };

function sixDigits() {
  return String(randomInt(1_000_000)).padStart(6, "0");
}

export async function issueLoginLink(userId: number, executor: Kysely<DB> = db) {
  const token = newToken();
  await executor
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

// Email login also needs a mail server; without one it is off rather than failing on send.
export async function loginMethods() {
  const { login, smtp } = await getSettings();
  return { code: login.code, link: login.link, email: login.email && smtp.host !== "" };
}

async function requireMethod(method: "code" | "link" | "email") {
  if (!(await loginMethods())[method]) {
    throw new AppError(403, "login_method_disabled", "这种登录方式已关闭，请换一种");
  }
}

export async function loginWithLink(token: string, client: Client) {
  await requireMethod("link");
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

async function assertNotBanned(executor: Kysely<DB>, userId: number) {
  const user = await executor
    .selectFrom("users")
    .select(["restriction", "restricted_until"])
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();
  const restriction = restrictionOf(user.restriction, user.restricted_until);
  if (restriction?.type !== "ban") return;
  const until = restriction.until
    ? `，到 ${restriction.until.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })} 解封`
    : "";
  throw new AppError(403, "banned", `账号已被封禁${until}`);
}

// Every way of logging in ends here, so the ban check lives here too.
async function startSession(trx: Transaction<DB>, userId: number, client: Client) {
  await assertNotBanned(trx, userId);
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
      "users.restriction",
      "users.restricted_until",
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
  const viewer: Viewer = {
    id: row.user_id,
    role: row.role,
    member_status: row.member_status,
    restriction: restrictionOf(row.restriction, row.restricted_until),
  };
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

// A ban logs the person out everywhere.
export async function endAllSessions(trx: Transaction<DB>, userId: number) {
  await trx.deleteFrom("sessions").where("user_id", "=", userId).execute();
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
      "users.restriction",
      "users.restricted_until",
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

  if (actAs && !operatorRef && (await getSettings()).bot.require_operator) {
    throw new AppError(
      400,
      "operator_required",
      "代表成员操作时要用 X-Operator 指明是谁让 bot 做的",
    );
  }
  const member = actAs && (await memberOrThrow(actAs, "X-Act-As 指定的人"));
  const operator = operatorRef && (await memberOrThrow(operatorRef, "X-Operator 指定的人"));
  if (member && operator && operator.id !== member.id && !STAFF.includes(operator.role)) {
    throw new AppError(403, "operator_not_allowed", "只有版主和管理员能让 bot 代表别人操作");
  }

  const viewer: Viewer = member
    ? {
        id: member.id,
        role: member.role,
        member_status: member.member_status,
        restriction: restrictionOf(member.restriction, member.restricted_until),
      }
    : {
        id: row.user_id,
        role: row.role,
        member_status: row.member_status,
        restriction: restrictionOf(row.restriction, row.restricted_until),
      };
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

// Sends a 6-digit code to the member's QQ mailbox, after the code is stored and outside any
// transaction. A new request overwrites the last code.
export async function requestEmailCode(qq: number, ip: string | null) {
  await requireMethod("email");
  rateLimit(`email:ip:${ip}`, 10, 10 * MINUTE);
  const member = await findMember({ qq });
  if (!member) throw new AppError(403, "not_member", "这个 QQ 号不在群里，或者还没有同步到论坛");
  rateLimit(`email:qq:${qq}:minute`, 1, MINUTE);
  rateLimit(`email:qq:${qq}:day`, 10, DAY);

  const code = sixDigits();
  const expires_at = new Date(Date.now() + EMAIL_CODE_TTL_MS);
  await db
    .insertInto("email_codes")
    .values({ user_id: member.id, code, expires_at })
    .onConflict((oc) =>
      oc.column("user_id").doUpdateSet({ code, attempts: 0, sent_at: new Date(), expires_at }),
    )
    .execute();
  await sendMail(
    `${qq}@qq.com`,
    `${SITE_NAME}登录验证码：${code}`,
    `你的${SITE_NAME}登录验证码是 ${code}，10 分钟内有效。\n\n如果不是你本人操作，请忽略这封邮件。`,
  );
}

export async function loginWithEmailCode(qq: number, code: string, client: Client) {
  await requireMethod("email");
  const member = await findMember({ qq });
  // Each check spends an attempt, counted in the same statement that reads the code.
  const stored =
    member &&
    (await db
      .updateTable("email_codes")
      .set((eb) => ({ attempts: eb("attempts", "+", 1) }))
      .where("user_id", "=", member.id)
      .where("expires_at", ">", new Date())
      .where("attempts", "<", EMAIL_CODE_ATTEMPTS)
      .returning(["code", "attempts"])
      .executeTakeFirst());
  if (!member || !stored) {
    throw new AppError(400, "email_code_invalid", "验证码无效、已过期或输错太多次，请重新获取");
  }
  if (stored.code !== code) {
    const left = EMAIL_CODE_ATTEMPTS - stored.attempts;
    throw new AppError(
      400,
      "email_code_invalid",
      left > 0 ? `验证码不对，还能再试 ${left} 次` : "验证码输错太多次，已作废，请重新获取",
    );
  }

  return db.transaction().execute(async (trx) => {
    await trx.deleteFrom("email_codes").where("user_id", "=", member.id).execute();
    const actor = { userId: member.id, operatorId: null, tokenId: null, ip: client.ip };
    await recordAudit(trx, actor, { action: "auth.login", data: { method: "email" } });
    return startSession(trx, member.id, client);
  });
}

// A login code for this browser: it keeps `secret` in a cookie and polls with it while the
// member sends `code` to the bot. Expired code tickets are cleared here, which keeps the table
// small and their codes free.
export async function createLoginCode(client: Client) {
  await requireMethod("code");
  rateLimit(`code:ip:${client.ip}`, 20, 10 * MINUTE);
  await db
    .deleteFrom("login_tickets")
    .where("kind", "=", "code")
    .where("expires_at", "<=", new Date())
    .execute();

  const secret = newToken();
  const expires_at = new Date(Date.now() + LOGIN_CODE_TTL_MS);
  // Six digits can collide with a live code; draw again.
  for (;;) {
    const code = sixDigits();
    const created = await db
      .insertInto("login_tickets")
      .values({
        kind: "code",
        secret_hash: hashToken(secret),
        code,
        user_agent: client.userAgent,
        ip: client.ip,
        expires_at,
      })
      .onConflict((oc) => oc.column("code").doNothing())
      .returning("id")
      .executeTakeFirst();
    if (created) return { secret, code, expires_at, hint: await codeHint(code) };
  }
}

async function codeHint(code: string) {
  return (await getSettings()).login.code_hint.replace("{code}", code);
}

// What the browser holding `secret` sees: nothing once expired, the code while waiting, and a
// new session once a bot has confirmed it.
export async function pollLoginCode(secret: string, client: Client) {
  const ticket = await db
    .selectFrom("login_tickets")
    .select(["id", "code", "user_id", "expires_at"])
    .where("kind", "=", "code")
    .where("secret_hash", "=", hashToken(secret))
    .where("expires_at", ">", new Date())
    .$narrowType<{ code: NotNull }>()
    .executeTakeFirst();
  if (!ticket) return null;
  if (ticket.user_id === null) {
    const hint = await codeHint(ticket.code);
    return { status: "pending" as const, code: ticket.code, expires_at: ticket.expires_at, hint };
  }

  return db.transaction().execute(async (trx) => {
    // Deleting first makes a confirmed code good for one session only.
    const used = await trx
      .deleteFrom("login_tickets")
      .where("id", "=", ticket.id)
      .returning("user_id")
      .$narrowType<{ user_id: NotNull }>()
      .executeTakeFirst();
    if (!used) return null;
    const actor = { userId: used.user_id, operatorId: null, tokenId: null, ip: client.ip };
    await recordAudit(trx, actor, { action: "auth.login", data: { method: "code" } });
    return { status: "confirmed" as const, token: await startSession(trx, used.user_id, client) };
  });
}

// A bot, acting as the member who sent the code, confirms it. Returns the waiting browser's
// device, so the member notices if someone tricked them into sending a code.
export async function confirmLoginCode(actor: Actor, code: string) {
  await requireMethod("code");
  rateLimit(`code:user:${actor.userId}`, 10, 10 * MINUTE);
  return db.transaction().execute(async (trx) => {
    await assertNotBanned(trx, actor.userId);
    const ticket = await trx
      .updateTable("login_tickets")
      .set({ user_id: actor.userId })
      .where("kind", "=", "code")
      .where("code", "=", code)
      .where("user_id", "is", null)
      .where("expires_at", ">", new Date())
      .returning("user_agent")
      .executeTakeFirst();
    if (!ticket) throw new AppError(404, "login_code_invalid", "口令无效或已过期");
    await recordAudit(trx, actor, {
      action: "auth.code_confirm",
      target_type: "user",
      target_id: actor.userId,
    });
    return { device: deviceSummary(ticket.user_agent) };
  });
}

// A one-time login link for the member a bot acts as, to send them in a private chat.
export async function issueLinkFor(actor: Actor) {
  await requireMethod("link");
  rateLimit(`link:user:${actor.userId}`, 10, 60 * MINUTE);
  return db.transaction().execute(async (trx) => {
    await assertNotBanned(trx, actor.userId);
    const token = await issueLoginLink(actor.userId, trx);
    await recordAudit(trx, actor, {
      action: "auth.link_issue",
      target_type: "user",
      target_id: actor.userId,
    });
    return { token, expires_at: new Date(Date.now() + LINK_TTL_MS) };
  });
}

// Daily: sessions, login codes and links, and email codes past their time.
export async function clearExpiredLogins() {
  const now = new Date();
  await db.deleteFrom("sessions").where("expires_at", "<", now).execute();
  await db.deleteFrom("login_tickets").where("expires_at", "<", now).execute();
  await db.deleteFrom("email_codes").where("expires_at", "<", now).execute();
}
