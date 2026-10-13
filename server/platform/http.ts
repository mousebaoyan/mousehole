import { OpenAPIHono, z } from "@hono/zod-openapi";
import { AppError } from "./errors.ts";

z.config(z.locales.zhCN());

export type Viewer = { id: number; role: string; member_status: string };

export type AppEnv = { Variables: { viewer: Viewer | null; sessionId: number | null } };

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
      const issue = result.error.issues[0];
      const where = issue.path.length ? `${issue.path.join(".")}：` : "";
      throw new AppError(400, "invalid_request", where + issue.message);
    },
  });
}

export function unix(date: Date) {
  return Math.floor(date.getTime() / 1000);
}

export function requireViewer(viewer: Viewer | null) {
  if (!viewer) throw new AppError(401, "unauthorized", "请先登录");
  return viewer;
}
