import { createRoute, z } from "@hono/zod-openapi";
import { authorize, createRouter, errorResponse, requireWeb, unix } from "../../platform/http.ts";
import { liveStream } from "../../platform/sse.ts";
import { UserBriefSchema } from "../users/schemas.ts";
import { countUnread, listNotifications, markRead, onUnreadChange } from "./service.ts";

const NotificationSchema = z
  .object({
    id: z.number(),
    type: z.string().openapi({
      description:
        "reply 回复了我的楼层，mention @了我，like 赞了我的楼层，boost 给我的楼层留了短评，watching 关注的帖子有新楼层，following 关注的人发了新帖，solved 我的回答被采纳",
    }),
    actor: UserBriefSchema.nullable().openapi({ description: "最近触发的人" }),
    count: z.number().openapi({ description: "合并了几次：点赞、短评按楼层，新楼层按帖子" }),
    thread: z.object({ id: z.number(), title: z.string() }),
    post: z
      .object({ id: z.number(), floor: z.number() })
      .openapi({ description: "新的那一层；点赞和短评是被赞的那一层" }),
    excerpt: z.string().openapi({ description: "这一层正文的前 80 个字；删掉了是空字符串" }),
    data: z.record(z.string(), z.string()).openapi({
      description: "点赞带最近的 emoji，短评带最近的短评 body",
    }),
    read: z.boolean(),
    created_at: z.number(),
  })
  .openapi("Notification");

export const notificationsRoutes = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/notifications",
      summary: "通知，最新的在前，每页 30 条；合并的通知有新动静时排到前面",
      request: {
        query: z.object({
          unread_only: z
            .enum(["true", "false"])
            .default("false")
            .transform((v) => v === "true"),
          cursor: z.string().optional(),
        }),
      },
      responses: {
        200: {
          description: "通知",
          content: {
            "application/json": {
              schema: z.object({
                items: z.array(NotificationSchema),
                next_cursor: z.string().nullable(),
              }),
            },
          },
        },
        401: errorResponse("没有登录"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "act");
      const { unread_only, cursor } = c.req.valid("query");
      const page = await listNotifications(viewer.id, unread_only, cursor);
      return c.json(
        {
          items: page.items.map((n) => ({ ...n, created_at: unix(n.created_at) })),
          next_cursor: page.next_cursor,
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/notifications/unread-count",
      summary: "未读通知数",
      responses: {
        200: {
          description: "未读数",
          content: { "application/json": { schema: z.object({ count: z.number() }) } },
        },
        401: errorResponse("没有登录"),
      },
    }),
    async (c) => c.json({ count: await countUnread(authorize(c, "act").id) }, 200),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/notifications/read",
      summary: "标为已读：ids 里的这几条，或者 all 为 true 时全部",
      request: {
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.union([
                z.object({ ids: z.array(z.number().int()).min(1).max(100) }),
                z.object({ all: z.literal(true) }),
              ]),
            },
          },
        },
      },
      responses: { 204: { description: "已标为已读" }, 401: errorResponse("没有登录") },
    }),
    async (c) => {
      const viewer = authorize(c, "act");
      const body = c.req.valid("json");
      await markRead(viewer.id, "ids" in body ? body.ids : "all");
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/stream",
      summary: "SSE：自己的未读通知数，连上时和每次变化时推一条 unread 事件，data 是未读数",
      responses: {
        200: {
          description: "text/event-stream；每 20 秒一条心跳注释",
          content: { "text/event-stream": { schema: z.string() } },
        },
        401: errorResponse("没有登录"),
      },
    }),
    (c) => {
      const viewer = requireWeb(c);
      return liveStream(
        c,
        (changed) => onUnreadChange(viewer.id, changed),
        async (stream) => {
          await stream.writeSSE({ event: "unread", data: String(await countUnread(viewer.id)) });
        },
      );
    },
  );
