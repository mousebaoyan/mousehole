import { createRoute, z } from "@hono/zod-openapi";
import { reachOf } from "../../platform/access.ts";
import {
  actorOf,
  authorize,
  createRouter,
  errorResponse,
  IdParam,
  IntParam,
} from "../../platform/http.ts";
import { dueSummaries, saveSummary, setSummaryDisabled, summarySource } from "./service.ts";

const ThreadParam = z.object({ thread: IntParam });

const PointSchema = z.object({
  text: z.string().trim().min(1).max(80),
  floors: z.array(z.number().int()).min(1).max(5),
});

export const summariesRoutes = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/bot/summaries/due",
      summary: "该写 AI 总结的帖子，最近有动静的在前；后台关着 AI 总结时为空",
      request: { query: z.object({ limit: z.coerce.number().int().min(1).max(50).default(10) }) },
      responses: {
        200: {
          description: "帖子",
          content: {
            "application/json": {
              schema: z.object({
                items: z.array(
                  z.object({
                    thread_id: z.number(),
                    replies: z.number().openapi({ description: "现在的回复数" }),
                  }),
                ),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      authorize(c, "read");
      return c.json({ items: await dueSummaries(c.req.valid("query").limit) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/bot/summaries/{thread}/source",
      summary: "写总结用的内容：公开、没删的楼层的纯文字，不带名字和投票结果",
      request: { params: ThreadParam },
      responses: {
        200: {
          description: "帖子和楼层",
          content: {
            "application/json": {
              schema: z.object({
                thread: z.object({
                  id: z.number(),
                  kind: z.string(),
                  title: z.string(),
                  board: z.string().openapi({ description: "版块名" }),
                  tags: z.array(z.string()),
                  positioning: z.boolean().openapi({ description: "保研定位帖" }),
                }),
                replies: z.number().openapi({ description: "现在的回复数，推送总结时带回来" }),
                posts: z.array(
                  z.object({
                    floor: z.number(),
                    op: z.boolean().openapi({ description: "楼主写的" }),
                    accepted: z.boolean(),
                    likes: z.number(),
                    text: z
                      .string()
                      .openapi({ description: "正文的纯文字，图片写成[图片]，最多 1000 个字" }),
                  }),
                ),
              }),
            },
          },
        },
        404: errorResponse("帖子不存在、不公开、是抽奖帖，或者总结被版主关闭了"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "read");
      const source = await summarySource(c.req.valid("param").thread, reachOf(viewer, c.var.bot));
      return c.json(source, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/bot/summaries/{thread}",
      summary: "推送写好的 AI 总结，覆盖原来的",
      request: {
        params: ThreadParam,
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({
                lead: z.string().trim().min(1).max(80),
                points: z.array(PointSchema).min(1).max(5),
                replies: z.number().int().min(0).openapi({ description: "取内容时的回复数" }),
              }),
            },
          },
        },
      },
      responses: {
        204: { description: "已保存" },
        400: errorResponse("引用的楼层不在这个帖子里"),
        403: errorResponse("后台关着 AI 总结"),
        404: errorResponse("帖子不存在、不公开或是抽奖帖"),
        409: errorResponse("版主关闭了这个帖子的总结（summary_disabled）"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "moderate");
      await saveSummary(actorOf(c, viewer), c.req.valid("param").thread, c.req.valid("json"));
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/threads/{id}/summary",
      summary: "关闭或恢复这个帖子的 AI 总结；版主",
      request: {
        params: IdParam,
        body: {
          required: true,
          content: { "application/json": { schema: z.object({ disabled: z.boolean() }) } },
        },
      },
      responses: { 204: { description: "已修改" }, 403: errorResponse("不是版主") },
    }),
    async (c) => {
      const viewer = authorize(c, "moderate");
      await setSummaryDisabled(
        actorOf(c, viewer),
        c.req.valid("param").id,
        c.req.valid("json").disabled,
      );
      return c.body(null, 204);
    },
  );
