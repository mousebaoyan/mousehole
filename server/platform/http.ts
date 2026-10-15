import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  assertNotMuted,
  checkOwner,
  checkPermission,
  reachOf,
  type Reader,
  type Actor,
  type Bot,
  type Scope,
  type Viewer,
} from "./access.ts";
import { AppError } from "./errors.ts";
import { log } from "./log.ts";
import { describeIssue } from "./validation.ts";

z.config({ ...z.locales.zhCN(), customError: describeIssue });

export type AppEnv = {
  Variables: { viewer: Viewer | null; sessionId: number | null; bot: Bot | null };
};

const ErrorSchema = z
  .object({ error: z.object({ code: z.string(), message: z.string() }) })
  .openapi("Error");

export function errorResponse(description: string) {
  return { description, content: { "application/json": { schema: ErrorSchema } } };
}

export function createRouter() {
  return new OpenAPIHono<AppEnv>({
    defaultHook(result) {
      if (result.success) return;
      throw new AppError(400, "invalid_request", result.error.issues[0].message);
    },
  });
}

export function handleError(error: Error, c: Context) {
  if (error instanceof AppError) {
    if (error.retryAfter !== undefined) c.header("Retry-After", String(error.retryAfter));
    if (error.status >= 500) log("warn", error.message, { code: error.code, error: error.cause });
    return c.json(
      { ...error.details, error: { code: error.code, message: error.message } },
      error.status,
    );
  }
  if (error instanceof HTTPException) return error.getResponse();
  log("error", "Unhandled error", { error, method: c.req.method, path: c.req.path });
  return c.json({ error: { code: "internal_error", message: "服务器出现错误，请稍后重试" } }, 500);
}

export function unix(date: Date) {
  return Math.floor(date.getTime() / 1000);
}

// The viewer, once they may do what the route needs; see access.ts for the rules.
export function authorize(c: Context<AppEnv>, need: Scope) {
  return checkPermission(c.var.viewer, c.var.bot, need);
}

export function authorizeOwner(c: Context<AppEnv>) {
  return checkOwner(c.var.viewer, c.var.bot);
}

// For putting words and pictures up, which muted members can't: posts, edits, reactions,
// boosts, uploads.
export function authorizePosting(c: Context<AppEnv>) {
  const viewer = authorize(c, "act");
  assertNotMuted(viewer);
  return viewer;
}

// Whether the viewer may also do what needs `need`, by the same rules as authorize: a moderator
// editing someone else's post, say.
export function can(c: Context<AppEnv>, need: Scope) {
  try {
    checkPermission(c.var.viewer, c.var.bot, need);
    return true;
  } catch (error) {
    if (error instanceof AppError) return false;
    throw error;
  }
}

export function readerOf(c: Context<AppEnv>): Reader {
  const { viewer, bot } = c.var;
  return { reach: reachOf(viewer, bot), id: viewer?.id ?? null, staff: can(c, "moderate") };
}

// For signed-in people only: login devices, bot tokens.
export function requireWeb(c: Context<AppEnv>) {
  if (c.var.bot) throw new AppError(403, "forbidden", "只能在网页上操作");
  if (!c.var.viewer) throw new AppError(401, "unauthorized", "请先登录");
  return c.var.viewer;
}

export function clientIp(c: Context) {
  return c.req.header("x-real-ip") ?? null;
}

export function actorOf(c: Context<AppEnv>, viewer: Viewer): Actor {
  const bot = c.var.bot;
  return {
    userId: viewer.id,
    operatorId: bot?.operator?.id ?? null,
    tokenId: bot?.tokenId ?? null,
    ip: clientIp(c),
    userAgent: c.req.header("user-agent") ?? null,
  };
}
