import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login, nextQq } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { createBotToken } from "../auth/service.ts";
import { latestEventId, readEvents, recordEvent } from "./service.ts";

const api = testClient(app).api.v1;

type Who = { headers: Record<string, string> };

let bot: Who = { headers: {} };
let asAsker: Who = { headers: {} };
let answerer: Who = as("");
let askerQq = 0;

beforeAll(async () => {
  const admin = await createUser("admin");
  const { token } = await createBotToken(
    { userId: admin.id, operatorId: null, tokenId: null, ip: null, userAgent: null },
    { name: "插件", botQq: nextQq(), scopes: ["read", "act", "admin", "events"] },
  );
  bot = { headers: { authorization: `Bearer ${token}` } };
  const asker = await createUser();
  askerQq = asker.qq;
  asAsker = { headers: { ...bot.headers, "x-act-as": `qq:${asker.qq}` } };
  answerer = as(await login((await createUser()).id));
  await api.boards.$post({ json: { slug: "e", name: "事件" } }, bot);
});

// Test files share the PostgreSQL cluster, and a transaction running in another one holds events
// back for a moment; so wait until this many are there.
async function batch(after: number, count: number, types?: string) {
  for (let tries = 0; ; tries++) {
    const res = await api.bot.events.batch.$get({ query: { after: String(after), types } }, bot);
    if (!res.ok) throw new Error(`status ${res.status}: ${await res.text()}`);
    const page = await res.json();
    if (page.items.length >= count || tries === 50) return page;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("事件流", () => {
  test("群里转来的提问和网页上的回答：事件带来源消息，回答带被回复那层的来源，方便引用", async () => {
    const start = await latestEventId();
    const source = { chat_type: "group" as const, chat_id: 123456, message_id: 42 };
    const res = await api.threads.$post(
      {
        json: {
          board: "e",
          title: "群里转来的问题",
          content: { markdown: "rank 30% 能冲吗" },
          source,
        },
      },
      asAsker,
    );
    if (!res.ok) throw new Error(`status ${res.status}`);
    const thread = await res.json();
    const posts = await api.threads[":id"].posts.$get({
      param: { id: String(thread.id) },
      query: {},
    });
    if (!posts.ok) throw new Error(`status ${posts.status}`);
    const opening = (await posts.json()).items[0].id;
    await api.threads[":id"].posts.$post(
      {
        param: { id: String(thread.id) },
        json: { content: { markdown: "能冲" }, reply_to_id: opening },
      },
      answerer,
    );

    const { items, next_after } = await batch(start, 3);
    expect(items.map((e) => e.type)).toEqual([
      "thread.created",
      "post.created",
      "notification.created",
    ]);
    expect(items[0].data).toMatchObject({ author: { qq: askerQq }, source });
    expect(items[0].data.qq_text).toMatch(/^【事件】群里转来的问题\n.+：rank 30% 能冲吗\nhttp/);
    expect(items[1].data).toMatchObject({
      post: { floor: 2, body: "能冲" },
      reply_to: { floor: 1, author: { qq: askerQq }, source },
      source: null,
    });
    expect(items[2].data).toMatchObject({ user: { qq: askerQq }, type: "reply" });
    expect(next_after).toBe(items[2].id);

    const onlyThreads = await batch(start, 1, "thread.created");
    expect(onlyThreads.items.map((e) => e.type)).toEqual(["thread.created"]);
  });

  test("成员第一次登录时有 member.activated，之后再登录没有", async () => {
    const start = await latestEventId();
    const user = await createUser();
    await login(user.id);
    await login(user.id);
    const { items } = await batch(start, 1);
    expect(items.map((e) => [e.type, e.data])).toEqual([
      ["member.activated", { user: { id: user.id, display_name: "鼠鼠", qq: user.qq } }],
    ]);
  });

  test("还没提交的事务里的事件，连同它之后的都先不读，免得游标越过它", async () => {
    const start = await latestEventId();
    const { promise: held, resolve: commit } = Promise.withResolvers<void>();
    const slow = db.transaction().execute(async (trx) => {
      await recordEvent(trx, "member.activated", { user: { id: 1 } });
      await held;
    });
    // Let the slow transaction take its event ID first.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await db
      .transaction()
      .execute((trx) => recordEvent(trx, "member.activated", { user: { id: 2 } }));
    expect(await readEvents(start, null, 10)).toEqual([]);

    commit();
    await slow;
    expect((await batch(start, 2)).items.map((e) => e.data)).toEqual([
      { user: { id: 1 } },
      { user: { id: 2 } },
    ]);
  });

  test("SSE 先补发游标之后的事件；游标太旧返回 410 和最新的 ID", async () => {
    const start = await latestEventId();
    await db
      .transaction()
      .execute((trx) => recordEvent(trx, "member.activated", { user: { id: 3 } }));
    const res = await app.request("/api/v1/bot/events", {
      headers: { ...bot.headers, "last-event-id": String(start) },
    });
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no stream");
    const { value } = await reader.read();
    await reader.cancel();
    expect(new TextDecoder().decode(value)).toBe(
      `event: member.activated\ndata: {"user":{"id":3}}\nid: ${start + 1}\n\n`,
    );

    await db.deleteFrom("events").where("id", "<=", start).execute();
    const expired = await api.bot.events.batch.$get({ query: { after: "0" } }, bot);
    expect(expired.status).toBe(410);
    expect(await expired.json()).toMatchObject({
      error: { code: "cursor_expired" },
      latest_id: start + 1,
    });
  });
});
