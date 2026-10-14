import { createRoute, z } from "@hono/zod-openapi";
import { isMember } from "../../platform/access.ts";
import {
  actorOf,
  authorize,
  authorizePosting,
  createRouter,
  errorResponse,
  unix,
} from "../../platform/http.ts";
import { UserBriefSchema } from "../users/schemas.ts";
import { BoostSchema, boostJson } from "./schemas.ts";
import {
  BOOST_MAX,
  boostLength,
  deleteOwnBoost,
  listBoosts,
  listReactions,
  react,
  REACTIONS,
  removeBoost,
  setBoost,
} from "./service.ts";

const IdParam = z.object({ id: z.coerce.number().int() });

const BoostBody = z
  .string()
  .trim()
  .refine((s) => s.length > 0, "短评不能为空")
  .refine((s) => boostLength(s) <= BOOST_MAX, `短评不超过 ${BOOST_MAX} 个字`)
  .openapi({ description: `不超过 ${BOOST_MAX} 个字，emoji 算一个` });

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
      const viewer = authorizePosting(c);
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
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/posts/{id}/boost",
      summary: "留下短评：每人每层一条，已有就改成新的",
      request: {
        params: IdParam,
        body: {
          required: true,
          content: { "application/json": { schema: z.object({ body: BoostBody }) } },
        },
      },
      responses: {
        200: {
          description: "短评",
          content: { "application/json": { schema: BoostSchema } },
        },
        403: errorResponse("不是成员"),
        404: errorResponse("回复不存在"),
      },
    }),
    async (c) => {
      const viewer = authorizePosting(c);
      const members = isMember(viewer, c.var.bot);
      const boost = await setBoost(
        actorOf(c, viewer),
        viewer,
        members,
        c.req.valid("param").id,
        c.req.valid("json").body,
      );
      return c.json(boostJson(boost), 200);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/posts/{id}/boost",
      summary: "删除自己在这一层的短评",
      request: { params: IdParam },
      responses: { 204: { description: "已删除" }, 404: errorResponse("没有留过短评") },
    }),
    async (c) => {
      const viewer = authorize(c, "act");
      await deleteOwnBoost(actorOf(c, viewer), viewer, c.req.valid("param").id);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/posts/{id}/boosts",
      summary: "这一层的全部短评，先留的在前",
      request: { params: IdParam },
      responses: {
        200: {
          description: "短评",
          content: { "application/json": { schema: z.object({ items: z.array(BoostSchema) }) } },
        },
        404: errorResponse("回复不存在"),
      },
    }),
    async (c) => {
      const members = isMember(c.var.viewer, c.var.bot);
      const boosts = await listBoosts(members, c.req.valid("param").id);
      return c.json({ items: boosts.map(boostJson) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/boosts/{id}",
      summary: "版主删除任意短评，可附理由，记进操作日志",
      request: {
        params: IdParam,
        body: {
          required: false,
          content: {
            "application/json": {
              schema: z.object({ reason: z.string().trim().max(200).optional() }),
            },
          },
        },
      },
      responses: {
        204: { description: "已删除" },
        403: errorResponse("不是版主"),
        404: errorResponse("短评不存在"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "moderate");
      await removeBoost(actorOf(c, viewer), c.req.valid("param").id, c.req.valid("json").reason);
      return c.body(null, 204);
    },
  );
