import { createHonoServer } from "react-router-hono-server/node";
import { app } from "./app.ts";

export default await createHonoServer({
  defaultLogger: false,
  configure(server) {
    server.route("/", app);
  },
});
