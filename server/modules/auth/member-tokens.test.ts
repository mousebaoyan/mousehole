import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login, ownerSession } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";

const api = testClient(app).api.v1;

type Who = { headers: Record<string, string> };

async function person(level = 1, role: "user" | "moderator" | "admin" = "user") {
  const { id } = await createUser(role, level);
  return { id, who: as(await login(id)) };
}

async function tokenOf(who: Who, scopes: ["read"] | ["read", "act"] = ["read", "act"]) {
  const res = await api.me.tokens.$post({ json: { name: "Codex", scopes } }, who);
  if (res.status !== 201) throw new Error(`status ${res.status}`);
  const { id, token } = await res.json();
  return { id, agent: { headers: { authorization: `Bearer ${token}` } }, token };
}

function newThread(who: Who) {
  return api.threads.$post(
    { json: { board: "agents", title: "Agent 发的帖子", content: { markdown: "正文" } } },
    who,
  );
}

beforeAll(async () => {
  const admin = await person(0, "admin");
  await api.boards.$post({ json: { slug: "agents", name: "Agent" } }, admin.who);
});

describe("成员的令牌", () => {
  test("只在生成时返回一次，以本人的身份用，撤销后失效", async () => {
    const me = await person();
    const { id, agent, token } = await tokenOf(me.who, ["read"]);

    const list = await api.me.tokens.$get({}, me.who);
    if (!list.ok) throw new Error(`status ${list.status}`);
    const listed = (await list.json()).items;
    expect(listed).toMatchObject([{ id, name: "Codex", scopes: ["read"], last_used_at: null }]);
    expect(JSON.stringify(listed)).not.toContain(token);

    const mine = await api.me.$get({}, agent);
    expect(await mine.json()).toMatchObject({ id: me.id });

    const revoked = await api.me.tokens[":id"].$delete({ param: { id: String(id) } }, me.who);
    expect(revoked.status).toBe(204);
    const after = await api.me.$get({}, agent);
    expect(after.status).toBe(401);
    expect(await after.json()).toMatchObject({ error: { code: "invalid_token" } });
  });

  test("只能撤销自己的令牌", async () => {
    const { id } = await tokenOf((await person()).who);
    const other = await person();
    const res = await api.me.tokens[":id"].$delete({ param: { id: String(id) } }, other.who);
    expect(res.status).toBe(404);
  });

  test("冻结的账号和站长不能生成令牌", async () => {
    const frozen = await person();
    await db
      .updateTable("users")
      .set({ member_status: "frozen" })
      .where("id", "=", frozen.id)
      .execute();
    const owner = await ownerSession();
    for (const who of [frozen.who, owner]) {
      const res = await api.me.tokens.$post({ json: { name: "Codex", scopes: ["read"] } }, who);
      expect(res.status).toBe(403);
    }
  });

  test("只能以本人的身份做自己的事：不能代表别人、不能管理、不能用 bot 和网页的接口", async () => {
    const { agent } = await tokenOf((await person(3, "moderator")).who);
    const other = await createUser();

    const actAs = await api.me.$get(
      {},
      { headers: { ...agent.headers, "x-act-as": String(other.id) } },
    );
    expect(actAs.status).toBe(403);
    expect(await actAs.json()).toMatchObject({ error: { code: "forbidden" } });
    for (const res of [
      await api.admin.members.$get({ query: {} }, agent),
      await api.bot.groups.$get({}, agent),
      await api.me.tokens.$get({}, agent),
      await api.me.tokens.$post({ json: { name: "再来一个", scopes: ["read"] } }, agent),
    ]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: { code: "forbidden" } });
    }
  });

  test("发内容要 act 和 L3，发出的标为 agent", async () => {
    const reader = await tokenOf((await person(3)).who, ["read"]);
    const missing = await newThread(reader.agent);
    expect(missing.status).toBe(403);
    expect(await missing.json()).toMatchObject({ error: { code: "scope_missing" } });

    const low = await tokenOf((await person(2)).who);
    const tooLow = await newThread(low.agent);
    expect(tooLow.status).toBe(403);
    expect(await tooLow.json()).toMatchObject({ error: { code: "level_required" } });

    const l3 = await tokenOf((await person(3)).who);
    const posted = await newThread(l3.agent);
    if (!posted.ok) throw new Error(`status ${posted.status}`);
    const thread = await posted.json();
    const opening = await db
      .selectFrom("posts")
      .select("via")
      .where("thread_id", "=", thread.id)
      .executeTakeFirstOrThrow();
    expect(opening.via).toBe("agent");
  });

  test("通过 Agent 每天最多发 5 个帖子", async () => {
    const { agent } = await tokenOf((await person(3)).who);
    for (let i = 0; i < 5; i++) expect((await newThread(agent)).status).toBe(201);
    const sixth = await newThread(agent);
    expect(sixth.status).toBe(429);
    expect(await sixth.json()).toMatchObject({ error: { code: "rate_limited" } });
    expect(Number(sixth.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  test("封禁时令牌作废", async () => {
    const me = await person();
    const { agent } = await tokenOf(me.who);
    const admin = await person(1, "admin");
    const banned = await api.users[":user"].restriction.$put(
      { param: { user: String(me.id) }, json: { type: "ban", until: null, reason: "刷屏" } },
      admin.who,
    );
    expect(banned.status).toBe(204);
    expect((await api.me.$get({}, agent)).status).toBe(401);
  });

  test("90 天没用过就失效", async () => {
    const me = await person();
    const { id, agent } = await tokenOf(me.who);
    await db
      .updateTable("api_tokens")
      .set({ created_at: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000) })
      .where("id", "=", id)
      .execute();

    expect((await api.me.$get({}, agent)).status).toBe(401);
    const list = await api.me.tokens.$get({}, me.who);
    if (!list.ok) throw new Error(`status ${list.status}`);
    expect((await list.json()).items).toEqual([]);
  });
});
