import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login, nextQq, readStream } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { createBotToken } from "../auth/service.ts";

const api = testClient(app).api.v1;

type Who = { headers: Record<string, string> };

let admin: Who = as("");
let member: Who = as("");
let bot: Who = { headers: {} };

beforeAll(async () => {
  const user = await createUser("admin");
  admin = as(await login(user.id));
  member = as(await login((await createUser()).id));
  const { token } = await createBotToken(
    { userId: user.id, operatorId: null, tokenId: null, ip: null },
    { name: "插件", botQq: nextQq(), scopes: ["read", "events"] },
  );
  bot = { headers: { authorization: `Bearer ${token}` } };
  await api.boards.$post({ json: { slug: "open", name: "公开" } }, admin);
  await api.boards.$post({ json: { slug: "held", name: "先审", review_mode: "before" } }, admin);
});

async function overview() {
  const res = await api.admin.overview.$get({}, admin);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

async function thread(board: string) {
  const res = await api.threads.$post(
    { json: { board, title: "今天发的帖子", content: { markdown: "正文" } } },
    member,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).id;
}

describe("概览", () => {
  test("今天公开的帖子和回复、待审核的内容、待处理的举报都算进去", async () => {
    const before = (await overview()).content;
    const id = await thread("open");
    const reply = await api.threads[":id"].posts.$post(
      { param: { id: String(id) }, json: { content: { markdown: "回复" } } },
      admin,
    );
    if (!reply.ok) throw new Error(`status ${reply.status}`);
    await thread("held");
    await api.posts[":id"].report.$post(
      { param: { id: String((await reply.json()).id) }, json: { reason: "广告" } },
      member,
    );

    const after = (await overview()).content;
    expect({
      threads_today: after.threads_today - before.threads_today,
      posts_today: after.posts_today - before.posts_today,
      pending: after.pending - before.pending,
      reports: after.reports - before.reports,
    }).toEqual({ threads_today: 1, posts_today: 1, pending: 1, reports: 1 });
  });

  test("bot 连着事件流时算一个，断开后减掉；按游标拉取时记下时间", async () => {
    const stream = await readStream("/api/v1/bot/events", bot.headers);
    await expect.poll(async () => (await overview()).events.streams).toBe(1);
    await stream.close();
    await expect.poll(async () => (await overview()).events.streams).toBe(0);

    expect((await overview()).events.polled_at).toBeNull();
    await api.bot.events.batch.$get({ query: {} }, bot);
    expect((await overview()).events.polled_at).not.toBeNull();
  });
});
