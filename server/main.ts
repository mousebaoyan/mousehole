import { RouterContextProvider } from "react-router";
import { createHonoServer } from "react-router-hono-server/node";
import { apiContext, createApi } from "../app/api.server.ts";
import { app } from "./app.ts";
import { migrate } from "./platform/migrate.ts";

await migrate();

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
