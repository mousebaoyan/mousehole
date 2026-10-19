import { createRoute, z } from "@hono/zod-openapi";
import { authorize, createRouter, errorResponse } from "../../platform/http.ts";
import { getStats, RANGES } from "./service.ts";

const Kinds = z
  .object({ site: z.number(), qq: z.number(), total: z.number() })
  .openapi({ description: "论坛、群里、合起来" });

const Totals = z.object({
  dau: Kinds.openapi({ description: "平均日活，只算过完了的天" }),
  wau: Kinds.openapi({ description: "截至最后一天的 7 天里来过的人" }),
  mau: Kinds.openapi({ description: "截至最后一天的 30 天里来过的人" }),
  new_activated: z.number(),
  read_seconds: z.number(),
  posts_read: z.number(),
});

export const statsRoutes = createRouter().openapi(
  createRoute({
    method: "get",
    path: "/admin/stats",
    summary: "数据页：活跃、成员、留存和阅读，按北京时间逐天，不算 bot 和站长",
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
);
