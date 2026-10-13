import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { sql } from "kysely";
import { adminRoutes } from "./modules/admin/routes.ts";
import { authenticate, authRoutes, bearerToken } from "./modules/auth/routes.ts";
import { tokenRoutes } from "./modules/auth/token-routes.ts";
import { boardsRoutes } from "./modules/boards/routes.ts";
import { membersRoutes } from "./modules/members/routes.ts";
import { threadsRoutes } from "./modules/threads/routes.ts";
import { usersRoutes } from "./modules/users/routes.ts";
import { db } from "./platform/db.ts";
import { env } from "./platform/env.ts";
import { createRouter, handleError, type AppEnv } from "./platform/http.ts";
import { requestBody } from "./platform/body.ts";
import { idempotency } from "./platform/idempotency.ts";

const api = createRouter()
  .route("/", authRoutes)
  .route("/", tokenRoutes)
  .route("/", usersRoutes)
  .route("/", membersRoutes)
  .route("/", boardsRoutes)
  .route("/", threadsRoutes)
  .route("/", adminRoutes);

api.doc31("/openapi.json", { openapi: "3.1.0", info: { title: "鼠洞", version: "1" } });

api.all("*", (c) => c.json({ error: { code: "not_found", message: "接口不存在" } }, 404));

export type ApiType = typeof api;

const checkOrigin = csrf({ origin: env.PUBLIC_URL });

// Mounted into the outer server, so the middleware here also runs for page requests.
export const app = new Hono<AppEnv>()
  // A cross-site page can make the browser send our cookie, but not a bearer token.
  .use((c, next) => (bearerToken(c) ? next() : checkOrigin(c, next)))
  .use(authenticate)
  .use("/api/v1/*", requestBody, idempotency)
  .get("/healthz", async (c) => {
    await sql`select 1`.execute(db);
    return c.text("ok");
  })
  .route("/api/v1", api)
  .onError(handleError);
