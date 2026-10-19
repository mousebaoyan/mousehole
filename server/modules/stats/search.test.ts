import { testClient } from "hono/testing";
import { sql } from "kysely";
import { beforeAll, expect, test } from "vitest";
import { as, createUser, login, nextQq, ownerSession } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { createBotToken } from "../auth/service.ts";

const api = testClient(app).api.v1;

const BROWSER =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

let admin = as("");

beforeAll(async () => {
  const { id } = await createUser("admin");
  admin = as(await login(id));
  await api.boards.$post({ json: { slug: "search", name: "搜索" } }, admin);
  await api.threads.$post(
    { json: { board: "search", title: "夏令营经验分享", content: { markdown: "正文" } } },
    admin,
  );
});

// As a browser at an address, or with a session's or bot's headers.
function from(ip: string, headers: Record<string, string> = {}) {
  return { headers: { "x-real-ip": ip, "user-agent": BROWSER, ...headers } };
}

async function search(q: string, who: { headers: Record<string, string> }, more = {}) {
  const res = await api.search.$get({ query: { q, ...more } }, who);
  expect(res.status).toBe(200);
}

test("记网页上搜的词：每人每天每个词一次，不记 bot、站长、爬虫和翻页；搜不到的另外数", async () => {
  const member = (await createUser()).id;
  const signedIn = { headers: { ...from("10.0.0.9").headers, ...as(await login(member)).headers } };
  const { token } = await createBotToken(
    { userId: member, operatorId: null, tokenId: null, ip: null, userAgent: null },
    { name: "插件", botQq: nextQq(), scopes: ["read"] },
  );
  const owner = await ownerSession();

  await search("夏令营", from("10.0.0.1"));
  await search("夏令营", from("10.0.0.1"), { sort: "created" });
  await search(" 夏令营 ", from("10.0.0.2"));
  await search("夏令营", signedIn);
  await search("夏令营", from("10.0.0.9"));
  await search("夏令营", from("10.0.0.3", { authorization: `Bearer ${token}` }));
  await search("夏令营", { headers: { ...from("10.0.0.4").headers, ...owner.headers } });
  await search("夏令营", from("10.0.0.5", { "user-agent": "Googlebot/2.1" }));
  await search("夏令营", from("10.0.0.6"), { cursor: "20" });
  await search("Summer  CAMP", from("10.0.0.1"));
  await search("summer camp", from("10.0.0.2"));
  await db
    .insertInto("search_terms")
    .values({
      day: sql<Date>`(now() AT TIME ZONE 'Asia/Shanghai')::date - 7`,
      term: "夏令营",
      searches: 5,
      empty: 0,
    })
    .execute();

  const res = await api.admin.stats.$get({ query: { range: "7" } }, admin);
  if (!res.ok) throw new Error(`status ${res.status}`);
  expect((await res.json()).searches).toEqual({
    most: [
      { term: "夏令营", searches: 4 },
      { term: "summer camp", searches: 2 },
    ],
    unfound: [{ term: "summer camp", searches: 2 }],
  });
});
