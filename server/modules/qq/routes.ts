import { createRoute, z } from "@hono/zod-openapi";
import { AppError } from "../../platform/errors.ts";
import { authorize, createRouter, errorResponse } from "../../platform/http.ts";
import { findLink, linkNotice } from "./service.ts";

const MessageParams = z.object({
  chat_type: z.enum(["group", "private"]),
  chat_id: z.coerce.number().int().positive(),
  message_id: z.coerce.number().int(),
});

const LinkSchema = z
  .object({
    kind: z.string().openapi({ description: "source：内容来自这条消息；notice：bot 发的转存回执" }),
    thread_id: z.number(),
    post_id: z.number().nullable(),
  })
  .openapi("MessageLink");

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
      method: "put",
      path: "/bot/messages/{chat_type}/{chat_id}/{message_id}",
      summary: "记录 bot 发出的转存回执：群友引用这条通知回复时，就知道回复的是哪个帖子",
      request: {
        params: MessageParams,
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({
                thread_id: z.number().int(),
                post_id: z.number().int().nullable().default(null),
              }),
            },
          },
        },
      },
      responses: {
        204: { description: "已记录" },
        403: errorResponse("token 没有 act 范围"),
        409: errorResponse("这条消息是论坛内容的来源"),
      },
    }),
    async (c) => {
      authorize(c, "act");
      const { thread_id, post_id } = c.req.valid("json");
      await linkNotice(c.req.valid("param"), thread_id, post_id);
      return c.body(null, 204);
    },
  );
