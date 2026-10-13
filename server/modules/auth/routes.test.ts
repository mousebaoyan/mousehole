import { Hono } from "hono";
import { testClient } from "hono/testing";
import { sql } from "kysely";
import { describe, expect, test } from "vitest";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { env } from "../../platform/env.ts";
import { issueLoginLink } from "./service.ts";

const api = testClient(app).api.v1;

let lastQq = 10000;

async function createUser() {
  const { id } = await db
    .insertInto("users")
    .values({ qq: ++lastQq, display_name: "鼠鼠" })
    .returning("id")
    .executeTakeFirstOrThrow();
  return id;
}

// Browsers send Origin with every POST and DELETE; the CSRF check relies on it.
function as(cookie: string) {
  return { headers: { cookie, origin: env.PUBLIC_URL } };
}

function sessionCookie(res: Response) {
  return res.headers
    .getSetCookie()
    .find((c) => c.startsWith("session="))
    ?.split(";")[0];
}

async function login(userId: number) {
  const res = await api.auth.link.$post({ json: { token: await issueLoginLink(userId) } });
  expect(res.status).toBe(204);
  return sessionCookie(res) ?? "";
}

describe("登录链接", () => {
  test("只能用一次", async () => {
    const token = await issueLoginLink(await createUser());
    expect((await api.auth.link.$post({ json: { token } })).status).toBe(204);

    const again = await api.auth.link.$post({ json: { token } });
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: { code: "login_link_invalid" } });
  });

  test("过期后不能用", async () => {
    const userId = await createUser();
    const token = await issueLoginLink(userId);
    await db
      .updateTable("login_tickets")
      .set({ expires_at: sql`now() - interval '1 second'` })
      .where("user_id", "=", userId)
      .execute();

    expect((await api.auth.link.$post({ json: { token } })).status).toBe(400);
  });

  test("第一次登录激活账号，并写入审计日志", async () => {
    const userId = await createUser();
    const cookie = await login(userId);

    expect(await (await api.me.$get({}, as(cookie))).json()).toMatchObject({
      id: userId,
      activated: true,
    });
    const audit = await db
      .selectFrom("audit_logs")
      .select("data")
      .where("actor_id", "=", userId)
      .where("action", "=", "auth.login")
      .executeTakeFirst();
    expect(audit?.data).toEqual({ method: "link" });
  });
});

describe("会话", () => {
  test("没有登录时返回 401", async () => {
    const res = await api.me.$get();
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  test("过期的会话视为没有登录，并清掉 Cookie", async () => {
    const userId = await createUser();
    const cookie = await login(userId);
    await db
      .updateTable("sessions")
      .set({ expires_at: sql`now() - interval '1 second'` })
      .where("user_id", "=", userId)
      .execute();

    const res = await api.me.$get({}, as(cookie));
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie().join()).toMatch(/session=;.*Max-Age=0/);
  });

  test("超过一小时没用的会话在使用时续期 90 天", async () => {
    const userId = await createUser();
    const cookie = await login(userId);
    expect(sessionCookie(await api.me.$get({}, as(cookie)))).toBeUndefined();

    await db
      .updateTable("sessions")
      .set({
        last_seen_at: sql`now() - interval '2 hours'`,
        expires_at: sql`now() + interval '1 day'`,
      })
      .where("user_id", "=", userId)
      .execute();
    const res = await api.me.$get({}, as(cookie));

    expect(sessionCookie(res)).toBe(cookie);
    const { expires_at } = await db
      .selectFrom("sessions")
      .select("expires_at")
      .where("user_id", "=", userId)
      .executeTakeFirstOrThrow();
    const days = (expires_at.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89.9);
  });

  test("页面请求也会续期", async () => {
    // Pages are rendered by React Router, which returns its own Response object.
    const server = new Hono().route("/", app).get("/page", () => new Response("page"));
    const userId = await createUser();
    const cookie = await login(userId);
    await db
      .updateTable("sessions")
      .set({ last_seen_at: sql`now() - interval '2 hours'` })
      .where("user_id", "=", userId)
      .execute();

    expect(sessionCookie(await server.request("/page", as(cookie)))).toBe(cookie);
  });

  test("退出后会话失效", async () => {
    const cookie = await login(await createUser());

    expect((await api.auth.logout.$post({}, as(cookie))).status).toBe(204);
    expect((await api.me.$get({}, as(cookie))).status).toBe(401);
  });

  test("只能让自己的设备下线", async () => {
    const owner = await createUser();
    const ownerCookie = await login(owner);
    const otherDevice = await login(owner);
    const stranger = await login(await createUser());

    const res = await api.me.sessions.$get({}, as(ownerCookie));
    if (!res.ok) throw new Error(`status ${res.status}`);
    const { items } = await res.json();
    expect(items).toHaveLength(2);
    const other = items.find((s) => !s.current);
    const param = { id: String(other?.id) };

    expect((await api.me.sessions[":id"].$delete({ param }, as(stranger))).status).toBe(404);
    expect((await api.me.$get({}, as(otherDevice))).status).toBe(200);
    expect((await api.me.sessions[":id"].$delete({ param }, as(ownerCookie))).status).toBe(204);
    expect((await api.me.$get({}, as(otherDevice))).status).toBe(401);
  });
});
