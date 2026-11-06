import { createRoute, z } from "@hono/zod-openapi";
import { SCOPES } from "../../platform/access.ts";
import {
  actorOf,
  authorizeOwner,
  createRouter,
  errorResponse,
  IdParam,
  requireWeb,
  unix,
} from "../../platform/http.ts";
import {
  createBotToken,
  createMemberToken,
  listBotTokens,
  listMemberTokens,
  revokeBotToken,
  revokeMemberToken,
} from "./service.ts";

const BotTokenSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    scopes: z.array(z.string()),
    bot: z.object({ id: z.number(), qq: z.number(), display_name: z.string() }),
    created_at: z.number(),
    last_used_at: z.number().nullable(),
    revoked_at: z.number().nullable(),
  })
  .openapi("BotToken");

const MemberTokenSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    scopes: z.array(z.string()),
    created_at: z.number(),
    last_used_at: z.number().nullable(),
  })
  .openapi("MemberToken");

// Bot tokens are managed by admins on the web only: a bot must not mint or revoke tokens.
export const tokenRoutes = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/admin/tokens",
      summary: "bot token 列表，包括已吊销的；只能在网页上操作",
      responses: {
        200: {
          description: "最新的在前",
          content: {
            "application/json": { schema: z.object({ items: z.array(BotTokenSchema) }) },
          },
        },
        401: errorResponse("没有登录"),
        403: errorResponse("不是站长，或者用 bot token 调用"),
      },
    }),
    async (c) => {
      authorizeOwner(c);
      const tokens = await listBotTokens();
      const items = tokens.map((t) => ({
        id: t.id,
        name: t.name,
        scopes: t.scopes,
        bot: { id: t.bot_user_id, qq: t.bot_qq, display_name: t.bot_name },
        created_at: unix(t.created_at),
        last_used_at: t.last_used_at && unix(t.last_used_at),
        revoked_at: t.revoked_at && unix(t.revoked_at),
      }));
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/admin/tokens",
      summary: "创建 bot token；token 只在这次返回",
      request: {
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({
                name: z.string().trim().min(1).max(40),
                bot_qq: z.number().int().min(10000),
                scopes: z
                  .array(z.enum(SCOPES))
                  .min(1)
                  .transform((s) => [...new Set(s)]),
              }),
            },
          },
        },
      },
      responses: {
        201: {
          description: "已创建",
          content: {
            "application/json": { schema: z.object({ id: z.number(), token: z.string() }) },
          },
        },
        401: errorResponse("没有登录"),
        403: errorResponse("不是站长，或者用 bot token 调用"),
        409: errorResponse("这个 QQ 号是登录过的群友"),
      },
    }),
    async (c) => {
      const viewer = authorizeOwner(c);
      const { name, bot_qq, scopes } = c.req.valid("json");
      const created = await createBotToken(actorOf(c, viewer), { name, botQq: bot_qq, scopes });
      return c.json(created, 201);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/admin/tokens/{id}",
      summary: "吊销 bot token",
      request: { params: IdParam },
      responses: {
        204: { description: "已吊销" },
        401: errorResponse("没有登录"),
        403: errorResponse("不是站长，或者用 bot token 调用"),
        404: errorResponse("token 不存在或已吊销"),
      },
    }),
    async (c) => {
      const viewer = authorizeOwner(c);
      await revokeBotToken(actorOf(c, viewer), c.req.valid("param").id);
      return c.body(null, 204);
    },
  );

// Members' own tokens, for their Agents and scripts (docs/api.md §8.1): only on the web, so a token
// can't make or revoke tokens.
export const memberTokenRoutes = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/me/tokens",
      summary: "自己有效的令牌，最近用过的在前；只能在网页上",
      responses: {
        200: {
          description: "令牌",
          content: {
            "application/json": { schema: z.object({ items: z.array(MemberTokenSchema) }) },
          },
        },
        401: errorResponse("没有登录"),
        403: errorResponse("用 token 调用"),
      },
    }),
    async (c) => {
      const tokens = await listMemberTokens(requireWeb(c).id);
      const items = tokens.map((t) => ({
        id: t.id,
        name: t.name,
        scopes: t.scopes,
        created_at: unix(t.created_at),
        last_used_at: t.last_used_at && unix(t.last_used_at),
      }));
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/me/tokens",
      summary: "生成个人令牌；令牌只在这次返回",
      request: {
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({
                name: z.string().trim().min(1).max(24),
                scopes: z.union([
                  z.tuple([z.literal("read")]),
                  z.tuple([z.literal("read"), z.literal("act")]),
                ]),
              }),
            },
          },
        },
      },
      responses: {
        201: {
          description: "已生成",
          content: {
            "application/json": { schema: z.object({ id: z.number(), token: z.string() }) },
          },
        },
        401: errorResponse("没有登录"),
        403: errorResponse("冻结的账号、站长，或者用 token 调用"),
      },
    }),
    async (c) => {
      const viewer = requireWeb(c);
      const created = await createMemberToken(actorOf(c, viewer), viewer, c.req.valid("json"));
      return c.json(created, 201);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/me/tokens/{id}",
      summary: "撤销自己的令牌，立即失效",
      request: { params: IdParam },
      responses: {
        204: { description: "已撤销" },
        401: errorResponse("没有登录"),
        403: errorResponse("用 token 调用"),
        404: errorResponse("不是自己的令牌，或者已经撤销"),
      },
    }),
    async (c) => {
      const viewer = requireWeb(c);
      await revokeMemberToken(actorOf(c, viewer), c.req.valid("param").id);
      return c.body(null, 204);
    },
  );
