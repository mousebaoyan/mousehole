import { testClient } from "hono/testing";
import { sql } from "kysely";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login, nextQq } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { createBotToken } from "../auth/service.ts";
import { clearOldEvents, latestEventId, recordEvent } from "./service.ts";

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

async function batch(after: number, types?: string) {
  const res = await api.bot.events.batch.$get({ query: { after: String(after), types } }, bot);
  if (!res.ok) throw new Error(`status ${res.status}: ${await res.text()}`);
  return res.json();
}

describe("事件流", () => {
  test("群里收录的提问和网页上的回答：回答的事件带被回复的那一层", async () => {
    const start = await latestEventId();
    const source = { chat_type: "group" as const, chat_id: 123456, message_ids: [42] };
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

    const { items, next_after } = await batch(start);
    expect(items.map((e) => e.type)).toEqual(["thread.created", "post.created"]);
    expect(items[0].data).toMatchObject({ author: { qq: askerQq } });
    expect(items[1].data).toMatchObject({
      post: { floor: 2, body: "能冲" },
      reply_to: { floor: 1, author: { qq: askerQq } },
    });
    expect(next_after).toBe(items[1].id);

    const onlyThreads = await batch(start, "thread.created");
    expect(onlyThreads.items.map((e) => e.type)).toEqual(["thread.created"]);
  });

  test("成员第一次登录时有 member.activated，之后再登录没有", async () => {
    const start = await latestEventId();
    const user = await createUser();
    await login(user.id);
    await login(user.id);
    const { items } = await batch(start);
    expect(items.map((e) => [e.type, e.data])).toEqual([
      ["member.activated", { user: { id: user.id, display_name: "鼠鼠", qq: user.qq } }],
    ]);
  });

  test("事件按提交的先后编号：先写了事件、后提交的排在后面，游标不会越过它", async () => {
    const start = await latestEventId();
    const { promise: begun, resolve: begin } = Promise.withResolvers<void>();
    const { promise: written, resolve: write } = Promise.withResolvers<void>();
    const { promise: held, resolve: commit } = Promise.withResolvers<void>();
    // Its transaction ID comes before the slow one's, its event after; it commits first.
    const early = db.transaction().execute(async (trx) => {
      await sql`SELECT pg_current_xact_id()`.execute(trx);
      begin();
      await written;
      await recordEvent(trx, "member.activated", { user: { id: 2 } });
    });
    await begun;
    const slow = db.transaction().execute(async (trx) => {
      await recordEvent(trx, "member.activated", { user: { id: 1 } });
      write();
      await held;
    });
    await early;
    const first = await batch(start);
    expect(first.items.map((e) => e.data)).toEqual([{ user: { id: 2 } }]);

    commit();
    await slow;
    const then = await batch(first.next_after);
    expect(then.items.map((e) => e.data)).toEqual([{ user: { id: 1 } }]);
  });

  test("SSE 先补发游标之后的事件；游标太旧返回 410 和最新的 ID", async () => {
    const start = await latestEventId();
    await db
      .transaction()
      .execute((trx) => recordEvent(trx, "member.activated", { user: { id: 3 } }));
    const id = await latestEventId();
    const res = await app.request("/api/v1/bot/events", {
      headers: { ...bot.headers, "last-event-id": String(start) },
    });
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no stream");
    const { value } = await reader.read();
    await reader.cancel();
    expect(new TextDecoder().decode(value)).toBe(
      `event: member.activated\ndata: {"user":{"id":3}}\nid: ${id}\n\n`,
    );

    await db.deleteFrom("events").where("id", "<=", start).execute();
    const expired = await api.bot.events.batch.$get({ query: { after: "0" } }, bot);
    expect(expired.status).toBe(410);
    expect(await expired.json()).toMatchObject({
      error: { code: "cursor_expired" },
      latest_id: id,
    });
  });

  test("一周没有新事件时，最新的一个不清理，跟上了的游标照样能续上", async () => {
    await db
      .transaction()
      .execute((trx) => recordEvent(trx, "member.activated", { user: { id: 4 } }));
    const latest = await latestEventId();
    await db
      .updateTable("events")
      .set({ created_at: sql<Date>`now() - interval '8 days'` })
      .execute();
    await clearOldEvents();
    expect(await latestEventId()).toBe(latest);

    await db
      .transaction()
      .execute((trx) => recordEvent(trx, "member.activated", { user: { id: 5 } }));
    expect((await batch(latest)).items.map((e) => e.data)).toEqual([{ user: { id: 5 } }]);
  });
});
