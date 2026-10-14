import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { brotliDecompressSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { compressResponses } from "./compress.ts";

const items = Array.from({ length: 200 }, (_, i) => ({ id: i, title: "夏令营经验" }));
const app = new Hono()
  .use(compressResponses)
  .get("/json", (c) => c.json({ items }))
  .get("/stream", (c) => streamSSE(c, (stream) => stream.writeSSE({ data: "x".repeat(2000) })));

function get(path: string, encoding = "gzip, deflate, br, zstd") {
  return app.request(path, { headers: { "accept-encoding": encoding } });
}

describe("响应压缩", () => {
  test("浏览器支持 Brotli 就用 Brotli，否则用 gzip；都不支持就原样返回", async () => {
    const br = await get("/json");
    expect(br.headers.get("content-encoding")).toBe("br");
    expect(br.headers.get("vary")).toBe("accept-encoding");
    const body = brotliDecompressSync(Buffer.from(await br.arrayBuffer())).toString();
    expect(JSON.parse(body)).toEqual({ items });

    expect((await get("/json", "gzip, deflate")).headers.get("content-encoding")).toBe("gzip");
    expect((await get("/json", "identity")).headers.get("content-encoding")).toBeNull();
  });

  test("事件流不压缩，不会被攒着", async () => {
    const stream = await get("/stream");
    expect(stream.headers.get("content-encoding")).toBeNull();
    expect(await stream.text()).toContain("x".repeat(2000));
  });
});
