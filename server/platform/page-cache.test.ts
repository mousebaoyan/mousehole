import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vitest";
import { compressResponses } from "./compress.ts";
import { guestPages } from "./page-cache.ts";

let renders = 0;
const hits: string[] = [];
const server = new Hono();
server.use(guestPages(server, (c) => hits.push(c.req.path)));
server.use(compressResponses);
server.get("/t/:id", (c) => {
  renders++;
  if (c.req.param("id") === "404") return c.text("没有", 404);
  return c.html(`<p>第 ${renders} 次渲染</p>`.repeat(50));
});

function get(path: string, headers: Record<string, string> = {}) {
  return server.request(path, { headers: { "accept-encoding": "gzip, br", ...headers } });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("访客页面缓存", () => {
  test("访客再次打开同一页直接用缓存，压缩格式不同分开存；登录的人每次都渲染", async () => {
    const first = await get("/t/1");
    const before = renders;
    const again = await get("/t/1");
    expect(renders).toBe(before);
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(
      new Uint8Array(await first.arrayBuffer()),
    );
    expect(again.headers.get("content-encoding")).toBe("br");
    expect(hits).toContain("/t/1");

    await get("/t/1", { "accept-encoding": "gzip" });
    expect(renders).toBe(before + 1);
    await get("/t/1", { cookie: "session=abc" });
    await get("/t/1", { cookie: "session=abc" });
    expect(renders).toBe(before + 3);
  });

  test("过期后先给旧页面，同时在后台重新渲染，之后给新的", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await get("/t/2");
    const rendered = renders;
    vi.setSystemTime(Date.now() + 11_000);
    const stale = new Uint8Array(await (await get("/t/2")).arrayBuffer());
    await vi.waitFor(async () => {
      expect(new Uint8Array(await (await get("/t/2")).arrayBuffer())).not.toEqual(stale);
    });
    expect(renders).toBe(rendered + 1);
  });

  test("不是 200 的页面不缓存", async () => {
    await get("/t/404");
    await get("/t/404");
    const before = renders;
    await get("/t/404");
    expect(renders).toBe(before + 1);
  });
});
