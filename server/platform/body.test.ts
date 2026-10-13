import { once } from "node:events";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { getRequestListener } from "@hono/node-server";
import { describe, expect, test } from "vitest";
import { nextQq } from "../../test/fixtures.ts";
import { app } from "../app.ts";
import { createBotToken } from "../modules/auth/service.ts";
import { db } from "./db.ts";

async function bot() {
  const { id } = await db
    .insertInto("users")
    .values({ qq: nextQq(), display_name: "管理员", role: "admin" })
    .returning("id")
    .executeTakeFirstOrThrow();
  const actor = { userId: id, operatorId: null, tokenId: null, ip: null };
  const { token } = await createBotToken(actor, {
    name: "插件",
    botQq: nextQq(),
    scopes: ["sync", "admin"],
  });
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

function send(path: string, method: string, headers: Record<string, string>, body: BodyInit) {
  return app.request(path, { method, headers, body });
}

describe("请求体", () => {
  test("gzip 压缩的全量同步照常处理", async () => {
    const headers = await bot();
    await send("/api/v1/admin/groups", "POST", headers, JSON.stringify({ group_id: 555 }));
    const members = Array.from({ length: 3 }, (_, i) => ({ user_id: 600000 + i }));
    const observed_at = Math.floor(Date.now() / 1000) - 60;
    const packed = gzipSync(JSON.stringify({ observed_at, members }));

    const res = await send(
      "/api/v1/bot/groups/555/members",
      "PUT",
      { ...headers, "content-encoding": "gzip" },
      packed,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ joined: 3 });
  });

  test("解压后超过上限的 gzip 请求体被拒绝", async () => {
    const headers = await bot();
    // 5MB of spaces packs into a few KB.
    const bomb = gzipSync(`{"members":[${" ".repeat(5 * 1024 * 1024)}]}`);
    const res = await send(
      "/api/v1/bot/groups/555/members",
      "PUT",
      { ...headers, "content-encoding": "gzip" },
      bomb,
    );
    expect(res.status).toBe(413);
  });

  test("普通接口的请求体不超过 1MB", async () => {
    const headers = await bot();
    const big = JSON.stringify({ group_id: 1, padding: "x".repeat(1024 * 1024) });
    expect((await send("/api/v1/admin/groups", "POST", headers, big)).status).toBe(413);
  });

  // Production serves Node's lightweight requests, which in-process tests never see, and leaves
  // the global Request alone, as react-router-hono-server does.
  test("经过 Node 服务器：不带请求体的 DELETE、分块传输的请求体都照常处理", async () => {
    const headers = await bot();
    const listener = getRequestListener(app.fetch, { overrideGlobalObjects: false });
    const server = createServer(listener).listen(0);
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Not listening on TCP");
    const { port } = address;
    const url = (path: string) => `http://localhost:${port}/api/v1${path}`;
    // A stream has no known length, so it goes out with Transfer-Encoding: chunked.
    const chunked = (text: string): RequestInit & { duplex: "half" } => ({
      method: "POST",
      headers,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text));
          controller.close();
        },
      }),
      duplex: "half",
    });
    try {
      // No body and no Content-Length: the route runs and refuses the bot.
      const removed = await fetch(url("/admin/tokens/1"), { method: "DELETE", headers });
      expect(removed.status).toBe(403);

      const linked = await fetch(url("/admin/groups"), chunked(JSON.stringify({ group_id: 556 })));
      expect(linked.status).toBe(204);

      const padding = "x".repeat(1024 * 1024);
      const big = await fetch(
        url("/admin/groups"),
        chunked(JSON.stringify({ group_id: 557, padding })),
      );
      expect(big.status).toBe(413);
    } finally {
      server.close();
    }
  });
});
