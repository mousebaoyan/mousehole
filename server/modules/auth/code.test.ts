import { testClient } from "hono/testing";
import { sql } from "kysely";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login, nextQq, sessionCookie } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { env } from "../../platform/env.ts";
import { createBotToken } from "./service.ts";

const api = testClient(app).api.v1;

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";

let token = "";
let lastIp = 0;

beforeAll(async () => {
  const admin = await createUser("admin");
  const actor = { userId: admin.id, operatorId: null, tokenId: null, ip: null };
  token = (await createBotToken(actor, { name: "插件", botQq: nextQq(), scopes: ["auth"] })).token;
});

// A browser asks for a code; its cookie is how it polls.
async function browserCode() {
  const headers = {
    "user-agent": CHROME_MAC,
    "x-real-ip": `10.1.0.${++lastIp}`,
    origin: env.PUBLIC_URL,
  };
  const res = await api.auth.code.$post({}, { headers });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const cookie = res.headers
    .getSetCookie()
    .find((c) => c.startsWith("login_code="))
    ?.split(";")[0];
  return { ...(await res.json()), cookie: cookie ?? "" };
}

function poll(cookie: string) {
  return api.auth.code.$get({}, { headers: { cookie } });
}

function confirm(code: string, actAs?: number) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (actAs !== undefined) headers["x-act-as"] = String(actAs);
  return api.bot.auth.code.confirm.$post({ json: { code } }, { headers });
}

describe("口令登录", () => {
  test("浏览器拿到口令，bot 代成员确认后，浏览器下一次查询就登录了", async () => {
    const member = await createUser();
    const { code, hint, cookie } = await browserCode();
    expect(hint).toContain(code);
    expect(await (await poll(cookie)).json()).toMatchObject({ status: "pending", code });

    const confirmed = await confirm(code, member.id);
    expect(await confirmed.json()).toEqual({ device: "Chrome · macOS" });

    const res = await poll(cookie);
    expect(await res.json()).toEqual({ status: "confirmed" });
    const session = sessionCookie(res) ?? "";
    expect(await (await api.me.$get({}, as(session))).json()).toMatchObject({ id: member.id });
    // The code is spent.
    expect((await poll(cookie)).status).toBe(410);
  });

  test("口令只能确认一次", async () => {
    const { code } = await browserCode();
    expect((await confirm(code, (await createUser()).id)).status).toBe(200);
    const again = await confirm(code, (await createUser()).id);
    expect(again.status).toBe(404);
    expect(await again.json()).toMatchObject({ error: { code: "login_code_invalid" } });
  });

  test("过期的口令不能确认，浏览器要重新申请", async () => {
    const { code, cookie } = await browserCode();
    await db
      .updateTable("login_tickets")
      .set({ expires_at: sql`now() - interval '1 second'` })
      .where("code", "=", code)
      .execute();

    expect((await confirm(code, (await createUser()).id)).status).toBe(404);
    expect((await poll(cookie)).status).toBe(410);
  });

  test("确认口令必须用 X-Act-As 指定是谁", async () => {
    const { code } = await browserCode();
    const res = await confirm(code);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "act_as_required" } });
  });

  test("封禁的成员不能用口令登录", async () => {
    const member = await createUser();
    await db.updateTable("users").set({ restriction: "ban" }).where("id", "=", member.id).execute();
    const { code } = await browserCode();

    const res = await confirm(code, member.id);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "banned" } });
  });

  test("口令登录关闭后不能申请", async () => {
    const admin = as(await login((await createUser("admin")).id));
    await api.admin.settings.$patch({ json: { login: { code: false } } }, admin);
    const res = await api.auth.code.$post({}, { headers: { origin: env.PUBLIC_URL } });
    expect(await res.json()).toMatchObject({ error: { code: "login_method_disabled" } });
    await api.admin.settings.$patch({ json: { login: { code: true } } }, admin);
  });
});

describe("bot 签发登录链接", () => {
  test("签发的链接能登录这位成员", async () => {
    const member = await createUser();
    const headers = { authorization: `Bearer ${token}`, "x-act-as": `qq:${member.qq}` };
    const res = await api.bot.auth.links.$post({}, { headers });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const { url } = await res.json();

    const linkToken = new URL(url).searchParams.get("token") ?? "";
    const used = await api.auth.link.$post({ json: { token: linkToken } });
    expect(used.status).toBe(204);
    const session = sessionCookie(used) ?? "";
    expect(await (await api.me.$get({}, as(session))).json()).toMatchObject({ id: member.id });
  });
});
