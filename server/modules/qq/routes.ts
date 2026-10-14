import { createRoute, z } from "@hono/zod-openapi";
import { AppError } from "../../platform/errors.ts";
import { authorize, createRouter, errorResponse } from "../../platform/http.ts";
import { findLink } from "./service.ts";

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

export const qqRoutes = createRouter().openapi(
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
);
