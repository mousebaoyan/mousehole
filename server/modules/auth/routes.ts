import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { env } from "../../platform/env.ts";
import {
  createRouter,
  errorResponse,
  requireViewer,
  unix,
  type AppEnv,
} from "../../platform/http.ts";
import {
  endSession,
  listSessions,
  loginWithLink,
  resolveSession,
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

// Runs for every request, pages included, so sliding renewal also refreshes the cookie.
export const session = createMiddleware<AppEnv>(async (c, next) => {
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
  return { ip: c.req.header("x-real-ip") ?? null, userAgent: c.req.header("user-agent") ?? "" };
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

export const authRoutes = createRouter()
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
      const viewer = requireViewer(c.var.viewer);
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
      const viewer = requireViewer(c.var.viewer);
      await endSession(viewer.id, c.req.valid("param").id);
      return c.body(null, 204);
    },
  );
