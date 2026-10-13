import { RouterContextProvider } from "react-router";
import { createHonoServer } from "react-router-hono-server/node";
import { apiContext, createApi } from "../app/api.server.ts";
import { app } from "./app.ts";
import { flushViews } from "./modules/threads/service.ts";
import { migrate } from "./platform/migrate.ts";
import { every } from "./platform/schedule.ts";

await migrate();
every(60_000, "Writing view counts", flushViews);

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
