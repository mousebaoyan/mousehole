import { createRoute, z } from "@hono/zod-openapi";
import {
  authorize,
  createRouter,
  errorResponse,
  unix,
  UnixSecondsParam,
} from "../../platform/http.ts";
import { AnonymousSchema } from "../users/schemas.ts";
import { weeklyStats } from "./stats.ts";

const Person = z.object({
  id: z.number(),
  display_name: z.string(),
  qq: z.number().nullable(),
  avatar_url: z.string().nullable(),
});

const ThreadItem = z.object({
  thread: z.object({ id: z.number(), title: z.string(), url: z.string() }),
  board: z.object({ slug: z.string(), name: z.string() }),
  author: z.union([Person, AnonymousSchema]),
  count: z.number(),
});

const PersonItem = z.object({ user: Person, count: z.number() });

const StatsSchema = z
  .object({
    since: z.number(),
    until: z.number(),
    overview: z.object({
      threads: z.number(),
      posts: z.number().openapi({ description: "新回复，含收录的" }),
      archived: z.number().openapi({ description: "收录了几层" }),
      active: z.number().openapi({ description: "发过内容的人数" }),
      activated: z.number().openapi({ description: "第一次登录的人数" }),
      badges: z.number().openapi({ description: "发出的徽章数" }),
    }),
    threads: z.object({
      most_liked: z.array(ThreadItem),
      most_replied: z.array(ThreadItem),
      most_read: z.array(ThreadItem).openapi({ description: "这一周里读过它的人数" }),
    }),
    people: z.object({
      most_liked: z.array(PersonItem),
      most_accepted: z.array(PersonItem),
      most_replies: z.array(PersonItem),
    }),
    gold_badges: z.array(
      z.object({ user: Person, badge: z.object({ id: z.number(), name: z.string() }) }),
    ),
  })
  .openapi("WeeklyStats");

export const weeklyRoutes = createRouter().openapi(
  createRoute({
    method: "get",
    path: "/bot/stats/weekly",
    summary: "一周的统计，给插件排周榜图片：概况、帖子榜、人的榜单和金徽章",
    request: {
      query: z.object({
        until: UnixSecondsParam.optional().openapi({
          description: "统计 [until - 7 天, until)，Unix 秒，默认现在",
        }),
      }),
    },
    responses: {
      200: { description: "统计", content: { "application/json": { schema: StatsSchema } } },
      403: errorResponse("token 没有 read 范围"),
    },
  }),
  async (c) => {
    authorize(c, "read");
    const { until } = c.req.valid("query");
    const stats = await weeklyStats(until === undefined ? new Date() : new Date(until * 1000));
    return c.json({ ...stats, since: unix(stats.since), until: unix(stats.until) }, 200);
  },
);
