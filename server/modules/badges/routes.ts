import { createRoute, z } from "@hono/zod-openapi";
import { reachOf } from "../../platform/access.ts";
import { actorOf, authorize, createRouter, errorResponse, unix } from "../../platform/http.ts";
import { UserBriefSchema, UserRefSchema } from "../users/schemas.ts";
import { findUserId } from "../users/service.ts";
import { TIERS } from "./rules.ts";
import {
  createBadge,
  getBadge,
  grantBadge,
  listBadges,
  listUserBadges,
  revokeBadge,
  updateBadge,
} from "./service.ts";

const BadgeSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    description: z.string(),
    tier: z.string().openapi({ description: "bronze 铜、silver 银、gold 金" }),
    grouping: z.string().openapi({
      description: "start 入门、likes 获赞、answers 回答、persistence 坚持、limited 绝版",
    }),
    multiple: z.boolean().openapi({ description: "能不能得多次" }),
    manual: z.boolean().openapi({ description: "管理员手动授予的活动徽章" }),
    granted_count: z.number().openapi({ description: "有几个人得到" }),
    granted: z.number().openapi({ description: "自己得到了几次，没登录为 0" }),
  })
  .openapi("Badge");

const UserBadgeSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    description: z.string(),
    tier: z.string(),
    grouping: z.string(),
    multiple: z.boolean(),
    count: z.number().openapi({ description: "得到几次" }),
    granted_at: z.number().openapi({ description: "最近一次得到的时间" }),
    posts: z
      .array(
        z.object({
          thread_id: z.number(),
          title: z.string(),
          post_id: z.number(),
          floor: z.number(),
          granted_at: z.number(),
        }),
      )
      .openapi({ description: "能得多次的徽章最近 10 次是哪几层，只含看得到的" }),
  })
  .openapi("UserBadge");

const IdParam = z.object({ id: z.coerce.number().int() });

const NAME = z.string().trim().min(1).max(12);
const DESCRIPTION = z.string().trim().min(1).max(60);
const REASON = z.string().trim().max(200);

export const badgesRoutes = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/badges",
      summary: "全部徽章，按组排，带得到的人数",
      responses: {
        200: {
          description: "徽章",
          content: { "application/json": { schema: z.object({ items: z.array(BadgeSchema) }) } },
        },
      },
    }),
    async (c) => c.json({ items: await listBadges(c.var.viewer?.id ?? null) }, 200),
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/badges/{id}",
      summary: "一枚徽章和得到的人，最近的在前，每页 50 个",
      request: {
        params: IdParam,
        query: z.object({
          cursor: z.coerce
            .number()
            .int()
            .min(0)
            .optional()
            .openapi({ description: "已经列出的人数" }),
        }),
      },
      responses: {
        200: {
          description: "徽章和得到的人",
          content: {
            "application/json": {
              schema: z.object({
                badge: BadgeSchema,
                items: z.array(z.object({ user: UserBriefSchema, granted_at: z.number() })),
                next: z.number().nullable(),
              }),
            },
          },
        },
        404: errorResponse("徽章不存在"),
      },
    }),
    async (c) => {
      const page = await getBadge(
        c.req.valid("param").id,
        c.var.viewer?.id ?? null,
        reachOf(c.var.viewer, c.var.bot),
        c.req.valid("query").cursor ?? 0,
      );
      return c.json(
        {
          ...page,
          items: page.items.map((i) => ({ user: i.user, granted_at: unix(i.granted_at) })),
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/users/{user}/badges",
      summary: "某人得到的全部徽章，金的在前",
      request: { params: z.object({ user: UserRefSchema }) },
      responses: {
        200: {
          description: "徽章",
          content: {
            "application/json": { schema: z.object({ items: z.array(UserBadgeSchema) }) },
          },
        },
        404: errorResponse("用户不存在"),
      },
    }),
    async (c) => {
      const id = await findUserId(c.req.valid("param").user);
      const items = await listUserBadges(id, reachOf(c.var.viewer, c.var.bot));
      return c.json(
        {
          items: items.map((b) => ({
            ...b,
            granted_at: unix(b.granted_at),
            posts: b.posts.map((p) => ({ ...p, granted_at: unix(p.granted_at) })),
          })),
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/admin/badges",
      summary: "新建活动徽章",
      request: {
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({ name: NAME, description: DESCRIPTION, tier: z.enum(TIERS) }),
            },
          },
        },
      },
      responses: {
        201: {
          description: "已新建",
          content: { "application/json": { schema: z.object({ id: z.number() }) } },
        },
        403: errorResponse("不是管理员"),
        409: errorResponse("已有同名的徽章"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "admin");
      return c.json(await createBadge(actorOf(c, viewer), c.req.valid("json")), 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/admin/badges/{id}",
      summary: "改活动徽章的名字和说明；自动授予的徽章不能改",
      request: {
        params: IdParam,
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({ name: NAME.optional(), description: DESCRIPTION.optional() }),
            },
          },
        },
      },
      responses: {
        204: { description: "已修改" },
        403: errorResponse("不是管理员，或者是自动授予的徽章"),
        404: errorResponse("徽章不存在"),
        409: errorResponse("已有同名的徽章"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "admin");
      await updateBadge(actorOf(c, viewer), c.req.valid("param").id, c.req.valid("json"));
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/admin/badges/{id}/grants",
      summary: "手动授予活动徽章；本人收到通知",
      request: {
        params: IdParam,
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({ user: UserRefSchema, reason: REASON.min(1) }),
            },
          },
        },
      },
      responses: {
        204: { description: "已授予" },
        403: errorResponse("不是管理员，或者是自动授予的徽章"),
        404: errorResponse("徽章或用户不存在"),
        409: errorResponse("TA 已经有这枚徽章"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "admin");
      const { user, reason } = c.req.valid("json");
      await grantBadge(actorOf(c, viewer), c.req.valid("param").id, await findUserId(user), reason);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/admin/badges/{id}/grants/{user}",
      summary: "撤销手动授予的徽章",
      request: {
        params: IdParam.extend({ user: UserRefSchema }),
        body: {
          required: false,
          content: { "application/json": { schema: z.object({ reason: REASON.optional() }) } },
        },
      },
      responses: {
        204: { description: "已撤销" },
        403: errorResponse("不是管理员，或者是自动授予的徽章"),
        404: errorResponse("徽章不存在，或者 TA 没有这枚徽章"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "admin");
      const { id, user } = c.req.valid("param");
      const reason = c.req.valid("json").reason ?? null;
      await revokeBadge(actorOf(c, viewer), id, await findUserId(user), reason);
      return c.body(null, 204);
    },
  );
