import { OpenAPIHono } from "@hono/zod-openapi";
import { Hono } from "hono";

const api = new OpenAPIHono();

api.doc31("/openapi.json", { openapi: "3.1.0", info: { title: "鼠洞", version: "1" } });

api.all("*", (c) => c.json({ error: { code: "not_found", message: "接口不存在" } }, 404));

api.onError((error, c) => {
  console.error(error);
  return c.json({ error: { code: "internal_error", message: "服务器出错了，请稍后再试" } }, 500);
});

export const app = new Hono().get("/healthz", (c) => c.text("ok")).route("/api/v1", api);
