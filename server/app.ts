import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { sql } from "kysely";
import { authRoutes, session } from "./modules/auth/routes.ts";
import { usersRoutes } from "./modules/users/routes.ts";
import { db } from "./platform/db.ts";
import { env } from "./platform/env.ts";
import { AppError } from "./platform/errors.ts";
import { createRouter, type AppEnv } from "./platform/http.ts";
import { log } from "./platform/log.ts";

const api = createRouter().route("/", authRoutes).route("/", usersRoutes);

api.doc31("/openapi.json", { openapi: "3.1.0", info: { title: "鼠洞", version: "1" } });

api.all("*", (c) => c.json({ error: { code: "not_found", message: "接口不存在" } }, 404));

export type ApiType = typeof api;

// Mounted into the outer server, so the middleware here also runs for page requests.
export const app = new Hono<AppEnv>()
  .use(csrf({ origin: env.PUBLIC_URL }), session)
  .get("/healthz", async (c) => {
    await sql`select 1`.execute(db);
    return c.text("ok");
  })
  .route("/api/v1", api)
  .onError((error, c) => {
    if (error instanceof AppError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status);
    }
    if (error instanceof HTTPException) return error.getResponse();
    log("error", "Unhandled error", { error, method: c.req.method, path: c.req.path });
    return c.json({ error: { code: "internal_error", message: "服务器出错了，请稍后再试" } }, 500);
  });
