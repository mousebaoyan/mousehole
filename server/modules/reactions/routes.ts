import { createRoute, z } from "@hono/zod-openapi";
import { isMember } from "../../platform/access.ts";
import { authorize, createRouter, errorResponse, unix } from "../../platform/http.ts";
import { UserBriefSchema } from "../users/schemas.ts";
import { listReactions, react, REACTIONS } from "./service.ts";

const IdParam = z.object({ id: z.coerce.number().int() });

const changed = {
  204: { description: "已更新" },
  403: errorResponse("不是成员，或者是自己的回复"),
  404: errorResponse("回复不存在"),
};

export const reactionsRoutes = createRouter()
  .openapi(
    createRoute({
      method: "put",
      path: "/posts/{id}/reaction",
      summary: "表情回应：每人一个，已有就替换；heart 就是点赞",
      request: {
        params: IdParam,
        body: {
          required: true,
          content: { "application/json": { schema: z.object({ emoji: z.enum(REACTIONS) }) } },
        },
      },
      responses: changed,
    }),
    async (c) => {
      const viewer = authorize(c, "act");
      const { emoji } = c.req.valid("json");
      await react(viewer, isMember(viewer, c.var.bot), c.req.valid("param").id, emoji);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/posts/{id}/reaction",
      summary: "取消自己的表情回应",
      request: { params: IdParam },
      responses: changed,
    }),
    async (c) => {
      const viewer = authorize(c, "act");
      await react(viewer, isMember(viewer, c.var.bot), c.req.valid("param").id, null);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/posts/{id}/reactions",
      summary: "谁回应了什么，最近的在前，每次 50 个；可按 emoji 筛选，cursor 取下一批",
      request: {
        params: IdParam,
        query: z.object({
          emoji: z.enum(REACTIONS).optional(),
          cursor: z.coerce.number().int().min(0).default(0),
        }),
      },
      responses: {
        200: {
          description: "回应",
          content: {
            "application/json": {
              schema: z.object({
                items: z.array(
                  z.object({ user: UserBriefSchema, emoji: z.string(), created_at: z.number() }),
                ),
                next_cursor: z.string().nullable(),
              }),
            },
          },
        },
        404: errorResponse("回复不存在"),
      },
    }),
    async (c) => {
      const { emoji, cursor } = c.req.valid("query");
      const members = isMember(c.var.viewer, c.var.bot);
      const page = await listReactions(members, c.req.valid("param").id, emoji, cursor);
      return c.json(
        {
          items: page.items.map((r) => ({ ...r, created_at: unix(r.created_at) })),
          next_cursor: page.next === null ? null : String(page.next),
        },
        200,
      );
    },
  );
