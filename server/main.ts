import { RouterContextProvider } from "react-router";
import { createHonoServer } from "react-router-hono-server/node";
import { apiContext, createApi } from "../app/api.server.ts";
import { app } from "./app.ts";
import { clearExpiredLogins } from "./modules/auth/service.ts";
import { flushViews } from "./modules/threads/service.ts";
import { clearUnusedUploads } from "./modules/uploads/service.ts";
import { clearIdempotencyKeys } from "./platform/idempotency.ts";
import { migrate } from "./platform/migrate.ts";
import { every } from "./platform/schedule.ts";

await migrate();
every(60_000, "Writing view counts", flushViews);
const DAY_MS = 24 * 3600_000;
every(DAY_MS, "Clearing unused uploads", clearUnusedUploads);
every(DAY_MS, "Clearing expired logins", clearExpiredLogins);
every(DAY_MS, "Clearing old idempotency keys", clearIdempotencyKeys);

export default await createHonoServer({
  defaultLogger: false,
  configure(server) {
    server.route("/", app);
  },
  getLoadContext(c) {
    const context = new RouterContextProvider();
    context.set(apiContext, createApi(c.req.raw));
    return context;
  },
});
