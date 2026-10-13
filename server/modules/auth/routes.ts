import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { SCOPES, type UserRef } from "../../platform/access.ts";
import { env } from "../../platform/env.ts";
import { AppError } from "../../platform/errors.ts";
import {
  actorOf,
  authorize,
  clientIp,
  createRouter,
  errorResponse,
  requireWeb,
  unix,
  type AppEnv,
} from "../../platform/http.ts";
import {
  createBotToken,
  endSession,
  listBotTokens,
  listSessions,
  loginMethods,
  loginWithEmailCode,
  loginWithLink,
  requestEmailCode,
  resolveBot,
  resolveSession,
  revokeBotToken,
  SESSION_TTL_MS,
} from "./service.ts";

const COOKIE = "session";
const secure = new URL(env.PUBLIC_URL).protocol === "https:";

function setSessionCookie(c: Context, token: string) {
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

const UserRefSchema = z
  .string()
  .regex(/^(qq:)?\d{1,12}$/, "格式应为 qq:QQ号 或论坛用户 ID")
  .transform((v): UserRef =>
    v.startsWith("qq:") ? { qq: Number(v.slice(3)) } : { id: Number(v) },
  );

function userRefHeader(c: Context, name: string) {
  const value = c.req.header(name);
  if (value === undefined) return null;
  const parsed = UserRefSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(400, "invalid_request", `${name}：${parsed.error.issues[0].message}`);
  }
  return parsed.data;
}

export function bearerToken(c: Context) {
  return c.req.header("authorization")?.match(/^Bearer (\S+)$/)?.[1];
}

// Runs for every request, pages included. Bots authenticate with a bearer token; people with
// the session cookie, whose sliding renewal also refreshes the cookie.
export const authenticate = createMiddleware<AppEnv>(async (c, next) => {
  c.set("bot", null);
  const bearer = bearerToken(c);
  if (bearer) {
    const { viewer, bot } = await resolveBot(
      bearer,
      userRefHeader(c, "X-Act-As"),
      userRefHeader(c, "X-Operator"),
    );
    c.set("viewer", viewer);
    c.set("sessionId", null);
    c.set("bot", bot);
    return next();
  }

  const token = getCookie(c, COOKIE);
  const found = token ? await resolveSession(token) : null;
  c.set("viewer", found?.viewer ?? null);
  c.set("sessionId", found?.id ?? null);
  await next();

  // Written after next(): React Router returns its own Response, which drops headers set before.
  // Login and logout write this cookie themselves, and they win.
  if (!token || c.res.headers.getSetCookie().some((v) => v.startsWith(`${COOKIE}=`))) return;
  if (!found) deleteCookie(c, COOKIE, { path: "/" });
  else if (found.renewed) setSessionCookie(c, token);
});

function client(c: Context) {
  return { ip: clientIp(c), userAgent: c.req.header("user-agent") ?? "" };
}

const SessionSchema = z
  .object({
    id: z.number(),
    user_agent: z.string(),
    ip: z.string().nullable(),
    created_at: z.number(),
    last_seen_at: z.number(),
    current: z.boolean(),
  })
  .openapi("Session");

const BotTokenSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    scopes: z.array(z.string()),
    bot: z.object({ id: z.number(), qq: z.number().nullable(), display_name: z.string() }),
    created_at: z.number(),
    last_used_at: z.number().nullable(),
    revoked_at: z.number().nullable(),
  })
  .openapi("BotToken");

const Qq = z.number().int().min(10000).max(99_999_999_999);

export const authRoutes = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/auth/methods",
      summary: "开着的登录方式；邮件服务没配置时邮箱登录也算关闭",
      responses: {
        200: {
          description: "每种方式是否可用",
          content: {
            "application/json": {
              schema: z.object({ code: z.boolean(), link: z.boolean(), email: z.boolean() }),
            },
          },
        },
      },
    }),
    async (c) => c.json(await loginMethods(), 200),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/auth/email",
      summary: "把登录验证码发到 QQ号@qq.com",
      request: {
        body: { required: true, content: { "application/json": { schema: z.object({ qq: Qq }) } } },
      },
      responses: {
        204: { description: "已发送，10 分钟内有效" },
        403: errorResponse("这个 QQ 号没有同步过，或者邮箱登录已关闭"),
        429: errorResponse("同一个 QQ 号 60 秒内只能发一次，每天最多 10 次"),
        502: errorResponse("邮件发送失败"),
        503: errorResponse("邮件服务还没有配置"),
      },
    }),
    async (c) => {
      await requestEmailCode(c.req.valid("json").qq, clientIp(c));
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/auth/email/verify",
      summary: "用邮件验证码登录",
      request: {
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({ qq: Qq, code: z.string().regex(/^\d{6}$/, "应为 6 位数字") }),
            },
          },
        },
      },
      responses: {
        204: { description: "已登录，会话写在 Cookie 里" },
        400: errorResponse("验证码不对、已过期或输错太多次"),
        403: errorResponse("账号已被封禁，或者邮箱登录已关闭"),
      },
    }),
    async (c) => {
      const { qq, code } = c.req.valid("json");
      setSessionCookie(c, await loginWithEmailCode(qq, code, client(c)));
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/auth/link",
      summary: "使用一次性登录链接，建立会话",
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: z.object({ token: z.string() }) } },
        },
      },
      responses: {
        204: { description: "已登录，会话写在 Cookie 里" },
        400: errorResponse("链接无效、已用过或已过期"),
      },
    }),
    async (c) => {
      const token = await loginWithLink(c.req.valid("json").token, client(c));
      setSessionCookie(c, token);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/auth/logout",
      summary: "退出当前会话；没有登录时也返回成功",
      responses: { 204: { description: "已退出" } },
    }),
    async (c) => {
      const viewer = c.var.viewer;
      const sessionId = c.var.sessionId;
      if (viewer && sessionId) await endSession(viewer.id, sessionId);
      deleteCookie(c, COOKIE, { path: "/" });
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/me/sessions",
      summary: "已登录的设备",
      responses: {
        200: {
          description: "按最近使用时间排序",
          content: {
            "application/json": { schema: z.object({ items: z.array(SessionSchema) }) },
          },
        },
        401: errorResponse("没有登录"),
      },
    }),
    async (c) => {
      const viewer = requireWeb(c);
      const sessions = await listSessions(viewer.id);
      const items = sessions.map((s) => ({
        ...s,
        created_at: unix(s.created_at),
        last_seen_at: unix(s.last_seen_at),
        current: s.id === c.var.sessionId,
      }));
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/me/sessions/{id}",
      summary: "让某个设备下线",
      request: { params: z.object({ id: z.coerce.number().int() }) },
      responses: {
        204: { description: "已下线" },
        401: errorResponse("没有登录"),
        404: errorResponse("不是自己的设备，或者已经下线"),
      },
    }),
    async (c) => {
      const viewer = requireWeb(c);
      await endSession(viewer.id, c.req.valid("param").id);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/admin/tokens",
      summary: "bot token 列表，包括已吊销的；只能在网页上操作",
      responses: {
        200: {
          description: "最新的在前",
          content: {
            "application/json": { schema: z.object({ items: z.array(BotTokenSchema) }) },
          },
        },
        401: errorResponse("没有登录"),
        403: errorResponse("不是管理员，或者用 bot token 调用"),
      },
    }),
    async (c) => {
      requireWeb(c);
      authorize(c, "admin");
      const tokens = await listBotTokens();
      const items = tokens.map((t) => ({
        id: t.id,
        name: t.name,
        scopes: t.scopes,
        bot: { id: t.bot_user_id, qq: t.bot_qq, display_name: t.bot_name },
        created_at: unix(t.created_at),
        last_used_at: t.last_used_at && unix(t.last_used_at),
        revoked_at: t.revoked_at && unix(t.revoked_at),
      }));
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/admin/tokens",
      summary: "创建 bot token；token 只在这次返回",
      request: {
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({
                name: z.string().trim().min(1).max(40),
                bot_qq: z.number().int().min(10000),
                scopes: z
                  .array(z.enum(SCOPES))
                  .min(1)
                  .transform((s) => [...new Set(s)]),
              }),
            },
          },
        },
      },
      responses: {
        201: {
          description: "已创建",
          content: {
            "application/json": { schema: z.object({ id: z.number(), token: z.string() }) },
          },
        },
        401: errorResponse("没有登录"),
        403: errorResponse("不是管理员，或者用 bot token 调用"),
        409: errorResponse("这个 QQ 号是登录过的群友"),
      },
    }),
    async (c) => {
      requireWeb(c);
      const viewer = authorize(c, "admin");
      const { name, bot_qq, scopes } = c.req.valid("json");
      const created = await createBotToken(actorOf(c, viewer), { name, botQq: bot_qq, scopes });
      return c.json(created, 201);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/admin/tokens/{id}",
      summary: "吊销 bot token",
      request: { params: z.object({ id: z.coerce.number().int() }) },
      responses: {
        204: { description: "已吊销" },
        401: errorResponse("没有登录"),
        403: errorResponse("不是管理员，或者用 bot token 调用"),
        404: errorResponse("token 不存在或已吊销"),
      },
    }),
    async (c) => {
      requireWeb(c);
      const viewer = authorize(c, "admin");
      await revokeBotToken(actorOf(c, viewer), c.req.valid("param").id);
      return c.body(null, 204);
    },
  );
