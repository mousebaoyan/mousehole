import { expect, test } from "vitest";
import { app } from "./app.ts";

// One schema the generator can't convert fails the whole document, which nothing else uses.
test("接口文档能生成", async () => {
  const res = await app.request("/api/v1/openapi.json");
  expect(res.status).toBe(200);
});
