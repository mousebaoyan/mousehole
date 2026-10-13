import { createHonoServer } from "react-router-hono-server/node";
import { app } from "./app.ts";
import { migrate } from "./platform/migrate.ts";

await migrate();

export default await createHonoServer({
  defaultLogger: false,
  configure(server) {
    server.route("/", app);
  },
});
