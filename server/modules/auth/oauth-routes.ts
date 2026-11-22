import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { env } from "../../platform/env.ts";
import { AppError } from "../../platform/errors.ts";
import {
  actorOf,
  authorizeOwner,
  clientIp,
  createRouter,
  errorResponse,
  IdParam,
  unix,
} from "../../platform/http.ts";
import { rateLimit } from "../../platform/rate-limit.ts";
import {
  APP_SCOPES,
  authorizeApp,
  createApp,
  describeAuthorization,
  exchangeCode,
  listApps,
  LOOPBACK,
  registerAgent,
  renewAppSecret,
  updateApp,
} from "./oauth.ts";

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
    tokens: z.number().meta({ description: "有效的令牌数，每人一个" }),
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
  resource: z.string().optional(),
  prompt: z.string().optional(),
});

const GoBack = z.object({ redirect_url: z.string() });

// Apps that log people in with the forum (docs/api.md §8.3): our own sites, which the owner
// registers on the web, and members' Agents. The authorization page asks here what to show and
// where to send the browser back.
export const oauthRoutes = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/oauth/authorize",
      summary:
        "授权页加载时调用：校验授权请求，返回要显示的应用和权限；请求有误，或者没登录又带了 prompt=none，返回带着错误跳回应用的地址",
      request: { query: AuthorizationRequestSchema },
      responses: {
        200: {
          description: "要显示的，或者跳回应用的地址",
          content: {
            "application/json": {
              schema: z.union([
                GoBack,
                z.object({
                  app: z.object({ name: z.string(), first_party: z.boolean() }),
                  redirect_host: z.string().meta({ description: "回调地址的主机名" }),
                  local: z.boolean().meta({ description: "回调是不是本机的程序" }),
                  scopes: z.array(z.string()).meta({ description: "应用要的范围" }),
                  level: z.number().meta({ description: "自己的等级，发内容要 L3" }),
                  role: z.string().meta({ description: "自己的角色，版主和管理员发内容不看等级" }),
                }),
              ]),
            },
          },
        },
        400: errorResponse("应用不存在或已停用，或者回调地址没有登记"),
        401: errorResponse("没有登录"),
        403: errorResponse("用 token 调用，或者冻结的账号和站长授权 Agent"),
      },
    }),
    async (c) => {
      if (c.var.token) throw new AppError(403, "forbidden", "只能在网页上操作");
      return c.json(await describeAuthorization(c.var.viewer, c.req.valid("query")), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/oauth/authorize",
      summary:
        "本人允许或拒绝，自家应用在授权页加载时直接调用：返回带着授权码或错误跳回应用的地址；没登录又没带 prompt=none 时返回 401",
      request: {
        body: {
          required: true,
          content: {
            "application/json": {
              schema: AuthorizationRequestSchema.extend({
                approve: z
                  .boolean()
                  .optional()
                  .meta({ description: "是否允许，Agent 的应用要带；自家应用不看它" }),
                scopes: z
                  .array(z.enum(APP_SCOPES))
                  .min(1)
                  .optional()
                  .meta({ description: "本人选定的范围，只能比应用要的少；不带时就是要的" }),
              }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "跳回应用的地址",
          content: { "application/json": { schema: GoBack } },
        },
        400: errorResponse("应用不存在或已停用，或者回调地址没有登记；选的范围超出应用要的"),
        401: errorResponse("没有登录"),
        403: errorResponse("用 token 调用，或者冻结的账号和站长授权 Agent"),
      },
    }),
    async (c) => {
      if (c.var.token) throw new AppError(403, "forbidden", "只能在网页上操作");
      const { viewer } = c.var;
      const { approve, scopes, ...request } = c.req.valid("json");
      const redirect_url = await authorizeApp(
        viewer && { viewer, actor: actorOf(c, viewer) },
        request,
        { approve, scopes },
      );
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

// The endpoints below answer in OAuth's own terms rather than the API's (docs/api.md §8.3).
function oauthError(c: Context, error: unknown) {
  if (!(error instanceof AppError)) throw error;
  if (error.retryAfter !== undefined) c.header("Retry-After", String(error.retryAfter));
  return c.json({ error: error.code, error_description: error.message }, error.status, NO_STORE);
}

// POST /oauth/token, called by apps' servers and by Agents: a form in.
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
    resource: field("resource"),
    ...basicCredentials(c.req.header("authorization")),
  };
  try {
    return c.json(await exchangeCode(request), 200, NO_STORE);
  } catch (error) {
    return oauthError(c, error);
  }
}

// What RFC 7591 lets an Agent say about itself that the forum takes; the rest is ignored.
const Registration = z.object({
  client_name: z.string().trim().min(1).max(40),
  redirect_uris: z.array(RedirectUri).min(1).max(5),
  token_endpoint_auth_method: z.literal("none").default("none"),
  // Refresh tokens are taken as asked for, but none is given (design §6.7).
  grant_types: z
    .array(z.enum(["authorization_code", "refresh_token"]))
    .default(["authorization_code"]),
  response_types: z.array(z.literal("code")).default(["code"]),
});

const HOUR_MS = 60 * 60 * 1000;

// POST /oauth/register, where an Agent starts. Nobody has logged in yet, so each address gets a
// few an hour (design §13).
export async function serveRegistration(c: Context) {
  try {
    rateLimit(`oauth-register:${clientIp(c)}`, 10, HOUR_MS);
    // A body that isn't JSON is metadata that doesn't check out, like any other.
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = Registration.safeParse(body);
    if (!parsed.success) {
      throw parsed.error.issues.some((issue) => issue.path[0] === "redirect_uris")
        ? new AppError(
            400,
            "invalid_redirect_uri",
            "redirect_uris 要 1–5 个：https 地址或本机的 http 地址，不能带 #",
          )
        : new AppError(
            400,
            "invalid_client_metadata",
            "client_name 必填，最多 40 个字；token_endpoint_auth_method 只能是 none，response_types 只能是 code",
          );
    }
    const { client_id, created_at } = await registerAgent(parsed.data);
    return c.json(
      { client_id, client_id_issued_at: unix(created_at), ...parsed.data },
      201,
      NO_STORE,
    );
  } catch (error) {
    return oauthError(c, error);
  }
}

// RFC 8414: where Agents register, send the browser and get the token. No
// client_id_metadata_document_supported: Codex would then use nothing else (design §6.7).
const SERVER_METADATA = {
  issuer: env.PUBLIC_URL,
  authorization_endpoint: `${env.PUBLIC_URL}/oauth/authorize`,
  token_endpoint: `${env.PUBLIC_URL}/oauth/token`,
  registration_endpoint: `${env.PUBLIC_URL}/oauth/register`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
  scopes_supported: APP_SCOPES,
  authorization_response_iss_parameter_supported: true,
};

export function serveServerMetadata(c: Context) {
  return c.json(SERVER_METADATA, 200, { "cache-control": "public, max-age=3600" });
}
