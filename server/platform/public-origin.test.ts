import { Hono } from "hono";
import { expect, test } from "vitest";
import { env } from "./env.ts";
import { atPublicOrigin } from "./public-origin.ts";

const app = new Hono()
  .use(atPublicOrigin)
  .post("/login/link", async (c) => c.json({ url: c.req.raw.url, body: await c.req.raw.text() }));

test("反代后面收到的 http 请求，页面看到的是 PUBLIC_URL 的地址，正文不变", async () => {
  const res = await app.request("http://127.0.0.1:3080/login/link?token=abc", {
    method: "POST",
    body: "intent=login",
  });
  expect(await res.json()).toEqual({
    url: `${env.PUBLIC_URL}/login/link?token=abc`,
    body: "intent=login",
  });
});
