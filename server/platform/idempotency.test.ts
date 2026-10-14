import { Hono } from "hono";
import { sql } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { authenticate } from "../modules/auth/routes.ts";
import { createBotToken } from "../modules/auth/service.ts";
import { db } from "./db.ts";
import { AppError } from "./errors.ts";
import { handleError, type AppEnv } from "./http.ts";
import { clearIdempotencyKeys, idempotency } from "./idempotency.ts";

let runs = 0;

const app = new Hono<AppEnv>()
  .use(authenticate, idempotency)
  .post("/created", (c) => c.json({ run: ++runs }, 201))
  .post("/other", (c) => c.json({ run: ++runs }, 201))
  .post("/missing", () => {
    runs++;
    throw new AppError(404, "not_found", "没有这个帖子");
  })
  .post("/broken", () => {
    runs++;
    throw new Error("boom");
  })
  .onError(handleError);

let token = "";
let qq = 20000;

beforeEach(async () => {
  runs = 0;
  const { id: userId } = await db
    .insertInto("users")
    .values({ qq: ++qq, display_name: "管理员", role: "admin" })
    .returning("id")
    .executeTakeFirstOrThrow();
  const actor = { userId, operatorId: null, tokenId: null, ip: null };
  token = (await createBotToken(actor, { name: "bot", botQq: ++qq, scopes: ["act"] })).token;
});

function post(path: string, key?: string) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (key) headers["idempotency-key"] = key;
  return app.request(path, { method: "POST", headers });
}

describe("幂等", () => {
  test("同一个键只执行一次，重复请求拿到第一次的结果", async () => {
    const first = await post("/created", "qq-1-1-thread");
    const again = await post("/created", "qq-1-1-thread");

    expect(runs).toBe(1);
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual(await first.json());
  });

  test("不带键时每次都执行", async () => {
    await post("/created");
    await post("/created");
    expect(runs).toBe(2);
  });

  test("业务错误也按第一次的结果返回", async () => {
    await post("/missing", "k");
    const again = await post("/missing", "k");

    expect(runs).toBe(1);
    expect(again.status).toBe(404);
    expect(await again.json()).toMatchObject({ error: { code: "not_found" } });
  });

  test("服务器出错不记结果，重试会再执行", async () => {
    expect((await post("/broken", "k")).status).toBe(500);
    expect((await post("/broken", "k")).status).toBe(500);
    expect(runs).toBe(2);
  });

  test("同一个键用在别的接口上返回 422", async () => {
    await post("/created", "k");
    const res = await post("/other", "k");
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { code: "idempotency_key_reused" } });
  });

  test("第一次还在处理时返回 409，超过 5 分钟视为中断，可以重新执行", async () => {
    await post("/created", "k");
    const row = db.updateTable("idempotency_keys").where("key", "=", "k");
    await row.set({ status: null, response: null }).execute();

    const busy = await post("/created", "k");
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ error: { code: "idempotency_in_progress" } });

    await row.set({ created_at: sql`now() - interval '6 minutes'` }).execute();
    expect((await post("/created", "k")).status).toBe(201);
    expect(runs).toBe(2);
  });

  test("7 天前的键可以重新使用", async () => {
    await post("/created", "k");
    await db
      .updateTable("idempotency_keys")
      .set({ created_at: sql`now() - interval '8 days'` })
      .where("key", "=", "k")
      .execute();

    await post("/created", "k");
    expect(runs).toBe(2);
  });

  test("每天清理 7 天前的键", async () => {
    await post("/created", "old");
    await post("/created", "new");
    await db
      .updateTable("idempotency_keys")
      .set({ created_at: sql`now() - interval '8 days'` })
      .where("key", "=", "old")
      .execute();
    await clearIdempotencyKeys();
    const keys = await db
      .selectFrom("idempotency_keys")
      .select("key")
      .where("key", "in", ["old", "new"])
      .execute();
    expect(keys).toEqual([{ key: "new" }]);
  });
});
