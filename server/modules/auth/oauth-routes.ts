import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { AppError } from "../../platform/errors.ts";
import {
  actorOf,
  authorizeOwner,
  createRouter,
  errorResponse,
  IdParam,
  unix,
} from "../../platform/http.ts";
import {
  APP_SCOPES,
  authorizeApp,
  createApp,
  exchangeCode,
  listApps,
  renewAppSecret,
  updateApp,
} from "./oauth.ts";

const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

const RedirectUri = z.url().refine((uri) => {
  const { protocol, hostname } = new URL(uri);
  return (
    !uri.includes("#") &&
    (protocol === "https:" || (protocol === "http:" && LOOPBACK.includes(hostname)))
  );
}, "回调地址要用 https，本地开发可以是本机的 http 地址，不能带 #");

const AppFields = z.object({
  name: z.string().trim().min(1).max(40),
  redirect_uris: z.array(RedirectUri).min(1).max(5),
  scopes: z
    .array(z.enum(APP_SCOPES))
    .min(1)
    .transform((s) => [...new Set(s)]),
});

const AppSchema = z
  .object({
    id: z.number(),
    client_id: z.string(),
    name: z.string(),
    redirect_uris: z.array(z.string()),
    scopes: z.array(z.string()),
    tokens: z.number().openapi({ description: "有效的令牌数，每人一个" }),
    last_used_at: z.number().nullable(),
    disabled: z.boolean(),
  })
  .openapi("App");

const AuthorizationRequestSchema = z.object({
  response_type: z.string().optional(),
  client_id: z.string().optional(),
  redirect_uri: z.string().optional(),
  state: z.string().optional(),
  code_challenge: z.string().optional(),
  code_challenge_method: z.string().optional(),
  scope: z.string().optional(),
  prompt: z.string().optional(),
});

// Our own sites that log people in with the forum (docs/api.md §8.3): the owner registers them on
// the web, and the authorization page asks here where to send the browser back.
export const oauthRoutes = createRouter()
  .openapi(
    createRoute({
      method: "post",
      path: "/oauth/authorize",
      summary:
        "授权页加载时调用：校验授权请求，返回带着授权码或错误跳回应用的地址；没登录又没带 prompt=none 时返回 401",
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: AuthorizationRequestSchema } },
        },
      },
      responses: {
        200: {
          description: "跳回应用的地址",
          content: {
            "application/json": { schema: z.object({ redirect_url: z.string() }) },
          },
        },
        400: errorResponse("应用不存在或已停用，或者回调地址没有登记"),
        401: errorResponse("没有登录"),
        403: errorResponse("用 token 调用"),
      },
    }),
    async (c) => {
      if (c.var.token) throw new AppError(403, "forbidden", "只能在网页上操作");
      const { viewer } = c.var;
      const redirect_url = await authorizeApp(viewer && actorOf(c, viewer), c.req.valid("json"));
      return c.json({ redirect_url }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/admin/apps",
      summary: "站长登记的自家应用，最新的在前；只能在网页上操作",
      responses: {
        200: {
          description: "应用",
          content: { "application/json": { schema: z.object({ items: z.array(AppSchema) }) } },
        },
        401: errorResponse("没有登录"),
        403: errorResponse("不是站长，或者用 token 调用"),
      },
    }),
    async (c) => {
      authorizeOwner(c);
      const apps = await listApps();
      const items = apps.map(({ disabled_at, last_used_at, ...app }) => ({
        ...app,
        last_used_at: last_used_at && unix(last_used_at),
        disabled: disabled_at !== null,
      }));
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/admin/apps",
      summary: "登记自家应用；密钥只在这次返回",
      request: {
        body: { required: true, content: { "application/json": { schema: AppFields } } },
      },
      responses: {
        201: {
          description: "已登记",
          content: {
            "application/json": {
              schema: z.object({
                id: z.number(),
                client_id: z.string(),
                client_secret: z.string(),
              }),
            },
          },
        },
        401: errorResponse("没有登录"),
        403: errorResponse("不是站长，或者用 token 调用"),
      },
    }),
    async (c) => {
      const viewer = authorizeOwner(c);
      return c.json(await createApp(actorOf(c, viewer), c.req.valid("json")), 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/admin/apps/{id}",
      summary: "修改自家应用，只改带了的字段；停用后它的令牌都失效",
      request: {
        params: IdParam,
        body: {
          required: true,
          content: {
            "application/json": {
              schema: AppFields.extend({ disabled: z.boolean() })
                .partial()
                .refine((input) => Object.keys(input).length > 0, "至少要改一项"),
            },
          },
        },
      },
      responses: {
        204: { description: "已修改" },
        401: errorResponse("没有登录"),
        403: errorResponse("不是站长，或者用 token 调用"),
        404: errorResponse("应用不存在"),
      },
    }),
    async (c) => {
      const viewer = authorizeOwner(c);
      await updateApp(actorOf(c, viewer), c.req.valid("param").id, c.req.valid("json"));
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/admin/apps/{id}/secret",
      summary: "给自家应用换一个密钥，旧的立即失效；新密钥只在这次返回",
      request: { params: IdParam },
      responses: {
        200: {
          description: "新密钥",
          content: {
            "application/json": { schema: z.object({ client_secret: z.string() }) },
          },
        },
        401: errorResponse("没有登录"),
        403: errorResponse("不是站长，或者用 token 调用"),
        404: errorResponse("应用不存在"),
      },
    }),
    async (c) => {
      const viewer = authorizeOwner(c);
      return c.json(await renewAppSecret(actorOf(c, viewer), c.req.valid("param").id), 200);
    },
  );

// client_secret_basic. Our client IDs and secrets have no characters that form encoding changes,
// so they need no decoding.
function basicCredentials(header: string | undefined) {
  const encoded = header?.match(/^Basic (\S+)$/)?.[1];
  const pair = encoded && /^([^:]*):(.*)$/s.exec(Buffer.from(encoded, "base64").toString());
  return pair ? { client_id: pair[1], client_secret: pair[2] } : {};
}

const NO_STORE = { "cache-control": "no-store" };

// POST /oauth/token, called by apps' servers: a form in, and OAuth's own responses and errors
// rather than the API's (docs/api.md §8.3).
export async function serveToken(c: Context) {
  const form = await c.req.parseBody();
  const field = (name: string) => {
    const value = form[name];
    return typeof value === "string" ? value : undefined;
  };
  const request = {
    grant_type: field("grant_type"),
    code: field("code"),
    redirect_uri: field("redirect_uri"),
    code_verifier: field("code_verifier"),
    client_id: field("client_id"),
    client_secret: field("client_secret"),
    ...basicCredentials(c.req.header("authorization")),
  };
  try {
    return c.json(await exchangeCode(request), 200, NO_STORE);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return c.json({ error: error.code, error_description: error.message }, error.status, NO_STORE);
  }
}
