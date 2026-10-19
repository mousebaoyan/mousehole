import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { isCrawler } from "../../platform/crawlers.ts";
import { env } from "../../platform/env.ts";
import {
  authorize,
  authorizeOwner,
  clientIp,
  createRouter,
  errorResponse,
  type AppEnv,
} from "../../platform/http.ts";
import { UserBriefSchema, UserRefSchema } from "../users/schemas.ts";
import { findUserId, userBriefs } from "../users/service.ts";
import {
  getStats,
  listVisits,
  othersAtAddresses,
  RANGES,
  recordSent,
  recordVisit,
  type Sent,
} from "./service.ts";

const SITE = new URL(env.PUBLIC_URL).origin;

// The page a response opened: its HTML, or its data fetched in the browser on the way there. Not
// what the pages' fetchers load, which `_routes` names, nor a page loading again after a change,
// which it asks for itself.
function openedPage(c: Context, referer: URL | null, fetched: Set<string>) {
  if (c.req.method !== "GET" || c.res.status !== 200) return null;
  const url = new URL(c.req.url);
  if (c.res.headers.get("content-type")?.startsWith("text/html")) return url.pathname;
  if (!url.pathname.endsWith(".data")) return null;
  const routes = url.searchParams.get("_routes")?.split(",") ?? [];
  if (routes.some((id) => fetched.has(id))) return null;
  url.searchParams.delete("_routes");
  const path = url.pathname === "/_root.data" ? "/" : url.pathname.slice(0, -".data".length);
  return referer?.pathname === path && referer.search === url.search ? null : path;
}

function kindOf(path: string): Sent {
  if (path.startsWith("/api/")) return "api";
  if (/^\/(?:uploads|avatars|backgrounds)\//.test(path)) return "image";
  return /\.\w+$/.test(path) && !path.endsWith(".data") ? "asset" : "page";
}

// What each response sent, by kind, and the pages people opened (design §10.1). `fetched` are
// the routes the pages' fetchers load. Bodies of unknown length are counted as they go out.
export function countVisits(fetched: Set<string>) {
  return createMiddleware<AppEnv>(async (c, next) => {
    await next();
    const kind = kindOf(c.req.path);
    const body = c.res.body;
    const length = c.res.headers.get("content-length");
    if (body && length !== null) recordSent(kind, Number(length));
    else if (body) {
      const counted = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          recordSent(kind, chunk.byteLength);
          controller.enqueue(chunk);
        },
      });
      c.res = new Response(body.pipeThrough(counted), c.res);
    }

    const ip = clientIp(c);
    const userAgent = c.req.header("user-agent");
    const referer = URL.parse(c.req.header("referer") ?? "");
    const page = openedPage(c, referer, fetched);
    // Requests from inside the server, such as the guest page cache refreshing a page, have no
    // address.
    if (page === null || ip === null || !userAgent || isCrawler(userAgent)) return;
    recordVisit({
      ip,
      user_agent: userAgent,
      // Pages from the guest page cache never reach the session lookup.
      user_id: c.var.viewer?.id ?? null,
      referrer: referer && referer.origin !== SITE ? referer.hostname : null,
      landing: page,
    });
  });
}

const Kinds = z
  .object({ site: z.number(), qq: z.number(), total: z.number() })
  .openapi({ description: "论坛、群里、合起来" });

const Bytes = z.object({
  page: z.number(),
  api: z.number(),
  image: z.number().openapi({ description: "正文图、头像和背景" }),
  asset: z.number().openapi({ description: "静态文件" }),
});

const Totals = z.object({
  dau: Kinds.openapi({ description: "平均日活，只算过完了的天" }),
  wau: Kinds.openapi({ description: "截至最后一天的 7 天里来过的人" }),
  mau: Kinds.openapi({ description: "截至最后一天的 30 天里来过的人" }),
  new_activated: z.number(),
  read_seconds: z.number(),
  posts_read: z.number(),
  guests: z.number().nullable().openapi({ description: "平均每天的访客，只算过完了的天" }),
  guest_views: z.number().nullable().openapi({ description: "平均每天访客的浏览量" }),
  member_views: z.number().nullable().openapi({ description: "平均每天成员的浏览量" }),
  bytes: Bytes.nullable().openapi({ description: "平均每天发出的字节数" }),
});

const Count = z.number().openapi({ description: "人次，每人每天算一次" });

export const statsRoutes = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/admin/stats",
      summary: "数据页：活跃、成员、留存、阅读、访问和带宽，按北京时间逐天，不算 bot 和站长",
      request: {
        query: z.object({
          range: z.coerce
            .number()
            .pipe(z.literal(RANGES))
            .default(30)
            .openapi({ description: "最近几天，含今天" }),
        }),
      },
      responses: {
        200: {
          description: "逐天的数，整段和前一段的合计，最近 12 周的留存",
          content: {
            "application/json": {
              schema: z.object({
                range: z.number(),
                days: z.array(
                  z.object({
                    day: z.string().openapi({ description: "YYYY-MM-DD" }),
                    active: Kinds,
                    members: z.number().nullable().openapi({ description: "那天的群成员数" }),
                    activated: z.number().nullable().openapi({ description: "其中已激活的" }),
                    new_activated: z.number(),
                    joined: z.number().openapi({ description: "进群的人次，按群算" }),
                    left: z.number().openapi({ description: "退群的人次，按群算" }),
                    read_seconds: z.number(),
                    posts_read: z.number(),
                    guests: z.number().nullable().openapi({
                      description: "访客人数：没登录的 IP + User-Agent；开始记录以前为 null",
                    }),
                    guest_views: z.number().nullable(),
                    member_views: z.number().nullable(),
                    bytes: Bytes.nullable().openapi({ description: "发出的字节数" }),
                  }),
                ),
                totals: z.object({
                  now: Totals,
                  before: Totals.openapi({ description: "前一段同样长的时间" }),
                }),
                retention: z.array(
                  z.object({
                    week: z.string().openapi({ description: "这一周的周一" }),
                    size: z.number().openapi({ description: "这一周激活的人数" }),
                    back: z.array(z.number().nullable()).openapi({
                      description: "其中第 1、2、4、8 周来过论坛的人数，那一周还没过完时为 null",
                    }),
                  }),
                ),
                referrers: z
                  .array(z.object({ host: z.string(), visits: Count }))
                  .openapi({ description: "访客从哪些网站来，按域名" }),
                landings: z
                  .array(
                    z.object({
                      path: z.string(),
                      title: z.string().nullable().openapi({ description: "帖子页的标题" }),
                      visits: Count,
                    }),
                  )
                  .openapi({ description: "访客最先打开的页面" }),
                devices: z
                  .object({
                    guests: z.array(z.object({ device: z.string(), visits: Count })),
                    members: z.array(z.object({ device: z.string(), visits: Count })),
                  })
                  .openapi({ description: "浏览器和系统" }),
              }),
            },
          },
        },
        403: errorResponse("不是管理员"),
      },
    }),
    async (c) => {
      authorize(c, "admin");
      return c.json(await getStats(c.req.valid("query").range), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/users/{user}/visits",
      summary: "访问记录：每天用过的 IP 和设备、浏览数，以及这些 IP 上的其他账号；只有站长能看",
      request: {
        params: z.object({ user: UserRefSchema }),
        query: z.object({
          cursor: z.coerce
            .number()
            .int()
            .min(0)
            .optional()
            .openapi({ description: "已经列出的条数" }),
        }),
      },
      responses: {
        200: {
          description: "最近的在前，每页 50 条",
          content: {
            "application/json": {
              schema: z.object({
                items: z.array(
                  z.object({
                    day: z.string().openapi({ description: "YYYY-MM-DD" }),
                    ip: z.string(),
                    device: z.string().openapi({ example: "Chrome · Windows" }),
                    user_agent: z.string(),
                    views: z.number(),
                  }),
                ),
                next_cursor: z.string().nullable(),
                others: z
                  .array(z.object({ user: UserBriefSchema, ips: z.array(z.string()) }))
                  .openapi({
                    description: "这些 IP 上来过的其他账号，共用的 IP 多的在前，最多 20 个",
                  }),
              }),
            },
          },
        },
        403: errorResponse("不是站长，或者不是在网页上"),
        404: errorResponse("用户不存在"),
      },
    }),
    async (c) => {
      authorizeOwner(c);
      const userId = await findUserId(c.req.valid("param").user);
      const [page, others] = await Promise.all([
        listVisits(userId, c.req.valid("query").cursor ?? 0),
        othersAtAddresses(userId),
      ]);
      const user = await userBriefs(others.map((o) => o.user_id));
      return c.json(
        {
          items: page.items,
          next_cursor: page.next === null ? null : String(page.next),
          others: others.map((o) => ({ user: user(o.user_id), ips: o.ips })),
        },
        200,
      );
    },
  );
