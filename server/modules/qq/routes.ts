import { createRoute, z } from "@hono/zod-openapi";
import { AppError } from "../../platform/errors.ts";
import { authorize, createRouter, errorResponse, UnixSecondsParam } from "../../platform/http.ts";
import { findLink, newAnswers } from "./service.ts";

const MessageParams = z.object({
  chat_type: z.enum(["group", "private"]),
  chat_id: z.coerce.number().int().positive(),
  message_id: z.coerce.number().int(),
});

const LinkSchema = z
  .object({
    thread_id: z.number(),
    post_id: z.number(),
  })
  .openapi("MessageLink");

const AnswersSchema = z
  .object({
    items: z.array(
      z.object({
        thread: z.object({
          id: z.number(),
          title: z.string(),
          created_at: z.number().openapi({ description: "Unix 秒；收录的提问是在群里问的时间" }),
        }),
        asker: z.object({ id: z.number(), display_name: z.string(), qq: z.number() }),
        source: z
          .object({ chat_id: z.number(), message_id: z.number() })
          .openapi({ description: "主楼整理自的第一条群消息" }),
        count: z.number().openapi({ description: "新回答几条" }),
        url: z.string().openapi({ description: "第一条新回答" }),
      }),
    ),
  })
  .openapi("NewAnswers");

export const qqRoutes = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/bot/messages/{chat_type}/{chat_id}/{message_id}",
      summary: "某条 QQ 消息对应的论坛帖子或回复",
      request: { params: MessageParams },
      responses: {
        200: { description: "对应的内容", content: { "application/json": { schema: LinkSchema } } },
        403: errorResponse("token 没有 read 范围"),
        404: errorResponse("这条消息没有对应的论坛内容"),
      },
    }),
    async (c) => {
      authorize(c, "read");
      const link = await findLink(c.req.valid("param"));
      if (!link) throw new AppError(404, "message_not_linked", "这条消息没有对应的论坛内容");
      return c.json(link, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/bot/answers",
      summary: "从群里收录的提问在论坛上有了哪些新回答，给插件在群里提醒提问的人",
      request: {
        query: z.object({
          since: UnixSecondsParam.openapi({ description: "Unix 秒" }),
          until: UnixSecondsParam.optional().openapi({
            description: "算 [since, until) 里发的回复，Unix 秒，默认现在",
          }),
        }),
      },
      responses: {
        200: { description: "新回答", content: { "application/json": { schema: AnswersSchema } } },
        403: errorResponse("token 没有 read 范围"),
      },
    }),
    async (c) => {
      authorize(c, "read");
      const { since, until } = c.req.valid("query");
      const items = await newAnswers(
        new Date(since * 1000),
        until === undefined ? new Date() : new Date(until * 1000),
      );
      return c.json({ items }, 200);
    },
  );
