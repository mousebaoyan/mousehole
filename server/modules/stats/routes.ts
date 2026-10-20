import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { isCrawler } from "../../platform/crawlers.ts";
import { env } from "../../platform/env.ts";
import { recordClick, recordOpen } from "../../platform/mail.ts";
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
  activeUsers,
  getStats,
  listVisits,
  othersAtAddresses,
  RANGES,
  recordSent,
  recordVisit,
  type Sent,
  USER_SORTS,
} from "./service.ts";

const SITE = new URL(env.PUBLIC_URL).origin;

const Range = z.coerce
  .number()
  .pipe(z.literal(RANGES))
  .default(30)
  .openapi({ description: "最近几天，含今天" });

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

// A transparent 1×1 GIF.
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

// The image at the end of reminders and letters, loaded when one is opened (design §8.6). Only the
// first time counts, so mail apps may keep it.
export async function serveMailOpen(c: Context<AppEnv, "/mail/:file{[0-9]+\\.gif}">) {
  await recordOpen(c.req.param("file").slice(0, -".gif".length), c.req.query("s") ?? "");
  return c.body(PIXEL, 200, {
    "content-type": "image/gif",
    "cache-control": "public, max-age=31536000, immutable",
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

const Sources = z
  .object({ web: z.number(), bot: z.number(), qq: z.number() })
  .openapi({ description: "网页上、bot 代发、群里收录" });

const Content = z
  .object({ threads: Sources, replies: Sources, reactions: Sources })
  .openapi({ description: "公开的新帖、回复和表情回应，收录的按在群里说的时间算" });

const Logins = z
  .object({ code: z.number(), link: z.number(), email: z.number() })
  .openapi({ description: "口令、链接、QQ 邮箱验证码三种方式各登录了几次" });

const Coins = z
  .object({
    earned: z
      .object({ check_in: z.number(), liked: z.number(), accepted: z.number(), bounty: z.number() })
      .openapi({ description: "发出的：签到、获赞、回复被采纳、回答悬赏" }),
    spent: z
      .object({ question: z.number(), look: z.number() })
      .openapi({ description: "花掉的：发问答帖、兑换动态版" }),
  })
  .openapi({ description: "鼠币，按记账的那天；获赞、采纳和悬赏次日结算" });

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
  content: Content,
  questions: z
    .object({
      asked: z.number(),
      solved: z.number().openapi({ description: "其中已解决的" }),
      answered: z.number().openapi({ description: "其中有别人回复的" }),
      wait: z
        .number()
        .nullable()
        .openapi({ description: "第一条别人回复的等待时间的中位数，秒；没人回复过时为 null" }),
    })
    .openapi({ description: "这一段在论坛上发的问答帖，不算群里收录的" }),
  logins: Logins,
  coins: Coins,
});

const Made = z.object({
  replies: z.number().openapi({ description: "这一段公开的新回复" }),
  reactions: z.number().openapi({ description: "这一段公开的楼层收到的表情回应" }),
});

const Count = z.number().openapi({ description: "人次，每人每天算一次" });

export const statsRoutes = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/admin/stats",
      summary:
        "数据页：活跃、成员、留存、访问、内容、阅读、登录、邮件、搜索、鼠币、带宽和排行，按北京时间逐天，不算 bot 和站长",
      request: {
        query: z.object({
          range: Range,
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
                    content: Content,
                    logins: Logins,
                    coins: Coins,
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
                mail: z
                  .array(
                    z.object({
                      kind: z
                        .string()
                        .openapi({ description: "通知类型、weekly、login（验证码）或 test" }),
                      sent: z.number(),
                      dropped: z.number().openapi({ description: "发不出去丢掉的" }),
                      opened: z.number().nullable().openapi({
                        description: "其中打开过的；验证码和测试邮件不记，为 null",
                      }),
                      clicked: z.number().nullable().openapi({ description: "其中点击过的" }),
                    }),
                  )
                  .openapi({ description: "这一段的邮件，按类，发得多的在前" }),
                searches: z
                  .object({
                    most: z
                      .array(z.object({ term: z.string(), searches: z.number() }))
                      .openapi({ description: "搜得最多的词，前 20" }),
                    unfound: z.array(z.object({ term: z.string(), searches: z.number() })).openapi({
                      description: "没有结果的词，前 20；searches 是没有结果的次数",
                    }),
                  })
                  .openapi({
                    description: "这一段网页上搜的词，转成小写；每人每天搜同一个词算一次",
                  }),
                top: z
                  .object({
                    threads: z.array(
                      z.object({ id: z.number(), title: z.string(), ...Made.shape }),
                    ),
                    boards: z.array(
                      z.object({ slug: z.string(), name: z.string(), ...Made.shape }),
                    ),
                    tags: z.array(z.object({ name: z.string(), ...Made.shape })),
                  })
                  .openapi({
                    description: "这一段新回复和表情回应合起来最多的帖子、版块和标签，各前 10",
                  }),
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
      path: "/admin/stats/users",
      summary:
        "数据页的活跃用户：这段时间在论坛上做得最多的前 30 人，按北京时间，不算 bot 和站长，也不算群里收录、bot 代发和匿名的",
      request: {
        query: z.object({
          range: Range,
          sort: z
            .enum(USER_SORTS)
            .default("posts")
            .openapi({ description: "按哪一项排，posts 是发帖和回复合起来；这一项为 0 的不列" }),
          staff: z
            .enum(["true", "false"])
            .default("true")
            .transform((v) => v === "true")
            .openapi({ description: "false 时不含版主和管理员" }),
        }),
      },
      responses: {
        200: {
          description: "从多到少",
          content: {
            "application/json": {
              schema: z.object({
                items: z.array(
                  z.object({
                    user: UserBriefSchema,
                    days: z.number().openapi({ description: "来过论坛的天数" }),
                    threads: z.number().openapi({ description: "在网页上发的帖子" }),
                    replies: z.number().openapi({ description: "在网页上发的回复" }),
                    accepted: z.number().openapi({ description: "回复被别人采纳的次数" }),
                    likes: z
                      .number()
                      .openapi({ description: "网页上写的楼层在网页上收到的表情回应" }),
                    votes: z.number().openapi({ description: "投过票的投票帖" }),
                    boosts: z.number().openapi({ description: "在网页上写的短评" }),
                  }),
                ),
              }),
            },
          },
        },
        403: errorResponse("不是管理员"),
      },
    }),
    async (c) => {
      authorize(c, "admin");
      const { range, sort, staff } = c.req.valid("query");
      const rows = await activeUsers(range, sort, staff);
      const user = await userBriefs(rows.map((r) => r.id));
      return c.json({ items: rows.map(({ id, ...r }) => ({ user: user(id), ...r })) }, 200);
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
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/mail/clicks",
      summary: "从邮件点进论坛，不用登录：记下这封邮件第一次点击，还没记过打开的一起记上",
      request: {
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({
                mail: z.string().max(100).openapi({ description: "链接里的 m：邮件 ID.签名" }),
              }),
            },
          },
        },
      },
      responses: { 204: { description: "已记下；签名不对时什么都不做" } },
    }),
    async (c) => {
      await recordClick(c.req.valid("json").mail);
      return c.body(null, 204);
    },
  );
