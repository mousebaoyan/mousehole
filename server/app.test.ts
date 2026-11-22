import { testClient } from "hono/testing";
import { expect, test } from "vitest";
import { as, createUser, login, nextQq } from "../test/fixtures.ts";
import { app } from "./app.ts";
import { createBotToken } from "./modules/auth/service.ts";

const api = testClient(app).api.v1;

// One schema the generator can't convert fails the whole document, which nothing else uses.
test("接口文档能生成", async () => {
  const res = await app.request("/api/v1/openapi.json");
  expect(res.status).toBe(200);
});

test("bot 的接口只给 bot：网页登录和成员的令牌都不行，只要 read 的也一样", async () => {
  const { id } = await createUser("moderator", 3);
  const web = as(await login(id));
  const minted = await api.me.tokens.$post({ json: { name: "Codex", scopes: ["read"] } }, web);
  if (minted.status !== 201) throw new Error(`status ${minted.status}`);
  const agent = { headers: { authorization: `Bearer ${(await minted.json()).token}` } };
  const { token } = await createBotToken(
    { userId: id, operatorId: null, tokenId: null, via: "web", ip: null, userAgent: null },
    { name: "插件", botQq: nextQq(), scopes: ["read", "sync"] },
  );
  const bot = { headers: { authorization: `Bearer ${token}` } };

  const weekly = (who?: { headers: Record<string, string> }) =>
    api.bot.stats.weekly.$get({ query: {} }, who);
  expect((await weekly()).status).toBe(401);
  for (const who of [web, agent]) {
    const res = await weekly(who);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "forbidden" } });
    expect((await api.bot.groups.$get({}, who)).status).toBe(403);
  }
  // Before the body is read: a garbled one doesn't get a 400 first.
  const garbled = await app.request("/api/v1/bot/auth/links", {
    method: "POST",
    headers: { ...agent.headers, "content-encoding": "gzip" },
    body: "x",
  });
  expect(garbled.status).toBe(403);
  expect((await weekly(bot)).status).toBe(200);
  expect((await api.bot.groups.$get({}, bot)).status).toBe(200);
});
