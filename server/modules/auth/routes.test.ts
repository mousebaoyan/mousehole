import { Hono } from "hono";
import { testClient } from "hono/testing";
import { sql } from "kysely";
import { describe, expect, test } from "vitest";
import { app } from "../../app.ts";
import type { Scope } from "../../platform/access.ts";
import { db } from "../../platform/db.ts";
import { as, createUser, login, nextQq, sessionCookie } from "../../../test/fixtures.ts";
import { issueLoginLink } from "./service.ts";

const api = testClient(app).api.v1;

describe("登录链接", () => {
  test("只能用一次", async () => {
    const token = await issueLoginLink((await createUser()).id);
    expect((await api.auth.link.$post({ json: { token } })).status).toBe(204);

    const again = await api.auth.link.$post({ json: { token } });
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: { code: "login_link_invalid" } });
  });

  test("过期后不能用", async () => {
    const userId = (await createUser()).id;
    const token = await issueLoginLink(userId);
    await db
      .updateTable("login_tickets")
      .set({ expires_at: sql`now() - interval '1 second'` })
      .where("user_id", "=", userId)
      .execute();

    expect((await api.auth.link.$post({ json: { token } })).status).toBe(400);
  });

  test("第一次登录激活账号，并写入审计日志", async () => {
    const userId = (await createUser()).id;
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
    const userId = (await createUser()).id;
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
    const userId = (await createUser()).id;
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
    const userId = (await createUser()).id;
    const cookie = await login(userId);
    await db
      .updateTable("sessions")
      .set({ last_seen_at: sql`now() - interval '2 hours'` })
      .where("user_id", "=", userId)
      .execute();

    expect(sessionCookie(await server.request("/page", as(cookie)))).toBe(cookie);
  });

  test("退出后会话失效", async () => {
    const cookie = await login((await createUser()).id);

    expect((await api.auth.logout.$post({}, as(cookie))).status).toBe(204);
    expect((await api.me.$get({}, as(cookie))).status).toBe(401);
  });

  test("只能让自己的设备下线", async () => {
    const owner = (await createUser()).id;
    const ownerCookie = await login(owner);
    const otherDevice = await login(owner);
    const stranger = await login((await createUser()).id);

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

function bearer(token: string, headers: Record<string, string> = {}) {
  return { headers: { authorization: `Bearer ${token}`, ...headers } };
}

async function createToken(scopes: Scope[] = ["read", "act"]) {
  const admin = await login((await createUser("admin")).id);
  const res = await api.admin.tokens.$post(
    { json: { name: "测试 bot", bot_qq: nextQq(), scopes } },
    as(admin),
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  return { admin, ...(await res.json()) };
}

async function meAs(token: string, headers: Record<string, string> = {}) {
  const res = await api.me.$get({}, bearer(token, headers));
  return { status: res.status, body: await res.json() };
}

describe("bot token", () => {
  test("token 只在创建时返回一次，bot 账号固定为 bot 角色", async () => {
    const { admin, id, token } = await createToken();

    const list = await api.admin.tokens.$get({}, as(admin));
    if (!list.ok) throw new Error(`status ${list.status}`);
    const listed = (await list.json()).items.find((t) => t.id === id);
    expect(listed).toMatchObject({ scopes: ["read", "act"], revoked_at: null });
    expect(JSON.stringify(listed)).not.toContain(token);

    expect((await meAs(token)).body).toMatchObject({ id: listed?.bot.id, role: "bot" });
  });

  test("X-Act-As 代表成员，可以写用户 ID 或 QQ 号", async () => {
    const { token } = await createToken();
    const member = await createUser();

    const byQq = await meAs(token, { "X-Act-As": `qq:${member.qq}` });
    expect(byQq.body).toMatchObject({ id: member.id });
    const byId = await meAs(token, { "X-Act-As": String(member.id) });
    expect(byId.body).toMatchObject({ id: member.id });
    expect(await meAs(token, { "X-Act-As": "qq:1" })).toMatchObject({
      status: 404,
      body: { error: { code: "unknown_member" } },
    });
    expect(await meAs(token, { "X-Act-As": "abc" })).toMatchObject({
      status: 400,
      body: { error: { code: "invalid_request" } },
    });
  });

  test("普通成员只能让 bot 代表自己，版主可以代表别人", async () => {
    const { token } = await createToken();
    const member = String((await createUser()).id);
    const other = String((await createUser()).id);
    const moderator = String((await createUser("moderator")).id);

    expect(await meAs(token, { "X-Act-As": member, "X-Operator": other })).toMatchObject({
      status: 403,
      body: { error: { code: "operator_not_allowed" } },
    });
    expect((await meAs(token, { "X-Act-As": member, "X-Operator": member })).status).toBe(200);
    expect((await meAs(token, { "X-Act-As": member, "X-Operator": moderator })).status).toBe(200);
  });

  test("后台要求必须带操作人时，代表成员却没带 X-Operator 的请求被拒", async () => {
    const { admin, token } = await createToken();
    const member = String((await createUser()).id);
    const setRequired = (on: boolean) =>
      api.admin.settings.$patch({ json: { bot: { require_operator: on } } }, as(admin));
    await setRequired(true);

    expect(await meAs(token, { "X-Act-As": member })).toMatchObject({
      status: 400,
      body: { error: { code: "operator_required" } },
    });
    expect((await meAs(token, { "X-Act-As": member, "X-Operator": member })).status).toBe(200);
    // The bot's own work, like member sync, has no one behind it.
    expect((await meAs(token)).status).toBe(200);
    await setRequired(false);
  });

  test("token 范围不够时拒绝", async () => {
    const { token } = await createToken(["act"]);
    expect(await meAs(token)).toMatchObject({
      status: 403,
      body: { error: { code: "scope_missing" } },
    });
  });

  test("吊销后不能再用", async () => {
    const { admin, id, token } = await createToken();
    const res = await api.admin.tokens[":id"].$delete({ param: { id: String(id) } }, as(admin));
    expect(res.status).toBe(204);
    expect(await meAs(token)).toMatchObject({
      status: 401,
      body: { error: { code: "invalid_token" } },
    });
  });

  test("带 token 的请求不检查 Origin，但不能管理 token", async () => {
    const { token } = await createToken(["read", "act", "moderate", "admin"]);

    // A bodyless POST without Origin is what the CSRF check stops for cookie requests.
    expect((await api.auth.logout.$post({}, bearer(token))).status).toBe(204);
    expect((await api.admin.tokens.$get({}, bearer(token))).status).toBe(403);
  });

  test("登录过的群友不能用作 bot", async () => {
    const admin = await login((await createUser("admin")).id);
    const taken = await createUser();
    await login(taken.id);

    const res = await api.admin.tokens.$post(
      { json: { name: "误填", bot_qq: taken.qq, scopes: ["read"] } },
      as(admin),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "bot_qq_taken" } });
  });
});
