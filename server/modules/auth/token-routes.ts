import { createRoute, z } from "@hono/zod-openapi";
import { SCOPES } from "../../platform/access.ts";
import { actorOf, authorizeOwner, createRouter, errorResponse, unix } from "../../platform/http.ts";
import { createBotToken, listBotTokens, revokeBotToken } from "./service.ts";

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
      request: { params: z.object({ id: z.coerce.number().int() }) },
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
