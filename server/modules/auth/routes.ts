import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { Viewer } from "../../platform/access.ts";
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
  confirmLoginCode,
  createLoginCode,
  endSession,
  issueLinkFor,
  listSessions,
  loginMethods,
  loginWithEmailCode,
  loginWithLink,
  pollLoginCode,
  requestEmailCode,
  resolveBot,
  resolveSession,
  SESSION_TTL_MS,
} from "./service.ts";
import { UserRefSchema } from "../users/schemas.ts";
import { deviceSummary } from "./device.ts";

const COOKIE = "session";
// Held by the browser that asked for a login code, until the code is used or expires.
const CODE_COOKIE = "login_code";
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

export type Visitor = { viewer: Viewer | null; sessionId: number | null };

// A page's loaders call the API in-process (app/api.server.ts) as the visitor the page request
// was already found to be, which spares each call looking the session up again. Kept out of the
// headers, which anyone could send.
const visitors = new WeakMap<Request, Visitor>();

export function asVisitor(request: Request, visitor: Visitor) {
  visitors.set(request, visitor);
  return request;
}

// Runs for every request, pages included. Bots authenticate with a bearer token; people with
// the session cookie, whose sliding renewal also refreshes the cookie.
export const authenticate = createMiddleware<AppEnv>(async (c, next) => {
  c.set("bot", null);
  const known = visitors.get(c.req.raw);
  if (known) {
    c.set("viewer", known.viewer);
    c.set("sessionId", known.sessionId);
    return next();
  }
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
    device: z.string().openapi({ example: "Chrome · macOS" }),
    ip: z.string().nullable(),
    created_at: z.number(),
    last_seen_at: z.number(),
    current: z.boolean(),
  })
  .openapi("Session");

const Qq = z.number().int().min(10000).max(99_999_999_999);

// Login on someone's behalf only makes sense for the member in X-Act-As.
function requireActAs(c: Context<AppEnv>) {
  const viewer = authorize(c, "auth");
  if (!c.var.bot?.actingAs) {
    throw new AppError(400, "act_as_required", "需要用 X-Act-As 指定要登录的成员");
  }
  return viewer;
}

const PendingCode = z.object({
  status: z.literal("pending"),
  code: z.string(),
  expires_at: z.number(),
  hint: z.string(),
});

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
      path: "/auth/code",
      summary: "申请登录口令，5 分钟有效；同时给这个浏览器设置一个 Cookie，用来查询口令状态",
      responses: {
        200: {
          description: "口令和提示文案",
          content: { "application/json": { schema: PendingCode.omit({ status: true }) } },
        },
        403: errorResponse("口令登录已关闭"),
        429: errorResponse("申请太频繁"),
      },
    }),
    async (c) => {
      const { secret, code, expires_at, hint } = await createLoginCode(client(c));
      setCookie(c, CODE_COOKIE, secret, {
        httpOnly: true,
        secure,
        sameSite: "Lax",
        path: "/",
        maxAge: Math.ceil((expires_at.getTime() - Date.now()) / 1000),
      });
      return c.json({ code, expires_at: unix(expires_at), hint }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/auth/code",
      summary: "浏览器轮询口令状态；bot 确认后在这里建立会话",
      responses: {
        200: {
          description: "还在等确认，或者已经登录",
          content: {
            "application/json": {
              schema: z.discriminatedUnion("status", [
                PendingCode,
                z.object({ status: z.literal("confirmed") }),
              ]),
            },
          },
        },
        403: errorResponse("账号已被封禁"),
        410: errorResponse("这个浏览器没有有效的口令，需要重新申请"),
      },
    }),
    async (c) => {
      const secret = getCookie(c, CODE_COOKIE);
      const state = secret ? await pollLoginCode(secret, client(c)) : null;
      if (!state) {
        if (secret) deleteCookie(c, CODE_COOKIE, { path: "/" });
        throw new AppError(410, "login_code_expired", "口令已过期，请重新获取");
      }
      if (state.status === "pending") {
        return c.json({ ...state, expires_at: unix(state.expires_at) }, 200);
      }
      deleteCookie(c, CODE_COOKIE, { path: "/" });
      setSessionCookie(c, state.token);
      return c.json({ status: state.status }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/bot/auth/code/confirm",
      summary: "以 X-Act-As 的身份确认登录口令，返回发起口令的浏览器的设备摘要",
      request: {
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({ code: z.string().regex(/^\d{6}$/, "验证码应为 6 位数字") }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "已确认，浏览器下一次查询时登录",
          content: {
            "application/json": {
              schema: z.object({ device: z.string().openapi({ example: "Chrome · macOS" }) }),
            },
          },
        },
        400: errorResponse("没有带 X-Act-As"),
        403: errorResponse("token 没有 auth 范围、口令登录已关闭，或者账号已被封禁"),
        404: errorResponse("口令无效或已过期"),
        429: errorResponse("同一个人确认太频繁"),
      },
    }),
    async (c) => {
      const viewer = requireActAs(c);
      return c.json(await confirmLoginCode(actorOf(c, viewer), c.req.valid("json").code), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/bot/auth/links",
      summary: "给 X-Act-As 的成员签发一次性登录链接，10 分钟有效",
      responses: {
        200: {
          description: "私聊发给这位成员",
          content: {
            "application/json": {
              schema: z.object({ url: z.string(), expires_at: z.number() }),
            },
          },
        },
        400: errorResponse("没有带 X-Act-As"),
        403: errorResponse("token 没有 auth 范围、链接登录已关闭，或者账号已被封禁"),
        429: errorResponse("同一个人申请太频繁"),
      },
    }),
    async (c) => {
      const viewer = requireActAs(c);
      const { token, expires_at } = await issueLinkFor(actorOf(c, viewer));
      const url = `${env.PUBLIC_URL}/login/link?token=${token}`;
      return c.json({ url, expires_at: unix(expires_at) }, 200);
    },
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
              schema: z.object({
                qq: Qq,
                code: z.string().regex(/^\d{6}$/, "验证码应为 6 位数字"),
              }),
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
      if (viewer && sessionId) await endSession(actorOf(c, viewer), sessionId, true);
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
        device: deviceSummary(s.user_agent),
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
      await endSession(actorOf(c, viewer), c.req.valid("param").id, false);
      return c.body(null, 204);
    },
  );
